"use strict";

/**
 * NyteDesk HTTP routes, as a factory so they can be mounted on the AnythingLLM
 * API router (server/endpoints/nytedesk.js) and exercised over real HTTP in
 * tests with stub authentication. Every route:
 *   1. runs the injected authentication middleware (`validatedRequest`);
 *   2. requires NYTEDESK_ENABLED=true, multi-user mode and an authenticated
 *      user, because independent approval needs distinct, verified identities;
 *   3. resolves workspaces only through the injected, permission-aware lookups.
 * A task in a workspace the user cannot access is reported as 404, never 403.
 * The only route that runs a task is POST /nytedesk/tasks/:id/run, and it
 * runs only approved engine model load/unload tasks when the owner has set
 * NYTEDESK_MODEL_CONTROL=true. Agent tasks are never run.
 */
const { NyteDeskError } = require("./store.cjs");

const TASK_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISABLED = "NyteDesk is disabled (set NYTEDESK_ENABLED=true)";
const SINGLE_USER =
  "NyteDesk requires multi-user mode so that approvals come from a different, authenticated user";

function send(response, out) {
  if (out.replayed) response.set("Idempotent-Replayed", "true");
  return response.status(out.status).json(out.body);
}

function body(request) {
  const b = request.body;
  if (typeof b !== "string") return b ?? {};
  try {
    return JSON.parse(b);
  } catch {
    throw new NyteDeskError(400, "Malformed JSON body");
  }
}

function fail(response, error) {
  if (error instanceof NyteDeskError || Number.isInteger(error?.status)) {
    return response.status(error.status).json({ error: error.message });
  }
  console.error("[nytedesk]", error?.message);
  return response.status(500).json({ error: "NyteDesk internal error" });
}

function createNyteDeskRoutes(app, deps) {
  if (!app) return;
  const auth = deps.auth ?? [];

  async function gate(request, response, next) {
    try {
      if (!deps.enabled()) {
        return response.status(403).json({ error: DISABLED, enabled: false });
      }
      if (!(await deps.isMultiUser(request, response))) {
        const out = { error: SINGLE_USER, enabled: true, multiUser: false };
        return response.status(403).json(out);
      }
      const user = await deps.currentUser(request, response);
      if (!user || !Number.isSafeInteger(Number(user.id)) || user.suspended) {
        const out = { error: "An authenticated user is required" };
        return response.status(401).json(out);
      }
      response.locals = response.locals || {};
      const actor = { id: Number(user.id), role: String(user.role), user };
      response.locals.nytedeskActor = actor;
      return next();
    } catch (error) {
      return fail(response, error);
    }
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

  const key = (request) => request.header("Idempotency-Key");
  const mw = [...auth, gate];

  app.get("/nytedesk/status", [
    ...auth,
    async (request, response) => {
      try {
        const enabled = deps.enabled();
        const multiUser = await deps.isMultiUser(request, response);
        const extra = enabled
          ? deps.service().status()
          : { executionEnabled: false };
        return response.status(200).json({ enabled, multiUser, ...extra });
      } catch (error) {
        return fail(response, error);
      }
    },
  ]);

  app.get(
    "/nytedesk/agents",
    mw,
    handler(async (_req, res) => {
      const svc = deps.service();
      res
        .status(200)
        .json({ agents: svc.agents(), components: svc.components() });
    })
  );

  app.get(
    "/nytedesk/workspaces",
    mw,
    handler(async (_req, res, actor) => {
      const list = await deps.accessibleWorkspaces(actor.user);
      const workspaces = (list || []).map((w) => ({
        id: Number(w.id),
        slug: w.slug,
        name: w.name,
      }));
      res.status(200).json({ workspaces });
    })
  );

  app.get(
    "/nytedesk/tasks",
    mw,
    handler(async (req, res, actor) => {
      let ids = await accessibleIds(actor);
      if (req.query?.workspace) {
        const slug = String(req.query.workspace);
        const ws = await deps.workspaceBySlug(actor.user, slug);
        ids = ws ? [Number(ws.id)] : [];
      }
      const filters = { status: req.query?.status, limit: req.query?.limit };
      const tasks = deps.service().listTasks(actor, ids, filters);
      res.status(200).json({ tasks });
    })
  );

  app.get(
    "/nytedesk/approvals",
    mw,
    handler(async (_req, res, actor) => {
      const ids = await accessibleIds(actor);
      const approvals = deps.service().pendingApprovals(actor, ids);
      res.status(200).json({ approvals });
    })
  );

  app.post(
    "/nytedesk/workspaces/:slug/tasks",
    mw,
    handler(async (req, res, actor) => {
      const slug = String(req.params.slug);
      const ws = await deps.workspaceBySlug(actor.user, slug);
      if (!ws) throw new NyteDeskError(404, "Workspace not found");
      const workspace = { id: Number(ws.id), slug: ws.slug };
      const svc = deps.service();
      send(res, svc.createTask(actor, workspace, body(req), key(req)));
    })
  );

  app.get(
    "/nytedesk/tasks/:id",
    mw,
    handler(async (req, res, actor) => {
      const task = await taskFor(req, actor);
      res.status(200).json(deps.service().getTask(actor, task));
    })
  );

  for (const decision of ["approve", "deny"]) {
    app.post(
      `/nytedesk/tasks/:id/${decision}`,
      mw,
      handler(async (req, res, actor) => {
        const task = await taskFor(req, actor);
        const svc = deps.service();
        send(res, svc.decide(actor, task, decision, body(req), key(req)));
      })
    );
  }

  app.post(
    "/nytedesk/tasks/:id/cancel",
    mw,
    handler(async (req, res, actor) => {
      const task = await taskFor(req, actor);
      send(res, deps.service().cancel(actor, task, body(req), key(req)));
    })
  );

  app.post(
    "/nytedesk/tasks/:id/run",
    mw,
    handler(async (req, res, actor) => {
      const task = await taskFor(req, actor);
      const out = await deps.service().runTask(actor, task, body(req));
      res.status(200).json(out);
    })
  );

  app.get(
    "/nytedesk/telemetry",
    mw,
    handler(async (_req, res, actor) => {
      res.set("Cache-Control", "no-store");
      res.status(200).json({ telemetry: deps.service().telemetry(actor) });
    })
  );

  app.get(
    "/nytedesk/engines",
    mw,
    handler(async (_req, res, actor) => {
      res.status(200).json(deps.service().engines(actor));
    })
  );

  app.put(
    "/nytedesk/engines/:id",
    mw,
    handler(async (req, res, actor) => {
      const id = String(req.params.id);
      const svc = deps.service();
      send(res, svc.putEngine(actor, id, body(req), key(req)));
    })
  );

  app.post(
    "/nytedesk/engines/:id/check",
    mw,
    handler(async (req, res, actor) => {
      const id = String(req.params.id);
      const check = await deps.service().checkEngine(actor, id);
      res.status(200).json({ check });
    })
  );

  // Explicit refusal, so clients get a clear answer: no process control.
  app.post(
    "/nytedesk/engines/:id/process",
    mw,
    handler(async (req, _res, actor) => {
      deps.service().processAction(actor, String(req.params.id));
    })
  );

  app.put(
    "/nytedesk/engine-selection",
    mw,
    handler(async (req, res, actor) => {
      const svc = deps.service();
      send(res, svc.selectEngine(actor, body(req), key(req)));
    })
  );

  app.get(
    "/nytedesk/providers",
    mw,
    handler(async (_req, res, actor) => {
      res.status(200).json({ providers: deps.service().providers(actor) });
    })
  );

  app.put(
    "/nytedesk/providers/:id",
    mw,
    handler(async (req, res, actor) => {
      const id = String(req.params.id);
      const svc = deps.service();
      send(res, svc.putProvider(actor, id, body(req), key(req)));
    })
  );
}

module.exports = { createNyteDeskRoutes, TASK_ID_RE };
