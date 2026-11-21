// NyteDesk dashboard: static checks that need no frontend toolchain. The full Vite build is
// separate (see NYTEDESK_CONTROL_PLANE.md).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ACTIONS, ALLOWED_ADAPTERS } = require("../../server/utils/nytedesk/control-plane.cjs");

const root = path.resolve(__dirname, "../..");
const page = fs.readFileSync(path.join(root, "frontend/src/pages/NyteDesk/index.jsx"), "utf8");
const model = fs.readFileSync(path.join(root, "frontend/src/models/nytedesk.js"), "utf8");
const list = (name) => JSON.parse(page.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`))[1].replace(/,\s*\]/, "]"));

test("dashboard action and adapter lists match the server catalog", () => {
  assert.deepEqual([...list("ACTIONS")].sort(), Object.values(ACTIONS).sort());
  assert.deepEqual([...list("ADAPTERS")].sort(), [...ALLOWED_ADAPTERS].sort());
});

test("every dashboard mutation sends an idempotency key and decisions send the reviewed payload hash", () => {
  for (const fn of ["createTask", "decide", "cancel", "saveProvider"])
    assert.match(model, new RegExp(`${fn}: \\([^)]*key\\)`), fn);
  assert.match(model, /payloadHash: task\.payloadHash/);
  assert.match(model, /expectedVersion: task\.version/);
});

test("the dashboard offers no way to start or execute a task, and never handles API key values", () => {
  assert.doesNotMatch(model, /\/start|\/execute/);
  // The only run call is the gated model control one.
  assert.deepEqual([...model.matchAll(/taskPath\(task, "(\w+)"\)/g)].map((m) => m[1]).filter((op) => op === "run"), ["run"]);
  assert.match(model, /runModelTask: \(task\)/);
  assert.doesNotMatch(page + model, /apiKey|api_key/i);
});

test("the dashboard route and sidebar link are registered", () => {
  assert.match(fs.readFileSync(path.join(root, "frontend/src/main.jsx"), "utf8"), /path: "\/settings\/nytedesk"/);
  assert.match(fs.readFileSync(path.join(root, "frontend/src/utils/paths.js"), "utf8"), /nytedesk: \(\) => "\/settings\/nytedesk"/);
  assert.match(fs.readFileSync(path.join(root, "frontend/src/components/SettingsSidebar/index.jsx"), "utf8"), /paths\.settings\.nytedesk\(\)/);
});

// ------------------------------------------------------------------ Local AI Engines panel
const engines = fs.readFileSync(path.join(root, "frontend/src/pages/NyteDesk/LocalAIEngines.jsx"), "utf8");
const routes = fs.readFileSync(path.join(root, "server/utils/nytedesk/routes.cjs"), "utf8");

test("engine client calls match the server's engine routes and methods", () => {
  const routePaths = [...routes.matchAll(/"(\/nytedesk\/engine[^"]*)"/g)].map((m) => m[1]);
  for (const [method, p] of [
    ["GET", "/nytedesk/engines"],
    ["PUT", "/nytedesk/engines/:id"],
    ["POST", "/nytedesk/engines/:id/check"],
    ["PUT", "/nytedesk/engine-selection"],
  ]) {
    assert.ok(routePaths.includes(p), `server route ${p}`);
    const clientPath = p.replace(":id", "${encodeURIComponent(id)}");
    assert.ok(model.includes(clientPath), `client path ${clientPath}`);
    assert.match(model, new RegExp(`request\\("${method}", (path|"${p.replace(/[/]/g, "\\/")}")`), `${method} ${p}`);
  }
  for (const fn of ["saveEngine", "selectEngine"]) assert.match(model, new RegExp(`${fn}: \\([^)]*key\\)`), fn);
});

test("the engines panel offers no process control and never calls the process route", () => {
  assert.doesNotMatch(model + engines, /\/process|processAction/);
  assert.doesNotMatch(engines, />\s*(Start|Stop|Restart|Unload|Kill)\s*</i);
  assert.match(engines, /externally owned · start\/stop disabled/);
});

test("the engines panel explains state, permissions and why selection is blocked", () => {
  for (const label of ["reachable", "unreachable", "not checked", "not configured"]) assert.ok(engines.includes(`"${label}"`), label);
  assert.match(engines, /ROLE_NOTE\[role\] \|\| ROLE_NOTE\.default/);
  assert.match(engines, /engine\.selectionBlockedReason/);
  assert.match(engines, /isAdmin && engine\.selectable && !selected/);          // server decides selectability
  assert.match(engines, /could not reach it/);                                  // selected but down
  assert.match(engines, /\$\{d\.code\}: \$\{d\.message\}/);                       // coded diagnostics shown
});

test("engine forms submit once and use a fresh idempotency key per answered request", () => {
  assert.match(engines, /type="submit"/);
  assert.doesNotMatch(engines, /<CTAButton onClick=\{save\}>/);                 // CTAButton drops the event
  assert.equal((engines.match(/if \(r\.status !== 0\) set\w*Key\(NyteDesk\.newIdempotencyKey\(\)\)/g) || []).length, 2);
});
