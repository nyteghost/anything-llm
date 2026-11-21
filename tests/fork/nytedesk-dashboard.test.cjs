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

test("the legend lists all eight requested states and marks untracked ones", () => {
  const ids = ts.DISPLAY_STATES.map((s) => s.label);
  for (const l of ["Proposed", "Awaiting approval", "Approved", "Queued", "Executing", "Agent-reported complete", "Independently verified", "Failed", "Cancelled"]) {
    assert.ok(ids.includes(l), l);
  }
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
