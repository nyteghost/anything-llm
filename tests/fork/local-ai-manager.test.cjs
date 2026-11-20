const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ENGINES, STATUSES, parseLoopbackEndpoint,
  registerEngine, observeEngine, selectEngine, requestProcessAction,
} = require("../../server/utils/nytedesk/local-ai-manager.cjs");

test("built-in choices include Ollama, Strata, and PolyStrata", () => {
  assert.deepEqual(Object.keys(ENGINES), ["ollama", "strata", "polystrata"]);
  assert.equal(ENGINES.ollama.defaultPort, 11434);
});

test("local endpoint accepts explicit unprivileged loopback only", () => {
  assert.equal(parseLoopbackEndpoint("http://127.0.0.1:40537/v1"), "http://127.0.0.1:40537/v1");
  for (const input of [
    "http://localhost:40537/v1", "https://127.0.0.1:40537/v1",
    "http://192.168.1.1:40537/v1", "http://127.0.0.1:80/",
    "http://127.0.0.1:40537/v1?token=a", "http://user:pass@127.0.0.1:40537/v1",
    "http://127.0.0.1:40537/v1#section", "file:///tmp/socket",
  ]) assert.throws(() => parseLoopbackEndpoint(input), /loopback/);
});

test("registering an engine never authorizes process control", () => {
  const entry = registerEngine({ id: "polystrata", endpoint: "http://127.0.0.1:40537/v1" });
  assert.equal(entry.status, STATUSES.UNKNOWN);
  assert.equal(entry.canStop, false);
  assert.equal(entry.canStart, false);
  assert.equal(entry.managedProcess, null);
  assert.ok(Object.isFrozen(entry));
  assert.throws(() => registerEngine({
    id: "polystrata", endpoint: "http://127.0.0.1:40537/v1", managed: true
  }), /not enabled/);
  assert.throws(() => registerEngine({ id: "custom", endpoint: "http://127.0.0.1:40537" }), /Unknown/);
});

test("healthy external process may be selected but never stopped", () => {
  const external = observeEngine(registerEngine({
    id: "polystrata", endpoint: "http://127.0.0.1:40537/v1"
  }), { healthy: true });
  assert.equal(external.status, STATUSES.EXTERNAL);
  assert.deepEqual(selectEngine({ polystrata: external }, "polystrata"), {
    selected: "polystrata", endpoint: "http://127.0.0.1:40537/v1",
  });
  assert.equal(external.canStop, false);
  assert.throws(() => requestProcessAction("stop", external), /disabled/);
});

test("unhealthy and unknown services cannot be selected", () => {
  const unknown = registerEngine({ id: "ollama", endpoint: "http://127.0.0.1:11434" });
  assert.throws(() => selectEngine({ ollama: unknown }, "ollama"), /not verified/);
  const stopped = observeEngine(unknown, { healthy: false });
  assert.equal(stopped.status, STATUSES.STOPPED);
  assert.throws(() => selectEngine({ ollama: stopped }, "ollama"), /not verified/);
  assert.throws(() => observeEngine(unknown, { healthy: "yes" }), /boolean/);
});
