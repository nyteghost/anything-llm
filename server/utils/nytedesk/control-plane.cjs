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
const MAX_DESCRIPTION = 4000;
const MAX_AUDIT_EVENTS = 128;

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

function append(task, event, actor, at) {
  const audit = task.audit.concat([{ sequence: task.nextSequence++, event, actor, at }]);
  task.audit = audit.slice(-MAX_AUDIT_EVENTS);
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
    createdAt: at,
    updatedAt: at,
    nextSequence: 1,
    audit: [],
  };
  append(task, "task.created", requesterId, at);
  return deepFreeze(task);
}

function transition(task, { operation, actorId, expectedSequence, decisionId }, options = {}) {
  if (!task || typeof task !== "object" || !Array.isArray(task.audit))
    throw new TypeError("Invalid task");
  assertNonempty(actorId, "actorId");
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence !== task.nextSequence)
    throw new Error("Stale task version");
  const at = (options.now ?? (() => new Date().toISOString()))();
  const next = snapshot(task);
  switch (operation) {
    case "approve":
    case "deny":
      if (next.status !== STATES.WAITING) throw new Error("Task is not awaiting approval");
      if (actorId === next.requesterId) throw new Error("Requester cannot self-approve");
      assertNonempty(decisionId, "decisionId");
      next.approval = { by: actorId, decisionId, at, decision: operation };
      next.status = operation === "approve" ? STATES.APPROVED : STATES.DENIED;
      break;
    case "start":
      if (next.status !== STATES.APPROVED || !next.approval || next.approval.decision !== "approve")
        throw new Error("Task is not approved");
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

module.exports = { STATES, ACTIONS, createTask, transition, listAdapters };
