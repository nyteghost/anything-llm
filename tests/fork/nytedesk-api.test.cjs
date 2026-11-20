// NyteDesk Phase 1: integration tests over real HTTP (node:http) against the real route factory,
// service and SQLite store, with stub authentication standing in for AnythingLLM's session layer.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { openStore } = require("../../server/utils/nytedesk/store.cjs");
const { createService } = require("../../server/utils/nytedesk/service.cjs");
const { createNyteDeskRoutes } = require("../../server/utils/nytedesk/routes.cjs");
const { ACTIONS } = require("../../server/utils/nytedesk/control-plane.cjs");

// ------------------------------------------------------------------ a minimal express-like app
function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ["get", "post", "put", "delete"]) {
    app[method] = (pattern, mws, handler) => {
      const keys = [];
      const re = new RegExp("^" + pattern.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
      routes.push({ method: method.toUpperCase(), pattern, re, keys, chain: [...(Array.isArray(mws) ? mws : [mws]), ...(handler ? [handler] : [])] });
    };
  }
  return { app, routes };
}

function serve(routes) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      const url = new URL(req.url, "http://x");
      const p = url.pathname.replace(/^\/api/, "");
      const route = routes.find((r) => r.method === req.method && r.re.test(p));
      const response = {
        locals: {},
        headers: {},
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        set(k, v) { this.headers[k] = v; return this; },
        json(obj) { res.writeHead(this.statusCode, { "content-type": "application/json", ...this.headers }); res.end(JSON.stringify(obj)); },
        sendStatus(code) { res.writeHead(code); res.end(); },
      };
      if (!route) return response.status(404).json({ error: "no route" });
      const m = p.match(route.re);
      const request = {
        params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])),
        query: Object.fromEntries(url.searchParams),
        body: raw ? JSON.parse(raw) : {},
        header: (name) => req.headers[name.toLowerCase()],
      };
      let i = 0;
      const next = async () => { const fn = route.chain[i++]; if (fn) await fn(request, response, next); };
      await next();
    });
  });
}

// ------------------------------------------------------------------ stub identity and workspaces
const USERS = {
  1: { id: 1, role: "admin", username: "admin" },
  2: { id: 2, role: "manager", username: "manager" },
  3: { id: 3, role: "default", username: "dev" },
  4: { id: 4, role: "default", username: "outsider" },
  5: { id: 5, role: "admin", username: "admin2" },
  6: { id: 6, role: "default", username: "suspended", suspended: 1 },
};
const WORKSPACES = [{ id: 10, slug: "alpha", name: "Alpha" }, { id: 20, slug: "beta", name: "Beta" }];
const MEMBERS = { 3: [10], 4: [20], 6: [10] };
const elevated = (u) => ["admin", "manager"].includes(u.role);
const visible = (u) => (elevated(u) ? WORKSPACES : WORKSPACES.filter((w) => (MEMBERS[u.id] || []).includes(w.id)));

const state = { enabled: true, multiUser: true };
let dir, store, server, base, routes, env;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nytedesk-"));
  env = { NYTEDESK_OPENAI_KEY: "sk-test-not-a-real-key" };
  store = openStore({ file: path.join(dir, "nytedesk.db") });
  const service = createService(store, { env });
  const built = makeApp();
  routes = built.routes;
  createNyteDeskRoutes(built.app, {
    auth: [async (req, res, next) => {             // stands in for validatedRequest
      const h = req.header("Authorization");
      if (!h) return res.status(401).json({ error: "No auth token found." });
      next();
    }],
    enabled: () => state.enabled,
    isMultiUser: async () => state.multiUser,
    currentUser: async (req) => USERS[(req.header("Authorization") || "").replace("Bearer u", "")] || null,
    workspaceBySlug: async (u, slug) => visible(u).find((w) => w.slug === slug) || null,
    workspaceById: async (u, id) => visible(u).find((w) => w.id === Number(id)) || null,
    accessibleWorkspaces: async (u) => visible(u),
    service: () => service,
  });
  server = serve(routes);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let keyN = 0;
const newKey = () => `test-key-${++keyN}-${Date.now()}`;
async function call(method, p, { user, body, key } = {}) {
  const headers = { "content-type": "application/json" };
  if (user) headers.Authorization = `Bearer u${user}`;
  if (key) headers["Idempotency-Key"] = key;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), replayed: r.headers.get("idempotent-replayed") === "true" };
}
async function createTask(user = 3, fields = {}, slug = "alpha") {
  const r = await call("POST", `/nytedesk/workspaces/${slug}/tasks`, {
    user, key: newKey(), body: { description: "Summarize the repository README", adapter: "ollama", action: ACTIONS.MODEL_PROMPT, ...fields },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.task;
}
const decide = (user, task, decision, extra = {}, key = newKey()) => call("POST", `/nytedesk/tasks/${task.id}/${decision}`, {
  user, key, body: { expectedVersion: task.version, payloadHash: task.payloadHash, ...extra },
});

// ------------------------------------------------------------------ tests
test("gates: disabled, single-user mode, missing or suspended user", async () => {
  state.enabled = false;
  assert.equal((await call("GET", "/nytedesk/agents", { user: 1 })).status, 403);
  state.enabled = true;
  state.multiUser = false;
  const r = await call("GET", "/nytedesk/agents", { user: 1 });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /multi-user mode/);
  state.multiUser = true;
  assert.equal((await call("GET", "/nytedesk/agents")).status, 401);
  assert.equal((await call("GET", "/nytedesk/agents", { user: 99 })).status, 401);
  assert.equal((await call("GET", "/nytedesk/agents", { user: 6 })).status, 401);
  const s = await call("GET", "/nytedesk/status", { user: 3 });
  assert.equal(s.status, 200);
  assert.equal(s.body.executionEnabled, false);
});

test("no route can start, run or execute a task", () => {
  for (const r of routes) assert.doesNotMatch(r.pattern, /start|run|exec|succeed|fail/i, r.pattern);
});

test("create needs an idempotency key; a replay returns the same task; key reuse with another body is refused", async () => {
  const body = { description: "Draft release notes", adapter: "ollama", action: ACTIONS.MODEL_PROMPT };
  assert.equal((await call("POST", "/nytedesk/workspaces/alpha/tasks", { user: 3, body })).status, 400);
  const key = newKey();
  const a = await call("POST", "/nytedesk/workspaces/alpha/tasks", { user: 3, key, body });
  assert.equal(a.status, 201);
  assert.match(a.body.task.payloadHash, /^[0-9a-f]{64}$/);
  assert.equal(a.body.task.status, "waiting_approval");
  assert.equal(a.body.task.requesterId, 3);
  const b = await call("POST", "/nytedesk/workspaces/alpha/tasks", { user: 3, key, body });
  assert.equal(b.status, 201);
  assert.equal(b.replayed, true);
  assert.equal(b.body.task.id, a.body.task.id);
  const c = await call("POST", "/nytedesk/workspaces/alpha/tasks", { user: 3, key, body: { ...body, description: "something else" } });
  assert.equal(c.status, 409);
  // the same key used by ANOTHER user is that user's own key, not a replay of user 3's request
  const d = await call("POST", "/nytedesk/workspaces/alpha/tasks", { user: 2, key, body });
  assert.equal(d.status, 201);
  assert.notEqual(d.body.task.id, a.body.task.id);
  assert.equal((await call("POST", "/nytedesk/workspaces/alpha/tasks", { user: 3, key: newKey(), body: { ...body, action: "host.execute" } })).status, 400);
  assert.equal((await call("POST", "/nytedesk/workspaces/alpha/tasks", { user: 3, key: newKey(), body: { ...body, adapter: "shell" } })).status, 400);
});

test("requester identity comes from the session, not the body", async () => {
  const r = await call("POST", "/nytedesk/workspaces/alpha/tasks", {
    user: 3, key: newKey(), body: { description: "x", adapter: "ollama", action: ACTIONS.MODEL_PROMPT, requesterId: 1 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.task.requesterId, 3);
});

test("workspace permissions: no create, view or decide outside accessible workspaces (404)", async () => {
  assert.equal((await call("POST", "/nytedesk/workspaces/beta/tasks", { user: 3, key: newKey(), body: { description: "x", adapter: "ollama", action: ACTIONS.MODEL_PROMPT } })).status, 404);
  const t = await createTask(3);
  assert.equal((await call("GET", `/nytedesk/tasks/${t.id}`, { user: 4 })).status, 404);
  assert.equal((await decide(4, t, "approve")).status, 404);
  const listed = await call("GET", "/nytedesk/tasks", { user: 4 });
  assert.ok(!listed.body.tasks.some((x) => x.id === t.id));
  assert.equal((await call("GET", "/nytedesk/tasks/not-a-uuid", { user: 1 })).status, 404);
});

test("approval roles: no self-approval, defaults cannot decide, admin-only actions", async () => {
  const own = await createTask(2);                                  // a manager's own task
  const self = await decide(2, own, "approve");
  assert.equal(self.status, 403);
  assert.match(self.body.error, /own task/);
  const t = await createTask(3);
  assert.equal((await decide(3, t, "approve")).status, 403);         // requester
  const vm = await createTask(3, { action: ACTIONS.VM_EXEC, description: "Run tests in the VM" });
  const m = await decide(2, vm, "approve");
  assert.equal(m.status, 403);
  assert.match(m.body.error, /administrator/);
  const a = await decide(1, vm, "approve");
  assert.equal(a.status, 200);
  assert.equal(a.body.task.status, "approved");
  assert.equal(a.body.task.approval.by, 1);
  assert.equal(a.body.task.approval.payloadHash, vm.payloadHash);
  assert.ok(a.body.task.approval.expiresAt);
  assert.equal(a.body.task.executionEnabled, false);
});

test("approval binding: the decider must name the reviewed payload hash and current version", async () => {
  const t = await createTask(3);
  const wrongHash = await decide(2, t, "approve", { payloadHash: "f".repeat(64) });
  assert.equal(wrongHash.status, 409);
  assert.match(wrongHash.body.error, /payload/);
  const stale = await decide(2, t, "approve", { expectedVersion: t.version + 1 });
  assert.equal(stale.status, 409);
  const missing = await call("POST", `/nytedesk/tasks/${t.id}/approve`, { user: 2, key: newKey(), body: { expectedVersion: t.version } });
  assert.equal(missing.status, 400);
  assert.equal(store.getTask(t.id).status, "waiting_approval");
});

test("concurrent approve and deny: exactly one decision wins, one decision row", async () => {
  const t = await createTask(3);
  const results = await Promise.all([decide(1, t, "approve"), decide(2, t, "deny"), decide(5, t, "approve")]);
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 409, 409], JSON.stringify(results.map((r) => r.body)));
  const rows = store._db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE task_id = ?").get(t.id);
  assert.equal(Number(rows.n), 1);
  assert.equal(store.verifyAudit(t.id).ok, true);
  assert.equal(store.auditFor(t.id).length, 2);
});

test("decision replay: same key returns the stored result; a new key cannot decide again", async () => {
  const t = await createTask(3);
  const key = newKey();
  const first = await decide(2, t, "approve", {}, key);
  assert.equal(first.status, 200);
  const again = await decide(2, t, "approve", {}, key);
  assert.equal(again.status, 200);
  assert.equal(again.replayed, true);
  assert.equal(again.body.task.approval.decisionId, first.body.task.approval.decisionId);
  const fresh = await decide(2, t, "approve");
  assert.equal(fresh.status, 409);
  const flip = await decide(1, { ...t, version: first.body.task.version }, "deny");
  assert.equal(flip.status, 409);                                    // not awaiting approval
  assert.equal(store.auditFor(t.id).length, 2);
});

test("cancel: requester or manager; others refused; cancelled tasks cannot be approved", async () => {
  const t = await createTask(3);
  const outsiderTask = await createTask(4, {}, "beta");
  assert.equal((await call("POST", `/nytedesk/tasks/${outsiderTask.id}/cancel`, { user: 3, key: newKey(), body: { expectedVersion: 1 } })).status, 404);
  const c = await call("POST", `/nytedesk/tasks/${t.id}/cancel`, { user: 3, key: newKey(), body: { expectedVersion: t.version, reason: "no longer needed" } });
  assert.equal(c.status, 200);
  assert.equal(c.body.task.status, "cancelled");
  assert.equal((await decide(2, c.body.task, "approve")).status, 409);
  const t2 = await createTask(3);
  const otherDefault = { ...USERS[3], id: 7 };                       // a second default member of alpha
  USERS[7] = otherDefault; MEMBERS[7] = [10];
  assert.equal((await call("POST", `/nytedesk/tasks/${t2.id}/cancel`, { user: 7, key: newKey(), body: { expectedVersion: t2.version } })).status, 403);
  assert.equal((await call("POST", `/nytedesk/tasks/${t2.id}/cancel`, { user: 2, key: newKey(), body: { expectedVersion: t2.version } })).status, 200);
});

test("task detail carries the verified hash-chained audit; pending approvals show who may decide", async () => {
  const t = await createTask(3, { action: ACTIONS.GIT_PUSH, description: "Push branch" });
  const d = await call("GET", `/nytedesk/tasks/${t.id}`, { user: 2 });
  assert.equal(d.status, 200);
  assert.equal(d.body.auditVerified, true);
  assert.equal(d.body.audit[0].event, "task.created");
  assert.equal(d.body.canDecide, false);                            // admin-only action
  const p1 = await call("GET", "/nytedesk/approvals", { user: 1 });
  assert.equal(p1.body.approvals.find((x) => x.id === t.id).canDecide, true);
  const p3 = await call("GET", "/nytedesk/approvals", { user: 3 });
  assert.equal(p3.body.approvals.find((x) => x.id === t.id).canDecide, false);
});

test("SQL guards: audit, decisions and task payload cannot be altered; approval binding is immutable", async () => {
  const t = await createTask(3);
  await decide(2, t, "approve");
  const db = store._db;
  assert.throws(() => db.prepare("UPDATE audit SET event = 'x' WHERE task_id = ?").run(t.id), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM audit WHERE task_id = ?").run(t.id), /append-only/);
  assert.throws(() => db.prepare("UPDATE tasks SET action = 'git.merge' WHERE id = ?").run(t.id), /immutable/);
  assert.throws(() => db.prepare("UPDATE tasks SET approval_json = '{}' WHERE id = ?").run(t.id), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM tasks WHERE id = ?").run(t.id), /never deleted/);
  assert.throws(() => db.prepare("UPDATE decisions SET decision = 'deny' WHERE task_id = ?").run(t.id), /immutable/);
});

test("tampering that bypasses the triggers is still detected by the hash chain", async () => {
  const t = await createTask(3);
  const db = store._db;
  db.exec("DROP TRIGGER audit_no_update");
  try {
    db.prepare("UPDATE audit SET detail_json = '{\"adapter\":\"openai\"}' WHERE task_id = ? AND sequence = 1").run(t.id);
    const v = store.verifyAudit(t.id);
    assert.equal(v.ok, false);
    assert.match(v.problems.join(";"), /hash mismatch/);
    const d = await call("GET", `/nytedesk/tasks/${t.id}`, { user: 1 });
    assert.equal(d.body.auditVerified, false);
  } finally {
    db.exec("CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'nytedesk: audit is append-only'); END;");
  }
});

test("execution stays disabled; reauthorization refuses expired approvals", async () => {
  const t = await createTask(3);
  const a = await decide(2, t, "approve");
  const approved = a.body.task;
  assert.throws(() => store.startTask(t.id, USERS[1], { expectedVersion: approved.version }), /not enabled/);
  assert.equal(store.reauthorize(t.id).ok, true);
  // a store whose clock is past the approval expiry
  const later = openStore({ file: store.file, now: () => new Date(Date.parse(approved.approval.expiresAt) + 1000).toISOString() });
  try {
    const r = later.reauthorize(t.id);
    assert.equal(r.ok, false);
    assert.match(r.problems.join(";"), /expired/);
    assert.throws(() => later.startTask(t.id, USERS[1], { expectedVersion: approved.version, executionEnabled: true }), /Reauthorization failed/);
  } finally {
    later.close();
  }
  assert.equal(store.getTask(t.id).status, "approved");
});

test("two connections racing on the same database: compare-and-swap lets only one through", async () => {
  const t = await createTask(3);
  const other = openStore({ file: store.file });
  try {
    const one = store.idempotent(2, newKey(), "h1", () => ({ status: 200, body: store.decideTask(t.id, USERS[2], { decision: "approve", expectedVersion: t.version, payloadHash: t.payloadHash }) }));
    assert.equal(one.status, 200);
    assert.throws(() => other.idempotent(1, newKey(), "h2", () => ({ status: 200, body: other.decideTask(t.id, USERS[1], { decision: "deny", expectedVersion: t.version, payloadHash: t.payloadHash }) })),
      (e) => e.status === 409);
  } finally {
    other.close();
  }
  assert.equal(store.getTask(t.id).status, "approved");
});

test("state survives a restart and its audit still verifies", async () => {
  const t = await createTask(3);
  const reopened = openStore({ file: store.file });
  try {
    assert.equal(reopened.getTask(t.id).payloadHash, t.payloadHash);
    assert.equal(reopened.verifyAudit(t.id).ok, true);
  } finally {
    reopened.close();
  }
});

test("providers: role checks, no stored secrets, local endpoints as IP literals, official cloud origins", async () => {
  assert.equal((await call("GET", "/nytedesk/providers", { user: 3 })).status, 403);
  const list = await call("GET", "/nytedesk/providers", { user: 2 });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.providers.map((p) => p.id), ["ollama", "strata", "anthropic", "openai"]);
  const put = (user, id, body) => call("PUT", `/nytedesk/providers/${id}`, { user, key: newKey(), body });
  assert.equal((await put(2, "ollama", { baseUrl: "http://127.0.0.1:11434", expectedVersion: 0 })).status, 403);
  const secret = await put(1, "openai", { apiKey: "sk-live", expectedVersion: 0 });
  assert.equal(secret.status, 400);
  assert.match(secret.body.error, /never stored/);
  assert.equal((await put(1, "ollama", { baseUrl: "http://localhost:11434", expectedVersion: 0 })).status, 400);
  assert.equal((await put(1, "ollama", { baseUrl: "http://8.8.8.8:11434", expectedVersion: 0 })).status, 400);
  assert.equal((await put(1, "ollama", { baseUrl: "http://user:pw@127.0.0.1:11434", expectedVersion: 0 })).status, 400);
  assert.equal((await put(1, "anthropic", { baseUrl: "https://evil.example", keyEnv: "NYTEDESK_ANTHROPIC_KEY", expectedVersion: 0 })).status, 400);
  assert.equal((await put(1, "anthropic", { model: "claude-x", expectedVersion: 0 })).status, 400);
  assert.equal((await put(1, "openai", { keyEnv: "JWT_SECRET", expectedVersion: 0 })).status, 400);
  const ok = await put(1, "ollama", { baseUrl: "http://10.200.1.30:11434/", model: "qwen3.5:9b", expectedVersion: 0 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.provider.baseUrl, "http://10.200.1.30:11434");
  assert.equal(ok.body.provider.version, 1);
  assert.equal((await put(1, "ollama", { model: "other", expectedVersion: 0 })).status, 409);
  const oa = await put(1, "openai", { baseUrl: "https://api.openai.com/v1", model: "gpt-x", keyEnv: "NYTEDESK_OPENAI_KEY", expectedVersion: 0 });
  assert.equal(oa.status, 200, JSON.stringify(oa.body));
  assert.equal(oa.body.provider.keyPresent, true);
  const all = JSON.stringify((await call("GET", "/nytedesk/providers", { user: 1 })).body);
  assert.ok(!all.includes(env.NYTEDESK_OPENAI_KEY), "a key value must never be returned");
  const agents = await call("GET", "/nytedesk/agents", { user: 3 });
  assert.ok(agents.body.agents.every((a) => a.executionEnabled === false));
  assert.equal(agents.body.agents.find((a) => a.id === "ollama").configured, true);
  assert.equal((await put(1, "shell", { expectedVersion: 0 })).status, 404);
  // the CLI agents run inside the VM; they have no endpoint configuration here
  assert.equal((await put(1, "claude-code", { expectedVersion: 0 })).status, 404);
  assert.equal((await put(1, "codex", { expectedVersion: 0 })).status, 404);
});

test("the task store never touches the AnythingLLM database", () => {
  assert.equal(path.basename(store.file), "nytedesk.db");
  const tables = store._db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ["audit", "decisions", "idempotency", "meta", "providers", "tasks"]);
});

test("supervised mode: agents are listed with roles and can never approve or execute", async () => {
  const s = await call("GET", "/nytedesk/status", { user: 3 });
  assert.equal(s.body.mode, "supervised");
  assert.equal(s.body.agentsMayApprove, false);
  assert.equal(s.body.executionEnabled, false);
  assert.deepEqual(s.body.executionPreconditions.map((p) => p.verified), [false, false, false, false, false]);
  const a = await call("GET", "/nytedesk/agents", { user: 3 });
  const byId = Object.fromEntries(a.body.agents.map((x) => [x.id, x]));
  assert.equal(byId.ollama.role, "coordinator");
  assert.equal(byId.strata.role, "coordinator");
  assert.equal(byId["claude-code"].role, "implementer");
  assert.equal(byId["claude-code"].runtime, "vm-cli");
  assert.equal(byId.codex.role, "reviewer");
  assert.ok(a.body.agents.every((x) => x.mayApprove === false && x.executionEnabled === false));
});

test("protected actions (credentials, privileges, publication) need an administrator", async () => {
  for (const action of [ACTIONS.CREDENTIAL_ACCESS, ACTIONS.PRIVILEGE_CHANGE, ACTIONS.EXTERNAL_PUBLISH]) {
    const t = await createTask(3, { action, adapter: "claude-code", description: `protected ${action}` });
    const m = await decide(2, t, "approve");
    assert.equal(m.status, 403, action);
    const d = await call("GET", `/nytedesk/tasks/${t.id}`, { user: 1 });
    assert.equal(d.body.protected, true);
    assert.equal((await decide(1, t, "approve")).status, 200);
  }
});

test("a task proposed for the coordinator is still decided only by a human session", async () => {
  // The local LLM may recommend work; the request is stored like any other and needs a
  // different human with the right role. There is no agent identity that can decide.
  const t = await createTask(3, { adapter: "ollama", description: "Coordinator plan: delegate review to codex" });
  assert.equal(t.status, "waiting_approval");
  assert.equal((await decide(3, t, "approve")).status, 403);
  assert.equal((await decide(2, t, "approve")).status, 200);
});
