const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openZip, LIMITS } = require('../../collector/utils/archives/zip');
const { zip } = require('./fixtures.cjs');

test('reads stored and deflated files with source paths and CRC', () => {
  const entries = openZip(zip([{ name: 'src/main.py', content: 'print(1)' }, { name: 'setup.bat', content: '@echo off', method: 0 }]));
  assert.equal(entries[0].path, 'src/main.py');
  assert.equal(entries[0].read().toString(), 'print(1)');
  assert.equal(entries[1].read().toString(), '@echo off');
});
test('rejects non-ZIP and incomplete data', () => {
  assert.throws(() => openZip(Buffer.from('not a zip')), /end record/);
  assert.throws(() => openZip(zip([{ name: 'a', content: 'a' }]).subarray(0, -3)), /end record/);
});
test('reports traversal, absolute, drive and control-character paths without reading', () => {
  for (const name of ['../bad', '/absolute', 'C:\\bad', 'a/../../bad', 'a\0b', '..\\bad']) {
    const entry = openZip(zip([{ name, content: 'hello' }]))[0];
    assert.match(entry.skipReason, /unsafe path/);
    assert.throws(() => entry.read(), /unsafe path/);
  }
});
test('reports symlinks, encrypted entries, duplicates and nested archives', () => {
  const entries = openZip(zip([{ name: 'link', mode: 0o120777 }, { name: 'secret', flags: 1 }, { name: 'a', content: '1' }, { name: 'a', content: '2' }, { name: 'inner.zip' }]));
  assert.match(entries[0].skipReason, /symbolic/);
  assert.match(entries[1].skipReason, /encrypted/);
  assert.match(entries[3].skipReason, /duplicate/);
  assert.match(entries[4].skipReason, /nested/);
});
test('bounds entries, declared expansion, member size and compression ratio', () => {
  const data = zip([{ name: 'a', content: 'hello' }]);
  assert.throws(() => openZip(data, { ...LIMITS, entries: 0 }), /the limit is/);
  assert.throws(() => openZip(data, { ...LIMITS, totalBytes: 1 }), /128 MiB/);
  assert.match(openZip(data, { ...LIMITS, entryBytes: 1 })[0].skipReason, /limit/);
  assert.match(openZip(zip([{ name: 'a', content: 'x'.repeat(100000) }]))[0].skipReason, /limit/);
});
test('detects altered stored contents and forged expansion sizes', () => {
  const data = zip([{ name: 'a', content: 'hello', method: 0 }]);
  data[31] ^= 1;
  assert.throws(() => openZip(data)[0].read(), /CRC/);
  const forged = zip([{ name: 'a', content: 'x'.repeat(10000), declaredSize: 1 }]);
  assert.throws(() => openZip(forged)[0].read(), /size\/CRC/);
});
test('checks local names, local flags and central directory bounds', () => {
  const name = zip([{ name: 'a', content: 'hello' }]); name[30] = 98;
  assert.throws(() => openZip(name)[0].read(), /name or data/);
  const flags = zip([{ name: 'a', content: 'hello' }]); flags.writeUInt16LE(1, 6);
  assert.throws(() => openZip(flags)[0].read(), /header mismatch/);
  const bounds = zip([{ name: 'a', content: 'hello' }]); bounds.writeUInt32LE(0xffffffff, bounds.length - 6);
  assert.throws(() => openZip(bounds), /ZIP64/);
});
test('skips dependencies and unsupported compression; handles empty ZIP', () => {
  const entries = openZip(zip([{ name: 'node_modules/a.js' }, { name: 'a', method: 99 }]));
  assert.match(entries[0].skipReason, /dependency/);
  assert.match(entries[1].skipReason, /compression/);
  assert.deepEqual(openZip(zip([])), []);
});

test('accepts ordinary repositories above 1000 entries but enforces the new hard cap', () => {
  const entries = openZip(zip(Array.from({ length: 2200 }, (_, i) => ({ name: `src/file-${i}.py`, content: 'print(1)' }))));
  assert.equal(entries.length, 2200);
  assert.equal(entries[2199].read().toString(), 'print(1)');
  const tooMany = zip(Array.from({ length: 10001 }, (_, i) => ({ name: `f${i}`, content: '' })));
  assert.throws(() => openZip(tooMany), /10,001 entries; the limit is 10,000/);
});
