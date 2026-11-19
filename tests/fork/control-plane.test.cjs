const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTask, transition, ACTIONS, STATES, listAdapters, payloadHash } =
  require("../../server/utils/nytedesk/control-plane.cjs");

const now = () => "2026-11-19T12:00:00.000Z";
const uuid = () => "test-task";
const base = {
  workspaceId: "workspace-1", requesterId: "developer", description: "Review this change",
  adapter: "ollama", action: ACTIONS.VM_EXEC,
};
const make = (fields = {}) => createTask({ ...base, ...fields }, { now, uuid });
function change(task, operation, actorId = "reviewer", extra = {}) {
  return transition(task, {
    operation, actorId, expectedSequence: task.nextSequence, approvedPayloadHash: task.payloadHash, ...extra,
  }, { now });
}

test("new tasks are immutable, auditable and gated regardless of action", () => {
  for (const action of Object.values(ACTIONS)) {
    const task = make({ action });
    assert.equal(task.status, STATES.WAITING);
    assert.equal(task.risk, "approval");
    assert.equal(task.audit[0].sequence, 1);
    assert.ok(Object.isFrozen(task));
    assert.ok(Object.isFrozen(task.audit));
    assert.ok(Object.isFrozen(task.audit[0]));
  }
});

test("unknown actions and adapters fail closed", () => {
  assert.throws(() => make({ action: "host.execute" }), /Unsupported action/);
  assert.throws(() => make({ adapter: "arbitrary" }), /Unsupported adapter/);
  assert.throws(() => make({ workspaceId: "" }), /workspaceId/);
  assert.throws(() => make({ description: "x".repeat(4001) }), /description/);
});

test("requester cannot approve their own task and approval requires decision id", () => {
  const task = make();
  assert.throws(() => change(task, "approve", "developer", { decisionId: "1" }), /self-approve/);
  assert.throws(() => change(task, "approve"), /decisionId/);
  assert.equal(task.status, STATES.WAITING);
});

test("approval, execution and successful completion preserve linear audit", () => {
  const pending = make();
  const approved = change(pending, "approve", "reviewer", { decisionId: "approval-1" });
  assert.equal(approved.status, STATES.APPROVED);
  assert.equal(pending.status, STATES.WAITING);
  assert.equal(approved.approval.by, "reviewer");
  const running = change(approved, "start", "runner");
  const done = change(running, "succeed", "runner");
  assert.equal(done.status, STATES.SUCCEEDED);
  assert.deepEqual(done.audit.map(x => x.event), [
    "task.created", "task.approve", "task.start", "task.succeed"
  ]);
  assert.deepEqual(done.audit.map(x => x.sequence), [1, 2, 3, 4]);
  assert.throws(() => change(done, "start", "runner"), /not approved/);
});

test("stale version and bypass attempts are rejected", () => {
  const task = make();
  assert.throws(() => change(task, "start", "runner"), /not approved/);
  assert.throws(() => change(task, "succeed", "runner"), /not running/);
  assert.throws(() => transition(task, {
    operation: "approve", actorId: "reviewer", decisionId: "1", expectedSequence: 1,
    approvedPayloadHash: task.payloadHash,
  }, { now }), /Stale task version/);
});

test("denied and cancelled tasks cannot be executed or resurrected", () => {
  const denied = change(make(), "deny", "reviewer", { decisionId: "denial-1" });
  assert.equal(denied.status, STATES.DENIED);
  assert.throws(() => change(denied, "start", "runner"), /not approved/);
  assert.throws(() => change(denied, "approve", "reviewer", { decisionId: "1" }), /not awaiting/);
  const cancelled = change(make(), "cancel", "developer");
  assert.equal(cancelled.status, STATES.CANCELLED);
  assert.throws(() => change(cancelled, "approve", "reviewer", { decisionId: "1" }), /not awaiting/);
});

test("adapter catalog is planning only and carries no live credentials", () => {
  assert.deepEqual(listAdapters().map(a => a.id), ["anthropic", "openai", "ollama", "strata"]);
  assert.ok(listAdapters().every(a => !a.executionEnabled && !a.configured));
});

test("approval is bound to the exact payload the decider reviewed", () => {
  const task = make();
  assert.match(task.payloadHash, /^[0-9a-f]{64}$/);
  assert.equal(task.payloadHash, payloadHash(task));
  assert.throws(() => change(task, "approve", "reviewer", { decisionId: "1", approvedPayloadHash: "0".repeat(64) }),
    /does not match the task payload/);
  assert.throws(() => change(task, "approve", "reviewer", { decisionId: "1", approvedPayloadHash: undefined }),
    /does not match the task payload/);
  const approved = change(task, "approve", "reviewer", { decisionId: "1" });
  assert.equal(approved.approval.payloadHash, task.payloadHash);
});

test("a task object whose payload was altered after creation is rejected", () => {
  const task = structuredClone(make());
  task.action = ACTIONS.GIT_MERGE;            // swap the reviewed action for another one
  assert.throws(() => change(task, "approve", "reviewer", { decisionId: "1" }), /recorded hash/);
  const approved = structuredClone(change(make(), "approve", "reviewer", { decisionId: "1" }));
  approved.description = "something else";
  assert.throws(() => change(approved, "start", "runner"), /recorded hash/);
});

test("audit history is never truncated silently", () => {
  let task = make();
  const raw = structuredClone(task);
  raw.audit = Array.from({ length: 128 }, (_, i) => ({ sequence: i + 1, event: "x", actor: "a", at: "t" }));
  raw.nextSequence = 129;
  assert.throws(() => change(raw, "cancel", "developer"), /audit capacity/);
});
