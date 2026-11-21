// Stand-ins for the owner's desktop engines as seen through the SSH tunnels in
// NYTEDESK_OWNER_VERIFICATION.md §4 (VM loopback ports 41434, 41537, 41600).
// Every request is appended to MOCK_LOG as JSON so the rehearsal can prove the
// traffic was read-only. A control port lets the rehearsal "drop a tunnel".
const http = require("node:http");
const fs = require("node:fs");

const LOG = process.env.MOCK_LOG || "engine-requests.jsonl";
const PORTS = {
  ollama: Number(process.env.MOCK_OLLAMA_PORT || 41434),
  polystrata: Number(process.env.MOCK_POLYSTRATA_PORT || 41537),
  strata: Number(process.env.MOCK_STRATA_PORT || 41600),
  control: Number(process.env.MOCK_CONTROL_PORT || 41999),
};
const MODEL = "qwen3.6-35b-a3b-ud-q2_k_xl";
const ROUTES = {
  ollama: {
    "GET /api/tags": { models: [{ name: "qwen3:8b", model: "qwen3:8b" }, { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest" }] },
    "GET /api/ps": { models: [] },
    "GET /api/version": { version: "0.0.0-mock" },
    // AnythingLLM's own model picker may ask for model metadata (read-only).
    "POST /api/show": { model_info: { "general.architecture": "qwen3", "qwen3.context_length": 32768 }, capabilities: ["completion"] },
  },
  polystrata: { "GET /v1/models": { object: "list", data: [{ id: MODEL, object: "model" }] } },
  strata: {
    "GET /models": { object: "list", data: [{ id: "strata-local-model", object: "model" }] },
    "GET /v1/models": { object: "list", data: [{ id: "strata-local-model", object: "model" }] },
  },
};

const servers = {};
function engine(name) {
  return http.createServer((req, res) => {
    const key = `${req.method} ${req.url.split("?")[0]}`;
    fs.appendFileSync(LOG, JSON.stringify({ engine: name, method: req.method, path: req.url, at: new Date().toISOString() }) + "\n");
    const body = ROUTES[name][key];
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
  });
}
function start(name) {
  if (servers[name]?.listening) return Promise.resolve();
  servers[name] = engine(name);
  return new Promise((resolve) => servers[name].listen(PORTS[name], "127.0.0.1", resolve));
}
function stop(name) {
  return new Promise((resolve) => (servers[name]?.listening ? servers[name].close(resolve) : resolve()));
}

const control = http.createServer(async (req, res) => {
  const [, action, name] = req.url.split("/");
  if (req.method === "POST" && ["start", "stop"].includes(action) && ROUTES[name]) {
    await (action === "start" ? start(name) : stop(name));
    res.writeHead(200).end(`${action} ${name}\n`);
  } else res.writeHead(404).end();
});

(async () => {
  fs.writeFileSync(LOG, "");
  for (const name of Object.keys(ROUTES)) await start(name);
  control.listen(PORTS.control, "127.0.0.1");
  console.log(`mock engines: ollama ${PORTS.ollama}, polystrata ${PORTS.polystrata}, strata ${PORTS.strata}, control ${PORTS.control}`);
})();
