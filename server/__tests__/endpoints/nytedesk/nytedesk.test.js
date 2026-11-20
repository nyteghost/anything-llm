/* eslint-env jest */
// NyteDesk routes mounted with the real AnythingLLM auth middleware
// (validatedRequest, JWT verification, user lookup, suspension check).
// Models are mocked; the NyteDesk SQLite store is real, in a temp folder.
const fs = require("fs");
const os = require("os");
const path = require("path");

const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "nytedesk-jest-"));
process.env.STORAGE_DIR = STORAGE;
process.env.JWT_SECRET = "nytedesk-test-secret";
process.env.NYTEDESK_ENABLED = "true";
delete process.env.AUTH_TOKEN;

let sqliteAvailable = true;
try {
  require("node:sqlite");
} catch {
  sqliteAvailable = false;
}

const mockUsers = {
  1: { id: 1, username: "admin", role: "admin", suspended: 0 },
  2: { id: 2, username: "manager", role: "manager", suspended: 0 },
  3: { id: 3, username: "dev", role: "default", suspended: 0 },
  4: { id: 4, username: "outsider", role: "default", suspended: 0 },
  5: { id: 5, username: "gone", role: "admin", suspended: 1 },
};
const mockWorkspaces = [
  { id: 10, slug: "alpha", name: "Alpha" },
  { id: 20, slug: "beta", name: "Beta" },
];
const mockMembers = { 3: [10], 4: [20] };
const mockVisible = (user) =>
  ["admin", "manager"].includes(user.role)
    ? mockWorkspaces
    : mockWorkspaces.filter((w) => (mockMembers[user.id] || []).includes(w.id));

const mockMultiUser = { value: true };
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: {
    isMultiUserMode: jest.fn(async () => mockMultiUser.value),
  },
}));
jest.mock("../../../models/user", () => ({
  User: { get: jest.fn(async ({ id }) => mockUsers[id] || null) },
}));
jest.mock("../../../models/workspace", () => ({
  Workspace: {
    getWithUser: jest.fn(async (user, clause) => {
      const list = mockVisible(user);
      if (clause.slug) return list.find((w) => w.slug === clause.slug) || null;
      return list.find((w) => w.id === clause.id) || null;
    }),
    whereWithUser: jest.fn(async (user) => mockVisible(user)),
  },
}));

const express = require("express");
const bodyParser = require("body-parser");
const JWT = require("jsonwebtoken");
const { makeJWT } = require("../../../utils/http");

const suite = sqliteAvailable ? describe : describe.skip;

suite("NyteDesk API with real AnythingLLM authentication", () => {
  let server;
  let base;
  let n = 0;
  const token = (id) => makeJWT({ id, username: mockUsers[id].username }, "1h");

  beforeAll(async () => {
    const { nytedeskEndpoints } = require("../../../endpoints/nytedesk");
    const app = express();
    app.use(bodyParser.json());
    const router = express.Router();
    app.use("/api", router);
    nytedeskEndpoints(router);
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(STORAGE, { recursive: true, force: true });
  });

  async function call(method, route, { auth, body, key } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    if (key) headers["Idempotency-Key"] = key;
    const res = await fetch(base + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  const newKey = () => `jest-key-${++n}-${Date.now()}`;
  const task = {
    description: "Summarize the README",
    adapter: "ollama",
    action: "model.prompt",
  };

  it("rejects a missing token, a forged token and a suspended user", async () => {
    expect((await call("GET", "/nytedesk/agents")).status).toBe(401);
    const forged = JWT.sign({ id: 1 }, "not-the-secret");
    expect((await call("GET", "/nytedesk/agents", { auth: forged })).status).toBe(401);
    expect((await call("GET", "/nytedesk/agents", { auth: token(5) })).status).toBe(401);
    expect((await call("GET", "/nytedesk/agents", { auth: token(3) })).status).toBe(200);
  });

  it("takes the requester from the verified session and enforces approval roles", async () => {
    const created = await call("POST", "/nytedesk/workspaces/alpha/tasks", {
      auth: token(3),
      key: newKey(),
      body: { ...task, requesterId: 1 },
    });
    expect(created.status).toBe(201);
    const t = created.body.task;
    expect(t.requesterId).toBe(3);
    const decision = { expectedVersion: t.version, payloadHash: t.payloadHash };
    const self = await call("POST", `/nytedesk/tasks/${t.id}/approve`, {
      auth: token(3),
      key: newKey(),
      body: decision,
    });
    expect(self.status).toBe(403);
    const outsider = await call("GET", `/nytedesk/tasks/${t.id}`, {
      auth: token(4),
    });
    expect(outsider.status).toBe(404);
    const ok = await call("POST", `/nytedesk/tasks/${t.id}/approve`, {
      auth: token(2),
      key: newKey(),
      body: decision,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.task.approval.by).toBe(2);
    expect(ok.body.task.executionEnabled).toBe(false);
  });

  it("keeps workspace isolation for creation", async () => {
    const r = await call("POST", "/nytedesk/workspaces/beta/tasks", {
      auth: token(3),
      key: newKey(),
      body: task,
    });
    expect(r.status).toBe(404);
  });

  it("refuses engine process control and non-admin engine changes", async () => {
    const engines = await call("GET", "/nytedesk/engines", { auth: token(3) });
    expect(engines.status).toBe(200);
    expect(engines.body.processControl).toBe(false);
    const stop = await call("POST", "/nytedesk/engines/ollama/process", {
      auth: token(1),
      body: { action: "stop" },
    });
    expect(stop.status).toBe(403);
    const change = await call("PUT", "/nytedesk/engines/ollama", {
      auth: token(2),
      key: newKey(),
      body: { endpoint: "http://127.0.0.1:11434", expectedVersion: 0 },
    });
    expect(change.status).toBe(403);
  });

  it("is off without NYTEDESK_ENABLED and refused in single-user mode", async () => {
    process.env.NYTEDESK_ENABLED = "false";
    expect((await call("GET", "/nytedesk/agents", { auth: token(1) })).status).toBe(403);
    process.env.NYTEDESK_ENABLED = "true";
    mockMultiUser.value = false;
    const single = await call("GET", "/nytedesk/agents", { auth: token(1) });
    expect(single.status).toBe(403);
    expect(single.body.error).toMatch(/multi-user mode/);
    mockMultiUser.value = true;
  });
});
