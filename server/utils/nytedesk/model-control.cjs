"use strict";

/**
 * NyteDesk engine model control: ask an already running Ollama, over its own
 * HTTP API, to load or unload one named model.
 *
 * - One HTTP request per operation, to the engine's configured loopback
 *   endpoint (parseLoopbackEndpoint). No redirects, no proxy, no
 *   credentials, bounded time and response size.
 * - No process is spawned, stopped or inspected; the engine stays externally
 *   owned. Starting or stopping the engine itself is still refused.
 * - Loading uses `POST /api/generate` with an empty prompt, which makes
 *   Ollama load the model without generating text. Unloading sends
 *   `keep_alive: 0`. `GET /api/ps` before and after shows the effect.
 *
 * Callers (service.runTask) are responsible for authorization, approval
 * re-checks and the audit record. Nothing here decides whether to act.
 */
const http = require("node:http");
const lam = require("./local-ai-manager.cjs");

const LOAD_TIMEOUT_MS = 180_000;
const UNLOAD_TIMEOUT_MS = 30_000;
const PS_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
// How long Ollama keeps a model loaded after NyteDesk loads it.
const KEEP_ALIVE = "30m";

/** One request to a loopback URL; resolves (never rejects) with a result. */
function requestJson(urlText, { method, payload, timeoutMs }) {
  return new Promise((resolve) => {
    const url = new URL(urlText);
    const data = payload === undefined ? null : JSON.stringify(payload);
    const headers = { accept: "application/json" };
    if (data !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(data);
    }
    const options = {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port),
      path: url.pathname,
      method,
      headers,
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
        if (size > MAX_RESPONSE_BYTES) {
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
    if (data !== null) req.write(data);
    req.end();
  });
}

/** Names of the models Ollama currently has loaded, or null on failure. */
async function loadedModels(endpoint, options = {}) {
  const base = lam.parseLoopbackEndpoint(endpoint);
  const out = await requestJson(`${base}/api/ps`, {
    method: "GET",
    timeoutMs: options.psTimeoutMs ?? PS_TIMEOUT_MS,
  });
  if (out.code !== "OK" || !out.body || !Array.isArray(out.body.models)) {
    return {
      ok: false,
      code: out.code === "OK" ? "UNEXPECTED_SHAPE" : out.code,
      httpStatus: out.httpStatus ?? null,
      models: null,
    };
  }
  const models = out.body.models
    .map((m) => (m && (m.name || m.model)) || null)
    .filter((n) => typeof n === "string" && n.length <= 256);
  return {
    ok: true,
    code: "OK",
    httpStatus: out.httpStatus,
    models: [...new Set(models)],
  };
}

/**
 * Load (`operation` "load") or unload ("unload") `model` in the Ollama at
 * `endpoint`. Resolves with { ok, code, httpStatus, durationMs, loadedAfter }.
 * `ok` is true only when the engine answered 2xx AND /api/ps afterwards shows
 * the expected state.
 */
async function runModelOperation({ endpoint, model, operation }, options = {}) {
  const base = lam.parseLoopbackEndpoint(endpoint);
  if (!["load", "unload"].includes(operation)) {
    throw new TypeError("Unknown model operation");
  }
  const payload =
    operation === "load"
      ? {
          model,
          prompt: "",
          stream: false,
          keep_alive: options.keepAlive ?? KEEP_ALIVE,
        }
      : { model, keep_alive: 0, stream: false };
  const started = Date.now();
  const answer = await requestJson(`${base}/api/generate`, {
    method: "POST",
    payload,
    timeoutMs:
      operation === "load"
        ? (options.loadTimeoutMs ?? LOAD_TIMEOUT_MS)
        : (options.unloadTimeoutMs ?? UNLOAD_TIMEOUT_MS),
  });
  const durationMs = Date.now() - started;
  const after = await loadedModels(base, options);
  const expected =
    after.ok &&
    (operation === "load"
      ? after.models.includes(model)
      : !after.models.includes(model));
  let code = answer.code;
  if (answer.code === "OK" && !after.ok) code = "STATE_UNVERIFIED";
  else if (answer.code === "OK" && !expected) code = "STATE_MISMATCH";
  return {
    ok: answer.code === "OK" && expected,
    code,
    httpStatus: answer.httpStatus ?? null,
    durationMs,
    loadedAfter: after.models,
  };
}

const DIAGNOSTICS = Object.freeze({
  OK: "The engine confirmed the operation.",
  STATE_UNVERIFIED:
    "The engine answered, but its loaded-model list could not be read afterwards.",
  STATE_MISMATCH:
    "The engine answered, but the loaded-model list does not show the expected change.",
  ...lam.DIAGNOSTICS,
});

module.exports = {
  KEEP_ALIVE,
  LOAD_TIMEOUT_MS,
  DIAGNOSTICS,
  loadedModels,
  runModelOperation,
};
