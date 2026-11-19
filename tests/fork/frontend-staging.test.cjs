const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stageFrontend } = require('../../tools/stage-frontend.cjs');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-staging-'));
  fs.mkdirSync(path.join(root, 'frontend/dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'server/public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server/public/_index.html'), 'old build');
  return root;
}
test('stages postbuild _index.html and assets, retaining the prior build', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'frontend/dist/_index.html'), 'new build');
    fs.writeFileSync(path.join(root, 'frontend/dist/main.js'), 'asset');
    stageFrontend(root);
    assert.equal(fs.readFileSync(path.join(root, 'server/public/_index.html'), 'utf8'), 'new build');
    assert.equal(fs.readFileSync(path.join(root, 'server/public/main.js'), 'utf8'), 'asset');
    assert.equal(fs.readFileSync(path.join(root, 'server/public-fork-previous/_index.html'), 'utf8'), 'old build');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('missing SSR template stops without changing the previous working build', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'frontend/dist/index.html'), 'pre-postbuild');
    assert.throws(() => stageFrontend(root), /_index.html/);
    assert.equal(fs.readFileSync(path.join(root, 'server/public/_index.html'), 'utf8'), 'old build');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
