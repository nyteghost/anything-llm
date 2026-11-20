"use strict";

/**
 * NyteDesk authorization layer. Identity always comes from the authenticated
 * session (`actor` = { id, role } of an AnythingLLM user); nothing in a
 * request body names who is acting.
 *
 * Operating mode is SUPERVISED: every action needs a human decision. Agents
 * (including the local coordinator LLM) are not users: they can never approve,
 * deny, grant permissions or change provider configuration.
 *
 * Roles (AnythingLLM multi-user roles):
 * - create a task: any user with access to the workspace;
 * - view tasks: users with access to the task's workspace;
 * - approve or deny: a manager or admin with workspace access who is not the
 *   requester; protected actions (ADMIN_APPROVAL_ACTIONS) need an admin;
 * - cancel: the requester, or a manager/admin with workspace access;
 * - provider configuration: managers and admins read, only admins change.
 *
 * Nothing here executes a model, shell, browser, VM or network call.
 */
const cp = require("./control-plane.cjs");
const { NyteDeskError, sha256 } = require("./store.cjs");

const DECIDER_ROLES = Object.freeze(["admin", "manager"]);
const KEY_ENV_RE = /^NYTEDESK_[A-Z0-9_]{1,64}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const OFFICIAL_API = Object.freeze({
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
});
const SECRET_FIELDS =
  /^(api[_-]?key|key|secret|token|password|authorization|bearer)$/i;
const PROVIDER_FIELDS = ["baseUrl", "model", "keyEnv", "expectedVersion"];
// Endpoint configuration applies to model APIs. The CLI agents (Claude Code,
// Codex) run inside the VM and are configured there, not here.
const PROVIDER_IDS = Object.freeze(
  cp.AGENTS.filter((a) => a.runtime !== "vm-cli").map((a) => a.id)
);
const OPEN_STATES = ["waiting_approval", "approved", "running"];

function assertActor(actor) {
  if (
    !actor ||
    !Number.isSafeInteger(Number(actor.id)) ||
    typeof actor.role !== "string"
  ) {
    throw new NyteDeskError(401, "An authenticated user is required");
  }
}

function isProtected(action) {
  return cp.ADMIN_APPROVAL_ACTIONS.includes(action);
}

function canDecide(actor, task) {
  if (Number(actor.id) === Number(task.requesterId)) return false;
  if (isProtected(task.action)) return actor.role === "admin";
  return DECIDER_ROLES.includes(actor.role);
}

function requestHash(method, route, body) {
  return sha256(cp.canonical({ method, route, body: body ?? null }));
}

/** IPv4 loopback/private/tailnet or IPv6 loopback/ULA, as an IP literal. */
function isLocalLiteral(host) {
  const h = host.replace(/^\[|\]$/g, "");
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((x) => x > 255)) return false;
    const [a, b] = octets;
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return h === "::1" || /^f[cd][0-9a-f]{2}:/i.test(h);
}

function parseBaseUrl(id, baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.length > 300) {
    throw new NyteDeskError(400, "Invalid baseUrl");
  }
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new NyteDeskError(400, "Invalid baseUrl");
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new NyteDeskError(
      400,
      "baseUrl cannot carry credentials, a query or a fragment"
    );
  }
  if (OFFICIAL_API[id]) {
    if (u.origin !== OFFICIAL_API[id]) {
      throw new NyteDeskError(
        400,
        `${id} must use its official API origin ${OFFICIAL_API[id]}`
      );
    }
  } else if (
    !["http:", "https:"].includes(u.protocol) ||
    !isLocalLiteral(u.hostname)
  ) {
    throw new NyteDeskError(
      400,
      `${id} must be a loopback, private or tailnet IP literal (no host names)`
    );
  }
  return u.origin + u.pathname.replace(/\/+$/, "");
}

function validateProvider(id, body) {
  if (!PROVIDER_IDS.includes(id)) {
    throw new NyteDeskError(404, "Unknown provider");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new NyteDeskError(400, "Invalid body");
  }
  for (const key of Object.keys(body)) {
    if (SECRET_FIELDS.test(key)) {
      throw new NyteDeskError(
        400,
        "API keys are never stored by NyteDesk; name an environment variable in keyEnv instead"
      );
    }
    if (!PROVIDER_FIELDS.includes(key)) {
      throw new NyteDeskError(400, `Unknown field: ${key}`);
    }
  }
  const { baseUrl = null, model = null, keyEnv = null } = body;
  const { expectedVersion } = body;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new NyteDeskError(400, "expectedVersion is required");
  }
  if (model !== null && (typeof model !== "string" || !MODEL_RE.test(model))) {
    throw new NyteDeskError(400, "Invalid model name");
  }
  if (
    keyEnv !== null &&
    (typeof keyEnv !== "string" || !KEY_ENV_RE.test(keyEnv))
  ) {
    throw new NyteDeskError(
      400,
      "keyEnv must be an environment variable name starting with NYTEDESK_"
    );
  }
  const url = baseUrl === null ? null : parseBaseUrl(id, baseUrl);
  if (OFFICIAL_API[id] && keyEnv === null && (url !== null || model !== null)) {
    throw new NyteDeskError(
      400,
      `${id} needs keyEnv naming the environment variable that holds its API key`
    );
  }
  return { kind: id, baseUrl: url, model, keyEnv, expectedVersion };
}

function createService(store, options = {}) {
  const env = options.env ?? process.env;

  function publicTask(task) {
    return { ...task, executionEnabled: false };
  }

  function keyPresent(keyEnv) {
    const value = keyEnv ? env[keyEnv] : null;
    return typeof value === "string" && value.length > 0;
  }

  function assertDecider(actor, task) {
    if (Number(actor.id) === task.requesterId) {
      throw new NyteDeskError(
        403,
        "Requester cannot approve or deny their own task"
      );
    }
    if (canDecide(actor, task)) return;
    throw new NyteDeskError(
      403,
      isProtected(task.action)
        ? "Only an administrator may decide this protected action"
        : "Only a manager or administrator may decide tasks"
    );
  }

  const service = {
    status() {
      return {
        phase: 1,
        mode: "supervised",
        executionEnabled: false,
        browserAutomation: false,
        vmOperations: false,
        agentsMayApprove: false,
        storage: "sqlite",
        executionPreconditions: cp.EXECUTION_PRECONDITIONS.map((id) => ({
          id,
          verified: false,
        })),
      };
    },

    agents() {
      const stored = store.listProviders();
      const configured = new Map(stored.map((p) => [p.id, p]));
      return cp.listAdapters().map((a) => {
        const p = configured.get(a.id);
        return {
          id: a.id,
          role: a.role,
          runtime: a.runtime,
          configured: !!(p && (p.baseUrl || p.model)),
          keyPresent: !!(p && keyPresent(p.keyEnv)),
          mayApprove: false,
          executionEnabled: false,
        };
      });
    },

    createTask(actor, workspace, body, idempotencyKey) {
      assertActor(actor);
      if (!workspace || !Number.isSafeInteger(Number(workspace.id))) {
        throw new NyteDeskError(404, "Workspace not found");
      }
      if (!body || typeof body !== "object") {
        throw new NyteDeskError(400, "Invalid body");
      }
      const { description, adapter, action } = body;
      const fields = { description, adapter, action };
      const route = `POST /nytedesk/workspaces/${workspace.slug}/tasks`;
      const hash = requestHash("POST", route, fields);
      return store.idempotent(actor.id, idempotencyKey, hash, () => {
        const input = { workspace, actor, ...fields };
        const task = publicTask(store.insertTask(input));
        return { status: 201, body: { task } };
      });
    },

    /** Raw stored task; routes must check workspace access before using it. */
    getTaskRecord(id) {
      return store.getTask(id);
    },

    listTasks(actor, workspaceIds, { status, limit } = {}) {
      assertActor(actor);
      if (status && !Object.values(cp.STATES).includes(status)) {
        throw new NyteDeskError(400, "Unknown status");
      }
      const tasks = store.listTasks({ workspaceIds, status, limit });
      return tasks.map(publicTask);
    },

    pendingApprovals(actor, workspaceIds) {
      assertActor(actor);
      const query = { workspaceIds, status: cp.STATES.WAITING, limit: 200 };
      return store.listTasks(query).map((t) => ({
        ...publicTask(t),
        protected: isProtected(t.action),
        canDecide: canDecide(actor, t),
      }));
    },

    getTask(actor, task) {
      assertActor(actor);
      const v = store.verifyAudit(task.id);
      const isRequester = Number(actor.id) === task.requesterId;
      const waiting = task.status === cp.STATES.WAITING;
      return {
        task: publicTask(task),
        protected: isProtected(task.action),
        audit: store.auditFor(task.id),
        auditVerified: v.ok,
        auditProblems: v.problems,
        canDecide: waiting && canDecide(actor, task),
        canCancel:
          OPEN_STATES.includes(task.status) &&
          (isRequester || DECIDER_ROLES.includes(actor.role)),
      };
    },

    decide(actor, task, decision, body, idempotencyKey) {
      assertActor(actor);
      if (!["approve", "deny"].includes(decision)) {
        throw new NyteDeskError(400, "Unknown decision");
      }
      assertDecider(actor, task);
      const { expectedVersion, payloadHash, reason } = body || {};
      if (!Number.isSafeInteger(expectedVersion)) {
        throw new NyteDeskError(400, "expectedVersion is required");
      }
      if (typeof payloadHash !== "string") {
        throw new NyteDeskError(
          400,
          "payloadHash of the reviewed task is required"
        );
      }
      const route = `POST /nytedesk/tasks/${task.id}/${decision}`;
      const fields = { expectedVersion, payloadHash, reason: reason ?? null };
      const hash = requestHash("POST", route, fields);
      return store.idempotent(actor.id, idempotencyKey, hash, () => {
        const args = { decision, expectedVersion, payloadHash, reason };
        const next = publicTask(store.decideTask(task.id, actor, args));
        return { status: 200, body: { task: next } };
      });
    },

    cancel(actor, task, body, idempotencyKey) {
      assertActor(actor);
      const isRequester = Number(actor.id) === task.requesterId;
      if (!isRequester && !DECIDER_ROLES.includes(actor.role)) {
        throw new NyteDeskError(
          403,
          "Only the requester or a manager/administrator may cancel"
        );
      }
      const { expectedVersion, reason } = body || {};
      if (!Number.isSafeInteger(expectedVersion)) {
        throw new NyteDeskError(400, "expectedVersion is required");
      }
      const route = `POST /nytedesk/tasks/${task.id}/cancel`;
      const fields = { expectedVersion, reason: reason ?? null };
      const hash = requestHash("POST", route, fields);
      return store.idempotent(actor.id, idempotencyKey, hash, () => {
        const args = { expectedVersion, reason };
        const next = publicTask(store.cancelTask(task.id, actor, args));
        return { status: 200, body: { task: next } };
      });
    },

    providers(actor) {
      assertActor(actor);
      if (!DECIDER_ROLES.includes(actor.role)) {
        throw new NyteDeskError(403, "Managers and administrators only");
      }
      const stored = new Map(store.listProviders().map((p) => [p.id, p]));
      return PROVIDER_IDS.map((id) => {
        const p = stored.get(id);
        return {
          id,
          kind: id,
          baseUrl: p?.baseUrl ?? null,
          model: p?.model ?? null,
          keyEnv: p?.keyEnv ?? null,
          keyPresent: keyPresent(p?.keyEnv),
          version: p?.version ?? 0,
          updatedBy: p?.updatedBy ?? null,
          updatedAt: p?.updatedAt ?? null,
          executionEnabled: false,
        };
      });
    },

    putProvider(actor, id, body, idempotencyKey) {
      assertActor(actor);
      if (actor.role !== "admin") {
        throw new NyteDeskError(
          403,
          "Only administrators may change provider configuration"
        );
      }
      const cfg = validateProvider(id, body);
      const route = `PUT /nytedesk/providers/${id}`;
      const hash = requestHash("PUT", route, cfg);
      return store.idempotent(actor.id, idempotencyKey, hash, () => {
        store.putProvider(id, actor, cfg);
        const provider = service.providers(actor).find((p) => p.id === id);
        return { status: 200, body: { provider } };
      });
    },
  };
  return service;
}

module.exports = {
  createService,
  canDecide,
  validateProvider,
  isLocalLiteral,
  PROVIDER_IDS,
};
