"use strict";

/**
 * NyteDesk HTTP routes (Phase 1), as a factory so they can be mounted on the AnythingLLM API
 * router (server/endpoints/nytedesk.js) and exercised over real HTTP in tests with stub
 * authentication. Every route:
 *   1. runs the injected authentication middleware (AnythingLLM `validatedRequest`);
 *   2. requires NYTEDESK_ENABLED=true, multi-user mode and an authenticated user, because
 *      independent approval needs distinct, verified identities;
 *   3. resolves workspaces only through the injected, permission-aware lookups.
 * A task in a workspace the user cannot access is reported as 404, never 403.
 * There is no route that starts, runs or executes a task.
 */
const { NyteDeskError } = require("./store.cjs");

const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function send(response, out) {
  if (out.replayed) response.set?.("Idempotent-Replayed", "true") ?? response.setHeader?.("Idempotent-Replayed", "true");
  return response.status(out.status).json(out.body);
}

function body(request) {
  const b = request.body;
  if (typeof b === "string") {
    try { return JSON.parse(b); } catch { throw new NyteDeskError(400, "Malformed JSON body"); }
  }
  return b ?? {};
}

function createNyteDeskRoutes(app, deps) {
  if (!app) return;
  const auth = deps.auth ?? [];

  async function gate(request, response, next) {
    try {
      if (!deps.enabled()) return response.status(403).json({ error: "NyteDesk is disabled (set NYTEDESK_ENABLED=true)", enabled: false });
      if (!(await deps.isMultiUser(request, response)))
        return response.status(403).json({ error: "NyteDesk requires multi-user mode so that approvals come from a different, authenticated user", enabled: true, multiUser: false });
      const user = await deps.currentUser(request, response);
      if (!user || !Number.isSafeInteger(Number(user.id)) || user.suspended)
        return response.status(401).json({ error: "An authenticated user is required" });
      response.locals = response.locals || {};
      response.locals.nytedeskActor = { id: Number(user.id), role: String(user.role), user };
      return next();
    } catch (error) {
      return fail(response, error);
    }
  }

  function fail(response, error) {
    if (error instanceof NyteDeskError || Number.isInteger(error?.status))
      return response.status(error.status).json({ error: error.message });
    console.error("[nytedesk]", error?.message);
    return response.status(500).json({ error: "NyteDesk internal error" });
  }

  function handler(fn) {
    return async (request, response) => {
      try {
        await fn(request, response, response.locals.nytedeskActor);
      } catch (error) {
        fail(response, error);
      }
    };
  }

  async function accessibleIds(actor) {
    const list = await deps.accessibleWorkspaces(actor.user);
    return (list || []).map((w) => Number(w.id)).filter(Number.isSafeInteger);
  }

  /** Load a task and confirm the actor may see its workspace; otherwise 404. */
  async function taskFor(request, actor) {
    const id = String(request.params.id || "");
    if (!TASK_ID_RE.test(id)) throw new NyteDeskError(404, "Task not found");
    const task = deps.service().getTaskRecord(id);
    if (!task) throw new NyteDeskError(404, "Task not found");
    const ws = await deps.workspaceById(actor.user, task.workspaceId);
    if (!ws) throw new NyteDeskError(404, "Task not found");
    return task;
  }

  const mw = [...auth, gate];

  app.get("/nytedesk/status", [...auth, async (request, response) => {
    try {
      const multiUser = await deps.isMultiUser(request, response);
      return response.status(200).json({ enabled: deps.enabled(), multiUser, ...(deps.enabled() ? deps.service().status() : { executionEnabled: false }) });
    } catch (error) {
      return fail(response, error);
    }
  }]);

  app.get("/nytedesk/agents", mw, handler(async (_req, res) => {
    res.status(200).json({ agents: deps.service().agents() });
  }));

  app.get("/nytedesk/workspaces", mw, handler(async (_req, res, actor) => {
    const list = await deps.accessibleWorkspaces(actor.user);
    res.status(200).json({ workspaces: (list || []).map((w) => ({ id: Number(w.id), slug: w.slug, name: w.name })) });
  }));

  app.get("/nytedesk/tasks", mw, handler(async (req, res, actor) => {
    let ids = await accessibleIds(actor);
    if (req.query?.workspace) {
      const ws = await deps.workspaceBySlug(actor.user, String(req.query.workspace));
      ids = ws ? [Number(ws.id)] : [];
    }
    res.status(200).json({ tasks: deps.service().listTasks(actor, ids, { status: req.query?.status, limit: req.query?.limit }) });
  }));

  app.get("/nytedesk/approvals", mw, handler(async (_req, res, actor) => {
    res.status(200).json({ approvals: deps.service().pendingApprovals(actor, await accessibleIds(actor)) });
  }));

  app.post("/nytedesk/workspaces/:slug/tasks", mw, handler(async (req, res, actor) => {
    const ws = await deps.workspaceBySlug(actor.user, String(req.params.slug));
    if (!ws) throw new NyteDeskError(404, "Workspace not found");
    send(res, deps.service().createTask(actor, { id: Number(ws.id), slug: ws.slug }, body(req), req.header("Idempotency-Key")));
  }));

  app.get("/nytedesk/tasks/:id", mw, handler(async (req, res, actor) => {
    res.status(200).json(deps.service().getTask(actor, await taskFor(req, actor)));
  }));

  for (const decision of ["approve", "deny"]) {
    app.post(`/nytedesk/tasks/:id/${decision}`, mw, handler(async (req, res, actor) => {
      send(res, deps.service().decide(actor, await taskFor(req, actor), decision, body(req), req.header("Idempotency-Key")));
    }));
  }

  app.post("/nytedesk/tasks/:id/cancel", mw, handler(async (req, res, actor) => {
    send(res, deps.service().cancel(actor, await taskFor(req, actor), body(req), req.header("Idempotency-Key")));
  }));

  app.get("/nytedesk/providers", mw, handler(async (_req, res, actor) => {
    res.status(200).json({ providers: deps.service().providers(actor) });
  }));

  app.put("/nytedesk/providers/:id", mw, handler(async (req, res, actor) => {
    send(res, deps.service().putProvider(actor, String(req.params.id), body(req), req.header("Idempotency-Key")));
  }));
}

module.exports = { createNyteDeskRoutes, TASK_ID_RE };
