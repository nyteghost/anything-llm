/**
 * NyteDesk task and approval API, mounted on the AnythingLLM API router.
 * Disabled unless NYTEDESK_ENABLED=true. Requires multi-user mode. No route
 * executes anything. See NYTEDESK_CONTROL_PLANE.md.
 */
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { userFromSession } = require("../utils/http");
const { SystemSettings } = require("../models/systemSettings");
const { Workspace } = require("../models/workspace");
const { createNyteDeskRoutes } = require("../utils/nytedesk/routes.cjs");

let service = null;
function getService() {
  if (!service) {
    const { openStore } = require("../utils/nytedesk/store.cjs");
    const { createService } = require("../utils/nytedesk/service.cjs");
    service = createService(openStore());
  }
  return service;
}

async function isMultiUser(_request, response) {
  const known = response?.locals?.multiUserMode;
  if (typeof known === "boolean") return known;
  return await SystemSettings.isMultiUserMode();
}

function nytedeskEndpoints(app) {
  if (!app) return;
  createNyteDeskRoutes(app, {
    auth: [validatedRequest],
    enabled: () => process.env.NYTEDESK_ENABLED === "true",
    isMultiUser,
    currentUser: (request, response) => userFromSession(request, response),
    workspaceBySlug: (user, slug) =>
      Workspace.getWithUser(user, { slug: String(slug) }),
    workspaceById: (user, id) =>
      Workspace.getWithUser(user, { id: Number(id) }),
    accessibleWorkspaces: (user) => Workspace.whereWithUser(user),
    service: getService,
  });
}

module.exports = { nytedeskEndpoints };
