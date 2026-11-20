"use strict";

/**
 * NyteDesk Local AI Manager.
 *
 * Read-only: it registers local inference engines, probes their model-list
 * endpoint over loopback HTTP, and reports availability. It never spawns,
 * stops, restarts, unloads or kills a process, never inspects the process
 * table, and never matches processes by name. Every running engine is treated
 * as externally owned.
 *
 * A future VM-local service must authenticate every caller, verify the exact
 * launch binary and its arguments against a trusted administrator policy, and
 * enforce process ownership outside this module.
 */
const http = require("node:http");

/**
 * Supported engines.
 * - Ollama: native API, default http://127.0.0.1:11434, models at /api/tags.
 * - PolyStrata: OpenAI-compatible API. The base URL includes /v1 and the port
 *   changes between sessions, so there is no default: the owner configures it.
 * - Strata: configurable endpoint and API style; no endpoint is assumed.
 */
const ENGINES = Object.freeze({
  ollama: Object.freeze({
    id: "ollama",
    name: "Ollama",
    api: "ollama",
    defaultEndpoint: "http://127.0.0.1:11434",
    defaultPort: 11434,
    apiPath: "/api/tags",
  }),
  strata: Object.freeze({
    id: "strata",
    name: "Strata",
    api: null,
    defaultEndpoint: null,
    defaultPort: null,
    apiPath: null,
  }),
  polystrata: Object.freeze({
    id: "polystrata",
    name: "PolyStrata",
    api: "openai",
    defaultEndpoint: null,
    defaultPort: null,
    apiPath: "/models",
  }),
});

const API_KINDS = Object.freeze(["ollama", "openai"]);
const MODELS_PATH = Object.freeze({ ollama: "/api/tags", openai: "/models" });

const STATUSES = Object.freeze({
  UNKNOWN: "unknown",
  EXTERNAL: "external", // reachable, but not started by NyteDesk
  STOPPED: "stopped",
  STARTING: "starting",
  MANAGED: "managed",
  STOPPING: "stopping",
  FAILED: "failed",
});

const DIAGNOSTICS = Object.freeze({
  OK: "Engine reachable; models listed.",
  NOT_CONFIGURED: "No endpoint is configured for this engine.",
  API_UNKNOWN: "The engine's API style (ollama or openai) is not configured.",
  CONNECTION_REFUSED:
    "Connection refused: nothing is listening on that port. The engine may not be running, or the port changed.",
  TIMEOUT: "The engine did not answer within the time limit.",
  NETWORK_ERROR: "The request failed before a response arrived.",
  REDIRECT_REFUSED:
    "The engine answered with a redirect, which is not followed.",
  HTTP_ERROR: "The engine answered with an HTTP error status.",
  RESPONSE_TOO_LARGE: "The model list exceeded the size limit.",
  INVALID_JSON: "The engine's answer was not valid JSON.",
  UNEXPECTED_SHAPE:
    "The answer was JSON but not a model list for the configured API style.",
  NO_MODELS: "The engine is reachable but lists no models.",
  MODEL_NOT_LISTED: "The selected model is not in the engine's model list.",
});

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function requireEngine(id) {
  if (!Object.hasOwn(ENGINES, id)) {
    throw new TypeError("Unknown inference engine");
  }
  return ENGINES[id];
}

/**
 * Loopback HTTP only: no DNS resolution, no credentials, query, fragment or
 * dot segments, and an explicit unprivileged port.
 */
function parseLoopbackEndpoint(input) {
  if (typeof input !== "string") {
    throw new TypeError("Endpoint must be a string");
  }
  if (/\.\./.test(input)) {
    throw new TypeError(
      "Only explicit unprivileged HTTP loopback endpoints are supported"
    );
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError("Invalid endpoint URL");
  }
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.protocol !== "http:" ||
    !loopback ||
    !url.port ||
    Number(url.port) < 1024 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "Only explicit unprivileged HTTP loopback endpoints are supported"
    );
  }
  return `http://${url.host}${url.pathname.replace(/\/+$/, "")}`;
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
  if (registration.managedProcess !== null) {
    throw new Error("Invalid unmanaged registration");
  }
  if (typeof healthy !== "boolean") {
    throw new TypeError("Expected boolean health result");
  }
  return Object.freeze({
    ...registration,
    status: healthy ? STATUSES.EXTERNAL : STATUSES.STOPPED,
    canStart: false,
    canStop: false,
  });
}

function selectEngine(registry, engineId) {
  requireEngine(engineId);
  if (!registry || !Object.hasOwn(registry, engineId)) {
    throw new Error("Engine not registered");
  }
  const entry = registry[engineId];
  if (entry.id !== engineId || entry.status !== STATUSES.EXTERNAL) {
    throw new Error("Selected engine is not verified as healthy");
  }
  return Object.freeze({ selected: engineId, endpoint: entry.endpoint });
}

/** No process actions until a separately reviewed VM-local executor exists. */
function requestProcessAction() {
  throw new Error("Process control disabled pending security review");
}

/** The model names in a model-list answer, or null if the shape is wrong. */
function modelNames(api, body) {
  if (api === "ollama") {
    if (!body || !Array.isArray(body.models)) return null;
    return body.models
      .map((m) => (m && (m.name || m.model)) || null)
      .filter((n) => typeof n === "string");
  }
  if (!body || !Array.isArray(body.data)) return null;
  return body.data
    .map((m) => (m && m.id) || null)
    .filter((n) => typeof n === "string");
}

/** One GET to a loopback URL: no redirects, no proxy, bounded time and size. */
function getJson(urlText, { timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    const url = new URL(urlText);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const options = {
      host,
      port: Number(url.port),
      path: url.pathname,
      method: "GET",
      headers: { accept: "application/json" },
      agent: false,
    };
    let settled = false;
    const done = (out) => {
      if (!settled) {
        settled = true;
        resolve(out);
      }
    };
    const req = http.request(options, (res) => {
      const status = res.statusCode;
      if (status >= 300 && status < 400) {
        res.resume();
        return done({ code: "REDIRECT_REFUSED", httpStatus: status });
      }
      let size = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          return done({ code: "RESPONSE_TOO_LARGE", httpStatus: status });
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (status < 200 || status >= 300) {
          return done({ code: "HTTP_ERROR", httpStatus: status });
        }
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          done({ code: "OK", httpStatus: status, body: JSON.parse(text) });
        } catch {
          done({ code: "INVALID_JSON", httpStatus: status });
        }
      });
      res.on("error", () => done({ code: "NETWORK_ERROR" }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ code: "TIMEOUT" });
    });
    req.on("error", (error) => {
      const refused = error && error.code === "ECONNREFUSED";
      done({ code: refused ? "CONNECTION_REFUSED" : "NETWORK_ERROR" });
    });
    req.end();
  });
}

/**
 * Probe one engine's model list. Read-only; resolves (never rejects) with a
 * status of "external" (reachable, externally owned), "stopped" (nothing
 * answering) or "failed" (answered, but unusable), plus diagnostics.
 */
async function probeEngine(config, options = {}) {
  const engine = requireEngine(config.id);
  const now = options.now ?? (() => new Date().toISOString());
  const started = Date.now();
  const result = {
    id: engine.id,
    endpoint: config.endpoint ?? null,
    api: config.api ?? engine.api,
    model: config.model ?? null,
    status: STATUSES.UNKNOWN,
    reachable: false,
    httpStatus: null,
    models: [],
    modelListed: null,
    diagnostics: [],
    checkedAt: now(),
    latencyMs: null,
    canStart: false,
    canStop: false,
  };
  const diag = (code) => {
    result.diagnostics.push({ code, message: DIAGNOSTICS[code] });
  };
  if (!result.endpoint) {
    diag("NOT_CONFIGURED");
    return result;
  }
  if (!API_KINDS.includes(result.api)) {
    diag("API_UNKNOWN");
    return result;
  }
  let base;
  try {
    base = parseLoopbackEndpoint(result.endpoint);
  } catch (error) {
    result.status = STATUSES.FAILED;
    const message = error.message;
    result.diagnostics.push({ code: "INVALID_ENDPOINT", message });
    return result;
  }
  const out = await getJson(base + MODELS_PATH[result.api], {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? MAX_RESPONSE_BYTES,
  });
  result.latencyMs = Date.now() - started;
  result.httpStatus = out.httpStatus ?? null;
  if (out.code === "CONNECTION_REFUSED" || out.code === "TIMEOUT") {
    result.status = STATUSES.STOPPED;
    diag(out.code);
    return result;
  }
  if (out.code !== "OK") {
    result.status = STATUSES.FAILED;
    result.reachable = out.httpStatus !== undefined;
    diag(out.code);
    return result;
  }
  result.reachable = true;
  const names = modelNames(result.api, out.body);
  if (names === null) {
    result.status = STATUSES.FAILED;
    diag("UNEXPECTED_SHAPE");
    return result;
  }
  result.models = names.slice(0, 200);
  result.status = STATUSES.EXTERNAL;
  if (names.length === 0) diag("NO_MODELS");
  if (result.model) {
    result.modelListed = names.includes(result.model);
    if (!result.modelListed) diag("MODEL_NOT_LISTED");
  }
  if (result.diagnostics.length === 0) diag("OK");
  return result;
}

module.exports = {
  ENGINES,
  API_KINDS,
  STATUSES,
  DIAGNOSTICS,
  parseLoopbackEndpoint,
  registerEngine,
  observeEngine,
  selectEngine,
  requestProcessAction,
  modelNames,
  probeEngine,
};
