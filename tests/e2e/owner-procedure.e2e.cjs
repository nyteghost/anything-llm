// CI rehearsal of NYTEDESK_OWNER_VERIFICATION.md §6–§7 against the instance
// started by tools/linux-run.sh, with mock engines on the tunnel ports
// (tests/e2e/mock-engines.cjs). Everything goes through the browser UI the
// owner will use, except a few status probes made from the page itself.
//
// Labelled "CI-simulated": it rehearses the procedure; it is not owner
// verification and never touches real engines.
//
// Env: BASE_URL (http://127.0.0.1:3002), SHOTS_DIR, CHROME, MOCK_CONTROL_PORT,
//      NODE_PATH containing playwright-core.
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

const BASE = process.env.BASE_URL || "http://127.0.0.1:3002";
const SHOTS = process.env.SHOTS_DIR || path.resolve("owner-procedure-screenshots");
const CONTROL = `http://127.0.0.1:${process.env.MOCK_CONTROL_PORT || 41999}`;
const MODEL = "qwen3.6-35b-a3b-ud-q2_k_xl";
const pw = () => crypto.randomBytes(12).toString("hex");
const USERS = {
  admin: { username: "verify-admin", password: pw() },
  manager: { username: "verify-manager", password: pw(), role: "manager" },
  viewer: { username: "verify-viewer", password: pw(), role: "default" },
};
const results = [];
const pageErrors = [];
// Known, reported page errors (not hidden): same message, told apart by page.
const KNOWN_ERRORS = [
  {
    id: "UPSTREAM-SECURITY-CTA",
    path: /^\/settings\/security/,
    message: /reading 'preventDefault'/,
    note: "Upstream AnythingLLM Settings → Security: CTAButton calls handleSubmit() without the event; the form still submits.",
  },
  {
    id: "D1-PROPOSE-TASK-CTA",
    path: /^\/nytedesk\/tasks/,
    message: /reading 'preventDefault'/,
    note: "NyteDesk 'Propose a task' form (PR #1, 689bf2e): CTAButton calls submit() without the event; the task is still created via implicit form submission.",
  },
];
const seenKnown = new Set();
let lastPage = null;

const ok = (name) => {
  results.push(name);
  console.log(`ok - ${name}`);
};
const shot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
const track = (page, who) => {
  page.on("pageerror", (e) => {
    let where = "";
    try {
      where = new URL(page.url()).pathname;
    } catch {}
    const known = KNOWN_ERRORS.find((k) => k.path.test(where) && k.message.test(e.message));
    if (known) seenKnown.add(known.id);
    else pageErrors.push(`${who} at ${where}: ${e.message}`);
  });
  lastPage = page;
  return page;
};
const mock = (action, engine) => fetch(`${CONTROL}/${action}/${engine}`, { method: "POST" });

/** Status of an API call made from the signed-in page; the token is never printed. */
const apiStatus = (page, url) =>
  page.evaluate(async (u) => {
    const t = localStorage.getItem("anythingllm_authToken");
    const r = await fetch(u, t ? { headers: { Authorization: `Bearer ${t}` } } : {});
    return r.status;
  }, url);
const apiJson = (page, url) =>
  page.evaluate(async (u) => {
    const t = localStorage.getItem("anythingllm_authToken");
    const r = await fetch(u, { headers: { Authorization: `Bearer ${t}` } });
    return r.json();
  }, url);

async function newContext(browser) {
  return browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", acceptDownloads: true });
}

async function signIn(browser, u, who, existing = null) {
  const context = existing ? null : await newContext(browser);
  const page = existing || track(await context.newPage(), who);
  await page.goto(`${BASE}/login`);
  await page.locator('input[name="username"]').first().fill(u.username);
  await page.locator('input[name="password"]').first().fill(u.password);
  await page.locator('button[type="submit"]').first().click();
  const download = page.getByRole("button", { name: "Download", exact: true });
  if (await download.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
    await Promise.all([page.waitForEvent("download").catch(() => null), download.click()]);
    await page.getByRole("button", { name: "Close", exact: true }).click();
  }
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30000 });
  await page.waitForLoadState("networkidle");
  return { context, page };
}

/** The innermost element that contains the engine's name and its Configure button. */
const card = (page, name) =>
  page
    .locator("div")
    .filter({ has: page.getByText(name, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: /^(Configure|Close)$/ }) })
    .last();

async function configureEngine(page, name, id, fields) {
  const c = card(page, name);
  await c.getByRole("button", { name: "Configure" }).click();
  await page.locator(`#${id}-endpoint`).fill(fields.endpoint);
  if (fields.api) await c.getByLabel("API style").selectOption(fields.api);
  if (fields.model !== undefined) await c.getByLabel("Model").fill(fields.model);
  if (fields.contextWindow) await c.getByLabel("Context window (tokens)").fill(String(fields.contextWindow));
  if (fields.vramReserveMiB !== undefined) await c.getByLabel("VRAM reserve (MiB)").fill(String(fields.vramReserveMiB));
  await c.getByRole("button", { name: /^Save/ }).click();
}

async function engineState(page, id) {
  const data = await apiJson(page, "/api/nytedesk/engines");
  return { engine: data.engines.find((e) => e.id === id), selection: data.selection };
}

async function propose(page, slug, adapter, action, description) {
  await page.goto(`${BASE}/nytedesk/tasks`);
  await page.getByText("Propose a task", { exact: true }).waitFor();
  const form = page.locator("form").filter({ has: page.getByPlaceholder("Describe exactly what should be done") });
  const selects = form.locator("select");
  await selects.nth(0).selectOption(slug);
  await selects.nth(1).selectOption(adapter);
  await selects.nth(2).selectOption(action);
  await form.getByPlaceholder("Describe exactly what should be done").fill(description);
  await form.getByRole("button", { name: /Submit for approval/ }).click();
  await page.getByText("Task submitted for approval").first().waitFor();
  const tasks = await apiJson(page, "/api/nytedesk/tasks?limit=100");
  return tasks.tasks.find((t) => t.description === description);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
  try {
    // ------------------------------------------------ §6 step 1: first start
    // tools/linux-run.sh writes LLM settings into server/.env, so the server
    // treats the instance as already onboarded and opens in single-user mode
    // with no password. Multi-user mode is switched on in Settings → Security.
    const adminCtx = await newContext(browser);
    const admin = track(await adminCtx.newPage(), "admin");
    await admin.goto(BASE);
    await admin.waitForLoadState("networkidle");
    assert.equal(new URL(admin.url()).pathname.startsWith("/onboarding"), false, "unexpected onboarding");
    assert.equal(new URL(admin.url()).pathname.startsWith("/login"), false, "unexpected login page");
    await shot(admin, "01-first-start-single-user-no-password");
    ok("§6.1: the launcher's instance opens without onboarding, in single-user mode with no password");

    await admin.goto(`${BASE}/settings/security`);
    await admin.getByText("Enable Multi-User Mode", { exact: true }).click();
    await admin.locator('input[name="username"]').fill(USERS.admin.username);
    await admin.locator('input[name="password"]').fill(USERS.admin.password);
    await admin.getByRole("button", { name: "Save changes" }).click();
    await admin.getByText("Multi-User mode enabled successfully.").first().waitFor();
    await admin.waitForURL((u) => /\/(login|settings\/users)/.test(u.pathname), { timeout: 20000 });
    await signIn(browser, USERS.admin, "admin", admin);
    await admin.waitForFunction(() => !!localStorage.getItem("anythingllm_authToken"));
    assert.equal(await apiStatus(admin, "/api/nytedesk/status"), 200);
    const status = await apiJson(admin, "/api/nytedesk/status");
    assert.equal(status.enabled, true, "NYTEDESK_ENABLED from the shell reached the server");
    assert.equal(status.multiUser, true);
    ok("§6.1: Settings → Security → Enable Multi-User Mode creates the admin; NyteDesk reports enabled + multi-user");

    // ------------------------------------------------ §6 step 2: users
    await admin.goto(`${BASE}/settings/users`);
    for (const key of ["manager", "viewer"]) {
      const u = USERS[key];
      await admin.getByRole("button", { name: "Add user" }).first().click();
      const modal = admin.locator("form").filter({ has: admin.locator('select[name="role"]') });
      await modal.locator('input[name="username"]').fill(u.username);
      await modal.locator('input[name="password"]').fill(u.password);
      await modal.locator('select[name="role"]').selectOption(u.role);
      await modal.locator('button[type="submit"]').click();
      await admin.getByText(u.username, { exact: true }).first().waitFor();
    }
    ok("§6.2: Settings → Users creates the manager and default users");

    // ------------------------------------------------ §6 step 3: workspace + members
    await admin.goto(BASE);
    await admin.locator('[data-tooltip-id="new-workspace-tooltip"]').first().click();
    await admin.locator('input[name="name"]').fill("NyteDesk Verify");
    await admin.getByRole("button", { name: "Save" }).click();
    await admin.waitForURL(/\/workspace\/[^/]+$/, { timeout: 20000 });
    const slug = new URL(admin.url()).pathname.split("/").pop();
    await admin.goto(`${BASE}/workspace/${slug}/settings/members`);
    await admin.getByRole("button", { name: "Manage Users" }).click();
    await admin.locator("tr").filter({ hasText: USERS.viewer.username }).click();
    await admin.getByRole("button", { name: "Save" }).click();
    await admin.getByText(USERS.viewer.username, { exact: true }).first().waitFor();
    ok(`§6.3: workspace '${slug}' created and the default user added under Members`);

    // ------------------------------------------------ §6.1 engines through the UI
    await admin.goto(`${BASE}/nytedesk/engines`);
    await admin.getByText("externally owned", { exact: false }).first().waitFor();
    await configureEngine(admin, "PolyStrata", "polystrata", {
      endpoint: "http://127.0.0.1:41537/v1",
      model: MODEL,
      contextWindow: 32768,
      vramReserveMiB: 1024,
    });
    await admin.waitForFunction(() => document.body.innerText.includes("http://127.0.0.1:41537/v1"));
    await configureEngine(admin, "Ollama", "ollama", { endpoint: "http://127.0.0.1:41434", model: "qwen3:8b" });
    await admin.waitForFunction(() => document.body.innerText.includes("http://127.0.0.1:41434"));
    await configureEngine(admin, "Strata", "strata", { endpoint: "http://127.0.0.1:41600", api: "openai", model: "" });
    await admin.waitForFunction(() => document.body.innerText.includes("http://127.0.0.1:41600"));
    for (const [name, id] of [["PolyStrata", "polystrata"], ["Ollama", "ollama"], ["Strata", "strata"]]) {
      await card(admin, name).getByRole("button", { name: "Check" }).click();
      await admin.waitForFunction(
        async (engineId) => {
          const t = localStorage.getItem("anythingllm_authToken");
          const d = await (await fetch("/api/nytedesk/engines", { headers: { Authorization: `Bearer ${t}` } })).json();
          return d.engines.find((e) => e.id === engineId)?.lastCheck?.status === "external";
        },
        id,
        { timeout: 15000, polling: 500 }
      );
    }
    let s = await engineState(admin, "polystrata");
    assert.deepEqual(s.engine.lastCheck.models, [MODEL]);
    assert.equal(s.engine.lastCheck.modelListed, true);
    assert.equal(s.engine.contextWindow, 32768);
    assert.equal(s.engine.vramReserveMiB, 1024);
    assert.equal((await engineState(admin, "strata")).engine.api, "openai");
    await card(admin, "PolyStrata").getByRole("button", { name: "Select" }).click();
    await admin.getByText("selected for the coordinator").first().waitFor();
    s = await engineState(admin, "polystrata");
    assert.equal(s.selection.engineId, "polystrata");
    await shot(admin, "02-local-ai-manager-configured-checked-selected");
    ok("§6.1: PolyStrata, Ollama and Strata configured, checked (reachable, models listed) and PolyStrata selected via the UI");

    // §6.2 expectations
    const before = (await engineState(admin, "ollama")).engine.version;
    await configureEngine(admin, "Ollama", "ollama", { endpoint: "http://192.168.1.10:11434" });
    await admin.waitForTimeout(1500);
    s = await engineState(admin, "ollama");
    assert.equal(s.engine.endpoint, "http://127.0.0.1:41434", "non-loopback endpoint was saved");
    assert.equal(s.engine.version, before);
    await card(admin, "Ollama").getByRole("button", { name: "Close" }).click().catch(() => {});
    ok("§6.2: a non-loopback endpoint is refused on save");

    await configureEngine(admin, "Strata", "strata", { endpoint: "http://127.0.0.1:41599", api: "openai" });
    await admin.waitForFunction(() => document.body.innerText.includes("http://127.0.0.1:41599"));
    await card(admin, "Strata").getByRole("button", { name: "Check" }).click();
    await admin.waitForFunction(() => /unreachable/.test(document.body.innerText), null, { timeout: 15000 });
    s = await engineState(admin, "strata");
    assert.ok(s.engine.lastCheck.diagnostics.some((d) => d.code === "CONNECTION_REFUSED"));
    assert.equal(s.engine.selectable, false);
    assert.match(await card(admin, "Strata").innerText(), /Select:/);
    ok("§6.2: a wrong port shows unreachable / CONNECTION_REFUSED, and Select is blocked with the reason shown");

    for (const label of ["Start", "Stop", "Restart", "Unload", "Kill"]) {
      assert.equal(await admin.getByRole("button", { name: label, exact: true }).count(), 0);
    }
    assert.ok((await admin.getByText("externally owned · start/stop disabled").count()) >= 3);
    ok("§6.2: no process-control buttons; every card says externally owned · start/stop disabled");
    await configureEngine(admin, "Strata", "strata", { endpoint: "http://127.0.0.1:41600", api: "openai" });

    // ------------------------------------------------ §7.2 authorization
    const mgr = await signIn(browser, USERS.manager, "manager");
    const viewer = await signIn(browser, USERS.viewer, "viewer");
    await mgr.page.goto(`${BASE}/nytedesk/engines`);
    await mgr.page.getByText("You can run availability checks.", { exact: false }).waitFor();
    assert.equal(await mgr.page.getByRole("button", { name: "Configure" }).count(), 0);
    assert.ok((await mgr.page.getByRole("button", { name: "Check" }).count()) >= 1);
    await viewer.page.goto(`${BASE}/nytedesk/engines`);
    await viewer.page.getByText("Read-only view.", { exact: false }).waitFor();
    assert.equal(await viewer.page.getByRole("button", { name: /^(Check|Configure|Select)$/ }).count(), 0);
    ok("§7.2: admin configures and selects; the manager can only check; the default user is read-only");

    await viewer.page.goto(`${BASE}/nytedesk`);
    await viewer.page.getByText("Host metrics are available to managers and administrators.").waitFor();
    assert.equal(await apiStatus(viewer.page, "/api/nytedesk/telemetry"), 403);
    assert.equal(await apiStatus(admin, "/api/nytedesk/telemetry"), 200);
    const anonCtx = await newContext(browser);
    const anon = track(await anonCtx.newPage(), "signed-out");
    const anonResp = await anon.goto(`${BASE}/api/nytedesk/telemetry`);
    assert.equal(anonResp.status(), 401);
    await anonCtx.close();
    ok("§7.2: telemetry 403 for the default user, 200 for admin, 401 signed out");

    // ------------------------------------------------ §7.3 approvals
    const mgrTask = await propose(mgr.page, slug, "codex", "repository.read", "Manager's own request: list unused dependencies.");
    await mgr.page.goto(`${BASE}/nytedesk/approvals/${mgrTask.id}`);
    await mgr.page.getByText("You requested this task", { exact: false }).waitFor();
    assert.equal(await mgr.page.getByRole("button", { name: "Approve" }).count(), 0);
    ok("§7.2: self-approval refused with the reason shown");

    const protectedTask = await propose(viewer.page, slug, "claude-code", "vm.write", "Default user's protected request: write in the VM working copy.");
    await mgr.page.goto(`${BASE}/nytedesk/approvals/${protectedTask.id}`);
    await mgr.page.getByText("Only an administrator", { exact: false }).waitFor();
    await admin.goto(`${BASE}/nytedesk/approvals/${protectedTask.id}`);
    await admin.getByRole("checkbox").waitFor();
    ok("§7.2: protected vm.write is administrator-only (manager blocked, admin may decide)");

    const sharedTask = await propose(viewer.page, slug, "codex", "repository.read", "Default user's request for the concurrency check.");
    await admin.goto(`${BASE}/nytedesk/approvals/${sharedTask.id}`);
    await mgr.page.goto(`${BASE}/nytedesk/approvals/${sharedTask.id}`);
    for (const p of [admin, mgr.page]) {
      await p.getByRole("heading", { name: "Supporting evidence" }).waitFor();
      assert.match(await p.getByRole("region", { name: "Supporting evidence" }).innerText(), /Verified/);
      await p.getByRole("checkbox").check();
    }
    await admin.getByRole("button", { name: "Approve" }).click();
    await admin.getByText("This task is not awaiting approval.").waitFor();
    await mgr.page.getByRole("button", { name: "Approve" }).click();
    await mgr.page.getByText("This task is not awaiting approval.").waitFor({ timeout: 15000 });
    const shared = await apiJson(admin, `/api/nytedesk/tasks/${sharedTask.id}`);
    assert.equal(shared.task.status, "approved");
    assert.equal(shared.task.approval.decision, "approve");
    assert.deepEqual(shared.audit.map((e) => e.event), ["task.created", "task.approve"]);
    assert.equal(shared.task.executionEnabled, false);
    await shot(mgr.page, "03-concurrency-second-approver-sees-decided-task");
    ok("§7.3: concurrent approval: the second approver is refused and sees the decided task; audit = created → approve; execution disabled");

    await admin.goto(`${BASE}/nytedesk/logs`);
    await admin.getByText("Disabled (engines are externally owned)").waitFor();
    await admin.goto(`${BASE}/nytedesk/agentbridge`);
    await admin.getByText("vm-isolation-verified", { exact: true }).waitFor();
    assert.equal(await admin.getByText("Not verified", { exact: true }).count(), 5);
    ok("§7.3: Logs show execution disabled; AgentBridge lists all five preconditions Not verified");

    // ------------------------------------------------ §7.4 telemetry (UI part)
    await admin.goto(`${BASE}/nytedesk`);
    const metrics = admin.getByRole("region", { name: "System metrics" });
    await metrics.getByText(/of \d+ cores|Unavailable/).first().waitFor();
    const m = await metrics.innerText();
    for (const label of ["GPU utilization", "VRAM", "GPU temperature", "Tokens / second"]) {
      assert.match(m, new RegExp(`${label.replace("/", "\\/")}\\s*Unavailable`));
    }
    assert.match(m, /Measured on the NyteDesk server host/);
    await shot(admin, "04-dashboard-admin");
    ok("§7.4: host CPU/RAM shown with freshness; GPU, VRAM, temperature and tokens/s Unavailable");

    // ------------------------------------------------ §7.5 reliability
    const fresh = await propose(viewer.page, slug, "codex", "repository.read", "Created while the admin dashboard is open.");
    await admin.waitForTimeout(5500);
    await admin.evaluate(() => window.dispatchEvent(new Event("focus")));
    await admin.waitForFunction(
      (desc) => document.body.innerText.includes("Read a repository") && document.querySelector("[data-freshness]")?.dataset.freshness === "fresh",
      fresh.description,
      { timeout: 15000 }
    );
    ok("§7.5: a task from another session reaches the open dashboard after focus");

    await mock("stop", "polystrata");
    await admin.goto(`${BASE}/nytedesk/engines`);
    await card(admin, "PolyStrata").getByRole("button", { name: "Check" }).click();
    await admin.waitForFunction(
      async () => {
        const t = localStorage.getItem("anythingllm_authToken");
        const d = await (await fetch("/api/nytedesk/engines", { headers: { Authorization: `Bearer ${t}` } })).json();
        return d.engines.find((e) => e.id === "polystrata")?.lastCheck?.status !== "external";
      },
      null,
      { timeout: 15000, polling: 500 }
    );
    await shot(admin, "05-tunnel-dropped-polystrata-unreachable");
    await mock("start", "polystrata");
    await card(admin, "PolyStrata").getByRole("button", { name: "Check" }).click();
    await admin.waitForFunction(
      async () => {
        const t = localStorage.getItem("anythingllm_authToken");
        const d = await (await fetch("/api/nytedesk/engines", { headers: { Authorization: `Bearer ${t}` } })).json();
        return d.engines.find((e) => e.id === "polystrata")?.lastCheck?.status === "external";
      },
      null,
      { timeout: 15000, polling: 500 }
    );
    ok("§7.5: dropping and restoring a tunnel shows unreachable, then reachable, with no action on the engine");

    await admin.goto(`${BASE}/workspace/${slug}`);
    await admin.locator("textarea").first().waitFor({ timeout: 20000 });
    await admin.goto(`${BASE}/nytedesk`);
    await admin.getByRole("heading", { name: "Main dashboard" }).waitFor();
    ok("§7.5: navigating to the workspace chat and back works");
    await mgr.context.close();
    await viewer.context.close();
    await adminCtx.close();
  } catch (e) {
    if (lastPage && !lastPage.isClosed()) {
      console.error(`URL at failure: ${lastPage.url()}`);
      console.error((await lastPage.evaluate(() => document.body?.innerText || "")).slice(0, 2500));
      await lastPage.screenshot({ path: path.join(SHOTS, "zz-failure.png") }).catch(() => {});
    }
    throw e;
  } finally {
    await browser.close();
  }
  for (const k of KNOWN_ERRORS) {
    console.log(`${seenKnown.has(k.id) ? "REPORTED" : "not seen"} - ${k.id}: ${k.note}`);
  }
  assert.deepEqual(pageErrors, [], `unexpected page errors:\n${pageErrors.join("\n")}`);
  ok("no unexpected page errors (known ones reported above)");
  console.log(`# pass ${results.length}`);
}

main().catch((e) => {
  console.error(e);
  console.error(`Page errors: ${pageErrors.join("; ") || "(none)"}`);
  console.error(`# failed after ${results.length} passing checks`);
  process.exit(1);
});
