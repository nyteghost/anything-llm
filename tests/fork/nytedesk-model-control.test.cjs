// NyteDesk engine model control: approval-gated load/unload over real HTTP, against the
// real routes, service and SQLite store, with a stateful fake Ollama on a loopback port.
// Nothing here starts, stops or signals a process.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { makeApp, serve } = require("./nytedesk-harness.cjs");
const { openStore } = require("../../server/utils/nytedesk/store.cjs");
const { createService } = require("../../server/utils/nytedesk/service.cjs");
const { createNyteDeskRoutes } = require("../../server/utils/nytedesk/routes.cjs");
const cp = require("../../server/utils/nytedesk/control-plane.cjs");

const USERS = {
  1: { id: 1, role: "admin" },
  2: { id: 2, role: "manager" },
  3: { id: 3, role: "default" },
  4: { id: 4, role: "default" },
};
const WORKSPACES = [{ id: 10, slug: "alpha", name: "Alpha" }];
const MODEL = "qwen3:8b";
const OTHER = "llama3.2:3b";

// ------------------------------------------------------------------ stateful fake Ollama
const ollama = { loaded: new Set(), requests: [], mode: "normal", loadDelayMs: 0 };
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
let engine, dir, store, server, base;
const env = { NYTEDESK_MODEL_CONTROL: "true" };

before(async () => {
  engine = http.createServer(async (req, res) => {
    const body = await readBody(req);
    ollama.requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    if (req.method === "GET" && req.url === "/api/tags") {
      return json(res, 200, { models: [{ name: MODEL }, { name: OTHER }] });
    }
    if (req.method === "GET" && req.url === "/api/ps") {
      return json(res, 200, { models: [...ollama.loaded].map((name) => ({ name })) });
    }
    if (req.method === "POST" && req.url === "/api/generate") {
      const p = JSON.parse(body);
      if (ollama.mode === "error") return json(res, 500, { error: "out of memory" });
      if (ollama.loadDelayMs) await new Promise((r) => setTimeout(r, ollama.loadDelayMs));
      if (ollama.mode === "stubborn") return json(res, 200, { done: true });
      if (p.keep_alive === 0) ollama.loaded.delete(p.model);
      else ollama.loaded.add(p.model);
      return json(res, 200, { model: p.model, done: true, done_reason: p.keep_alive === 0 ? "unload" : "load" });
    }
    return json(res, 404, {});
  });
  await new Promise((r) => engine.listen(0, "127.0.0.1", r));

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nytedesk-model-control-"));
  store = openStore({ file: path.join(dir, "nytedesk.db") });
  const service = createService(store, { env, probeOptions: { timeoutMs: 1000 } });
  const built = makeApp();
  createNyteDeskRoutes(built.app, {
    auth: [async (req, res, next) => (req.header("Authorization") ? next() : res.status(401).json({ error: "no token" }))],
    enabled: () => true,
    isMultiUser: async () => true,
    currentUser: async (req) => USERS[(req.header("Authorization") || "").replace("Bearer u", "")] || null,
    workspaceBySlug: async (_u, slug) => WORKSPACES.find((w) => w.slug === slug) || null,
    workspaceById: async (_u, id) => WORKSPACES.find((w) => w.id === Number(id)) || null,
    accessibleWorkspaces: async () => WORKSPACES,
    service: () => service,
  });
  server = serve(built.routes);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api`;

  // Admin points Ollama at the fake and a manager checks it (model list evidence).
  const cur = (await call("GET", "/nytedesk/engines", { user: 1 })).body.engines.find((e) => e.id === "ollama");
  const put = await call("PUT", "/nytedesk/engines/ollama", {
    user: 1, key: newKey(), body: { expectedVersion: cur.version, endpoint: `http://127.0.0.1:${engine.address().port}` },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await call("POST", "/nytedesk/engines/ollama/check", { user: 2 })).status, 200);
});

after(() => {
  server.close();
  engine.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const newKey = () => `mc-key-${++n}-${Date.now()}`;
async function call(method, p, { user, body, key } = {}) {
  const headers = { "content-type": "application/json" };
  if (user) headers.Authorization = `Bearer u${user}`;
  if (key) headers["Idempotency-Key"] = key;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const propose = (user, action, target, extra = {}) =>
  call("POST", "/nytedesk/workspaces/alpha/tasks", {
    user, key: newKey(), body: { description: `${action} ${target}`, adapter: "ollama", action, target, ...extra },
  });
async function approved(action, target, requester = 3) {
  const t = (await propose(requester, action, target)).body.task;
  assert.ok(t, "task created");
  const a = await call("POST", `/nytedesk/tasks/${t.id}/approve`, {
    user: 2, key: newKey(), body: { expectedVersion: t.version, payloadHash: t.payloadHash },
  });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return a.body.task;
}
const run = (user, task) => call("POST", `/nytedesk/tasks/${task.id}/run`, { user, body: { expectedVersion: task.version } });
const detail = async (task, user = 1) => (await call("GET", `/nytedesk/tasks/${task.id}`, { user })).body;
const engineCalls = (since) => ollama.requests.slice(since).map((r) => `${r.method} ${r.url}`);

// ------------------------------------------------------------------ tests
test("status reports model control; it follows NYTEDESK_MODEL_CONTROL", async () => {
  assert.equal((await call("GET", "/nytedesk/status", { user: 3 })).body.modelControl, true);
  env.NYTEDESK_MODEL_CONTROL = "false";
  try {
    assert.equal((await call("GET", "/nytedesk/status", { user: 3 })).body.modelControl, false);
  } finally {
    env.NYTEDESK_MODEL_CONTROL = "true";
  }
});

test("with model control off, model tasks cannot be proposed or run, and the engine is not called", async () => {
  const t = await approved(cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL);
  const since = ollama.requests.length;
  env.NYTEDESK_MODEL_CONTROL = "false";
  try {
    const p = await propose(3, cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL);
    assert.equal(p.status, 403);
    assert.match(p.body.error, /Model control is disabled/);
    const r = await run(1, t);
    assert.equal(r.status, 403);
    assert.equal((await detail(t)).canRun, false);
  } finally {
    env.NYTEDESK_MODEL_CONTROL = "true";
  }
  assert.deepEqual(engineCalls(since), []);
  assert.equal((await detail(t)).task.status, "approved");
});

test("proposals: model bound to the payload; Ollama only; must be listed; agents' actions take no target", async () => {
  const a = await propose(3, cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL);
  assert.equal(a.status, 201);
  assert.equal(a.body.task.target, MODEL);
  const b = await propose(3, cp.ACTIONS.ENGINE_MODEL_LOAD, OTHER);
  assert.notEqual(b.body.task.payloadHash, a.body.task.payloadHash);
  assert.equal((await propose(3, cp.ACTIONS.ENGINE_MODEL_LOAD, "not-listed:1b")).status, 400);
  assert.equal((await propose(3, cp.ACTIONS.ENGINE_MODEL_LOAD, "bad name;rm")).status, 400);
  assert.equal((await propose(3, cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL, { adapter: "strata" })).status, 400);
  assert.equal((await propose(3, cp.ACTIONS.ENGINE_MODEL_LOAD, undefined)).status, 400);
  assert.equal((await propose(3, cp.ACTIONS.MODEL_PROMPT, MODEL)).status, 400);
  const d = await detail(a.body.task);
  assert.equal(d.audit[0].detail.target, MODEL);
});

test("run is refused before approval, for the requester, for default users and for agent actions", async () => {
  const waiting = (await propose(3, cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL)).body.task;
  assert.equal((await run(1, waiting)).status, 409);                    // not approved
  const t = await approved(cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL, 3);
  assert.equal((await run(3, t)).status, 403);                          // requester
  assert.equal((await run(4, t)).status, 403);                          // default role
  assert.equal((await detail(t, 4)).canRun, false);
  const prompt = (await call("POST", "/nytedesk/workspaces/alpha/tasks", {
    user: 3, key: newKey(), body: { description: "x", adapter: "ollama", action: cp.ACTIONS.MODEL_PROMPT },
  })).body.task;
  const ap = await call("POST", `/nytedesk/tasks/${prompt.id}/approve`, {
    user: 2, key: newKey(), body: { expectedVersion: prompt.version, payloadHash: prompt.payloadHash },
  });
  const r = await run(1, ap.body.task);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /agent execution is disabled/);
  assert.equal(ap.body.task.executionEnabled, false);
  assert.equal((await run(1, { ...t, version: t.version + 5 })).status, 409); // stale version
});

test("approved load: fresh check, state read, one load, state verified, evidence in the audit", async () => {
  ollama.loaded.clear();
  const t = await approved(cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL);
  assert.equal((await detail(t)).canRun, true);
  const since = ollama.requests.length;
  const r = await run(1, t);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.task.status, "succeeded");
  assert.deepEqual(engineCalls(since), ["GET /api/tags", "GET /api/ps", "POST /api/generate", "GET /api/ps"]);
  const load = ollama.requests.find((q, i) => i >= since && q.method === "POST");
  assert.deepEqual(load.body, { model: MODEL, prompt: "", stream: false, keep_alive: "30m" });
  const d = await detail(t);
  assert.deepEqual(d.audit.map((e) => e.event), ["task.created", "task.approve", "task.start", "task.succeed"]);
  assert.equal(d.auditVerified, true);
  const ev = d.audit[3].detail;
  assert.equal(ev.operation, "load");
  assert.equal(ev.code, "OK");
  assert.deepEqual(ev.loadedBefore, []);
  assert.deepEqual(ev.loadedAfter, [MODEL]);
  assert.equal(d.audit[2].actorId, 1);
  // A second run is impossible: the task is no longer approved.
  assert.equal((await run(1, d.task)).status, 409);
});

test("loading a model that is already loaded is refused before acting; the task stays approved", async () => {
  ollama.loaded.add(MODEL);
  const t = await approved(cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL);
  const since = ollama.requests.length;
  const r = await run(1, t);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already loaded/);
  assert.ok(!engineCalls(since).includes("POST /api/generate"));
  assert.equal((await detail(t)).task.status, "approved");
});

test("approved unload sends keep_alive 0 and verifies the model is gone", async () => {
  ollama.loaded.add(MODEL);
  const t = await approved(cp.ACTIONS.ENGINE_MODEL_UNLOAD, MODEL);
  const since = ollama.requests.length;
  const r = await run(2, t);
  // Manager 2 approved it; a different manager/admin may run it, and so may the approver.
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.task.status, "succeeded");
  const post = ollama.requests.find((q, i) => i >= since && q.method === "POST");
  assert.deepEqual(post.body, { model: MODEL, keep_alive: 0, stream: false });
  assert.deepEqual(r.body.result.loadedAfter, []);
  const again = await approved(cp.ACTIONS.ENGINE_MODEL_UNLOAD, MODEL);
  const refused = await run(1, again);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /not loaded/);
});

test("an engine that answers but does not change state, or errors, fails the task with evidence", async () => {
  ollama.loaded.clear();
  ollama.mode = "stubborn";
  try {
    const t = await approved(cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL);
    const r = await run(1, t);
    assert.equal(r.status, 200);
    assert.equal(r.body.task.status, "failed");
    assert.equal(r.body.result.code, "STATE_MISMATCH");
    ollama.mode = "error";
    const t2 = await approved(cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL);
    const r2 = await run(1, t2);
    assert.equal(r2.body.task.status, "failed");
    assert.equal(r2.body.result.code, "HTTP_ERROR");
    assert.equal(r2.body.result.httpStatus, 500);
    const d = await detail(t2);
    assert.equal(d.audit.at(-1).event, "task.fail");
    assert.equal(d.auditVerified, true);
  } finally {
    ollama.mode = "normal";
  }
});

test("only one model operation runs at a time", async () => {
  ollama.loaded.clear();
  ollama.loadDelayMs = 400;
  try {
    const a = await approved(cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL);
    const b = await approved(cp.ACTIONS.ENGINE_MODEL_LOAD, OTHER);
    const [ra, rb] = await Promise.all([run(1, a), run(1, b)]);
    const statuses = [ra.status, rb.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const refused = ra.status === 409 ? ra : rb;
    assert.match(refused.body.error, /Another model operation is running/);
  } finally {
    ollama.loadDelayMs = 0;
  }
});

test("an expired approval is refused at run time", async () => {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "nytedesk-mc-ttl-"));
  const s = openStore({ file: path.join(tdir, "db"), approvalTtlMs: 1 });
  try {
    const svc = createService(s, { env, probeOptions: { timeoutMs: 1000 } });
    const ollamaUrl = `http://127.0.0.1:${engine.address().port}`;
    svc.putEngine(USERS[1], "ollama", { expectedVersion: 0, endpoint: ollamaUrl }, newKey());
    await svc.checkEngine(USERS[2], "ollama");
    const created = svc.createTask(USERS[3], WORKSPACES[0], {
      description: "load", adapter: "ollama", action: cp.ACTIONS.ENGINE_MODEL_LOAD, target: OTHER,
    }, newKey()).body.task;
    const ok = svc.decide(USERS[2], created, "approve", { expectedVersion: created.version, payloadHash: created.payloadHash }, newKey());
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(svc.runTask(USERS[1], ok.body.task, { expectedVersion: ok.body.task.version }), /approval expired/);
  } finally {
    s.close();
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});

test("the target column is immutable in storage, like the rest of the payload", async () => {
  const t = (await propose(3, cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL)).body.task;
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(store.file);
  try {
    assert.throws(() => raw.prepare("UPDATE tasks SET target = ? WHERE id = ?").run(OTHER, t.id), /immutable/);
  } finally {
    raw.close();
  }
});

test("tasks without a target keep the original payload hash formula", () => {
  const fields = { workspaceId: "10", requesterId: "3", description: "d", adapter: "ollama", action: cp.ACTIONS.MODEL_PROMPT };
  const task = cp.createTask(fields);
  const legacy = crypto.createHash("sha256").update(cp.canonical(fields)).digest("hex");
  assert.equal(task.payloadHash, legacy);
  assert.equal("target" in task, false);
});

test("the engine process route still refuses every process action", async () => {
  for (const action of ["start", "stop", "restart", "unload", "kill"]) {
    const r = await call("POST", "/nytedesk/engines/ollama/process", { user: 1, key: newKey(), body: { action } });
    assert.equal(r.status, 403);
  }
});
