// NyteDesk Local AI Manager: the complete owner workflow, end to end over HTTP, against
// isolated mock engines on loopback. The PolyStrata values below are the owner's
// observed environment, used here as test data only; nothing in the code defaults to
// them. Nothing here contacts a real engine or starts, stops or signals any process.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { makeApp, serve } = require("./nytedesk-harness.cjs");
const { openStore } = require("../../server/utils/nytedesk/store.cjs");
const { createService } = require("../../server/utils/nytedesk/service.cjs");
const { createNyteDeskRoutes } = require("../../server/utils/nytedesk/routes.cjs");

const OBSERVED = { model: "qwen3.6-35b-a3b-ud-q2_k_xl", contextWindow: 32768, vramReserveMiB: 1024 };
const USERS = { 1: { id: 1, role: "admin" }, 2: { id: 2, role: "manager" }, 3: { id: 3, role: "default" } };

let dir, dbFile, polyEngine, ollamaEngine, hostileEngine, api;
const listen = (server, port = 0) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
const modelsServer = (pathName, body) =>
  http.createServer((req, res) => {
    res.writeHead(req.url === pathName ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === pathName ? body : {}));
  });

async function startApi(file) {
  const store = openStore({ file });
  const service = createService(store, { probeOptions: { timeoutMs: 500, maxBytes: 256 * 1024 } });
  const built = makeApp();
  createNyteDeskRoutes(built.app, {
    auth: [async (req, res, next) => (req.header("Authorization") ? next() : res.status(401).json({ error: "no token" }))],
    enabled: () => true,
    isMultiUser: async () => true,
    currentUser: async (req) => USERS[(req.header("Authorization") || "").replace("Bearer u", "")] || null,
    workspaceBySlug: async () => null,
    workspaceById: async () => null,
    accessibleWorkspaces: async () => [],
    service: () => service,
  });
  const server = serve(built.routes);
  await listen(server);
  return { store, server, base: `http://127.0.0.1:${server.address().port}/api` };
}
async function stopApi(a) {
  await new Promise((r) => a.server.close(r));
  a.store.close();
}

let n = 0;
async function call(method, p, { user = 1, body, key } = {}) {
  const headers = { "content-type": "application/json", Authorization: `Bearer u${user}` };
  if (key !== false && method !== "GET") headers["Idempotency-Key"] = key || `wf-${++n}-${Date.now()}`;
  const r = await fetch(api.base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const list = async (user = 3) => (await call("GET", "/nytedesk/engines", { user })).body;
const engine = async (id, user = 3) => (await list(user)).engines.find((e) => e.id === id);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nytedesk-workflow-"));
  dbFile = path.join(dir, "nytedesk.db");
  // Prefer the owner's observed port so the workflow mirrors the real setup; fall back
  // to any free port, since nothing may be assumed about what this machine runs.
  polyEngine = modelsServer("/v1/models", { object: "list", data: [{ id: OBSERVED.model, object: "model" }] });
  try { await listen(polyEngine, 40537); } catch { polyEngine = modelsServer("/v1/models", { data: [{ id: OBSERVED.model }] }); await listen(polyEngine); }
  ollamaEngine = await listen(modelsServer("/api/tags", { models: [{ name: "qwen3:8b" }] }));
  hostileEngine = await listen(modelsServer("/v1/models", {
    data: [
      { id: "ok-model" }, { id: "ok-model" },                      // duplicate
      { id: "x".repeat(300) },                                       // overlong
      { id: "bad\nname" }, { id: "bell\u0007" },                     // control characters
      { id: 42 }, null, {},                                          // not strings
    ],
  }));
  api = await startApi(dbFile);
});

after(async () => {
  if (api) await stopApi(api);
  for (const s of [polyEngine, ollamaEngine, hostileEngine]) if (s?.listening) s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("workflow: register, configure, check, discover, select, persist, then lose the engine", async () => {
  const polyUrl = `http://127.0.0.1:${polyEngine.address().port}/v1`;

  // 1. Registered but unconfigured: no endpoint is guessed, nothing can be selected.
  let poly = await engine("polystrata");
  assert.equal(poly.endpoint, null);
  assert.equal(poly.selectable, false);
  assert.match(poly.selectionBlockedReason, /Set an endpoint/);
  assert.equal(poly.canStart, false);
  assert.equal(poly.canStop, false);

  // 2. Configure (admin) with the observed values.
  const put = await call("PUT", "/nytedesk/engines/polystrata", { body: { endpoint: polyUrl, ...OBSERVED, expectedVersion: 0 } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.engine.endpoint, polyUrl);
  assert.equal(put.body.engine.api, "openai");
  assert.equal(put.body.engine.contextWindow, 32768);
  assert.equal(put.body.engine.vramReserveMiB, 1024);
  assert.equal(put.body.engine.selectable, false);
  assert.match(put.body.engine.selectionBlockedReason, /availability check/);

  // 3. Check health and discover models (manager).
  const chk = await call("POST", "/nytedesk/engines/polystrata/check", { user: 2 });
  assert.equal(chk.status, 200);
  assert.equal(chk.body.check.status, "external");
  assert.equal(chk.body.check.reachable, true);
  assert.deepEqual(chk.body.check.models, [OBSERVED.model]);
  assert.equal(chk.body.check.modelListed, true);
  assert.deepEqual(chk.body.check.diagnostics.map((d) => d.code), ["OK"]);
  assert.equal(typeof chk.body.check.latencyMs, "number");

  // 4. The listing now says it can be selected, and the selection route agrees.
  poly = await engine("polystrata", 1);
  assert.equal(poly.selectable, true);
  assert.equal(poly.selectionBlockedReason, null);
  const sel = await call("PUT", "/nytedesk/engine-selection", { body: { engineId: "polystrata", expectedSelectionId: null } });
  assert.equal(sel.status, 200, JSON.stringify(sel.body));
  assert.equal(sel.body.selection.model, OBSERVED.model);
  assert.equal((await engine("polystrata")).selected, true);

  // 5. Switch away and back with fresh keys: each answered request gets a new key.
  // Point Ollama at its mock first: the built-in default would reach a real local Ollama.
  const ollamaUrl = `http://127.0.0.1:${ollamaEngine.address().port}`;
  const putOllama = await call("PUT", "/nytedesk/engines/ollama", { body: { endpoint: ollamaUrl, expectedVersion: 0 } });
  assert.equal(putOllama.status, 200, JSON.stringify(putOllama.body));
  assert.equal((await call("POST", "/nytedesk/engines/ollama/check", { user: 2 })).body.check.status, "external");
  const toOllama = await call("PUT", "/nytedesk/engine-selection", { body: { engineId: "ollama", expectedSelectionId: sel.body.selection.selectionId } });
  assert.equal(toOllama.status, 200);
  // Reusing an answered key for a different request is refused, never replayed.
  const reused = await call("PUT", "/nytedesk/engine-selection", {
    key: "wf-reused-key-0001",
    body: { engineId: "polystrata", expectedSelectionId: toOllama.body.selection.selectionId },
  });
  assert.equal(reused.status, 200);
  const backAgain = await call("PUT", "/nytedesk/engine-selection", {
    key: "wf-reused-key-0001",
    body: { engineId: "ollama", expectedSelectionId: reused.body.selection.selectionId },
  });
  assert.equal(backAgain.status, 409);
  assert.match(backAgain.body.error, /different request/);
  assert.equal((await list()).selection.engineId, "polystrata");

  // 6. Persistence: a restarted server reads the same configuration, check and selection.
  await stopApi(api);
  api = await startApi(dbFile);
  const after = await list(1);
  poly = after.engines.find((e) => e.id === "polystrata");
  assert.equal(poly.endpoint, polyUrl);
  assert.equal(poly.model, OBSERVED.model);
  assert.equal(poly.contextWindow, 32768);
  assert.equal(poly.vramReserveMiB, 1024);
  assert.equal(poly.lastCheck.status, "external");
  assert.equal(after.selection.engineId, "polystrata");

  // 7. The engine goes away (owned elsewhere): reported, not acted on.
  await new Promise((r) => polyEngine.close(r));
  const down = await call("POST", "/nytedesk/engines/polystrata/check", { user: 2 });
  assert.equal(down.status, 200);
  assert.equal(down.body.check.reachable, false);
  assert.notEqual(down.body.check.status, "external");
  assert.ok(down.body.check.diagnostics.some((d) => d.code === "CONNECTION_REFUSED"), JSON.stringify(down.body.check));
  poly = await engine("polystrata", 1);
  assert.equal(poly.selectable, false);
  assert.equal(after.processControl, false);
  // Reporting an outage never escalates into process control.
  for (const action of ["start", "restart"]) {
    const r = await call("POST", "/nytedesk/engines/polystrata/process", { body: { action } });
    assert.equal(r.status, 403);
  }
});

test("stale and conflicting configuration updates are refused", async () => {
  const cur = await engine("strata", 1);
  const body = (endpoint) => ({ endpoint, api: "openai", model: null, expectedVersion: cur.version });
  const port = ollamaEngine.address().port;
  const [a, b] = await Promise.all([
    call("PUT", "/nytedesk/engines/strata", { body: body(`http://127.0.0.1:${port}/a`) }),
    call("PUT", "/nytedesk/engines/strata", { body: body(`http://127.0.0.1:${port}/b`) }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const stale = await call("PUT", "/nytedesk/engines/strata", { body: body(`http://127.0.0.1:${port}/c`) });
  assert.equal(stale.status, 409);
});

test("hostile model lists are cleaned: short printable names, once each", async () => {
  const cur = await engine("strata", 1);
  const put = await call("PUT", "/nytedesk/engines/strata", {
    body: { endpoint: `http://127.0.0.1:${hostileEngine.address().port}/v1`, api: "openai", model: null, expectedVersion: cur.version },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const chk = await call("POST", "/nytedesk/engines/strata/check", { user: 2 });
  assert.deepEqual(chk.body.check.models, ["ok-model"]);
});

test("a check record without a valid timestamp never makes an engine selectable", async () => {
  const strata = await engine("strata", 1);
  api.store.saveEngineCheck("strata", USERS[1], { ...strata.lastCheck, checkedAt: "not a date" });
  const after = await engine("strata", 1);
  assert.equal(after.selectable, false);
  assert.match(after.selectionBlockedReason, /too old/);
});
