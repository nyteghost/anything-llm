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
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    dispatchEvent: (e) => events.push(e),
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
  assert.equal(n("small"), 11);
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
  window.localStorage.setItem(mod.CHAT_FONT_STORAGE_KEY, "large");   // a value saved by the old presets
  assert.equal(mod.readChatFontSize(), 18);
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
