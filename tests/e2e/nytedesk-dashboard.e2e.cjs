// End-to-end check of the NyteDesk dashboard in the REAL running app: the
// AnythingLLM server (production mode) serving the production frontend build,
// a fresh SQLite database, real login, and headless Chrome. Inference engines
// are isolated mock HTTP servers on loopback; no real engine is contacted.
//
// Seeds three users (admin, manager, default), one workspace, engine settings
// and tasks through the public API, then drives the UI, asserts behaviour and
// saves screenshots. Exits non-zero on any failed assertion or page error.
//
// Env: BASE_URL (default http://127.0.0.1:3001), SHOTS_DIR, CHROME,
//      NODE_PATH containing playwright or playwright-core.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { chromium } = (() => {
  try {
    return require("playwright");
  } catch {
    return require("playwright-core");
  }
})();

const BASE = process.env.BASE_URL || "http://127.0.0.1:3001";
const API = `${BASE}/api`;
const SHOTS = process.env.SHOTS_DIR || path.resolve("nytedesk-screenshots");
const MODEL = "qwen3.6-35b-a3b-ud-q2_k_xl";
const pw = () => crypto.randomBytes(12).toString("hex"); // throwaway test passwords
const USERS = {
  admin: { username: "owner-admin", password: pw(), role: "admin" },
  manager: { username: "review-manager", password: pw(), role: "manager" },
  viewer: { username: "team-viewer", password: pw(), role: "default" },
};
const results = [];
const pageErrors = [];
const consoleErrors = [];
let lastPage = null; // for failure diagnostics

function ok(name) {
  results.push(name);
  console.log(`ok - ${name}`);
}

// ------------------------------------------------------------------ mocks
function mockEngine(pathName, body) {
  return http.createServer((req, res) => {
    const hit = req.method === "GET" && req.url === pathName;
    res.writeHead(hit ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(hit ? body : { error: "not found" }));
  });
}
// Fixed ports when given, so the server's own LLM setting can point at the mock.
const listen = (server, port = 0) =>
  new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));

// ------------------------------------------------------------------ API seeding
async function api(method, p, { token, body, key = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key && method !== "GET") headers["Idempotency-Key"] = `e2e-${crypto.randomUUID()}`;
  const r = await fetch(`${API}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${API}/ping`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("server did not start");
}

async function login(u) {
  const r = await api("POST", "/request-token", { body: { username: u.username, password: u.password }, key: false });
  assert.ok(r.valid && r.token, `login ${u.username}`);
  return r;
}

async function seed(ports) {
  await api("POST", "/onboarding", { key: false });
  await api("POST", "/system/enable-multi-user", {
    body: { username: USERS.admin.username, password: USERS.admin.password },
    key: false,
  });
  const admin = await login(USERS.admin);
  const ids = { admin: admin.user.id };
  for (const k of ["manager", "viewer"]) {
    const r = await api("POST", "/admin/users/new", { token: admin.token, body: USERS[k], key: false });
    ids[k] = r.user.id;
  }
  const { workspace } = await api("POST", "/workspace/new", { token: admin.token, body: { name: "NyteDesk Demo" }, key: false });
  await api("POST", `/admin/workspaces/${workspace.id}/update-users`, {
    token: admin.token,
    body: { userIds: [ids.manager, ids.viewer] },
    key: false,
  });
  const manager = await login(USERS.manager);
  const viewer = await login(USERS.viewer);

  // Engines: PolyStrata and Ollama on mock servers; Strata left unconfigured.
  const t = admin.token;
  await api("PUT", "/nytedesk/engines/polystrata", {
    token: t,
    body: { endpoint: `http://127.0.0.1:${ports.poly}/v1`, model: MODEL, contextWindow: 32768, vramReserveMiB: 1024, expectedVersion: 0 },
  });
  await api("PUT", "/nytedesk/engines/ollama", { token: t, body: { endpoint: `http://127.0.0.1:${ports.ollama}`, expectedVersion: 0 } });
  await api("POST", "/nytedesk/engines/polystrata/check", { token: t });
  await api("POST", "/nytedesk/engines/ollama/check", { token: t });
  await api("PUT", "/nytedesk/engine-selection", { token: t, body: { engineId: "polystrata", expectedSelectionId: null } });

  // Tasks covering several states.
  const slug = workspace.slug;
  const create = (token, adapter, action, description) =>
    api("POST", `/nytedesk/workspaces/${slug}/tasks`, { token, body: { adapter, action, description } }).then((r) => r.task);
  const decide = (token, task, op) =>
    api("POST", `/nytedesk/tasks/${task.id}/${op}`, {
      token,
      body: { expectedVersion: task.version, payloadHash: task.payloadHash, reason: `e2e ${op}` },
    }).then((r) => r.task);

  const approved = await create(t, "polystrata", "model.prompt", "Summarize the open NyteDesk roadmap items for the weekly review.");
  await decide(manager.token, approved, "approve");
  const rejected = await create(manager.token, "codex", "repository.read", "Read the anything-llm repository and list unused dependencies.");
  await decide(t, rejected, "deny");
  const cancelled = await create(t, "claude-code", "repository.read", "Draft a migration plan for the engines table.");
  await api("POST", `/nytedesk/tasks/${cancelled.id}/cancel`, { token: t, body: { expectedVersion: cancelled.version, reason: "e2e" } });
  const protectedTask = await create(
    manager.token,
    "claude-code",
    "vm.write",
    "Apply the reviewed font-slider patch inside the dedicated VM working copy (branch feature/nytedesk-dashboard-ui). Do not push."
  );
  const standardTask = await create(viewer.token, "codex", "repository.read", "Review PR #6 changes to the Local AI Manager for SSRF regressions.");
  return { admin, manager, viewer, slug, protectedTask, standardTask, approved };
}

// ------------------------------------------------------------------ browser
async function signIn(browser, u, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    acceptDownloads: true,
    ...options,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${u.username}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`${u.username}: ${m.text()}`));
  lastPage = page;
  await page.goto(`${BASE}/login`);
  await page.locator('input[name="username"]').first().fill(u.username);
  await page.locator('input[name="password"]').first().fill(u.password);
  await page.locator('button[type="submit"]').first().click();
  // Until a user has saved their recovery codes, every login shows them first
  // and stores the session only after Download, then Close.
  const download = page.getByRole("button", { name: "Download", exact: true });
  const shown = await download
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (shown) {
    await Promise.all([page.waitForEvent("download").catch(() => null), download.click()]);
    await page.getByRole("button", { name: "Close", exact: true }).click();
  }
  // The login page stores the session and then redirects home; wait for both.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30000 });
  await page.waitForFunction(
    () => !!localStorage.getItem("anythingllm_authToken") && !!localStorage.getItem("anythingllm_user"),
    null,
    { timeout: 20000 }
  );
  await page.waitForLoadState("networkidle");
  return { context, page };
}

const overlaps = (a, b) =>
  !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Counts requests whose URL matches `re` from now on. */
function countRequests(page, re) {
  const counter = { n: 0 };
  page.on("request", (r) => {
    if (re.test(r.url())) counter.n += 1;
  });
  return counter;
}

/** Freshness indicator plus top-bar controls: visible and not overlapping. */
async function checkTopBar(page, label) {
  const indicator = page.locator("[data-freshness]");
  const box = await indicator.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `${label}: freshness indicator visible`);
  const refreshBtn = await page.getByRole("button", { name: /Refresh dashboard data/ }).boundingBox();
  const textSize = await page.getByRole("banner").getByRole("button", { name: /text size/i }).boundingBox();
  const account = await page.locator("[data-user-menu]").boundingBox();
  const parts = { indicator: box, refresh: refreshBtn, textSize, account };
  const names = Object.keys(parts);
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++)
      assert.equal(overlaps(parts[names[i]], parts[names[j]]), false, `${label}: ${names[i]} overlaps ${names[j]}`);
  return indicator;
}

async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const poly = mockEngine("/v1/models", { object: "list", data: [{ id: MODEL, object: "model" }] });
  const ollama = mockEngine("/api/tags", { models: [{ name: "qwen3:8b" }, { name: "nomic-embed-text:latest" }] });
  const ports = {
    poly: await listen(poly, Number(process.env.MOCK_POLYSTRATA_PORT || 0)),
    ollama: await listen(ollama, Number(process.env.MOCK_OLLAMA_PORT || 0)),
  };
  await waitForServer();
  const s = await seed(ports);
  ok("seeded users, workspace, engines and tasks through the API");

  const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
  try {
    // ---------------- admin, desktop
    const { context, page } = await signIn(browser, USERS.admin);
    await page.goto(`${BASE}/nytedesk`);
    await page.getByRole("heading", { name: "Main dashboard" }).waitFor();
    const overview = page.getByRole("region", { name: "Overview" });
    await overview.getByText("PolyStrata").first().waitFor();
    await overview.getByText(MODEL).waitFor();
    assert.match(await overview.innerText(), /Pending approvals\s*2/);
    ok("dashboard shows the selected engine, model and 2 pending approvals from the API");

    const metrics = page.getByRole("region", { name: "System metrics" });
    await metrics.getByText(/of \d+ cores|Unavailable/).first().waitFor();
    assert.match(await metrics.innerText(), /GPU utilization\s*Unavailable/);
    assert.match(await metrics.innerText(), /Measured on the NyteDesk server host/);
    ok("metrics show real host values and 'Unavailable' for GPU, VRAM and throughput");

    for (const label of ["Start", "Stop", "Restart", "Unload", "Kill"]) {
      assert.equal(await page.getByRole("button", { name: label, exact: true }).count(), 0, label);
    }
    ok("no process-control buttons");

    // AnythingLLM's account button sits in the top bar without covering its controls.
    const account = await page.locator("[data-user-menu]").boundingBox();
    const textSizeButton = await page.getByRole("banner").getByRole("button", { name: /text size/i }).boundingBox();
    const banner = await page.getByRole("banner").boundingBox();
    assert.ok(account && textSizeButton, "account and text-size buttons are visible");
    assert.equal(overlaps(account, textSizeButton), false, "account button covers the text-size button");
    assert.ok(account.y + account.height <= banner.y + banner.height + 1, "account button stays inside the top bar");
    ok("account button sits inside the top bar without covering the text-size control");

    await page.getByRole("region", { name: "AI chat workspace and agent playground" }).waitFor();
    await page.locator("textarea").first().waitFor({ timeout: 20000 });
    ok("embedded AnythingLLM workspace chat renders with its prompt input");
    // F2: dashboard data refreshes when another session changes it.
    const freshness = page.locator("[data-freshness]");
    assert.equal(await freshness.getAttribute("data-freshness"), "fresh");
    const pending = async () => Number((await overview.innerText()).match(/Pending approvals\s*(\d+)/)[1]);
    const before = await pending();
    await api("POST", `/nytedesk/workspaces/${s.slug}/tasks`, {
      token: s.viewer.token,
      body: { adapter: "codex", action: "repository.read", description: "Created from another session to test dashboard refresh." },
    });
    await page.waitForTimeout(5500); // focus refresh is throttled to one per 5 s
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(
      (n) => new RegExp(`Pending approvals\\s*${n}\\b`).test(document.querySelector('[aria-label="Overview"]').innerText),
      before + 1,
      { timeout: 10000 }
    );
    ok("F2: a task created in another session appears after the window regains focus");

    // A failed refresh keeps the last good data and says so; recovery returns to fresh.
    const tasksApi = /\/api\/nytedesk\/tasks\?/;
    await page.route(tasksApi, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"simulated outage"}' })
    );
    await page.getByRole("button", { name: /Refresh dashboard data/ }).click();
    await page.waitForFunction(() => document.querySelector("[data-freshness]")?.dataset.freshness === "failed");
    assert.match(await freshness.innerText(), /Refresh failed; showing data from/);
    assert.equal(await pending(), before + 1);
    await page.unroute(tasksApi);
    await page.getByRole("button", { name: /Refresh dashboard data/ }).click();
    await page.waitForFunction(() => document.querySelector("[data-freshness]")?.dataset.freshness === "fresh");
    ok("F2: a failed refresh is shown as failed, keeps the last good data, and recovers");

    const desktopIndicator = await checkTopBar(page, "1440");
    assert.equal(await desktopIndicator.locator("[data-freshness-full]").isVisible(), true);
    assert.match(await desktopIndicator.locator("[data-freshness-full]").innerText(), /^Updated /);
    ok("N1: at 1440px the full freshness sentence is visible and clear of the other controls");

    // N3: overlapping refresh triggers while one request is in flight make one request.
    const slowTasks = /\/api\/nytedesk\/tasks\?/;
    await page.route(slowTasks, async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });
    const taskRequests = countRequests(page, slowTasks);
    await page.waitForTimeout(5200); // past the focus throttle
    await page.getByRole("button", { name: /Refresh dashboard data/ }).click();
    for (let i = 0; i < 5; i++) await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => document.querySelector("[data-freshness]")?.dataset.freshness === "fresh", null, { timeout: 10000 });
    assert.equal(taskRequests.n, 1, `overlapping refreshes made ${taskRequests.n} task requests`);
    ok("N3: a manual refresh plus five focus events during one request make exactly one request");

    // N3: unmount during a delayed refresh; nothing polls afterwards; remount is clean.
    const telemetryRequests = countRequests(page, /\/api\/nytedesk\/telemetry/);
    const errorsBefore = pageErrors.length;
    await page.getByRole("button", { name: /Refresh dashboard data/ }).click();
    await page.evaluate((target) => {
      window.history.pushState({}, "", target);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `/workspace/${s.slug}`);
    // The dashboard's embedded chat also has a textarea: wait for the route change itself.
    await page.waitForFunction(() => !document.querySelector(".nytedesk-app"), null, { timeout: 20000 });
    await page.locator("textarea").first().waitFor({ timeout: 20000 });
    assert.equal(await page.evaluate(() => document.body.classList.contains("nytedesk-route")), false);
    const tasksAtUnmount = taskRequests.n;
    telemetryRequests.n = 0;
    await page.waitForTimeout(11000); // > telemetry interval; the delayed response lands meanwhile
    assert.equal(telemetryRequests.n, 0, "telemetry kept polling after unmount");
    assert.equal(taskRequests.n, tasksAtUnmount, "data kept polling after unmount");
    assert.equal(pageErrors.length, errorsBefore, `page errors after unmount: ${pageErrors.slice(errorsBefore).join("; ")}`);
    await page.unroute(slowTasks);
    await page.evaluate(() => {
      window.history.pushState({}, "", "/nytedesk");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByRole("heading", { name: "Main dashboard" }).waitFor();
    await page.waitForFunction(() => document.querySelector("[data-freshness]")?.dataset.freshness === "fresh", null, { timeout: 10000 });
    assert.match(await page.getByRole("region", { name: "Overview" }).innerText(), /Pending approvals\s*\d+/);
    ok("N3: unmounting mid-refresh stops all polling, raises no errors, and remounting loads cleanly");

    await page.waitForTimeout(10500); // let a second telemetry sample arrive (CPU needs two)
    await shot(page, "01-dashboard-desktop-1440x900");

    // Resize the right sidebar from the keyboard; it must persist.
    const sep = page.getByRole("separator", { name: "Resize Activity sidebar" });
    await sep.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
    assert.equal(await sep.getAttribute("aria-valuenow"), "380");
    await page.reload();
    await page.getByRole("separator", { name: "Resize Activity sidebar" }).waitFor();
    assert.equal(await page.getByRole("separator", { name: "Resize Activity sidebar" }).getAttribute("aria-valuenow"), "380");
    ok("sidebar resizes from the keyboard and the width persists across reload");
    await shot(page, "02-dashboard-sidebar-widened");

    // Typed chat text survives crossing the 1024px breakpoint (the chat is not remounted).
    const chatBox = page.getByRole("region", { name: "AI chat workspace and agent playground" }).locator("textarea").first();
    await chatBox.fill("draft that must survive a resize");
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForFunction(() => document.querySelector("[data-split-layout]")?.dataset.splitLayout === "stacked");
    assert.equal(await chatBox.inputValue(), "draft that must survive a resize");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => document.querySelector("[data-split-layout]")?.dataset.splitLayout === "side-by-side");
    assert.equal(await chatBox.inputValue(), "draft that must survive a resize");
    await chatBox.fill("");
    ok("typed chat text survives resizing across the 1024px breakpoint (no remount)");

    await page.getByRole("button", { name: "Collapse navigation" }).click();
    await page.reload();
    await page.getByRole("button", { name: "Expand navigation" }).waitFor();
    ok("navigation collapse persists across reload");
    await shot(page, "03-dashboard-nav-collapsed");
    await page.getByRole("button", { name: "Expand navigation" }).click();

    // Text size from the top bar (shared control): End = 22px, persisted.
    await page.getByRole("banner").getByRole("button", { name: /text size/i }).click();
    const slider = page.getByRole("slider");
    await slider.first().focus();
    await page.keyboard.press("End");
    assert.equal(await slider.first().getAttribute("aria-valuetext"), "22 pixels");
    assert.equal(await page.evaluate(() => localStorage.getItem("anythingllm_text_size")), "22");
    await shot(page, "04-text-size-22px");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog", { name: /text size/i }).count(), 0);
    await page.evaluate(() => localStorage.setItem("anythingllm_text_size", "14"));
    ok("top-bar text size reaches 22px from the keyboard, persists, and Escape closes it");

    // Inspector: admin may decide the protected task; Approve needs the review box.
    await page.goto(`${BASE}/nytedesk/approvals/${s.protectedTask.id}`);
    await page.getByRole("heading", { name: "Exact proposed operation" }).waitFor();
    for (const h of ["Requester and provenance", "Affected resources and files", "Risk and permissions", "Supporting evidence", "Audit history"]) {
      await page.getByRole("heading", { name: h }).waitFor();
    }
    const approve = page.getByRole("button", { name: "Approve" });
    assert.equal(await approve.isDisabled(), true);
    await page.getByRole("checkbox").check();
    assert.equal(await approve.isDisabled(), false);
    await shot(page, "05-approval-inspector-admin");
    ok("inspector shows all six sections; Approve stays disabled until the review is confirmed");

    // F1: moving from task A to task B in the same view never carries the review over.
    const A = s.protectedTask;
    const B = s.standardTask;
    const go = (p) =>
      page.evaluate((target) => {
        window.history.pushState({}, "", target);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, p);
    await page.goto(`${BASE}/nytedesk/approvals/${A.id}`);
    await page.getByText(A.description).waitFor();
    await page.getByRole("checkbox").check();
    assert.equal(await page.getByRole("button", { name: "Approve" }).isDisabled(), false);
    await go(`/nytedesk/approvals/${B.id}`);
    await page.getByText(B.description).waitFor();
    assert.equal(await page.getByRole("checkbox").isChecked(), false);
    assert.equal(await page.getByRole("button", { name: "Approve" }).isDisabled(), true);
    ok("F1: the review confirmation for task A does not carry over to task B");

    // A slow, older response for A must not replace B.
    const slowA = new RegExp(`/api/nytedesk/tasks/${A.id}$`);
    await page.route(slowA, async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });
    await go(`/nytedesk/approvals/${A.id}`);
    await go(`/nytedesk/approvals/${B.id}`);
    await page.getByText(B.description).waitFor();
    await page.waitForTimeout(2600);
    assert.equal(await page.getByText(B.description).count(), 1);
    assert.equal(await page.getByText(A.description).count(), 0);
    await page.unroute(slowA);
    ok("F1: a late response for an earlier task is ignored");

    // Approve the standard task through the UI and see the state change.
    await page.goto(`${BASE}/nytedesk/approvals/${s.standardTask.id}`);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByText("This task is not awaiting approval.").waitFor();
    const detail = await api("GET", `/nytedesk/tasks/${s.standardTask.id}`, { token: s.admin.token });
    assert.equal(detail.task.status, "approved");
    assert.equal(detail.task.approval.by, s.admin.user.id);
    ok("approving in the inspector records the decision on the server (state: approved)");

    await page.goto(`${BASE}/nytedesk/tasks`);
    await page.getByRole("heading", { name: "Task states" }).waitFor();
    await shot(page, "06-tasks-and-states");
    await page.goto(`${BASE}/nytedesk/engines`);
    await page.getByText("externally owned", { exact: false }).first().waitFor();
    const engineButtons = page.getByRole("button", { name: /^(Check|Select|Configure)$/ });
    const boxes = [];
    for (let i = 0; i < (await engineButtons.count()); i++) boxes.push(await engineButtons.nth(i).boundingBox());
    assert.ok(boxes.length >= 3, `engine buttons found: ${boxes.length}`);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) assert.equal(overlaps(boxes[i], boxes[j]), false, `engine buttons ${i} and ${j} overlap`);
    ok("engine card buttons do not overlap");
    await shot(page, "07-local-ai-manager");
    await page.goto(`${BASE}/nytedesk/agentbridge`);
    await page.getByRole("heading", { name: "Who does what" }).waitFor();
    const roles = await page.getByRole("table").innerText();
    assert.match(roles, /PolyStrata\s+Inference engine/);
    assert.match(roles, /Codex CLI\s+Agent/);
    assert.match(roles, /AgentBridge\s+Orchestrator/);
    await shot(page, "08-agentbridge-roles");
    ok("AgentBridge view lists engines as inference engines, not agents");
    await page.goto(`${BASE}/nytedesk/logs`);
    await page.getByRole("heading", { name: "Engine diagnostics (last check)" }).waitFor();
    await shot(page, "09-logs-diagnostics");

    // Light theme.
    await page.evaluate(() => localStorage.setItem("theme", "light"));
    await page.goto(`${BASE}/nytedesk`);
    await page.getByRole("heading", { name: "Main dashboard" }).waitFor();
    await page.waitForTimeout(1500);
    await shot(page, "10-dashboard-light-theme");
    await page.evaluate(() => localStorage.setItem("theme", "dark"));

    // The original workspace page still works.
    await page.goto(`${BASE}/workspace/${s.slug}`);
    await page.locator("textarea").first().waitFor({ timeout: 20000 });
    await shot(page, "11-original-workspace-chat");
    ok("the original AnythingLLM workspace chat page still loads");
    await context.close();

    // ---------------- manager: protected task is admin-only
    const m = await signIn(browser, USERS.manager);
    await m.page.goto(`${BASE}/nytedesk/approvals/${s.protectedTask.id}`);
    await m.page.getByText("You requested this task", { exact: false }).waitFor();
    await shot(m.page, "12-inspector-manager-own-request");
    ok("the requester sees why they cannot decide their own task");
    await m.context.close();

    // ---------------- default user: read-only
    const v = await signIn(browser, USERS.viewer);
    await v.page.goto(`${BASE}/nytedesk`);
    await v.page.getByText("Host metrics are available to managers and administrators.").waitFor();
    assert.match(await v.page.getByRole("region", { name: "Overview" }).innerText(), /System health\s*Restricted/);
    const direct = await v.page.evaluate(async () => {
      const r = await fetch("/api/nytedesk/telemetry", {
        headers: { Authorization: `Bearer ${localStorage.getItem("anythingllm_authToken")}` },
      });
      return { status: r.status, body: await r.json() };
    });
    assert.equal(direct.status, 403);
    assert.equal(direct.body.telemetry, undefined);
    ok("F5: a default user gets no host telemetry, in the UI or from a direct API request");
    await v.page.goto(`${BASE}/nytedesk/approvals/${s.protectedTask.id}`);
    await v.page.getByText("Only an administrator", { exact: false }).or(v.page.getByText("Your role cannot approve", { exact: false })).first().waitFor();
    assert.equal(await v.page.getByRole("button", { name: "Approve" }).count(), 0);
    await shot(v.page, "13-inspector-default-user");
    ok("a default user cannot approve and is told why");
    await v.context.close();

    // ---------------- responsive
    for (const [name, viewport] of [["14-dashboard-tablet-1024x768", { width: 1024, height: 768 }], ["15-dashboard-tablet-portrait-768x1024", { width: 768, height: 1024 }]]) {
      const r = await signIn(browser, USERS.admin, { viewport });
      await r.page.goto(`${BASE}/nytedesk`);
      await r.page.getByRole("heading", { name: "Main dashboard" }).waitFor();
      await r.page.waitForTimeout(1200);
      const ind = await checkTopBar(r.page, name);
      const shortVisible = await ind.locator("[data-freshness-short]").isVisible();
      const fullVisible = await ind.locator("[data-freshness-full]").isVisible();
      assert.equal(shortVisible || fullVisible, true, `${name}: freshness text visible`);
      assert.equal(fullVisible, viewport.width >= 1024, `${name}: full label only from lg`);
      ok(`N1: freshness visible and clear of other controls at ${viewport.width}x${viewport.height}`);
      await shot(r.page, name);
      await r.context.close();
    }
    const mobile = await signIn(browser, USERS.admin, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobile.page.goto(`${BASE}/nytedesk`);
    await mobile.page.getByRole("heading", { name: "Main dashboard" }).waitFor();
    const width = await mobile.page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 390, `no horizontal overflow on mobile (scrollWidth ${width})`);
    await shot(mobile.page, "16-dashboard-mobile-390x844");
    const mAccount = await mobile.page.locator("[data-user-menu]").boundingBox();
    const mTextSize = await mobile.page.getByRole("banner").getByRole("button", { name: /text size/i }).boundingBox();
    assert.equal(overlaps(mAccount, mTextSize), false, "mobile: account button covers the text-size button");

    // N1: compact freshness on a phone; failed and stale are visibly different.
    const mInd = await checkTopBar(mobile.page, "390");
    assert.equal(await mInd.locator("[data-freshness-short]").isVisible(), true);
    const mTasks = /\/api\/nytedesk\/tasks\?/;
    await mobile.page.route(mTasks, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"simulated outage"}' })
    );
    await mobile.page.getByRole("button", { name: /Refresh dashboard data/ }).click();
    await mobile.page.waitForFunction(() => document.querySelector("[data-freshness]")?.dataset.freshness === "failed");
    assert.equal(await mInd.locator("[data-freshness-short]").innerText(), "Failed");
    const failedDot = await mInd.locator("span.rounded-full").getAttribute("class");
    await shot(mobile.page, "18-mobile-freshness-failed");
    await mobile.page.unroute(mTasks);
    await mobile.page.getByRole("button", { name: /Refresh dashboard data/ }).click();
    await mobile.page.waitForFunction(() => document.querySelector("[data-freshness]")?.dataset.freshness === "fresh");

    // Hidden tab with aged data: no polling at all, and the data turns stale.
    const hiddenTasks = countRequests(mobile.page, mTasks);
    const hiddenTelemetry = countRequests(mobile.page, /\/api\/nytedesk\/telemetry/);
    await mobile.page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      const realNow = Date.now.bind(Date);
      window.__realNow = realNow;
      Date.now = () => realNow() + 120000; // the last refresh is now 2 minutes old
    });
    await mobile.page.waitForFunction(() => document.querySelector("[data-freshness]")?.dataset.freshness === "stale", null, { timeout: 10000 });
    assert.match(await mInd.locator("[data-freshness-short]").innerText(), /^Stale /);
    const staleDot = await mInd.locator("span.rounded-full").getAttribute("class");
    assert.notEqual(staleDot, failedDot, "stale and failed use different colours");
    await shot(mobile.page, "19-mobile-freshness-stale");
    await mobile.page.waitForTimeout(31000); // longer than the data (30 s) and telemetry (10 s) intervals
    assert.equal(hiddenTasks.n, 0, `data polled ${hiddenTasks.n} times while hidden`);
    assert.equal(hiddenTelemetry.n, 0, `telemetry polled ${hiddenTelemetry.n} times while hidden`);
    await mobile.page.evaluate(() => {
      delete document.hidden;
      delete document.visibilityState;
      Date.now = window.__realNow;
    });
    await mobile.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await mobile.page.waitForFunction(() => document.querySelector("[data-freshness]")?.dataset.freshness === "fresh", null, { timeout: 10000 });
    ok("N1: on a phone, Failed and Stale are shown in text and colour; N3: no polling while hidden, refresh on return");

    // F3: keyboard-only use of the modal drawer.
    const opener = mobile.page.getByRole("button", { name: "Open navigation" });
    await opener.focus();
    await mobile.page.keyboard.press("Enter");
    await mobile.page.getByRole("dialog", { name: "Navigation" }).waitFor();
    const focusInside = () => mobile.page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    assert.equal(await focusInside(), true, "focus moves into the drawer");
    for (let i = 0; i < 16; i++) {
      await mobile.page.keyboard.press("Tab");
      assert.equal(await focusInside(), true, `Tab ${i + 1} left the drawer`);
    }
    for (let i = 0; i < 16; i++) {
      await mobile.page.keyboard.press("Shift+Tab");
      assert.equal(await focusInside(), true, `Shift+Tab ${i + 1} left the drawer`);
    }
    const inert = () =>
      mobile.page.evaluate(() => ({
        content: !!document.getElementById("nytedesk-main")?.closest("[inert]"),
        account: !!document.querySelector("[data-user-menu]")?.inert,
      }));
    assert.deepEqual(await inert(), { content: true, account: true });
    await shot(mobile.page, "17-mobile-navigation-drawer");
    await mobile.page.keyboard.press("Escape");
    assert.equal(await mobile.page.getByRole("dialog", { name: "Navigation" }).count(), 0);
    await mobile.page.waitForTimeout(150); // focus returns on the next animation frame
    assert.equal(await mobile.page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Open navigation");
    assert.deepEqual(await inert(), { content: false, account: false });
    ok("F3: drawer traps Tab/Shift+Tab, makes the page inert, and Escape returns focus to the opener");

    // Backdrop dismissal still works.
    await opener.click();
    await mobile.page.mouse.click(370, 400);
    assert.equal(await mobile.page.getByRole("dialog", { name: "Navigation" }).count(), 0);
    ok("mobile: no horizontal overflow; backdrop dismissal works; account button clear of controls");
    await mobile.context.close();

    // N2: drawer open at 390px, then the window grows past 768px.
    const rs = await signIn(browser, USERS.admin, { viewport: { width: 390, height: 844 } });
    const p2 = rs.page;
    await p2.goto(`${BASE}/nytedesk`);
    await p2.getByRole("heading", { name: "Main dashboard" }).waitFor();
    const menuButton = p2.getByRole("button", { name: "Open navigation" });
    await menuButton.focus();
    await p2.keyboard.press("Enter");
    await p2.getByRole("dialog", { name: "Navigation" }).waitFor();
    await p2.keyboard.press("Tab");
    assert.equal(await p2.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true);
    await p2.setViewportSize({ width: 1440, height: 900 });
    await p2.getByRole("button", { name: "Collapse navigation" }).waitFor();
    assert.equal(await p2.getByRole("dialog", { name: "Navigation" }).count(), 0);
    await p2.waitForTimeout(300);
    const landed = await p2.evaluate(() => {
      const el = document.activeElement;
      return {
        tag: el?.tagName,
        inNav: !!el?.closest('nav[aria-label="NyteDesk"]'),
        current: el?.getAttribute("aria-current"),
        visible: !!el && el !== document.body && el.getClientRects().length > 0,
        inert: !!el?.closest("[inert]"),
        contentInert: !!document.getElementById("nytedesk-main")?.closest("[inert]"),
        accountInert: !!document.querySelector("[data-user-menu]")?.inert,
        ariaHidden: document.querySelectorAll('[aria-hidden="true"][inert]').length,
      };
    });
    assert.deepEqual(
      landed,
      { tag: "A", inNav: true, current: "page", visible: true, inert: false, contentInert: false, accountInert: false, ariaHidden: 0 },
      JSON.stringify(landed)
    );
    ok("N2: growing past 768px closes the drawer, clears inert, and focuses the current page in the desktop nav");
    await p2.keyboard.press("Tab");
    assert.equal(await p2.evaluate(() => document.activeElement !== document.body), true, "focus not lost after Tab");

    await p2.setViewportSize({ width: 390, height: 844 });
    await menuButton.waitFor();
    await menuButton.focus();
    await p2.keyboard.press("Enter");
    await p2.getByRole("dialog", { name: "Navigation" }).waitFor();
    for (let i = 0; i < 6; i++) {
      await p2.keyboard.press("Shift+Tab");
      assert.equal(await p2.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true);
    }
    await p2.keyboard.press("Escape");
    await p2.waitForTimeout(150);
    assert.equal(await p2.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Open navigation");
    await menuButton.click();
    await p2.getByRole("dialog", { name: "Navigation" }).waitFor();
    await p2.mouse.click(370, 400);
    assert.equal(await p2.getByRole("dialog", { name: "Navigation" }).count(), 0);
    ok("N2: back at 390px the drawer reopens, traps focus, and Escape/backdrop still work");
    await rs.context.close();
  } catch (e) {
    await diagnose();
    throw e;
  } finally {
    await browser.close();
    poly.close();
    ollama.close();
  }

  assert.deepEqual(pageErrors, [], `uncaught page errors:\n${pageErrors.join("\n")}`);
  ok("no uncaught page errors");
  console.log(`# pass ${results.length}`);
}

async function diagnose() {
  if (!lastPage || lastPage.isClosed()) return;
  try {
    console.error(`URL at failure: ${lastPage.url()}`);
    const text = await lastPage.evaluate(() => document.body?.innerText || "");
    console.error(`Page text at failure:\n${text.slice(0, 3000)}`);
    await lastPage.screenshot({ path: path.join(SHOTS, "zz-failure.png") });
  } catch (e) {
    console.error(`(diagnostics failed: ${e.message})`);
  }
}

main().catch(async (e) => {
  console.error(e);
  await diagnose();
  console.error(`Page errors:\n${pageErrors.join("\n") || "(none)"}`);
  console.error(`Console errors:\n${consoleErrors.slice(0, 30).join("\n") || "(none)"}`);
  console.error(`# failed after ${results.length} passing checks`);
  process.exit(1);
});
