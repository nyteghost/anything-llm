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
  assert.doesNotMatch(model, /\/start|\/execute|\/run\b/);
  assert.doesNotMatch(page + model, /apiKey|api_key/i);
});

test("the dashboard route and sidebar link are registered", () => {
  assert.match(fs.readFileSync(path.join(root, "frontend/src/main.jsx"), "utf8"), /path: "\/settings\/nytedesk"/);
  assert.match(fs.readFileSync(path.join(root, "frontend/src/utils/paths.js"), "utf8"), /nytedesk: \(\) => "\/settings\/nytedesk"/);
  assert.match(fs.readFileSync(path.join(root, "frontend/src/components/SettingsSidebar/index.jsx"), "utf8"), /paths\.settings\.nytedesk\(\)/);
});
