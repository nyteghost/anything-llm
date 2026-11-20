// Chat font-size preference (PR #2): the real frontend module, loaded as ESM from source,
// with a stand-in window and localStorage.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
let mod;
const events = [];

before(async () => {
  const store = new Map();
  globalThis.CustomEvent ??= class CustomEvent extends Event {
    constructor(type, init) { super(type); this.detail = init?.detail; }
  };
  const target = new EventTarget();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: (e) => { events.push(e); return target.dispatchEvent(e); },
  };
  const src = read("frontend/src/utils/chat/textSize.js");
  mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
});

test("range 10-22 px, default 14, legacy presets migrate", () => {
  assert.equal(mod.CHAT_FONT_MIN, 10);
  assert.equal(mod.CHAT_FONT_MAX, 22);
  assert.equal(mod.CHAT_FONT_DEFAULT, 14);
  const n = mod.normalizeChatFontSize;
  assert.equal(n(null), 14);
  assert.equal(n("garbage"), 14);
  assert.equal(n(undefined), 14);
  assert.equal(n({}), 14);
  assert.equal(n(3), 10);
  assert.equal(n(99), 22);
  assert.equal(n("16"), 16);
  assert.equal(n(15.6), 16);
  assert.equal(n("small"), 12);                 // AnythingLLM's text-[12px]
  assert.equal(n("normal"), 14);
  assert.equal(n("large"), 18);
});

test("writes persist, broadcast a live update, and read back clamped", () => {
  assert.equal(mod.readChatFontSize(), 14);                 // nothing stored yet
  assert.equal(mod.writeChatFontSize(30), 22);
  assert.equal(window.localStorage.getItem(mod.CHAT_FONT_STORAGE_KEY), "22");
  assert.equal(events.at(-1).type, "textSizeChange");
  assert.equal(events.at(-1).detail, 22);
  assert.equal(mod.readChatFontSize(), 22);
  mod.writeChatFontSize(mod.CHAT_FONT_DEFAULT);             // reset
  assert.equal(mod.readChatFontSize(), 14);
  for (const [legacy, px] of [["small", 12], ["normal", 14], ["large", 18]]) {
    window.localStorage.setItem(mod.CHAT_FONT_STORAGE_KEY, legacy);   // saved by the old presets
    assert.equal(mod.readChatFontSize(), px);
    assert.equal(window.localStorage.getItem(mod.CHAT_FONT_STORAGE_KEY), String(px)); // migrated once
  }
  window.localStorage.setItem(mod.CHAT_FONT_STORAGE_KEY, "40");
  assert.equal(mod.readChatFontSize(), 22);
  assert.equal(window.localStorage.getItem(mod.CHAT_FONT_STORAGE_KEY), "22");
});

test("subscribers follow this tab and other tabs, and unsubscribe cleanly", () => {
  const seen = [];
  const stop = mod.subscribeChatFontSize((px) => seen.push(px));
  mod.writeChatFontSize(17);                                        // this tab
  const storage = (key, newValue) => {
    const e = new Event("storage");
    Object.assign(e, { key, newValue });
    window.dispatchEvent(e);
  };
  storage(mod.CHAT_FONT_STORAGE_KEY, "20");                         // another tab
  storage(mod.CHAT_FONT_STORAGE_KEY, "small");                      // another tab, old build
  storage("unrelated_key", "21");                                   // ignored
  stop();
  mod.writeChatFontSize(13);                                        // after unsubscribe
  assert.deepEqual(seen, [17, 20, 12]);
});

test("controls and the hook share one subscription helper", () => {
  for (const rel of [
    "frontend/src/hooks/useTextSize.js",
    "frontend/src/components/WorkspaceChat/ChatContainer/ChatSettingsMenu/TextSize/index.jsx",
    "frontend/src/components/WorkspaceChat/ChatContainer/TextSizeMenu/index.jsx",
    "frontend/src/components/WorkspaceChat/ChatContainer/PromptInput/TextSizeMenu/index.jsx",
  ]) {
    const src = read(rel);
    assert.match(src, /useEffect\(\(\) => subscribeChatFontSize\(set\w+\), \[\]\)/, rel);
    assert.doesNotMatch(src, /addEventListener\("textSizeChange"/, rel);
  }
});

test("markdown headings, tables and code scale in chat only, unchanged at 14px", () => {
  const css = read("frontend/src/index.css");
  const rule = (sel) => css.match(new RegExp(sel.replace(/[.]/g, "\\.") + " \\{\\s*font-size: ([\\d.]+)em"))?.[1];
  // em × 14px reproduces the fixed upstream sizes at the default.
  for (const [sel, px] of [
    [".chat-font-scale.markdown h1", 32], [".chat-font-scale.markdown h2", 24],
    [".chat-font-scale.markdown h3", 18], [".chat-font-scale.markdown table", 13],
    [".chat-font-scale .hljs", 14],
  ]) {
    const em = Number(rule(sel));
    assert.ok(Math.abs(em * 14 - px) < 0.01, `${sel}: ${em}em`);
  }
  const history = read("frontend/src/components/WorkspaceChat/ChatContainer/ChatHistory/index.jsx");
  assert.match(history, /className=\{`markdown chat-font-scale /);
  // Only the chat history opts in; other markdown surfaces keep their sizes.
  assert.equal((css.match(/\.chat-font-scale/g) || []).length, 5);
});

test("blocked storage still applies the size for the page", () => {
  const saved = window.localStorage;
  window.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  try {
    assert.equal(mod.readChatFontSize(), 14);
    assert.equal(mod.writeChatFontSize(12), 12);
    assert.equal(events.at(-1).detail, 12);
  } finally {
    window.localStorage = saved;
  }
});

test("every chat surface follows the slider: history and the prompt input", () => {
  const history = read("frontend/src/components/WorkspaceChat/ChatContainer/ChatHistory/index.jsx");
  assert.match(history, /style=\{\{ fontSize: `\$\{textSizePx\}px` \}\}/);
  const prompt = read("frontend/src/components/WorkspaceChat/ChatContainer/PromptInput/index.jsx");
  assert.match(prompt, /const \{ textSizePx \} = useTextSize\(\)/);
  assert.match(prompt, /fontSize: `\$\{inputFontSize\}px`/);
  assert.match(prompt, /Math\.max\(16, textSizePx\)/);           // mobile minimum, avoids iOS zoom
  assert.doesNotMatch(prompt, /textSizeClass/);
});

test("the settings-menu slider is keyboard accessible", () => {
  const row = read("frontend/src/components/WorkspaceChat/ChatContainer/ChatSettingsMenu/TextSize/index.jsx");
  assert.match(row, /<button[\s\S]*?aria-haspopup="true"[\s\S]*?aria-expanded=\{showSubmenu\}/);
  assert.match(row, /\["Enter", " ", "ArrowLeft"\]/);
  assert.match(row, /event\.key === "Escape"/);
  assert.match(row, /type="range"[\s\S]*?min=\{CHAT_FONT_MIN\}[\s\S]*?max=\{CHAT_FONT_MAX\}/);
  assert.match(row, /aria-valuetext=/);
  assert.match(row, /onClick=\{\(\) => change\(CHAT_FONT_DEFAULT\)\}/);   // reset to 14 px
});

test("the settings-menu slider works on touch screens and phones", () => {
  const row = read("frontend/src/components/WorkspaceChat/ChatContainer/ChatSettingsMenu/TextSize/index.jsx");
  // Hover opens only for a mouse, so a tap's synthetic enter + click cannot cancel out.
  assert.match(row, /onPointerEnter=[\s\S]*?pointerType !== "mouse"/);
  assert.doesNotMatch(row, /onMouseEnter|onMouseLeave/);
  // The click after a hover keeps the submenu open.
  assert.match(row, /if \(openedByHover\.current\) \{[\s\S]*?setShowSubmenu\(true\)/);
  // Inline below md; flyout to the left only from md up.
  assert.match(row, /className="mt-1 md:mt-0 md:absolute md:right-full/);
  assert.match(row, /w-full md:w-\[190px\]/);
});
