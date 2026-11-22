"use strict";

/**
 * NyteDesk control-plane primitives.
 * No shell, browser, model, network or filesystem execution is exposed here.
 * Engine model control (load/unload a model in a running engine) is a task
 * action like any other: it is approved here and run elsewhere
 * (model-control.cjs), only when the owner enables it.
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
  CREDENTIAL_ACCESS: "credential.access",
  PRIVILEGE_CHANGE: "privilege.change",
  EXTERNAL_PUBLISH: "external.publish",
  ENGINE_MODEL_LOAD: "engine.model.load",
  ENGINE_MODEL_UNLOAD: "engine.model.unload",
});

/**
 * Engine model control: ask an already running engine, over its own HTTP API,
 * to load or unload one named model. Not agent execution: no process, shell,
 * VM or credential is involved. Only engines listed here may be targeted.
 */
const ENGINE_CONTROL_ACTIONS = Object.freeze([
  ACTIONS.ENGINE_MODEL_LOAD,
  ACTIONS.ENGINE_MODEL_UNLOAD,
]);
const ENGINE_CONTROL_ADAPTERS = Object.freeze(["ollama"]);
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

// Every action is approval-gated. Supervised mode is the only operating mode:
// no action, including reads, runs without a human decision.
const RISK = Object.freeze(
  Object.fromEntries(Object.values(ACTIONS).map((a) => [a, "approval"]))
);

/**
 * Agents NyteDesk knows. Roles follow the confirmed architecture:
 * - coordinator: the local LLM plans, delegates and summarizes. It may only
 *   RECOMMEND tasks; it never approves, grants permissions or bypasses review.
 * - implementer: Claude Code CLI, the primary development agent (in the VM).
 * - reviewer: OpenAI Codex CLI, independent review and debugging (in the VM).
 * - api: hosted model APIs used through their official interfaces.
 * Nothing here runs an agent; execution is disabled in this phase.
 */
const AGENTS = Object.freeze([
  { id: "ollama", role: "coordinator", runtime: "local-api" },
  { id: "strata", role: "coordinator", runtime: "local-api" },
  { id: "polystrata", role: "coordinator", runtime: "local-api" },
  { id: "claude-code", role: "implementer", runtime: "vm-cli" },
  { id: "codex", role: "reviewer", runtime: "vm-cli" },
  { id: "anthropic", role: "api", runtime: "cloud-api" },
  { id: "openai", role: "api", runtime: "cloud-api" },
]);
const ALLOWED_ADAPTERS = Object.freeze(AGENTS.map((a) => a.id));

/**
 * What each part of the system is, for people reading the dashboard. Inference
 * engines serve a model; they are not agents. The coordinator is the local
 * model running on whichever engine is selected. AgentBridge enforces policy.
 * Task adapters `ollama`, `strata` and `polystrata` mean "the coordinator,
 * through that engine". This catalog grants nothing.
 */
const COMPONENTS = Object.freeze(
  [
    {
      id: "coordinator",
      kind: "agent",
      name: "Local coordinator model",
      role: "coordinator",
      responsibility:
        "Plans, delegates and summarizes. Recommends tasks only: cannot approve, grant permissions or execute.",
      runsOn: "the selected local inference engine",
    },
    {
      id: "polystrata",
      kind: "engine",
      name: "PolyStrata",
      role: "inference-engine",
      responsibility:
        "Serves the local model over an OpenAI-compatible API. Externally owned.",
      runsOn: "owner's machine",
    },
    {
      id: "strata",
      kind: "engine",
      name: "Strata",
      role: "inference-engine",
      responsibility: "Serves a local model. Externally owned.",
      runsOn: "owner's machine",
    },
    {
      id: "ollama",
      kind: "engine",
      name: "Ollama",
      role: "inference-engine",
      responsibility: "Serves local models. Externally owned.",
      runsOn: "owner's machine",
    },
    {
      id: "claude-code",
      kind: "agent",
      name: "Claude Code CLI",
      role: "implementer",
      responsibility: "Implements approved changes.",
      runsOn: "dedicated VM",
    },
    {
      id: "codex",
      kind: "agent",
      name: "Codex CLI",
      role: "reviewer",
      responsibility:
        "Coding and independent review of work it did not implement.",
      runsOn: "dedicated VM",
    },
    {
      id: "agentbridge",
      kind: "orchestrator",
      name: "AgentBridge",
      role: "orchestration",
      responsibility:
        "Routes work between agents and enforces policy and approvals.",
      runsOn: "NyteDesk server",
    },
  ].map((c) => ({ ...c, mayApprove: false, executionEnabled: false }))
);

// Protected actions: their approval needs an administrator, not only a
// manager. They change state outside the conversation, execute, publish,
// touch credentials or change privileges.
const ADMIN_APPROVAL_ACTIONS = Object.freeze([
  ACTIONS.VM_WRITE,
  ACTIONS.VM_EXEC,
  ACTIONS.BROWSER_INTERACT,
  ACTIONS.GIT_PUSH,
  ACTIONS.GIT_MERGE,
  ACTIONS.CREDENTIAL_ACCESS,
  ACTIONS.PRIVILEGE_CHANGE,
  ACTIONS.EXTERNAL_PUBLISH,
]);

/**
 * Preconditions the owner set before any execution may be enabled. All are
 * unverified in this phase, so execution stays disabled whatever the request.
 */
const EXECUTION_PRECONDITIONS = Object.freeze([
  "vm-isolation-verified",
  "host-shared-resources-reviewed",
  "vm-recovery-snapshot-verified",
  "execution-limits-and-cancellation-configured",
  "credentials-protected",
]);

const MAX_DESCRIPTION = 4000;
// Never silently drop audit history: a task that would exceed this is refused.
const MAX_AUDIT_EVENTS = 128;
const PAYLOAD_FIELDS = Object.freeze([
  "workspaceId",
  "requesterId",
  "description",
  "adapter",
  "action",
]);
// Bound into the payload hash only when present, so tasks created before the
// field existed keep their recorded hash.
const OPTIONAL_PAYLOAD_FIELDS = Object.freeze(["target"]);

function assertNonempty(value, field, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(`Invalid ${field}`);
  }
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

/** Canonical JSON: sorted keys, no whitespace (payload binding, audit hashes). */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${canonical(value[k])}`
    );
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 over the immutable request payload. An approval records this hash
 * and is valid only for a task whose payload still hashes to it, so an
 * approval can never be moved to other work.
 */
function payloadHash(task) {
  const payload = {};
  for (const field of PAYLOAD_FIELDS) payload[field] = task[field];
  for (const field of OPTIONAL_PAYLOAD_FIELDS) {
    if (task[field] !== undefined && task[field] !== null) {
      payload[field] = task[field];
    }
  }
  return crypto.createHash("sha256").update(canonical(payload)).digest("hex");
}

function append(task, event, actor, at) {
  if (task.audit.length >= MAX_AUDIT_EVENTS) {
    throw new Error("Task audit capacity reached");
  }
  const entry = { sequence: task.nextSequence++, event, actor, at };
  task.audit = task.audit.concat([entry]);
  task.updatedAt = at;
}

function createTask(fields, options = {}) {
  const { workspaceId, requesterId, description, adapter, action } = fields;
  assertNonempty(workspaceId, "workspaceId");
  assertNonempty(requesterId, "requesterId");
  assertNonempty(description, "description", MAX_DESCRIPTION);
  if (!ALLOWED_ADAPTERS.includes(adapter)) {
    throw new TypeError("Unsupported adapter");
  }
  if (!Object.hasOwn(RISK, action)) throw new TypeError("Unsupported action");
  const target = fields.target ?? null;
  if (ENGINE_CONTROL_ACTIONS.includes(action)) {
    if (!ENGINE_CONTROL_ADAPTERS.includes(adapter)) {
      throw new TypeError("Model control is only supported for Ollama");
    }
    if (typeof target !== "string" || !TARGET_RE.test(target)) {
      throw new TypeError("Model control needs a valid model name");
    }
  } else if (target !== null) {
    throw new TypeError("Only model control tasks take a target");
  }
  const at = (options.now ?? (() => new Date().toISOString()))();
  const task = {
    id: (options.uuid ?? crypto.randomUUID)(),
    workspaceId,
    requesterId,
    description,
    adapter,
    action,
    ...(target !== null ? { target } : {}),
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

function transition(task, args, options = {}) {
  const { operation, actorId, expectedSequence, decisionId } = args;
  if (!task || typeof task !== "object" || !Array.isArray(task.audit)) {
    throw new TypeError("Invalid task");
  }
  assertNonempty(actorId, "actorId");
  if (
    !Number.isSafeInteger(expectedSequence) ||
    expectedSequence !== task.nextSequence
  ) {
    throw new Error("Stale task version");
  }
  // A task object whose payload no longer matches its creation hash was altered.
  if (
    typeof task.payloadHash !== "string" ||
    payloadHash(task) !== task.payloadHash
  ) {
    throw new Error("Task payload does not match its recorded hash");
  }
  const at = (options.now ?? (() => new Date().toISOString()))();
  const next = snapshot(task);
  switch (operation) {
    case "approve":
    case "deny":
      if (next.status !== STATES.WAITING) {
        throw new Error("Task is not awaiting approval");
      }
      if (actorId === next.requesterId) {
        throw new Error("Requester cannot self-approve");
      }
      assertNonempty(decisionId, "decisionId");
      // The decider must name the exact payload they reviewed.
      if (args.approvedPayloadHash !== next.payloadHash) {
        throw new Error("Decision does not match the task payload");
      }
      next.approval = {
        by: actorId,
        decisionId,
        at,
        decision: operation,
        payloadHash: next.payloadHash,
      };
      next.status = operation === "approve" ? STATES.APPROVED : STATES.DENIED;
      break;
    case "start":
      if (
        next.status !== STATES.APPROVED ||
        !next.approval ||
        next.approval.decision !== "approve"
      ) {
        throw new Error("Task is not approved");
      }
      if (next.approval.payloadHash !== next.payloadHash) {
        throw new Error("Approval is not bound to this task payload");
      }
      next.status = STATES.RUNNING;
      break;
    case "succeed":
    case "fail":
      if (next.status !== STATES.RUNNING) {
        throw new Error("Task is not running");
      }
      next.status = operation === "succeed" ? STATES.SUCCEEDED : STATES.FAILED;
      break;
    case "cancel": {
      const open = [STATES.WAITING, STATES.APPROVED, STATES.RUNNING];
      if (!open.includes(next.status)) {
        throw new Error("Task cannot be cancelled");
      }
      next.status = STATES.CANCELLED;
      break;
    }
    default:
      throw new TypeError("Unsupported operation");
  }
  append(next, `task.${operation}`, actorId, at);
  return deepFreeze(next);
}

/** Planning-only agent catalog; contains no API keys or remote endpoints. */
function listAdapters() {
  return AGENTS.map((a) => ({
    id: a.id,
    role: a.role,
    runtime: a.runtime,
    configured: false,
    executionEnabled: false,
  }));
}

module.exports = {
  STATES,
  ACTIONS,
  AGENTS,
  ALLOWED_ADAPTERS,
  COMPONENTS,
  ADMIN_APPROVAL_ACTIONS,
  EXECUTION_PRECONDITIONS,
  ENGINE_CONTROL_ACTIONS,
  ENGINE_CONTROL_ADAPTERS,
  TARGET_RE,
  MAX_DESCRIPTION,
  createTask,
  transition,
  listAdapters,
  payloadHash,
  canonical,
};
