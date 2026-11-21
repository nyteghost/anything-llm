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
    // The inspector is told in advance: no run control, and the reason.
    const d = svc.getTask(USERS[1], s.getTask(created.id));
    assert.equal(d.canRun, false);
    assert.match(d.runBlockedReason, /Reauthorization would fail: .*approval expired/);
    // The authoritative check in the run path still refuses it.
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


// ------------------------------------------------------------------ review fixes (PR #9 independent review)
const lam = require("../../server/utils/nytedesk/local-ai-manager.cjs");
const mc = require("../../server/utils/nytedesk/model-control.cjs");

test("cancelling while the engine request is in flight is refused; the outcome is recorded", async () => {
  ollama.loaded.clear();
  ollama.loadDelayMs = 500;
  try {
    const t = await approved(cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL);
    const since = ollama.requests.length;
    const pending = run(1, t);
    // Wait until the POST has actually reached the engine.
    const deadline = Date.now() + 3000;
    while (!engineCalls(since).includes("POST /api/generate")) {
      assert.ok(Date.now() < deadline, "POST was dispatched");
      await new Promise((r) => setTimeout(r, 10));
    }
    const live = await detail(t);
    assert.equal(live.task.status, "running");
    assert.equal(live.operationInFlight, true);
    assert.equal(live.canCancel, false);
    for (const user of [3, 2, 1]) {
      const c = await call("POST", `/nytedesk/tasks/${t.id}/cancel`, {
        user, key: newKey(), body: { expectedVersion: live.task.version, reason: "stop" },
      });
      assert.equal(c.status, 409, `user ${user}`);
      assert.match(c.body.error, /in flight/);
    }
    const r = await pending;
    assert.equal(r.status, 200);
    assert.equal(r.body.task.status, "succeeded");
    const d = await detail(t);
    assert.deepEqual(d.audit.map((e) => e.event), ["task.created", "task.approve", "task.start", "task.succeed"]);
    assert.deepEqual(d.audit.at(-1).detail.loadedAfter, [MODEL]);
    assert.equal(d.auditVerified, true);
    assert.equal(d.operationInFlight, false);
  } finally {
    ollama.loadDelayMs = 0;
  }
});

test("a running task that no live operation owns (crashed process) can still be cancelled", async () => {
  const t = await approved(cp.ACTIONS.ENGINE_MODEL_UNLOAD, MODEL);
  // Simulate a process that started the task and then died before finishing.
  const stranded = store.startTask(t.id, USERS[1], { expectedVersion: t.version, executionEnabled: true });
  const d = await detail(t, 3);
  assert.equal(d.task.status, "running");
  assert.equal(d.operationInFlight, false);
  assert.equal(d.canCancel, true);
  const c = await call("POST", `/nytedesk/tasks/${t.id}/cancel`, {
    user: 3, key: newKey(), body: { expectedVersion: stranded.version, reason: "recovery after crash" },
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.task.status, "cancelled");
  assert.equal((await detail(t)).auditVerified, true);
});

test("run eligibility is reported with its reason; Run is hidden when reauthorization would fail", async () => {
  const waiting = (await propose(3, cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL)).body.task;
  let d = await detail(waiting);
  assert.equal(d.canRun, false);
  assert.match(d.runBlockedReason, /not approved/);
  const t = await approved(cp.ACTIONS.ENGINE_MODEL_LOAD, MODEL);
  assert.match((await detail(t, 3)).runBlockedReason, /requester cannot run/);
  assert.match((await detail(t, 4)).runBlockedReason, /manager or administrator/);
  env.NYTEDESK_MODEL_CONTROL = "false";
  try {
    assert.match((await detail(t)).runBlockedReason, /Model control is off/);
  } finally {
    env.NYTEDESK_MODEL_CONTROL = "true";
  }
  d = await detail(t);
  assert.equal(d.canRun, true);
  assert.equal(d.runBlockedReason, null);
  // Agent tasks never get a run control or a run reason.
  const prompt = (await call("POST", "/nytedesk/workspaces/alpha/tasks", {
    user: 3, key: newKey(), body: { description: "x", adapter: "ollama", action: cp.ACTIONS.MODEL_PROMPT },
  })).body.task;
  const pd = await detail(prompt);
  assert.equal(pd.canRun, false);
  assert.equal(pd.runBlockedReason, null);
});

test("an unexpected executor error fails the task with evidence and releases the operation lock", async () => {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "nytedesk-mc-err-"));
  const s = openStore({ file: path.join(tdir, "db") });
  try {
    let calls = 0;
    const throwing = {
      loadedModels: async () => ({ ok: true, code: "OK", models: [] }),
      runModelOperation: async () => {
        calls += 1;
        throw new Error("boom");
      },
    };
    const svc = createService(s, { env, modelControl: throwing, probeOptions: { timeoutMs: 1000 } });
    svc.putEngine(USERS[1], "ollama", { expectedVersion: 0, endpoint: `http://127.0.0.1:${engine.address().port}` }, newKey());
    await svc.checkEngine(USERS[2], "ollama");
    const mk = (target) => {
      const c = svc.createTask(USERS[3], WORKSPACES[0], { description: "l", adapter: "ollama", action: cp.ACTIONS.ENGINE_MODEL_LOAD, target }, newKey()).body.task;
      return svc.decide(USERS[2], c, "approve", { expectedVersion: c.version, payloadHash: c.payloadHash }, newKey()).body.task;
    };
    const a = mk(MODEL);
    const ra = await svc.runTask(USERS[1], a, { expectedVersion: a.version });
    assert.equal(ra.task.status, "failed");
    assert.equal(ra.result.code, "INTERNAL_ERROR");
    assert.ok(ra.result.message);
    // The lock was released: the next run is not refused as concurrent.
    const b = mk(OTHER);
    const rb = await svc.runTask(USERS[1], b, { expectedVersion: b.version });
    assert.equal(rb.task.status, "failed");
    assert.equal(calls, 2);
    // A refusal before dispatch also releases it.
    const c = mk(MODEL);
    await assert.rejects(svc.runTask(USERS[1], c, { expectedVersion: c.version + 1 }), /Task changed/);
    const c2 = await svc.runTask(USERS[1], c, { expectedVersion: c.version });
    assert.equal(c2.task.status, "failed");
  } finally {
    s.close();
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});

test("a task probe for model B never becomes selection evidence for configured model A", async () => {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "nytedesk-mc-sel-"));
  const s = openStore({ file: path.join(tdir, "db") });
  const saved = new Set(ollama.loaded);
  ollama.loaded.clear();
  try {
    const svc = createService(s, { env, probeOptions: { timeoutMs: 1000 } });
    const endpoint = `http://127.0.0.1:${engine.address().port}`;
    // Configured model A = OTHER; checked and selectable.
    svc.putEngine(USERS[1], "ollama", { expectedVersion: 0, endpoint, model: OTHER }, newKey());
    await svc.checkEngine(USERS[2], "ollama");
    const ollamaOf = () => svc.engines(USERS[1]).engines.find((e) => e.id === "ollama");
    const checkBefore = ollamaOf().lastCheck;
    assert.equal(ollamaOf().selectable, true);
    assert.equal(checkBefore.model, OTHER);
    // Run a load task for model B = MODEL.
    const c = svc.createTask(USERS[3], WORKSPACES[0], { description: "l", adapter: "ollama", action: cp.ACTIONS.ENGINE_MODEL_LOAD, target: MODEL }, newKey()).body.task;
    const ap = svc.decide(USERS[2], c, "approve", { expectedVersion: c.version, payloadHash: c.payloadHash }, newKey()).body.task;
    const r = await svc.runTask(USERS[1], ap, { expectedVersion: ap.version });
    assert.equal(r.task.status, "succeeded");
    assert.equal(r.result.freshCheck.modelListed, true);
    // The saved selection evidence is untouched by the task probe.
    assert.deepEqual(ollamaOf().lastCheck, checkBefore);
    // And evidence recorded for another model is rejected by the selection rule.
    s.saveEngineCheck("ollama", USERS[2], { ...checkBefore, model: MODEL, modelListed: true, checkedAt: new Date().toISOString() });
    assert.equal(ollamaOf().selectable, false);
    assert.match(ollamaOf().selectionBlockedReason, /configured model changed/);
    assert.throws(() => svc.selectEngine(USERS[1], { engineId: "ollama" }, newKey()), /configured model changed/);
    s.saveEngineCheck("ollama", USERS[2], { ...checkBefore, api: "openai", checkedAt: new Date().toISOString() });
    assert.match(ollamaOf().selectionBlockedReason, /API style changed/);
  } finally {
    for (const m of saved) ollama.loaded.add(m);
    s.close();
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});

// A slow local test double: answers immediately, then trickles one byte every
// 40 ms so an idle (inactivity) timeout would never fire. It has its own
// cutoff: after TRICKLE_CUTOFF_MS it destroys the connection. If a client ever
// reverts to an inactivity timeout, its call ends at the cutoff (not at its
// deadline) with a non-TIMEOUT code, so the test fails promptly instead of
// hanging.
const TRICKLE_CUTOFF_MS = 2500;
async function withSlowServer(fn) {
  const sockets = { closed: 0 };
  const slow = http.createServer((req, res) => {
    req.on("close", () => { sockets.closed += 1; });
    if (req.url === "/redirect" || req.url === "/api/redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:1/" });
      const t = setInterval(() => res.write("x"), 20);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (req.url === "/api/huge") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(`{"models":[${'"m",'.repeat(200000)}"m"]}`);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    const t = setInterval(() => res.write(" "), 40);
    const cutoff = setTimeout(() => res.destroy(), TRICKLE_CUTOFF_MS);
    res.on("close", () => {
      clearInterval(t);
      clearTimeout(cutoff);
    });
  });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${slow.address().port}`, sockets);
  } finally {
    slow.closeAllConnections?.();
    await new Promise((r) => slow.close(r));
  }
}
const elapsed = async (p) => { const t = Date.now(); const out = await p; return { out, ms: Date.now() - t }; };

test("elapsed deadlines: the fresh probe, /api/ps and /api/generate stop at their deadline despite a trickle", { timeout: 30_000 }, async () => {
  await withSlowServer(async (url) => {
    const probe = await elapsed(lam.probeEngine({ id: "ollama", endpoint: url, api: "ollama", model: MODEL }, { timeoutMs: 300 }));
    assert.equal(probe.out.status, lam.STATUSES.STOPPED);
    assert.equal(probe.out.diagnostics[0].code, "TIMEOUT");
    assert.ok(probe.ms < 1500, `probe took ${probe.ms} ms`);

    const ps = await elapsed(mc.loadedModels(url, { psTimeoutMs: 300 }));
    assert.equal(ps.out.ok, false);
    assert.equal(ps.out.code, "TIMEOUT");
    assert.ok(ps.ms < 1500, `ps took ${ps.ms} ms`);

    const gen = await elapsed(mc.runModelOperation({ endpoint: url, model: MODEL, operation: "load" }, { loadTimeoutMs: 300, psTimeoutMs: 300 }));
    assert.equal(gen.out.ok, false);
    assert.equal(gen.out.code, "TIMEOUT");
    assert.ok(gen.ms < 2500, `generate (+ps) took ${gen.ms} ms`);

    const un = await elapsed(mc.runModelOperation({ endpoint: url, model: MODEL, operation: "unload" }, { unloadTimeoutMs: 300, psTimeoutMs: 300 }));
    assert.equal(un.out.code, "TIMEOUT");
    assert.ok(un.ms < 2500, `unload (+ps) took ${un.ms} ms`);
  });
});

// A double that redirects on the engine's real paths with a body that never
// ends, or answers with an oversized body.
async function withHostileServer(mode, fn) {
  const closes = [];
  const srv = http.createServer((req, res) => {
    req.socket.on("close", () => closes.push(Date.now()));
    if (mode === "redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:1/" });
      const t = setInterval(() => res.write("x".repeat(64)), 10);
      res.on("close", () => clearInterval(t));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`{"models":[${'{"name":"m"},'.repeat(150000)}{"name":"m"}]}`); // ~2 MB
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}`, closes);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
}

test("a refused redirect closes the connection immediately, in both clients", async () => {
  await withHostileServer("redirect", async (url, closes) => {
    const start = Date.now();
    const probe = await elapsed(lam.probeEngine({ id: "ollama", endpoint: url, api: "ollama" }, { timeoutMs: 5000 }));
    assert.equal(probe.out.status, lam.STATUSES.FAILED);
    assert.equal(probe.out.httpStatus, 302);
    assert.equal(probe.out.diagnostics[0].code, "REDIRECT_REFUSED");
    assert.ok(probe.ms < 1000, `probe took ${probe.ms} ms`);

    const ps = await elapsed(mc.loadedModels(url, { psTimeoutMs: 5000 }));
    assert.equal(ps.out.code, "REDIRECT_REFUSED");
    assert.ok(ps.ms < 1000, `ps took ${ps.ms} ms`);

    const gen = await elapsed(mc.runModelOperation({ endpoint: url, model: MODEL, operation: "load" }, { loadTimeoutMs: 5000, psTimeoutMs: 5000 }));
    assert.equal(gen.out.code, "REDIRECT_REFUSED");
    assert.equal(gen.out.ok, false);
    assert.ok(gen.ms < 1500, `generate took ${gen.ms} ms`);

    // The server saw each connection closed promptly, not after a drain.
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(closes.length >= 4, `closed ${closes.length}`);
    assert.ok(closes.every((t) => t - start < 2000));
  });
});

test("the response-size limit still holds for the probe and for /api/ps", async () => {
  await withHostileServer("huge", async (url) => {
    const probe = await lam.probeEngine({ id: "ollama", endpoint: url, api: "ollama" }, { timeoutMs: 5000 });
    assert.equal(probe.status, lam.STATUSES.FAILED);
    assert.equal(probe.diagnostics[0].code, "RESPONSE_TOO_LARGE");
    const ps = await mc.loadedModels(url, { psTimeoutMs: 5000 });
    assert.equal(ps.code, "RESPONSE_TOO_LARGE");
    assert.equal(ps.ok, false);
  });
});

test("model control only talks to loopback endpoints", async () => {
  for (const bad of ["http://10.200.1.124:11434", "http://example.com:11434", "https://127.0.0.1:11434", "http://user:pw@127.0.0.1:11434"]) {
    await assert.rejects(mc.loadedModels(bad), /loopback|http|credentials|Invalid|not allowed/i, bad);
    await assert.rejects(mc.runModelOperation({ endpoint: bad, model: MODEL, operation: "load" }), /loopback|http|credentials|Invalid|not allowed/i, bad);
  }
});

test("legacy database from e26e36a: additive migration, old tasks keep their hashes and audit", () => {
  const legacy = require("./fixtures/nytedesk-e26e36a/store.cjs");
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "nytedesk-mc-legacy-"));
  const file = path.join(tdir, "nytedesk.db");
  let oldId, oldHash;
  const old = legacy.openStore({ file });
  try {
    const t = old.insertTask({ workspace: WORKSPACES[0], actor: USERS[3], description: "legacy", adapter: "ollama", action: "model.prompt" });
    const a = old.decideTask(t.id, USERS[2], { decision: "approve", expectedVersion: t.version, payloadHash: t.payloadHash });
    oldId = a.id;
    oldHash = a.payloadHash;
  } finally {
    old.close();
  }
  const { DatabaseSync } = require("node:sqlite");
  const peek = new DatabaseSync(file);
  assert.equal(peek.prepare("PRAGMA table_info(tasks)").all().some((c) => c.name === "target"), false);
  peek.close();

  const s = openStore({ file });
  try {
    const raw = new DatabaseSync(file);
    try {
      assert.equal(raw.prepare("PRAGMA table_info(tasks)").all().some((c) => c.name === "target"), true);
      assert.throws(() => raw.prepare("UPDATE tasks SET target = 'x' WHERE id = ?").run(oldId), /immutable/);
    } finally {
      raw.close();
    }
    const t = s.getTask(oldId);
    assert.equal(t.payloadHash, oldHash);
    assert.equal(t.target, null);
    assert.equal(s.verifyAudit(oldId).ok, true);
    assert.deepEqual(s.reauthorize(oldId), { ok: true, problems: [] });
    // New model tasks work in the migrated database.
    const m = s.insertTask({ workspace: WORKSPACES[0], actor: USERS[3], description: "load", adapter: "ollama", action: cp.ACTIONS.ENGINE_MODEL_LOAD, target: MODEL });
    assert.equal(s.getTask(m.id).target, MODEL);
    assert.equal(s.verifyAudit(m.id).ok, true);
  } finally {
    s.close();
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});

test("cancelling during preflight (before task.start) succeeds and the run then refuses to dispatch", async () => {
  // Reproduces the PR #9 re-review finding: pause the fresh probe, cancel,
  // then release the probe. No POST may reach the engine.
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "nytedesk-mc-preflight-"));
  const s = openStore({ file: path.join(tdir, "db") });
  let release;
  const gate = new Promise((r) => { release = r; });
  let probing = false;
  const gatedProbe = async (...args) => {
    probing = true;
    await gate;
    return lam.probeEngine(...args);
  };
  ollama.loaded.clear();
  try {
    const svc = createService(s, { env, probe: gatedProbe, probeOptions: { timeoutMs: 1000 } });
    svc.putEngine(USERS[1], "ollama", { expectedVersion: 0, endpoint: `http://127.0.0.1:${engine.address().port}` }, newKey());
    await lam.probeEngine({ id: "ollama", endpoint: `http://127.0.0.1:${engine.address().port}`, api: "ollama" }).then((c) => s.saveEngineCheck("ollama", USERS[2], c));
    const mk = (target) => {
      const c = svc.createTask(USERS[3], WORKSPACES[0], { description: "l", adapter: "ollama", action: cp.ACTIONS.ENGINE_MODEL_LOAD, target }, newKey()).body.task;
      return svc.decide(USERS[2], c, "approve", { expectedVersion: c.version, payloadHash: c.payloadHash }, newKey()).body.task;
    };
    const t = mk(MODEL);
    const other = mk(OTHER);
    const since = ollama.requests.length;
    const pending = svc.runTask(USERS[1], t, { expectedVersion: t.version });
    while (!probing) await new Promise((r) => setTimeout(r, 5));

    // Preflight: still approved, not owned, cancellable; the lock is held.
    const d = svc.getTask(USERS[3], s.getTask(t.id));
    assert.equal(d.task.status, "approved");
    assert.equal(d.operationInFlight, false);
    assert.equal(d.canCancel, true);
    const od = svc.getTask(USERS[1], s.getTask(other.id));
    assert.equal(od.canRun, false);
    assert.equal(od.runBlockedReason, "Another model operation is running");
    await assert.rejects(svc.runTask(USERS[1], other, { expectedVersion: other.version }), /Another model operation is running/);

    const cancelled = svc.cancel(USERS[3], s.getTask(t.id), { expectedVersion: t.version, reason: "changed my mind" }, newKey());
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.task.status, "cancelled");

    release();
    await assert.rejects(pending, (e) => e.status === 409);
    // The engine got only the read-only probe (and possibly /api/ps), never the POST.
    assert.ok(!engineCalls(since).includes("POST /api/generate"), engineCalls(since).join(", "));
    const after = svc.getTask(USERS[1], s.getTask(t.id));
    assert.equal(after.task.status, "cancelled");
    assert.deepEqual(after.audit.map((e) => e.event), ["task.created", "task.approve", "task.cancel"]);
    assert.equal(after.auditVerified, true);
    // The lock was released by the refused run (startTask threw after the lock was taken).
    const r = await svc.runTask(USERS[1], other, { expectedVersion: other.version });
    assert.equal(r.task.status, "succeeded");
  } finally {
    release();
    ollama.loaded.clear();
    s.close();
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});
