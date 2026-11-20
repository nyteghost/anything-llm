// NyteDesk Local AI Manager: integration tests over real HTTP against the real routes,
// service, SQLite store and engine probe, with fake engines on loopback ports.
// Nothing here starts, stops or signals any process.
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
const lam = require("../../server/utils/nytedesk/local-ai-manager.cjs");

const USERS = {
  1: { id: 1, role: "admin" },
  2: { id: 2, role: "manager" },
  3: { id: 3, role: "default" },
};
const WORKSPACES = [{ id: 10, slug: "alpha", name: "Alpha" }];
const state = { multiUser: true };
const POLY_MODEL = "qwen3.6-35b-a3b-ud-q2_k_xl";

// ------------------------------------------------------------------ fake engines
const requests = [];
function fake(handler) {
  const server = http.createServer((req, res) => {
    requests.push({ port: server.address().port, method: req.method, url: req.url });
    handler(req, res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const engines = {};
let dir, store, server, base, freePort;

before(async () => {
  engines.ollama = await fake((req, res) =>
    req.url === "/api/tags" ? json(res, 200, { models: [{ name: "qwen3:8b" }, { model: "llama3.2:3b" }] }) : json(res, 404, {}));
  engines.poly = await fake((req, res) =>
    req.url === "/v1/models" ? json(res, 200, { object: "list", data: [{ id: POLY_MODEL }] }) : json(res, 404, {}));
  engines.poly2 = await fake((req, res) =>
    req.url === "/v1/models" ? json(res, 200, { data: [{ id: POLY_MODEL }] }) : json(res, 404, {}));
  engines.target = await fake((_req, res) => json(res, 200, { data: [{ id: "redirected" }] }));
  engines.redirect = await fake((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${engines.target.address().port}/v1/models` });
    res.end();
  });
  engines.slow = await fake(() => {});                                  // never answers
  engines.error = await fake((_req, res) => json(res, 500, { error: "boom" }));
  engines.badjson = await fake((_req, res) => json(res, 200, "{not json"));
  engines.shape = await fake((_req, res) => json(res, 200, { models: [{ name: "x" }] })); // ollama shape on an openai API
  engines.big = await fake((_req, res) => json(res, 200, { data: Array.from({ length: 5000 }, (_, i) => ({ id: `m-${i}-${"x".repeat(40)}` })) }));
  engines.empty = await fake((_req, res) => json(res, 200, { data: [] }));
  const tmp = await fake(() => {});
  freePort = tmp.address().port;
  await new Promise((r) => tmp.close(r));                               // a port nothing listens on

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nytedesk-engines-"));
  store = openStore({ file: path.join(dir, "nytedesk.db") });
  const service = createService(store, { probeOptions: { timeoutMs: 400, maxBytes: 64 * 1024 } });
  const built = makeApp();
  createNyteDeskRoutes(built.app, {
    auth: [async (req, res, next) => (req.header("Authorization") ? next() : res.status(401).json({ error: "no token" }))],
    enabled: () => true,
    isMultiUser: async () => state.multiUser,
    currentUser: async (req) => USERS[(req.header("Authorization") || "").replace("Bearer u", "")] || null,
    workspaceBySlug: async (_u, slug) => WORKSPACES.find((w) => w.slug === slug) || null,
    workspaceById: async (_u, id) => WORKSPACES.find((w) => w.id === Number(id)) || null,
    accessibleWorkspaces: async () => WORKSPACES,
    service: () => service,
  });
  server = serve(built.routes);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  for (const s of Object.values(engines)) s.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const newKey = () => `engine-key-${++n}-${Date.now()}`;
async function call(method, p, { user, body, key } = {}) {
  const headers = { "content-type": "application/json" };
  if (user) headers.Authorization = `Bearer u${user}`;
  if (key) headers["Idempotency-Key"] = key;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), replayed: r.headers.get("idempotent-replayed") === "true" };
}
const port = (s) => s.address().port;
const url = (s, suffix = "") => `http://127.0.0.1:${port(s)}${suffix}`;
async function engineState(id) {
  const r = await call("GET", "/nytedesk/engines", { user: 3 });
  return r.body.engines.find((e) => e.id === id);
}
async function configure(id, fields) {
  const cur = await engineState(id);
  const r = await call("PUT", `/nytedesk/engines/${id}`, { user: 1, key: newKey(), body: { expectedVersion: cur.version, ...fields } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.engine;
}
const check = (id, user = 2) => call("POST", `/nytedesk/engines/${id}/check`, { user });
const codes = (r) => r.body.check.diagnostics.map((d) => d.code);

// ------------------------------------------------------------------ tests
test("registry: Ollama, Strata and PolyStrata; only Ollama has a default endpoint; all externally owned", async () => {
  const r = await call("GET", "/nytedesk/engines", { user: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.engines.map((e) => e.id), ["ollama", "strata", "polystrata"]);
  const byId = Object.fromEntries(r.body.engines.map((e) => [e.id, e]));
  assert.equal(byId.ollama.endpoint, "http://127.0.0.1:11434");
  assert.equal(byId.ollama.endpointIsDefault, true);
  assert.equal(byId.polystrata.endpoint, null);            // the session port is never assumed
  assert.equal(byId.polystrata.api, "openai");
  assert.equal(byId.strata.endpoint, null);                // no invented endpoint
  assert.equal(byId.strata.api, null);
  for (const e of r.body.engines) {
    assert.equal(e.ownership, "external");
    assert.equal(e.canStart, false);
    assert.equal(e.canStop, false);
  }
  assert.equal(r.body.processControl, false);
  const s = await call("GET", "/nytedesk/status", { user: 3 });
  assert.equal(s.body.engineProcessControl, false);
});

test("configuration: admins only, versioned, idempotent; managers and defaults refused", async () => {
  const body = { endpoint: url(engines.poly, "/v1"), model: POLY_MODEL, contextWindow: 32768, vramReserveMiB: 1024, expectedVersion: 0 };
  assert.equal((await call("PUT", "/nytedesk/engines/polystrata", { user: 3, key: newKey(), body })).status, 403);
  assert.equal((await call("PUT", "/nytedesk/engines/polystrata", { user: 2, key: newKey(), body })).status, 403);
  assert.equal((await call("PUT", "/nytedesk/engines/polystrata", { user: 1, body })).status, 400); // no idempotency key
  const key = newKey();
  const a = await call("PUT", "/nytedesk/engines/polystrata", { user: 1, key, body });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.engine.endpoint, url(engines.poly, "/v1"));
  assert.equal(a.body.engine.contextWindow, 32768);
  assert.equal(a.body.engine.vramReserveMiB, 1024);
  assert.equal(a.body.engine.version, 1);
  const again = await call("PUT", "/nytedesk/engines/polystrata", { user: 1, key, body });
  assert.equal(again.replayed, true);
  assert.equal((await call("PUT", "/nytedesk/engines/polystrata", { user: 1, key: newKey(), body })).status, 409); // stale version 0
  assert.equal((await call("PUT", "/nytedesk/engines/polystrata", { user: 1, key: newKey(), body: { ...body, expectedVersion: 1, apiKey: "x" } })).status, 400);
  assert.equal((await call("PUT", "/nytedesk/engines/polystrata", { user: 1, key: newKey(), body: { ...body, expectedVersion: 1, command: "rm -rf /" } })).status, 400);
  assert.equal((await call("PUT", "/nytedesk/engines/polystrata", { user: 1, key: newKey(), body: { ...body, expectedVersion: 1, api: "ollama" } })).status, 400);
  assert.equal((await call("PUT", "/nytedesk/engines/polystrata", { user: 1, key: newKey(), body: { ...body, expectedVersion: 1, contextWindow: 10 } })).status, 400);
  assert.equal((await call("PUT", "/nytedesk/engines/llamacpp", { user: 1, key: newKey(), body })).status, 404);
});

test("invalid endpoints are refused: names, LAN, TLS, privileged ports, credentials, queries, dot segments", async () => {
  const bad = [
    "http://localhost:40537/v1", "http://192.168.1.10:40537/v1", "http://10.200.1.30:11434", "https://127.0.0.1:40537/v1",
    "http://127.0.0.1:80/v1", "http://127.0.0.1/v1", "http://user:pw@127.0.0.1:40537/v1", "http://127.0.0.1:40537/v1?x=1",
    "http://127.0.0.1:40537/v1#a", "http://127.0.0.1:40537/../admin", "file:///run/ollama.sock", "not a url",
  ];
  const cur = await engineState("strata");
  for (const endpoint of bad) {
    const r = await call("PUT", "/nytedesk/engines/strata", { user: 1, key: newKey(), body: { endpoint, api: "openai", expectedVersion: cur.version } });
    assert.equal(r.status, 400, endpoint);
  }
  const strataApi = await call("PUT", "/nytedesk/engines/strata", { user: 1, key: newKey(), body: { api: "llamacpp", expectedVersion: cur.version } });
  assert.equal(strataApi.status, 400);
});

test("checks: managers and admins only; Ollama and PolyStrata report their models", async () => {
  await configure("ollama", { endpoint: url(engines.ollama) });
  assert.equal((await check("ollama", 3)).status, 403);
  const o = await check("ollama");
  assert.equal(o.status, 200);
  assert.equal(o.body.check.status, "external");
  assert.deepEqual(o.body.check.models, ["qwen3:8b", "llama3.2:3b"]);
  assert.deepEqual(codes(o), ["OK"]);
  assert.equal(o.body.check.canStop, false);
  const p = await check("polystrata", 1);
  assert.equal(p.body.check.status, "external");
  assert.equal(p.body.check.modelListed, true);
  assert.deepEqual(p.body.check.models, [POLY_MODEL]);
  const listed = await engineState("polystrata");
  assert.equal(listed.lastCheck.status, "external");
  assert.equal(listed.lastCheck.checkedBy, 1);
});

test("diagnostics: refused, timeout, HTTP error, invalid JSON, wrong shape, too large, empty, model not listed", async () => {
  const cases = [
    [`http://127.0.0.1:${freePort}/v1`, "stopped", "CONNECTION_REFUSED"],
    [url(engines.slow, "/v1"), "stopped", "TIMEOUT"],
    [url(engines.error, "/v1"), "failed", "HTTP_ERROR"],
    [url(engines.badjson, "/v1"), "failed", "INVALID_JSON"],
    [url(engines.shape, "/v1"), "failed", "UNEXPECTED_SHAPE"],
    [url(engines.big, "/v1"), "failed", "RESPONSE_TOO_LARGE"],
    [url(engines.empty, "/v1"), "external", "NO_MODELS"],
  ];
  for (const [endpoint, status, code] of cases) {
    await configure("strata", { endpoint, api: "openai", model: null });
    const r = await check("strata");
    assert.equal(r.body.check.status, status, endpoint);
    assert.ok(codes(r).includes(code), `${endpoint}: ${codes(r)}`);
    assert.ok(r.body.check.diagnostics.every((d) => typeof d.message === "string" && d.message.length > 0));
  }
  await configure("strata", { endpoint: url(engines.poly, "/v1"), api: "openai", model: "not-loaded" });
  const r = await check("strata");
  assert.equal(r.body.check.modelListed, false);
  assert.ok(codes(r).includes("MODEL_NOT_LISTED"));
});

test("redirects are never followed", async () => {
  await configure("strata", { endpoint: url(engines.redirect, "/v1"), api: "openai", model: null });
  const before = requests.filter((q) => q.port === port(engines.target)).length;
  const r = await check("strata");
  assert.equal(r.body.check.status, "failed");
  assert.ok(codes(r).includes("REDIRECT_REFUSED"));
  assert.equal(requests.filter((q) => q.port === port(engines.target)).length, before);
});

test("an unconfigured engine reports why instead of guessing an endpoint", async () => {
  const fresh = createService(openStore({ file: ":memory:" }));
  const r = await fresh.checkEngine(USERS[2], "polystrata");
  assert.equal(r.status, "unknown");
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["NOT_CONFIGURED"]);
  await assert.rejects(fresh.checkEngine(USERS[2], "vllm"), (e) => e.status === 404);
});

test("selection: admin only, needs a fresh healthy check of the same endpoint, and a listed model", async () => {
  const sel = (user, body) => call("PUT", "/nytedesk/engine-selection", { user, key: newKey(), body });
  assert.equal((await sel(2, { engineId: "polystrata" })).status, 403);
  // PolyStrata's port changes: the old check no longer covers the new endpoint
  await configure("polystrata", { endpoint: url(engines.poly2, "/v1"), model: POLY_MODEL });
  const stale = await sel(1, { engineId: "polystrata" });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /endpoint changed|check/);
  await check("polystrata");
  const ok = await sel(1, { engineId: "polystrata" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.selection.endpoint, url(engines.poly2, "/v1"));
  assert.equal(ok.body.selection.model, POLY_MODEL);
  // concurrent change: the expected selection id must match the current one
  assert.equal((await sel(1, { engineId: "ollama" })).status, 409);
  await check("ollama");
  const swap = await sel(1, { engineId: "ollama", expectedSelectionId: ok.body.selection.selectionId });
  assert.equal(swap.status, 200);
  // an engine whose last check failed cannot be selected
  await configure("strata", { endpoint: `http://127.0.0.1:${freePort}/v1`, api: "openai", model: null });
  await check("strata");
  assert.equal((await sel(1, { engineId: "strata", expectedSelectionId: swap.body.selection.selectionId })).status, 409);
  // a check older than 15 minutes is too old
  const old = { ...(await engineState("polystrata")).lastCheck, checkedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() };
  store.saveEngineCheck("polystrata", USERS[1], old);
  const tooOld = await sel(1, { engineId: "polystrata", expectedSelectionId: swap.body.selection.selectionId });
  assert.equal(tooOld.status, 409);
  assert.match(tooOld.body.error, /too old/);
});

test("process control is always refused, for every role and action", async () => {
  for (const user of [1, 2, 3]) {
    for (const action of ["start", "stop", "restart", "unload", "kill"]) {
      const r = await call("POST", "/nytedesk/engines/ollama/process", { user, key: newKey(), body: { action } });
      assert.equal(r.status, 403, `${user} ${action}`);
      assert.match(r.body.error, /never starts, stops, restarts, unloads or kills/);
    }
  }
  assert.equal((await call("POST", "/nytedesk/engines/unknown/process", { user: 1, body: { action: "stop" } })).status, 404);
  assert.throws(() => lam.requestProcessAction("stop", { id: "ollama" }), /disabled/);
});

test("the manager never controls processes: no child_process, no signals, GET-only probes to the models path", () => {
  const raw = fs.readFileSync(path.join(__dirname, "../../server/utils/nytedesk/local-ai-manager.cjs"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");   // comments describe what is NOT done
  assert.doesNotMatch(code, /child_process|process\.kill|\.kill\(|spawn|execFile|pkill|killall|\/proc\//);
  const engineRequests = requests.filter((q) => q.port !== port(engines.target) || q.method !== "GET");
  assert.ok(engineRequests.length > 0);
  for (const q of engineRequests) {
    assert.equal(q.method, "GET");
    assert.ok(["/api/tags", "/v1/models"].includes(q.url), q.url);
  }
  // the fake "engines" are all still running: nothing was stopped
  for (const s of Object.values(engines)) assert.equal(s.listening, true);
});

test("engine routes need multi-user mode and an authenticated user", async () => {
  assert.equal((await call("GET", "/nytedesk/engines")).status, 401);
  state.multiUser = false;
  assert.equal((await call("GET", "/nytedesk/engines", { user: 1 })).status, 403);
  state.multiUser = true;
});
