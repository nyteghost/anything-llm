// How NyteDesk tasks are shown. The backend state machine
// (server/utils/nytedesk/control-plane.cjs) is the only source of truth: this
// file maps its states to labels and never upgrades a state. In particular a
// task the agent reports as finished is "Agent-reported complete", never
// "verified", because no independent verification record exists yet.

export const DISPLAY_STATES = Object.freeze([
  {
    id: "proposed",
    label: "Proposed",
    tracked: false,
    note: "Not stored yet: tasks are created directly as awaiting approval.",
  },
  { id: "awaiting_approval", label: "Awaiting approval", tracked: true },
  { id: "approved", label: "Approved", tracked: true },
  { id: "queued", label: "Queued", tracked: true },
  { id: "executing", label: "Executing", tracked: true },
  {
    id: "agent_reported_complete",
    label: "Agent-reported complete",
    tracked: true,
  },
  {
    id: "independently_verified",
    label: "Independently verified",
    tracked: false,
    note: "Not tracked yet: no verification record exists, so no task is shown as verified.",
  },
  { id: "failed", label: "Failed", tracked: true },
  { id: "rejected", label: "Rejected", tracked: true },
  { id: "cancelled", label: "Cancelled", tracked: true },
]);

const BACKEND_TO_DISPLAY = Object.freeze({
  queued: "queued",
  waiting_approval: "awaiting_approval",
  approved: "approved",
  running: "executing",
  succeeded: "agent_reported_complete",
  failed: "failed",
  denied: "rejected",
  cancelled: "cancelled",
});

const TONE = Object.freeze({
  awaiting_approval: "warning",
  approved: "info",
  queued: "neutral",
  executing: "active",
  agent_reported_complete: "success",
  failed: "danger",
  rejected: "danger",
  cancelled: "neutral",
});

export const OPEN_BACKEND_STATES = Object.freeze([
  "queued",
  "waiting_approval",
  "approved",
  "running",
]);

/** Display state for a backend status; unknown statuses are shown as such. */
export function displayState(status) {
  const id = BACKEND_TO_DISPLAY[status];
  if (!id) {
    return {
      id: "unknown",
      label: `Unknown state (${String(status)})`,
      tone: "neutral",
      backend: status,
    };
  }
  const def = DISPLAY_STATES.find((s) => s.id === id);
  return { id, label: def.label, tone: TONE[id], backend: status };
}

const ENGINE_NAMES = Object.freeze({
  ollama: "Ollama",
  strata: "Strata",
  polystrata: "PolyStrata",
});

/** Who a task is addressed to. Engine adapters mean the coordinator model. */
export function describeAdapter(adapter) {
  if (ENGINE_NAMES[adapter]) {
    return {
      name: `Local coordinator via ${ENGINE_NAMES[adapter]}`,
      kind: "agent",
      role: "coordinator",
    };
  }
  const known = {
    "claude-code": {
      name: "Claude Code CLI",
      kind: "agent",
      role: "implementer",
    },
    codex: { name: "Codex CLI", kind: "agent", role: "reviewer" },
    anthropic: { name: "Anthropic API", kind: "api", role: "model API" },
    openai: { name: "OpenAI API", kind: "api", role: "model API" },
  }[adapter];
  return known ?? { name: String(adapter), kind: "unknown", role: "unknown" };
}

/** What an action would be allowed to do if executed. Execution is disabled. */
export const ACTION_INFO = Object.freeze({
  "model.prompt": { label: "Prompt a model", scope: "Model conversation" },
  "repository.read": { label: "Read a repository", scope: "Repository (read)" },
  "vm.read": { label: "Read in the VM", scope: "Dedicated VM (read)" },
  "vm.write": { label: "Write in the VM", scope: "Dedicated VM (write)" },
  "vm.execute": {
    label: "Run commands in the VM",
    scope: "Dedicated VM (execute)",
  },
  "browser.read": { label: "Read web pages", scope: "Browser (read)" },
  "browser.interact": {
    label: "Act in a browser",
    scope: "Browser (interact)",
  },
  "git.push": { label: "Push to git", scope: "Git remote (write)" },
  "git.merge": { label: "Merge in git", scope: "Git branches (merge)" },
  "credential.access": { label: "Use credentials", scope: "Credentials" },
  "privilege.change": { label: "Change privileges", scope: "Permissions" },
  "external.publish": {
    label: "Publish externally",
    scope: "External services",
  },
  "engine.model.load": {
    label: "Load a model",
    scope: "Inference engine (load a model)",
  },
  "engine.model.unload": {
    label: "Unload a model",
    scope: "Inference engine (unload a model)",
  },
});

/** Engine model control actions (load/unload in a running engine). */
export const MODEL_CONTROL_ACTIONS = Object.freeze([
  "engine.model.load",
  "engine.model.unload",
]);

/** The recorded outcome evidence of a model control task, or null. */
export function modelOutcome(audit = []) {
  const last = [...audit]
    .reverse()
    .find((e) => e.event === "task.succeed" || e.event === "task.fail");
  if (!last || !last.detail || !last.detail.operation) return null;
  return {
    ...last.detail,
    succeeded: last.event === "task.succeed",
    at: last.at,
  };
}

/** Approval level, from the server's `protected` flag (never guessed). */
export function riskLevel(isProtected) {
  if (isProtected === true) {
    return { level: "High", approver: "Administrator approval required" };
  }
  if (isProtected === false) {
    return { level: "Standard", approver: "Manager or administrator approval" };
  }
  return { level: "Unknown", approver: "Approval level not reported" };
}

/**
 * Provenance lines for a task: who asked, who decided, who reported the
 * outcome. Everything comes from the task record and its audit log.
 */
export function provenance(task, audit = []) {
  const lines = [
    {
      label: "Requested by",
      value: `user #${task.requesterId}`,
      at: task.createdAt,
    },
    { label: "Addressed to", value: describeAdapter(task.adapter).name },
  ];
  if (task.approval) {
    const verb = task.approval.decision === "approve" ? "Approved" : "Rejected";
    lines.push({
      label: `${verb} by`,
      value: `user #${task.approval.by}`,
      at: task.approval.at,
    });
  }
  const last = audit.length ? audit[audit.length - 1] : null;
  if (last) {
    const who = last.actorRole
      ? `user #${last.actorId} (${last.actorRole})`
      : `user #${last.actorId}`;
    lines.push({
      label: "Last event",
      value: `${last.event} by ${who}`,
      at: last.at,
    });
  }
  if (task.status === "succeeded") {
    lines.push({
      label: "Outcome",
      value: "Reported complete by the agent. Not independently verified.",
    });
  }
  return lines;
}

/**
 * What a person confirmed they reviewed: one exact task revision. Any change
 * of task, version or payload hash makes the confirmation void.
 */
export function reviewBinding(task) {
  if (!task) return null;
  return { id: task.id, version: task.version, payloadHash: task.payloadHash };
}

export function reviewMatches(binding, task) {
  return (
    !!binding &&
    !!task &&
    binding.id === task.id &&
    binding.version === task.version &&
    binding.payloadHash === task.payloadHash
  );
}

/**
 * Sequencer for overlapping loads: `begin()` returns a token, and `isCurrent`
 * is true only for the newest token, so a slow response for an earlier
 * request can never replace a newer one.
 */
export function createSequencer() {
  let latest = 0;
  let cancelled = false;
  return {
    begin() {
      latest += 1;
      return latest;
    },
    isCurrent(token) {
      return !cancelled && token === latest;
    },
    /** Voids every token, current and future (e.g. on unmount). */
    cancel() {
      cancelled = true;
    },
  };
}
