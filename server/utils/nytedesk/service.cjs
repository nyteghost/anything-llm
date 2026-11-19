"use strict";

/**
 * NyteDesk authorization layer (Phase 1). Identity always comes from the authenticated session
 * (`actor` = { id, role } of an AnythingLLM user); nothing in a request body names who is acting.
 *
 * Roles (AnythingLLM multi-user roles):
 * - create a task: any user with access to the workspace;
 * - view tasks: users with access to the task's workspace;
 * - approve or deny: a manager or admin with workspace access who is not the requester;
 *   actions in ADMIN_APPROVAL_ACTIONS (VM write/execute, browser interaction, git push/merge)
 *   need an admin;
 * - cancel: the requester, or a manager/admin with workspace access;
 * - provider configuration: managers and admins may read, only admins may change.
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
const SECRET_FIELDS = /^(api[_-]?key|key|secret|token|password|authorization|bearer)$/i;

function assertActor(actor) {
  if (!actor || !Number.isSafeInteger(Number(actor.id)) || typeof actor.role !== "string")
    throw new NyteDeskError(401, "An authenticated user is required");
}

function canDecide(actor, task) {
  if (Number(actor.id) === Number(task.requesterId)) return false;
  if (cp.ADMIN_APPROVAL_ACTIONS.includes(task.action)) return actor.role === "admin";
  return DECIDER_ROLES.includes(actor.role);
}

function requestHash(method, route, body) {
  return sha256(cp.canonical({ method, route, body: body ?? null }));
}

/** IPv4 loopback/private, IPv6 loopback/ULA, or a tailnet address, as an IP literal (no DNS). */
function isLocalLiteral(host) {
  const h = host.replace(/^\[|\]$/g, "");
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (v4.slice(1).some((x) => Number(x) > 255)) return false;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === "::1" || /^f[cd][0-9a-f]{2}:/i.test(h);
}

function validateProvider(id, body) {
  if (!cp.ALLOWED_ADAPTERS.includes(id)) throw new NyteDeskError(404, "Unknown provider");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new NyteDeskError(400, "Invalid body");
  for (const key of Object.keys(body)) {
    if (SECRET_FIELDS.test(key))
      throw new NyteDeskError(400, "API keys are never stored by NyteDesk; name an environment variable in keyEnv instead");
    if (!["baseUrl", "model", "keyEnv", "expectedVersion"].includes(key)) throw new NyteDeskError(400, `Unknown field: ${key}`);
  }
  const { baseUrl = null, model = null, keyEnv = null, expectedVersion } = body;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new NyteDeskError(400, "expectedVersion is required");
  if (model !== null && (typeof model !== "string" || !MODEL_RE.test(model))) throw new NyteDeskError(400, "Invalid model name");
  if (keyEnv !== null && (typeof keyEnv !== "string" || !KEY_ENV_RE.test(keyEnv)))
    throw new NyteDeskError(400, "keyEnv must be an environment variable name starting with NYTEDESK_");
  let url = null;
  if (baseUrl !== null) {
    if (typeof baseUrl !== "string" || baseUrl.length > 300) throw new NyteDeskError(400, "Invalid baseUrl");
    let u;
    try { u = new URL(baseUrl); } catch { throw new NyteDeskError(400, "Invalid baseUrl"); }
    if (u.username || u.password || u.search || u.hash) throw new NyteDeskError(400, "baseUrl cannot carry credentials, a query or a fragment");
    if (OFFICIAL_API[id]) {
      if (u.origin !== OFFICIAL_API[id]) throw new NyteDeskError(400, `${id} must use its official API origin ${OFFICIAL_API[id]}`);
    } else if (!["http:", "https:"].includes(u.protocol) || !isLocalLiteral(u.hostname)) {
      throw new NyteDeskError(400, `${id} must be a loopback, private or tailnet IP literal (no host names)`);
    }
    url = u.origin + u.pathname.replace(/\/+$/, "");
  }
  if (OFFICIAL_API[id] && keyEnv === null && (baseUrl !== null || model !== null))
    throw new NyteDeskError(400, `${id} needs keyEnv naming the environment variable that holds its API key`);
  return { kind: id, baseUrl: url, model, keyEnv, expectedVersion };
}

function createService(store, options = {}) {
  const env = options.env ?? process.env;

  function publicTask(task) {
    return { ...task, executionEnabled: false };
  }

  const service = {
    status() {
      return { phase: 1, executionEnabled: false, browserAutomation: false, vmOperations: false, storage: "sqlite" };
    },

    agents() {
      const configured = new Map(store.listProviders().map((p) => [p.id, p]));
      return cp.listAdapters().map((a) => {
        const p = configured.get(a.id);
        return {
          id: a.id,
          configured: !!(p && (p.baseUrl || p.model)),
          keyPresent: !!(p && p.keyEnv && typeof env[p.keyEnv] === "string" && env[p.keyEnv].length > 0),
          executionEnabled: false,
        };
      });
    },

    createTask(actor, workspace, body, idempotencyKey) {
      assertActor(actor);
      if (!workspace || !Number.isSafeInteger(Number(workspace.id))) throw new NyteDeskError(404, "Workspace not found");
      if (!body || typeof body !== "object") throw new NyteDeskError(400, "Invalid body");
      const { description, adapter, action } = body;
      const route = `POST /nytedesk/workspaces/${workspace.slug}/tasks`;
      return store.idempotent(actor.id, idempotencyKey, requestHash("POST", route, { description, adapter, action }), () => ({
        status: 201,
        body: { task: publicTask(store.insertTask({ workspace, actor, description, adapter, action })) },
      }));
    },

    /** Raw stored task (no authorization); routes must check workspace access before using it. */
    getTaskRecord(id) {
      return store.getTask(id);
    },

    listTasks(actor, workspaceIds, { status, limit } = {}) {
      assertActor(actor);
      if (status && !Object.values(cp.STATES).includes(status)) throw new NyteDeskError(400, "Unknown status");
      return store.listTasks({ workspaceIds, status, limit }).map(publicTask);
    },

    pendingApprovals(actor, workspaceIds) {
      assertActor(actor);
      return store.listTasks({ workspaceIds, status: cp.STATES.WAITING, limit: 200 })
        .map((t) => ({ ...publicTask(t), canDecide: canDecide(actor, t) }));
    },

    getTask(actor, task) {
      assertActor(actor);
      const v = store.verifyAudit(task.id);
      return {
        task: publicTask(task),
        audit: store.auditFor(task.id),
        auditVerified: v.ok,
        auditProblems: v.problems,
        canDecide: task.status === cp.STATES.WAITING && canDecide(actor, task),
        canCancel: ["waiting_approval", "approved", "running"].includes(task.status)
          && (Number(actor.id) === task.requesterId || DECIDER_ROLES.includes(actor.role)),
      };
    },

    decide(actor, task, decision, body, idempotencyKey) {
      assertActor(actor);
      if (!["approve", "deny"].includes(decision)) throw new NyteDeskError(400, "Unknown decision");
      if (Number(actor.id) === task.requesterId) throw new NyteDeskError(403, "Requester cannot approve or deny their own task");
      if (!canDecide(actor, task))
        throw new NyteDeskError(403, cp.ADMIN_APPROVAL_ACTIONS.includes(task.action)
          ? "Only an administrator may decide this action" : "Only a manager or administrator may decide tasks");
      const { expectedVersion, payloadHash, reason } = body || {};
      if (!Number.isSafeInteger(expectedVersion)) throw new NyteDeskError(400, "expectedVersion is required");
      if (typeof payloadHash !== "string") throw new NyteDeskError(400, "payloadHash of the reviewed task is required");
      const route = `POST /nytedesk/tasks/${task.id}/${decision}`;
      return store.idempotent(actor.id, idempotencyKey, requestHash("POST", route, { expectedVersion, payloadHash, reason: reason ?? null }), () => ({
        status: 200,
        body: { task: publicTask(store.decideTask(task.id, actor, { decision, expectedVersion, payloadHash, reason })) },
      }));
    },

    cancel(actor, task, body, idempotencyKey) {
      assertActor(actor);
      if (Number(actor.id) !== task.requesterId && !DECIDER_ROLES.includes(actor.role))
        throw new NyteDeskError(403, "Only the requester or a manager/administrator may cancel");
      const { expectedVersion, reason } = body || {};
      if (!Number.isSafeInteger(expectedVersion)) throw new NyteDeskError(400, "expectedVersion is required");
      const route = `POST /nytedesk/tasks/${task.id}/cancel`;
      return store.idempotent(actor.id, idempotencyKey, requestHash("POST", route, { expectedVersion, reason: reason ?? null }), () => ({
        status: 200,
        body: { task: publicTask(store.cancelTask(task.id, actor, { expectedVersion, reason })) },
      }));
    },

    providers(actor) {
      assertActor(actor);
      if (!DECIDER_ROLES.includes(actor.role)) throw new NyteDeskError(403, "Managers and administrators only");
      const stored = new Map(store.listProviders().map((p) => [p.id, p]));
      return cp.ALLOWED_ADAPTERS.map((id) => {
        const p = stored.get(id);
        return {
          id, kind: id, baseUrl: p?.baseUrl ?? null, model: p?.model ?? null, keyEnv: p?.keyEnv ?? null,
          keyPresent: !!(p?.keyEnv && typeof env[p.keyEnv] === "string" && env[p.keyEnv].length > 0),
          version: p?.version ?? 0, updatedBy: p?.updatedBy ?? null, updatedAt: p?.updatedAt ?? null, executionEnabled: false,
        };
      });
    },

    putProvider(actor, id, body, idempotencyKey) {
      assertActor(actor);
      if (actor.role !== "admin") throw new NyteDeskError(403, "Only administrators may change provider configuration");
      const cfg = validateProvider(id, body);
      const route = `PUT /nytedesk/providers/${id}`;
      return store.idempotent(actor.id, idempotencyKey, requestHash("PUT", route, cfg), () => {
        store.putProvider(id, actor, cfg);
        return { status: 200, body: { provider: service.providers(actor).find((p) => p.id === id) } };
      });
    },
  };
  return service;
}

module.exports = { createService, canDecide, validateProvider, isLocalLiteral };
