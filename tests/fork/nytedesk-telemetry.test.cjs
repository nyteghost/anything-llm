// NyteDesk dashboard backend: system component catalog and read-only telemetry.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { makeApp, serve } = require("./nytedesk-harness.cjs");
const cp = require("../../server/utils/nytedesk/control-plane.cjs");
const { createTelemetry } = require("../../server/utils/nytedesk/telemetry.cjs");
const { openStore } = require("../../server/utils/nytedesk/store.cjs");
const { createService } = require("../../server/utils/nytedesk/service.cjs");
const { createNyteDeskRoutes } = require("../../server/utils/nytedesk/routes.cjs");

const root = path.resolve(__dirname, "../..");

test("components: engines are not agents; nothing may approve or execute", () => {
  const byId = Object.fromEntries(cp.COMPONENTS.map((c) => [c.id, c]));
  for (const id of ["polystrata", "strata", "ollama"]) assert.equal(byId[id].kind, "engine", id);
  assert.equal(byId.coordinator.kind, "agent");
  assert.equal(byId.coordinator.role, "coordinator");
  assert.equal(byId["claude-code"].role, "implementer");
  assert.equal(byId.codex.role, "reviewer");
  assert.equal(byId.agentbridge.kind, "orchestrator");
  for (const c of cp.COMPONENTS) {
    assert.equal(c.mayApprove, false, c.id);
    assert.equal(c.executionEnabled, false, c.id);
  }
  assert.ok(Object.isFrozen(cp.COMPONENTS));
});

test("telemetry: CPU needs two samples; memory and freshness are real values", () => {
  let t = 1_700_000_000_000;
  let idle = 100;
  let busy = 100;
  const tel = createTelemetry({
    now: () => t,
    cpus: () => [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }, { times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }],
    totalmem: () => 32 * 2 ** 30,
    freemem: () => 12 * 2 ** 30,
  });
  const first = tel.sample();
  assert.equal(first.host.cpuPercent, null);
  assert.match(first.host.cpuReason, /second sample/);
  assert.equal(first.host.cpuCount, 2);
  assert.equal(first.host.memoryUsedBytes, 20 * 2 ** 30);
  assert.equal(first.host.memoryTotalBytes, 32 * 2 ** 30);
  assert.equal(first.sampledAt, new Date(t).toISOString());
  t += 10_000; busy += 30; idle += 70;                       // 30% busy over the interval
  const second = tel.sample({ engine: { engineId: "polystrata", model: "m", contextWindow: 32768 } });
  assert.equal(second.host.cpuPercent, 30);
  assert.equal(second.host.cpuReason, null);
  assert.equal(second.inference.engineId, "polystrata");
  assert.equal(second.inference.contextWindow, 32768);
});

test("telemetry: unmeasured values are null with a reason, never estimated", () => {
  const s = createTelemetry().sample();
  assert.equal(s.gpu.available, false);
  for (const k of ["utilizationPercent", "vramUsedBytes", "vramTotalBytes", "temperatureC"]) assert.equal(s.gpu[k], null, k);
  assert.match(s.gpu.reason, /does not run nvidia-smi/);
  assert.equal(s.inference.available, false);
  assert.equal(s.inference.tokensPerSecond, null);
  assert.equal(s.inference.contextUsedTokens, null);
  assert.ok(s.inference.reason.length > 0);
});

test("telemetry reads Node counters only: no processes, shell, files or network", () => {
  const src = fs.readFileSync(path.join(root, "server/utils/nytedesk/telemetry.cjs"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const code = src.replace(/"(?:[^"\\]|\\.)*"/g, (m) => (m.startsWith('"node:') ? m : '""')); // ignore message text
  assert.doesNotMatch(code, /child_process|exec|spawn|nvidia|fetch\(|process\.binding/);
  assert.deepEqual([...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]), ["node:os"]);
});

// ------------------------------------------------------------------ HTTP
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nytedesk-telemetry-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const ROLE_BY_TOKEN = { "Bearer admin": "admin", "Bearer manager": "manager", "Bearer user": "default" };

async function start({ multiUser = true, enabled = true } = {}) {
  const store = openStore({ file: path.join(dir, `db-${Math.random()}.db`) });
  const service = createService(store);
  const built = makeApp();
  createNyteDeskRoutes(built.app, {
    auth: [async (req, res, next) => (req.header("Authorization") ? next() : res.status(401).json({ error: "no token" }))],
    enabled: () => enabled,
    isMultiUser: async () => multiUser,
    currentUser: async (req) => {
      const role = ROLE_BY_TOKEN[req.header("Authorization")];
      return role ? { id: { admin: 1, manager: 2, default: 3 }[role], role } : null;
    },
    workspaceBySlug: async () => null,
    workspaceById: async () => null,
    accessibleWorkspaces: async () => [],
    service: () => service,
  });
  const server = serve(built.routes);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { base, close: () => new Promise((r) => { server.close(r); store.close(); }) };
}

test("telemetry: managers and admins only (server-side), gated, no caching", async () => {
  const on = await start();
  const get = (auth) => fetch(`${on.base}/nytedesk/telemetry`, auth ? { headers: { Authorization: auth } } : {});
  try {
    assert.equal((await get()).status, 401);
    const denied = await get("Bearer user");
    assert.equal(denied.status, 403);
    const body = await denied.json();
    assert.match(body.error, /managers and administrators/);
    assert.equal(body.telemetry, undefined);                       // nothing leaks with the refusal
    for (const auth of ["Bearer manager", "Bearer admin"]) {
      const r = await get(auth);
      assert.equal(r.status, 200, auth);
      assert.equal(r.headers.get("cache-control"), "no-store");
      const { telemetry } = await r.json();
      assert.equal(telemetry.source, "nytedesk-server-host");
      assert.equal(telemetry.gpu.available, false);
    }
    // The role catalog stays readable by every signed-in user.
    const a = await (await fetch(`${on.base}/nytedesk/agents`, { headers: { Authorization: "Bearer user" } })).json();
    assert.equal(a.components.find((c) => c.id === "polystrata").kind, "engine");
    assert.ok(Array.isArray(a.agents));
  } finally { await on.close(); }
  for (const opts of [{ multiUser: false }, { enabled: false }]) {
    const off = await start(opts);
    try {
      const r = await fetch(`${off.base}/nytedesk/telemetry`, { headers: { Authorization: "Bearer admin" } });
      assert.equal(r.status, 403, JSON.stringify(opts));
    } finally { await off.close(); }
  }
});
