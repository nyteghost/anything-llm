"use strict";

/**
 * NyteDesk Phase 1 control-plane primitives.
 * No shell, browser, model, network or filesystem execution is exposed here.
 * Callers must enforce authentication, workspace authorization, persistence,
 * and transaction isolation before exposing these primitives via HTTP.
 */
const crypto = require("node:crypto");

const STATES = Object.freeze({
  QUEUED: "queued",
  WAITING: "waiting_approval",
  APPROVED: "approved",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  DENIED: "denied",
  CANCELLED: "cancelled",
});

const ACTIONS = Object.freeze({
  MODEL_PROMPT: "model.prompt",
  REPO_READ: "repository.read",
  VM_READ: "vm.read",
  VM_WRITE: "vm.write",
  VM_EXEC: "vm.execute",
  BROWSER_READ: "browser.read",
  BROWSER_INTERACT: "browser.interact",
  GIT_PUSH: "git.push",
  GIT_MERGE: "git.merge",
});

const RISK = Object.freeze({
  [ACTIONS.MODEL_PROMPT]: "approval",
  [ACTIONS.REPO_READ]: "approval",
  [ACTIONS.VM_READ]: "approval",
  [ACTIONS.VM_WRITE]: "approval",
  [ACTIONS.VM_EXEC]: "approval",
  [ACTIONS.BROWSER_READ]: "approval",
  [ACTIONS.BROWSER_INTERACT]: "approval",
  [ACTIONS.GIT_PUSH]: "approval",
  [ACTIONS.GIT_MERGE]: "approval",
});

// All actions start gated. Future policy releases may explicitly downgrade
// carefully scoped read-only operations, but not executable operations.
const ALLOWED_ADAPTERS = Object.freeze(["anthropic", "openai", "ollama", "strata"]);
// Actions whose approval needs an administrator (not only a manager): they change
// state outside the conversation, publish, or execute.
const ADMIN_APPROVAL_ACTIONS = Object.freeze([
  ACTIONS.VM_WRITE, ACTIONS.VM_EXEC, ACTIONS.BROWSER_INTERACT, ACTIONS.GIT_PUSH, ACTIONS.GIT_MERGE,
]);
const MAX_DESCRIPTION = 4000;
// Never silently drop audit history: a task that would exceed this is rejected.
const MAX_AUDIT_EVENTS = 128;
const PAYLOAD_FIELDS = Object.freeze(["workspaceId", "requesterId", "description", "adapter", "action"]);

function assertNonempty(value, field, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new TypeError(`Invalid ${field}`);
  return value;
}

function deepFreeze(object) {
  if (object && typeof object === "object" && !Object.isFrozen(object)) {
    for (const value of Object.values(object)) deepFreeze(value);
    Object.freeze(object);
  }
  return object;
}

function snapshot(task) {
  return structuredClone(task);
}

/** Canonical JSON: sorted keys, no whitespace. Used for payload binding and audit hashing. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

/**
 * SHA-256 over the immutable request payload. An approval records this hash and is valid only
 * for a task whose payload still hashes to it, so an approval can never be moved to other work.
 */
function payloadHash(task) {
  const payload = {};
  for (const field of PAYLOAD_FIELDS) payload[field] = task[field];
  return crypto.createHash("sha256").update(canonical(payload)).digest("hex");
}

function append(task, event, actor, at) {
  if (task.audit.length >= MAX_AUDIT_EVENTS) throw new Error("Task audit capacity reached");
  task.audit = task.audit.concat([{ sequence: task.nextSequence++, event, actor, at }]);
  task.updatedAt = at;
}

function createTask({ workspaceId, requesterId, description, adapter, action }, options = {}) {
  assertNonempty(workspaceId, "workspaceId");
  assertNonempty(requesterId, "requesterId");
  assertNonempty(description, "description", MAX_DESCRIPTION);
  if (!ALLOWED_ADAPTERS.includes(adapter)) throw new TypeError("Unsupported adapter");
  if (!Object.hasOwn(RISK, action)) throw new TypeError("Unsupported action");
  const at = (options.now ?? (() => new Date().toISOString()))();
  const task = {
    id: (options.uuid ?? crypto.randomUUID)(),
    workspaceId,
    requesterId,
    description,
    adapter,
    action,
    risk: RISK[action],
    status: STATES.WAITING,
    approval: null,
    payloadHash: null,
    createdAt: at,
    updatedAt: at,
    nextSequence: 1,
    audit: [],
  };
  task.payloadHash = payloadHash(task);
  append(task, "task.created", requesterId, at);
  return deepFreeze(task);
}

function transition(task, { operation, actorId, expectedSequence, decisionId, approvedPayloadHash }, options = {}) {
  if (!task || typeof task !== "object" || !Array.isArray(task.audit))
    throw new TypeError("Invalid task");
  assertNonempty(actorId, "actorId");
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence !== task.nextSequence)
    throw new Error("Stale task version");
  // A task object whose payload no longer matches its creation hash has been altered.
  if (typeof task.payloadHash !== "string" || payloadHash(task) !== task.payloadHash)
    throw new Error("Task payload does not match its recorded hash");
  const at = (options.now ?? (() => new Date().toISOString()))();
  const next = snapshot(task);
  switch (operation) {
    case "approve":
    case "deny":
      if (next.status !== STATES.WAITING) throw new Error("Task is not awaiting approval");
      if (actorId === next.requesterId) throw new Error("Requester cannot self-approve");
      assertNonempty(decisionId, "decisionId");
      // The decider must name the exact payload they reviewed.
      if (approvedPayloadHash !== next.payloadHash)
        throw new Error("Decision does not match the task payload");
      next.approval = { by: actorId, decisionId, at, decision: operation, payloadHash: next.payloadHash };
      next.status = operation === "approve" ? STATES.APPROVED : STATES.DENIED;
      break;
    case "start":
      if (next.status !== STATES.APPROVED || !next.approval || next.approval.decision !== "approve")
        throw new Error("Task is not approved");
      if (next.approval.payloadHash !== next.payloadHash)
        throw new Error("Approval is not bound to this task payload");
      next.status = STATES.RUNNING;
      break;
    case "succeed":
    case "fail":
      if (next.status !== STATES.RUNNING) throw new Error("Task is not running");
      next.status = operation === "succeed" ? STATES.SUCCEEDED : STATES.FAILED;
      break;
    case "cancel":
      if (![STATES.WAITING, STATES.APPROVED, STATES.RUNNING].includes(next.status))
        throw new Error("Task cannot be cancelled");
      next.status = STATES.CANCELLED;
      break;
    default:
      throw new TypeError("Unsupported operation");
  }
  append(next, `task.${operation}`, actorId, at);
  return deepFreeze(next);
}

/** Planning-only adapter catalog; contains no API keys or remote endpoints. */
function listAdapters() {
  return ALLOWED_ADAPTERS.map((id) => ({ id, configured: false, executionEnabled: false }));
}

module.exports = {
  STATES, ACTIONS, ALLOWED_ADAPTERS, ADMIN_APPROVAL_ACTIONS, MAX_DESCRIPTION,
  createTask, transition, listAdapters, payloadHash, canonical,
};
