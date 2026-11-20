// NyteDesk test harness: a minimal express-like app over node:http, used by the
// NyteDesk integration tests with stub authentication.
const http = require("node:http");

// ------------------------------------------------------------------ a minimal express-like app
function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ["get", "post", "put", "delete"]) {
    app[method] = (pattern, mws, handler) => {
      const keys = [];
      const re = new RegExp("^" + pattern.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
      routes.push({ method: method.toUpperCase(), pattern, re, keys, chain: [...(Array.isArray(mws) ? mws : [mws]), ...(handler ? [handler] : [])] });
    };
  }
  return { app, routes };
}

function serve(routes) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      const url = new URL(req.url, "http://x");
      const p = url.pathname.replace(/^\/api/, "");
      const route = routes.find((r) => r.method === req.method && r.re.test(p));
      const response = {
        locals: {},
        headers: {},
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        set(k, v) { this.headers[k] = v; return this; },
        json(obj) { res.writeHead(this.statusCode, { "content-type": "application/json", ...this.headers }); res.end(JSON.stringify(obj)); },
        sendStatus(code) { res.writeHead(code); res.end(); },
      };
      if (!route) return response.status(404).json({ error: "no route" });
      const m = p.match(route.re);
      const request = {
        params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])),
        query: Object.fromEntries(url.searchParams),
        body: raw ? JSON.parse(raw) : {},
        header: (name) => req.headers[name.toLowerCase()],
      };
      let i = 0;
      const next = async () => { const fn = route.chain[i++]; if (fn) await fn(request, response, next); };
      await next();
    });
  });
}

module.exports = { makeApp, serve };
