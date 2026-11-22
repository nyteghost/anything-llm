// NyteDesk dashboard (frontend): task-state mapping, layout persistence, and
// source checks for the safety properties the UI must keep.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const load = (rel) => import("data:text/javascript;base64," + Buffer.from(read(rel)).toString("base64"));
const app = (f) => read(`frontend/src/pages/NyteDeskApp/${f}`);

let ts;
let layout;
before(async () => {
  ts = await load("frontend/src/utils/nytedesk/taskState.js");
  layout = await load("frontend/src/utils/nytedesk/layout.js");
});

// ------------------------------------------------------------------ task states
test("every backend state maps to its display state; nothing is upgraded", () => {
  const { STATES } = require("../../server/utils/nytedesk/control-plane.cjs");
  const expected = {
    queued: "Queued",
    waiting_approval: "Awaiting approval",
    approved: "Approved",
    running: "Executing",
    succeeded: "Agent-reported complete",
    failed: "Failed",
    denied: "Rejected",
    cancelled: "Cancelled",
  };
  assert.deepEqual(Object.values(STATES).sort(), Object.keys(expected).sort(), "backend states changed");
  for (const [backend, label] of Object.entries(expected)) {
    assert.equal(ts.displayState(backend).label, label, backend);
  }
  // No backend state is ever shown as independently verified or proposed.
  for (const s of Object.values(STATES)) {
    assert.notEqual(ts.displayState(s).id, "independently_verified");
    assert.notEqual(ts.displayState(s).id, "proposed");
  }
  assert.match(ts.displayState("mystery").label, /Unknown state \(mystery\)/);
});

test("a succeeded model load/unload is engine-confirmed; agent tasks stay agent-reported", () => {
  for (const action of ["engine.model.load", "engine.model.unload"]) {
    const s = ts.displayState("succeeded", action);
    assert.equal(s.id, "engine_confirmed", action);
    assert.equal(s.label, "Engine-confirmed");
    assert.equal(s.tone, "success");
    assert.notEqual(s.id, "independently_verified");
    // Other states of a model task are unchanged.
    assert.equal(ts.displayState("failed", action).label, "Failed");
    assert.equal(ts.displayState("approved", action).label, "Approved");
  }
  for (const action of ["model.prompt", "vm.execute", undefined]) {
    assert.equal(ts.displayState("succeeded", action).label, "Agent-reported complete", String(action));
  }
  const model = { requesterId: 3, adapter: "ollama", action: "engine.model.load", createdAt: "t0", status: "succeeded" };
  const outcome = ts.provenance(model, []).find((l) => l.label === "Outcome").value;
  assert.match(outcome, /^Confirmed by the engine/);
  assert.match(outcome, /No agent was involved/);
  assert.doesNotMatch(outcome, /Reported complete by the agent/);
  // The task list says so too, and only agent tasks carry the unverified flag.
  const sections = app("sections.jsx");
  assert.match(sections, /MODEL_CONTROL_ACTIONS\.includes\(t\.action\)/);
  assert.match(sections, /Confirmed against the engine&apos;s loaded models/);
  for (const f of ["sections.jsx", "widgets.jsx", "ApprovalInspector.jsx"]) {
    const src = app(f);
    assert.doesNotMatch(src, /<StateBadge status=\{[^}]+\} \/>/, `${f}: StateBadge without action`);
  }
});

test("the legend lists all eight requested states and marks untracked ones", () => {
  const ids = ts.DISPLAY_STATES.map((s) => s.label);
  for (const l of ["Proposed", "Awaiting approval", "Approved", "Queued", "Executing", "Agent-reported complete", "Independently verified", "Failed", "Cancelled"]) {
    assert.ok(ids.includes(l), l);
  }
  assert.ok(ids.includes("Engine-confirmed"));
  const untracked = ts.DISPLAY_STATES.filter((s) => !s.tracked).map((s) => s.id);
  assert.deepEqual(untracked.sort(), ["independently_verified", "proposed"]);
});

test("engine adapters are described as the coordinator, not as agents of their own", () => {
  assert.equal(ts.describeAdapter("polystrata").name, "Local coordinator via PolyStrata");
  assert.equal(ts.describeAdapter("polystrata").role, "coordinator");
  assert.equal(ts.describeAdapter("claude-code").role, "implementer");
  assert.equal(ts.describeAdapter("codex").role, "reviewer");
  assert.equal(ts.describeAdapter("nope").kind, "unknown");
  // Every action the backend accepts has a description.
  const { ACTIONS } = require("../../server/utils/nytedesk/control-plane.cjs");
  for (const a of Object.values(ACTIONS)) assert.ok(ts.ACTION_INFO[a], a);
});

test("provenance comes from the record; a reported success is flagged unverified", () => {
  const task = { requesterId: 4, adapter: "codex", createdAt: "t0", status: "succeeded", approval: { decision: "approve", by: 2, at: "t1" } };
  const audit = [{ event: "task.succeed", actorId: 9, actorRole: "admin", at: "t3" }];
  const lines = ts.provenance(task, audit);
  const byLabel = Object.fromEntries(lines.map((l) => [l.label, l.value]));
  assert.equal(byLabel["Requested by"], "user #4");
  assert.equal(byLabel["Addressed to"], "Codex CLI");
  assert.equal(byLabel["Approved by"], "user #2");
  assert.equal(byLabel["Last event"], "task.succeed by user #9 (admin)");
  assert.match(byLabel.Outcome, /Not independently verified/);
  assert.equal(ts.riskLevel(true).level, "High");
  assert.equal(ts.riskLevel(false).level, "Standard");
  assert.equal(ts.riskLevel(undefined).level, "Unknown");
});

// ------------------------------------------------------------------ layout
test("panel widths persist within limits and leave room for the chat", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(layout.readLayout(storage), { navCollapsed: false, rightWidth: layout.RIGHT_DEFAULT });
  layout.writeLayout({ navCollapsed: true, rightWidth: 9999 }, storage);
  assert.deepEqual(layout.readLayout(storage), { navCollapsed: true, rightWidth: layout.RIGHT_MAX });
  layout.writeLayout({ rightWidth: 5 }, storage);
  assert.equal(layout.readLayout(storage).rightWidth, layout.RIGHT_MIN);
  store.set(layout.LAYOUT_KEY, "{not json");
  assert.deepEqual(layout.readLayout(storage), { ...layout.DEFAULT_LAYOUT });
  // The chat keeps MAIN_MIN: in a 900px row the sidebar can be at most 480px.
  assert.equal(layout.clampRightWidth(520, 900), 900 - layout.MAIN_MIN);
  assert.equal(layout.clampRightWidth(400, 500), layout.RIGHT_MIN);
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(layout.readLayout(blocked), { ...layout.DEFAULT_LAYOUT });
  assert.equal(layout.writeLayout({ rightWidth: 300 }, blocked).rightWidth, 300);
});

test("telemetry freshness marks stale and missing samples", () => {
  const now = Date.parse("2026-11-20T12:00:30Z");
  assert.deepEqual(layout.freshness("2026-11-20T12:00:20Z", now), { ageMs: 10_000, stale: false, label: "10s ago" });
  assert.equal(layout.freshness("2026-11-20T11:59:00Z", now).stale, true);
  assert.equal(layout.freshness("garbage", now).label, "No sample");
});

// ------------------------------------------------------------------ source checks
test("routes: /nytedesk sections and the inspector are private routes", () => {
  const main = read("frontend/src/main.jsx");
  assert.match(main, /path: "\/nytedesk\/:section\?\/:taskId\?"[\s\S]{0,200}PrivateRoute Component=\{NyteDeskApp\}/);
  const index = app("index.jsx");
  for (const s of ["dashboard", "workspace", "engines", "agentbridge", "tasks", "approvals", "knowledge", "memories", "logs"]) {
    assert.match(index, new RegExp(`\\b${s}: \\w+Section`), s);
  }
});

test("no process-control, execution or dispatch controls in the dashboard", () => {
  const all = ["index.jsx", "Shell.jsx", "widgets.jsx", "sections.jsx", "ChatPanel.jsx", "ApprovalInspector.jsx", "ui.jsx", "useNyteDesk.js"].map(app).join("\n");
  assert.doesNotMatch(all, /\/process\b|processAction|startTask|\/start\b|dispatch\(/);
  assert.doesNotMatch(all, />\s*(Start|Stop|Restart|Unload|Kill|Run|Execute|Dispatch)\s*</);
});

test("telemetry is never invented: no hardcoded readings, unavailable values say so", () => {
  const widgets = app("widgets.jsx");
  assert.doesNotMatch(widgets, /58°|7\.4 GB|10\.0 GB|Optimal|\b74%/);         // concept-image values
  for (const label of ["GPU utilization", "VRAM", "GPU temperature", "Tokens / second", "Context usage"]) {
    assert.match(widgets, new RegExp(`label="${label.replace("/", "\\/")}"[^]*?Unavailable`), label);
  }
  assert.match(widgets, /Measured on the NyteDesk server host/);
  assert.match(widgets, /fresh\.stale \? `Stale/);
  assert.match(app("useNyteDesk.js"), /document\.hidden/);                   // no polling in background tabs
});

test("approval: inline sidebar only links to the inspector; approve needs an explicit review", () => {
  const decisions = app("widgets.jsx").split("export function DecisionsPanel")[1];
  assert.doesNotMatch(decisions, /NyteDesk\.decide|onClick=\{\(\) => act/);
  assert.match(decisions, /to=\{`\/nytedesk\/approvals\/\$\{encodeURIComponent\(t\.id\)\}`\}/);
  const inspector = app("ApprovalInspector.jsx");
  assert.match(inspector, /disabled=\{!reviewed \|\| busy\}[\s\S]{0,80}act\("approve"\)/);
  assert.match(inspector, /NyteDesk\.decide\(task, op, reason, keys\[op\]\)/);  // sends version + payload hash
  assert.match(inspector, /if \(r\.status !== 0\) setKeys\(newKeys\(\)\)/);
  assert.match(inspector, /Number\(user\.id\) === Number\(task\.requesterId\)/); // explains self-approval
  for (const heading of ["Exact proposed operation", "Requester and provenance", "Affected resources and files", "Risk and permissions", "Supporting evidence", "Audit history"]) {
    assert.ok(inspector.includes(`title="${heading}"`), heading);
  }
});

test("text size reuses the shared control instead of a new implementation", () => {
  const shell = app("Shell.jsx");
  assert.match(shell, /import TextSizeMenu from "@\/components\/WorkspaceChat\/ChatContainer\/TextSizeMenu"/);
  assert.doesNotMatch(shell, /type="range"|localStorage\.setItem\("anythingllm_text_size"/);
  const menu = read("frontend/src/components/WorkspaceChat/ChatContainer/TextSizeMenu/index.jsx");
  assert.match(menu, /event\.key !== "Escape"/);
  assert.match(menu, /aria-valuetext=\{`\$\{selectedSize\} pixels`\}/);
  assert.match(menu, /subscribeChatFontSize\(setSelectedSize\)/);
});

test("resizable split is keyboard-operable and nav collapse persists", () => {
  const shell = app("Shell.jsx");
  assert.match(shell, /role="separator"[\s\S]{0,400}tabIndex=\{0\}/);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) assert.ok(shell.includes(`"${key}"`), key);
  assert.match(shell, /updateLayout\(\{ navCollapsed: !layout\.navCollapsed \}\)/);
  assert.match(shell, /useMediaQuery\("\(min-width: 1024px\)"\)/);           // stacks below lg
  assert.match(shell, /aria-modal="true"/);                                    // mobile drawer
});

test("the embedded chat is AnythingLLM's own workspace chat component", () => {
  const chat = app("ChatPanel.jsx");
  assert.match(chat, /import \{ default as WorkspaceChatContainer \} from "@\/components\/WorkspaceChat"/);
  assert.match(chat, /<WorkspaceChatContainer\s+loading=/);
});

test("the account button uses a stable hook, not a structure-dependent :has() selector", () => {
  const css = read("frontend/src/index.css");
  assert.match(css, /\.nytedesk-route \[data-user-menu\] \{\s*top: 0\.625rem;\s*right: 1rem;/);
  assert.doesNotMatch(css, /:has\(> \.nytedesk-app\)/);
  assert.match(read("frontend/src/components/UserMenu/UserButton/index.jsx"), /data-user-menu\s/);
  const shell = app("Shell.jsx");
  assert.match(shell, /document\.body\.classList\.add\("nytedesk-route"\)/);
  assert.match(shell, /return \(\) => document\.body\.classList\.remove\("nytedesk-route"\)/);
  assert.match(shell, /pr-16 md:pr-20 h-14/);
});

test("engine card buttons cancel CTAButton's corner margin so they do not overlap", () => {
  const cards = read("frontend/src/pages/NyteDesk/LocalAIEngines.jsx");
  assert.equal((cards.match(/<CTAButton(?! className="!mr-0")/g) || []).length, 0);
});

// ------------------------------------------------------------------ F1: review binding
test("F1: a review confirmation covers one exact task revision", () => {
  const a = { id: "A", version: 2, payloadHash: "h1" };
  const bound = ts.reviewBinding(a);
  assert.equal(ts.reviewMatches(bound, a), true);
  assert.equal(ts.reviewMatches(bound, { ...a, id: "B" }), false);          // other task
  assert.equal(ts.reviewMatches(bound, { ...a, version: 3 }), false);       // changed since review
  assert.equal(ts.reviewMatches(bound, { ...a, payloadHash: "h2" }), false); // other payload
  assert.equal(ts.reviewMatches(null, a), false);
  assert.equal(ts.reviewBinding(null), null);
});

test("F1: only the newest load may update the inspector (out-of-order responses)", async () => {
  const seq = ts.createSequencer();
  const shown = [];
  const load = async (id, delayMs) => {
    const token = seq.begin();
    await new Promise((r) => setTimeout(r, delayMs));
    if (seq.isCurrent(token)) shown.push(id);
  };
  await Promise.all([load("A", 40), load("B", 5)]);  // A is slower and older
  assert.deepEqual(shown, ["B"]);
});

test("F1: the inspector resets on task change and guards submission", () => {
  const src = app("ApprovalInspector.jsx");
  assert.match(src, /useEffect\(\(\) => \{\s*setDetail\(null\);\s*setError\(null\);\s*setReviewedFor\(null\);\s*setReason\(""\);\s*setKeys\(newKeys\(\)\);\s*load\(\);\s*\}, \[taskId, load\]\)/);
  assert.match(src, /if \(!sequencer\.current\.isCurrent\(token\)\) return;/);
  assert.match(src, /if \(r\.data\?\.task\?\.id !== taskId\) return;/);
  assert.match(src, /if \(!detail \|\| detail\.task\.id !== taskId\)/);
  assert.match(src, /const reviewed = reviewMatches\(reviewedFor, task\);/);
  assert.match(src, /if \(op === "approve" && !reviewMatches\(reviewedFor, task\)\) return;/);
  assert.match(src, /setReviewedFor\(e\.target\.checked \? reviewBinding\(task\) : null\)/);
  assert.doesNotMatch(src, /useState\(false\);\s*\/\/.*reviewed|setReviewed\(/);
  assert.match(src, /window\.addEventListener\("focus", onFocus\)/);      // reload on return
});

// ------------------------------------------------------------------ F2: freshness
test("F2: overlapping refreshes share one run", async () => {
  let runs = 0;
  let release;
  const fn = () => { runs += 1; return new Promise((r) => { release = r; }); };
  const flight = layout.createSingleFlight(fn);
  const p1 = flight();
  const p2 = flight();
  assert.equal(p1, p2);
  await Promise.resolve();
  assert.equal(runs, 1);
  release();
  await p1;
  const p3 = flight();
  await Promise.resolve();
  assert.equal(runs, 2);                                   // a later call starts a new run
  release();
  await p3;
});

test("F2: freshness distinguishes loading, refreshing, fresh, stale and failed", () => {
  const now = Date.parse("2026-11-20T12:05:00Z");
  const f = (o) => layout.dataFreshness(o, now);
  assert.equal(f({}).state, "loading");
  assert.equal(f({ lastError: "HTTP 500" }).state, "failed");
  assert.match(f({ lastError: "HTTP 500" }).label, /Could not load: HTTP 500/);
  assert.deepEqual(f({ lastSuccessAt: "2026-11-20T12:04:50Z" }), { state: "fresh", label: "Updated 10s ago", short: "10s ago" });
  assert.equal(f({ lastSuccessAt: "2026-11-20T12:04:50Z", refreshing: true }).state, "refreshing");
  assert.equal(f({ lastSuccessAt: "2026-11-20T12:02:00Z" }).state, "stale");
  const failed = f({ lastSuccessAt: "2026-11-20T12:04:00Z", lastError: "HTTP 502" });
  assert.equal(failed.state, "failed");
  assert.match(failed.label, /showing data from 1m ago/);
  assert.ok(layout.DATA_REFRESH_MS <= 60_000 && layout.DATA_REFRESH_MS >= 10_000);
  assert.ok(layout.DATA_STALE_MS > layout.DATA_REFRESH_MS);
});

test("F2: the data hook polls while visible, refreshes on focus, and cleans up", () => {
  const hook = app("useNyteDesk.js");
  assert.match(hook, /setInterval\(tick, DATA_REFRESH_MS\)/);
  assert.match(hook, /if \(!document\.hidden\) refresh\(\)/);
  assert.match(hook, /window\.addEventListener\("focus", onFocus\)/);
  assert.match(hook, /Date\.now\(\) - lastAttempt\.current < FOCUS_REFRESH_MIN_MS/);
  assert.match(hook, /createSingleFlight\(load\)/);
  assert.match(hook, /clearInterval\(id\);\s*window\.removeEventListener\("focus", onFocus\)/);
  assert.match(hook, /tasks: t\.ok \? t\.data\.tasks \|\| \[\] : prev\.tasks/);   // keep last good data
  const shell = app("Shell.jsx");
  assert.match(shell, /<span role="status" aria-live="polite" className="sr-only">/);
  assert.match(shell, /data-freshness=\{f\.state\}/);
  assert.match(shell, /aria-label=\{`Refresh dashboard data\. \$\{f\.label\}`\}/);
});

// ------------------------------------------------------------------ F3: drawer
test("F3: the mobile drawer traps focus, makes the page inert and restores focus", () => {
  const shell = app("Shell.jsx");
  assert.match(shell, /el\.inert = true;\s*el\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(shell, /el\.inert = false;\s*el\.removeAttribute\("aria-hidden"\)/);
  assert.match(shell, /document\.querySelector\("\[data-user-menu\]"\)/);   // account button too
  assert.match(shell, /restoreFocus\(opener, desktopNavRef\.current\)/);
  assert.match(shell, /if \(e\.key !== "Tab"\) return;/);
  assert.match(shell, /openerRef\.current = document\.activeElement/);
  assert.match(shell, /tabIndex=\{-1\}\s+aria-label="Close navigation"/);       // backdrop: mouse only
  assert.match(shell, /if \(isDesktop\) setDrawerOpen\(false\)/);
});

// ------------------------------------------------------------------ F5: telemetry UI
test("F5: the dashboard asks for host telemetry only for managers and admins", () => {
  const hook = app("useNyteDesk.js");
  assert.match(hook, /const TELEMETRY_ROLES = \["admin", "manager"\]/);
  assert.match(hook, /if \(!ready \|\| !telemetryAllowed\) return undefined;/);
  const widgets = app("widgets.jsx");
  assert.match(widgets, /Host metrics are available to managers and administrators\./);
  assert.match(widgets, /value="Restricted"/);
});

// ------------------------------------------------------------------ F4: CI
test("F4: the browser driver is pinned by lockfile and screenshots stay out of logs", () => {
  const pkg = JSON.parse(read("tests/e2e/package.json"));
  assert.equal(pkg.devDependencies["playwright-core"], "1.63.0");
  const lock = JSON.parse(read("tests/e2e/package-lock.json"));
  const entry = lock.packages["node_modules/playwright-core"];
  assert.equal(entry.version, "1.63.0");
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
  const wf = read(".github/workflows/fork-focused-tests.yml");
  assert.doesNotMatch(wf, /playwright-core@/);
  assert.equal((wf.match(/npm ci --prefix tests\/e2e --ignore-scripts/g) || []).length, 2);
  assert.doesNotMatch(wf, /base64|NYTEDESK-SHOT/);
  assert.match(wf, /retention-days: 7/);
});

// ------------------------------------------------------------------ N1: freshness on every viewport
test("N1: every freshness state has a short label for small screens", () => {
  const now = Date.parse("2026-11-20T12:05:00Z");
  const f = (o) => layout.dataFreshness(o, now);
  assert.equal(f({}).short, "Loading");
  assert.equal(f({ lastError: "x" }).short, "Failed");
  assert.equal(f({ lastSuccessAt: "2026-11-20T12:04:50Z", refreshing: true }).short, "Refreshing");
  assert.equal(f({ lastSuccessAt: "2026-11-20T12:04:00Z", lastError: "x" }).short, "Failed");
  assert.equal(f({ lastSuccessAt: "2026-11-20T12:02:00Z" }).short, "Stale 3m ago");
  assert.equal(f({ lastSuccessAt: "2026-11-20T12:04:50Z" }).short, "10s ago");
  // Stale and failed never share a short label.
  assert.notEqual(f({ lastSuccessAt: "2026-11-20T12:02:00Z" }).short, f({ lastSuccessAt: "2026-11-20T12:02:00Z", lastError: "x" }).short);
});

test("N1: the indicator is visible at every width; full sentence for screen readers", () => {
  const shell = app("Shell.jsx");
  const block = shell.split("function DataFreshness")[1].split("function TopBar")[0];
  assert.doesNotMatch(block, /hidden lg:inline text-xs/);                     // no longer hidden below lg
  assert.match(block, /className="lg:hidden" data-freshness-short/);
  assert.match(block, /className="hidden lg:inline" data-freshness-full/);
  assert.match(block, /FRESHNESS_DOT\[f\.state\]/);                           // colour plus text
  assert.match(block, /`Dashboard data: \$\{f\.label\}`/);
  for (const state of ["fresh", "refreshing", "loading", "stale", "failed"]) {
    assert.match(shell, new RegExp(`FRESHNESS_DOT = \\{[^}]*\\b${state}:`), state);
  }
});

// ------------------------------------------------------------------ N2: breakpoint focus
test("N2: closing on a breakpoint change restores focus to a visible desktop control", () => {
  const shell = app("Shell.jsx");
  assert.match(shell, /useEffect\(\(\) => \{\s*if \(isDesktop\) setDrawerOpen\(false\);\s*\}, \[isDesktop\]\)/);
  assert.match(shell, /openerRef\.current = null;/);                          // no detached reference kept
  assert.match(shell, /window\.requestAnimationFrame\(/);                     // after the DOM commit
  assert.match(shell, /if \(active && active !== document\.body && document\.contains\(active\)\)/);
  assert.match(shell, /export function restoreFocus\(opener, nav\)/);
  assert.match(shell, /nav\?\.querySelector\('\[aria-current="page"\]'\)/);
  assert.match(shell, /el\.isConnected &&\s*!el\.closest\("\[inert\]"\) &&\s*el\.getClientRects\(\)\.length > 0/);
  assert.match(shell, /ref=\{desktopNavRef\}/);
  // The desktop navigation is never part of the inert background.
  const bg = shell.match(/const background = \[([\s\S]*?)\]\.filter\(Boolean\)/)[1];
  assert.doesNotMatch(bg, /desktopNavRef/);
});

// ------------------------------------------------------------------ N3: request lifecycle
test("N3: cancelling a sequencer voids every token, including the current one", () => {
  const seq = ts.createSequencer();
  const t1 = seq.begin();
  assert.equal(seq.isCurrent(t1), true);
  seq.cancel();
  assert.equal(seq.isCurrent(t1), false);
  assert.equal(seq.isCurrent(seq.begin()), false);
});

test("N3: a response that arrives after unmount changes nothing", async () => {
  // Mirrors useNyteDesk: token taken at request time, checked before setState.
  const seq = ts.createSequencer();
  const applied = [];
  const request = async (value, delayMs) => {
    const token = seq.begin();
    await new Promise((r) => setTimeout(r, delayMs));
    if (seq.isCurrent(token)) applied.push(value);
  };
  const late = request("late", 30);
  seq.cancel(); // unmount
  await late;
  assert.deepEqual(applied, []);
});

test("N3: every data and telemetry update is guarded; unmount cancels both", () => {
  const hook = app("useNyteDesk.js");
  // Lifecycle effect comes before the fetching effects and is StrictMode-safe.
  const lifecycle = hook.indexOf("dataSeq.current = createSequencer();");
  assert.ok(lifecycle > 0 && lifecycle < hook.indexOf("setInterval(tick, DATA_REFRESH_MS)"));
  assert.match(hook, /dataSeq\.current\.cancel\(\);\s*telemetrySeq\.current\.cancel\(\);\s*singleFlight\.current = null;/);
  // load(): checked after each await, before any state update.
  const load = hook.split("const load = useCallback")[1].split("const refresh = useCallback")[0];
  assert.equal((load.match(/if \(!seq\.isCurrent\(token\)\) return;/g) || []).length, 2);
  assert.ok(load.indexOf("await NyteDesk.status()") < load.indexOf("if (!seq.isCurrent(token)) return;"));
  const poll = hook.split("const pollTelemetry = useCallback")[1].split("const ready")[0];
  assert.match(poll, /await NyteDesk\.telemetry\(\);\s*if \(!seq\.isCurrent\(token\)\) return;/);
  assert.match(poll, /document\.hidden\) return;/);
  // Single-flight, 30 s interval and 5 s focus throttle unchanged.
  assert.match(hook, /createSingleFlight\(load\)/);
  assert.match(hook, /Date\.now\(\) - lastAttempt\.current < FOCUS_REFRESH_MIN_MS/);
  assert.equal(layout.DATA_REFRESH_MS, 30_000);
  assert.equal(layout.FOCUS_REFRESH_MIN_MS, 5_000);
});

test("historical model tasks show the outcome message for their recorded code; the audit text is kept", () => {
  // Evidence as recorded by 643c51c during the 2026-11-22 owner run.
  const legacy = (event, detail) => [
    { event: "task.created", actorId: 3, at: "t0", detail: {} },
    { event: "task.approve", actorId: 2, at: "t1", detail: {} },
    { event: "task.start", actorId: 1, at: "t2", detail: {} },
    { event, actorId: 1, at: "t3", detail },
  ];
  const audit = legacy("task.succeed", {
    operation: "load", engine: "ollama", model: "qwen2.5-coder:0.5b-base",
    code: "OK", message: "Engine reachable; models listed.",
    httpStatus: 200, durationMs: 1265, loadedBefore: [], loadedAfter: ["qwen2.5-coder:0.5b-base"],
  });
  const before = JSON.stringify(audit);
  const o = ts.modelOutcome(audit);
  assert.equal(o.message, "The engine confirmed the operation.");
  assert.equal(o.recordedMessage, "Engine reachable; models listed.");
  assert.equal(o.succeeded, true);
  assert.equal(o.code, "OK");
  assert.deepEqual(o.loadedAfter, ["qwen2.5-coder:0.5b-base"]);
  assert.equal(JSON.stringify(audit), before, "the audit entries are not modified");
  // Codes model control does not define keep their recorded message.
  const failed = ts.modelOutcome(legacy("task.fail", { operation: "load", code: "HTTP_ERROR", message: "The engine answered with an HTTP error status.", httpStatus: 500 }));
  assert.equal(failed.message, "The engine answered with an HTTP error status.");
  assert.equal(failed.succeeded, false);
  // Model-control codes always use the current wording.
  assert.equal(ts.modelOutcome(legacy("task.fail", { operation: "unload", code: "STATE_MISMATCH", message: "old text" })).message,
    ts.MODEL_OUTCOME_MESSAGES.STATE_MISMATCH);
  assert.equal(ts.modelOutcome([{ event: "task.created", detail: {} }]), null);
  // The inspector renders the derived message.
  assert.match(app("ApprovalInspector.jsx"), /outcome\.message \? `: \$\{outcome\.message\}`/);
});

test("the inspector's model outcome messages match the server's model-control messages", () => {
  const mc = require("../../server/utils/nytedesk/model-control.cjs");
  for (const [code, text] of Object.entries(ts.MODEL_OUTCOME_MESSAGES)) {
    assert.equal(mc.DIAGNOSTICS[code], text, code);
  }
});
