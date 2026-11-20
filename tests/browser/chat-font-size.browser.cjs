// Real-browser check of the chat font-size module and the chat markdown CSS.
// This is a standalone harness, not the AnythingLLM app: it serves the real
// frontend/src/utils/chat/textSize.js and the real index.css rules to Chrome.
// Run: NODE_PATH=<dir with playwright or playwright-core> CHROME=<chrome path> \
//      node tests/browser/chat-font-size.browser.cjs
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
// Full playwright or playwright-core: either drives an installed Chrome.
const { chromium } = (() => {
  try { return require("playwright"); } catch { return require("playwright-core"); }
})();

const root = path.resolve(__dirname, "../..");
const moduleSrc = fs.readFileSync(path.join(root, "frontend/src/utils/chat/textSize.js"), "utf8");
const css = fs.readFileSync(path.join(root, "frontend/src/index.css"), "utf8");
// Plain-CSS rules only (no Tailwind directives): the upstream fixed sizes and the chat overrides.
const pick = (re) => (css.match(re) || []).join("\n");
const rules = [
  pick(/\.markdown h[123] \{[^}]*\}/g),
  pick(/\.markdown table \{[^}]*font-size[^}]*\}/g),
  pick(/\.chat-font-scale[^{]*\{[^}]*\}/g),
  ".text-sm{font-size:.875rem;line-height:1.25rem}", // Tailwind's text-sm on code blocks
].join("\n");
const page = `<!doctype html><style>${rules}</style>
<div id="chat" class="markdown chat-font-scale"><h1>H1</h1><h2>H2</h2><h3>H3</h3><p id="p">Body</p>
<table><tr><td id="td">cell</td></tr></table><div class="hljs text-sm" id="code">code</div></div>
<div id="other" class="markdown" style="font-size:14px"><h3>H3</h3><div class="hljs text-sm">code</div></div>
<script type="module">
  import * as m from "/textSize.js";
  window.m = m; window.seen = [];
  m.subscribeChatFontSize((px) => { window.seen.push(px); document.getElementById("chat").style.fontSize = px + "px"; });
  document.getElementById("chat").style.fontSize = m.readChatFontSize() + "px";
  window.ready = true;
</script>`;
const server = http.createServer((req, res) => {
  if (req.url === "/textSize.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(moduleSrc); }
  res.writeHead(200, { "content-type": "text/html" }); res.end(page);
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
  const results = [];
  const check = async (name, fn) => { await fn(); results.push(name); console.log("ok -", name); };
  try {
    const ctx = await browser.newContext();
    const a = await ctx.newPage();
    await a.goto(url);
    await a.evaluate(() => localStorage.setItem("anythingllm_text_size", "small"));
    await a.reload(); await a.waitForFunction(() => window.ready);
    const sizes = (p) => p.evaluate(() => {
      const fs = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize);
      return { p: fs("#p"), h1: fs("#chat h1"), h2: fs("#chat h2"), h3: fs("#chat h3"), td: fs("#td"),
               code: fs("#code"), otherH3: fs("#other h3"), otherCode: fs("#other .hljs"),
               stored: localStorage.getItem("anythingllm_text_size") };
    });

    await check("legacy 'small' migrates to 12px and is rewritten in storage", async () => {
      const s = await sizes(a);
      assert.equal(s.p, 12); assert.equal(s.stored, "12");
    });

    await check("at the 14px default the chat matches upstream's fixed sizes", async () => {
      await a.evaluate(() => window.m.writeChatFontSize(14));
      const s = await sizes(a);
      assert.deepEqual([s.p, s.h1, s.h2, s.h3, s.td, s.code].map(Math.round), [14, 32, 24, 18, 13, 14]);
    });

    await check("at 22px headings, tables and code scale; other markdown is untouched", async () => {
      await a.evaluate(() => window.m.writeChatFontSize(22));
      const s = await sizes(a);
      assert.equal(s.p, 22); assert.ok(s.h3 > s.p && s.h2 > s.h3 && s.h1 > s.h2, JSON.stringify(s));
      assert.equal(Math.round(s.code), 22); assert.ok(s.td > 19);
      assert.equal(s.otherH3, 18); assert.equal(s.otherCode, 14);   // outside .chat-font-scale
    });

    await check("a second tab follows the change live (storage event)", async () => {
      const b = await ctx.newPage(); await b.goto(url); await b.waitForFunction(() => window.ready);
      assert.equal((await sizes(b)).p, 22);                          // persisted across load
      await a.evaluate(() => window.m.writeChatFontSize(16));
      await b.waitForFunction(() => window.seen.includes(16), null, { timeout: 3000 });
      assert.equal((await sizes(b)).p, 16);
    });

    await check("the size survives a reload", async () => {
      await a.reload(); await a.waitForFunction(() => window.ready);
      assert.equal((await sizes(a)).p, 16);
    });
  } finally {
    await browser.close(); server.close();
  }
  console.log(`# pass ${results.length}`);
})().catch((e) => { console.error(e); process.exit(1); });
