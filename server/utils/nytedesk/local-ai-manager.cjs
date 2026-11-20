"use strict";

/**
 * NyteDesk Local AI Manager — policy-only foundation.
 * No process spawning, process killing, HTTP requests, or host inspection.
 * A future VM-local service must authenticate every caller, verify the exact
 * launch binary and its arguments against a trusted administrator policy, and
 * enforce process ownership outside this module.
 */

const ENGINES = Object.freeze({
  ollama: Object.freeze({ id: "ollama", name: "Ollama", defaultPort: 11434, apiPath: "/api/tags" }),
  strata: Object.freeze({ id: "strata", name: "Strata", defaultPort: null, apiPath: null }),
  polystrata: Object.freeze({ id: "polystrata", name: "PolyStrata", defaultPort: null, apiPath: "/v1/models" }),
});

const STATUSES = Object.freeze({
  UNKNOWN: "unknown",
  EXTERNAL: "external", // detected, but not started by NyteDesk
  STOPPED: "stopped",
  STARTING: "starting",
  MANAGED: "managed",
  STOPPING: "stopping",
  FAILED: "failed",
});

function requireEngine(id) {
  if (!Object.hasOwn(ENGINES, id)) throw new TypeError("Unknown inference engine");
  return ENGINES[id];
}

function parseLoopbackEndpoint(input) {
  if (typeof input !== "string") throw new TypeError("Endpoint must be a string");
  let url;
  try { url = new URL(input); }
  catch { throw new TypeError("Invalid endpoint URL"); }
  // Loopback-only in Phase 1. No DNS resolution, SSRF, credentials or query
  // strings. Explicitly forbid URLs that could target privileged local sockets.
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port || Number(url.port) < 1024 || url.username || url.password ||
      url.search || url.hash || /\.\./.test(url.pathname))
    throw new TypeError("Only explicit unprivileged HTTP loopback endpoints are supported");
  return `http://${url.host}${url.pathname.replace(/\/$/, "")}`;
}

function registerEngine({ id, endpoint, managed = false }) {
  requireEngine(id);
  if (managed !== false) throw new Error("Managed execution is not enabled");
  return Object.freeze({
    id,
    endpoint: parseLoopbackEndpoint(endpoint),
    status: STATUSES.UNKNOWN,
    managedProcess: null,
    canStart: false,
    canStop: false,
  });
}

function observeEngine(registration, { healthy }) {
  requireEngine(registration?.id);
  if (registration.managedProcess !== null) throw new Error("Invalid unmanaged registration");
  if (typeof healthy !== "boolean") throw new TypeError("Expected boolean health result");
  return Object.freeze({
    ...registration,
    status: healthy ? STATUSES.EXTERNAL : STATUSES.STOPPED,
    canStart: false,
    canStop: false,
  });
}

function selectEngine(registry, engineId) {
  requireEngine(engineId);
  if (!registry || !Object.hasOwn(registry, engineId))
    throw new Error("Engine not registered");
  const entry = registry[engineId];
  if (entry.id !== engineId || entry.status !== STATUSES.EXTERNAL)
    throw new Error("Selected engine is not verified as healthy");
  return Object.freeze({ selected: engineId, endpoint: entry.endpoint });
}

/** No process actions until a separately reviewed VM-local executor is ready. */
function requestProcessAction() {
  throw new Error("Process control disabled pending security review");
}

module.exports = {
  ENGINES, STATUSES, parseLoopbackEndpoint,
  registerEngine, observeEngine, selectEngine, requestProcessAction,
};
