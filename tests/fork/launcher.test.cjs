const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(broken = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-launcher-'));
  fs.mkdirSync(path.join(root, 'tools'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.copyFileSync(path.join(__dirname, '../../tools/linux-run.sh'), path.join(root, 'tools/linux-run.sh'));
  function binary(name, content) { fs.writeFileSync(path.join(root, 'bin', name), '#!/bin/bash\n' + content, { mode: 0o755 }); }
  binary('node', 'if [[ \"${2:-}\" == \"process.arch\" ]]; then echo x64; else echo 26; fi\n');
  binary('npx', 'echo RECURSION >&2; exit 99\n');
  binary('npm', `
arguments="$*"
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--prefix" ]]; then prefix="$2"; shift 2; else shift; fi
done
printf 'install\\n' >> "$prefix/install-count"
printf '%s\\n' "$arguments" > "$prefix/install-arguments"
mkdir -p "$prefix/node_modules/node-linux-x64/bin" "$prefix/node_modules/yarn/bin"
printf '#!/bin/bash\\necho ${broken ? '26' : '24'}\\n' > "$prefix/node_modules/node-linux-x64/bin/node"
printf '#!/bin/bash\\necho 1.22.22\\n' > "$prefix/node_modules/yarn/bin/yarn"
printf '// fixture\\n' > "$prefix/node_modules/yarn/bin/yarn.js"
chmod +x "$prefix/node_modules/node-linux-x64/bin/node" "$prefix/node_modules/yarn/bin/yarn"
`);
  return root;
}
function run(root) {
  return spawnSync('/bin/bash', ['tools/linux-run.sh', '--check-toolchain'], {
    cwd: root, env: { ...process.env, PATH: path.join(root, 'bin') + ':/usr/bin:/bin' },
    encoding: 'utf8', timeout: 5000,
  });
}

test('installs explicit tools once, then reuses them without npm-exec recursion', { skip: process.getuid?.() === 0 }, () => {
  const root = fixture();
  try {
    const first = run(root);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /24\n1\.22\.22/);
    const argumentsUsed = fs.readFileSync(path.join(root, 'server/storage/.fork-toolchain/install-arguments'), 'utf8');
    assert.match(argumentsUsed, /--ignore-scripts/);
    assert.match(argumentsUsed, /node-linux-x64@24\.22\.3/);
    assert.ok(!argumentsUsed.includes(' node@'));
    assert.ok(!first.stderr.includes('RECURSION'));
    const second = run(root);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'server/storage/.fork-toolchain/install-count'), 'utf8'), 'install\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('wrong toolchain version fails once instead of restarting indefinitely', { skip: process.getuid?.() === 0 }, () => {
  const root = fixture(true);
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no automatic relaunch/);
    assert.ok(!result.stderr.includes('RECURSION'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uses an explicit installed browser and rejects invalid browser paths', { skip: process.getuid?.() === 0 }, () => {
  const root = fixture();
  try {
    assert.equal(run(root).status, 0);
    const browser = path.join(root, 'bin', 'test-chromium');
    fs.writeFileSync(browser, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const options = { cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: path.join(root, 'bin') + ':/usr/bin:/bin', PUPPETEER_EXECUTABLE_PATH: browser } };
    const result = spawnSync('/bin/bash', ['tools/linux-run.sh', '--check-browser'], options);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /skipping bundled download/);
    options.env.PUPPETEER_EXECUTABLE_PATH = path.join(root, 'missing-browser');
    const invalid = spawnSync('/bin/bash', ['tools/linux-run.sh', '--check-browser'], options);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /not executable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
