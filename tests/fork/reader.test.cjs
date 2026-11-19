const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FileReview } = require('../../server/utils/agents/aibitat/utils/fileReview');
const { attachedFileContext } = require('../../server/utils/agents/aibitat/utils/attachedFileContext');

test('raw reads preserve numbered lines and distinguish partial supply', () => {
  const reader = new FileReview(), doc = { title: 'a.py', content: 'alpha\nbeta\ngamma' };
  assert.equal(reader.coverage('one', doc).files[0].status, 'not supplied');
  const first = reader.read('one', doc, { line_count: 1 });
  assert.equal(first.content, '1: alpha');
  assert.deepEqual(first.next, { start_line: 2, character_offset: 0 });
  assert.equal(reader.coverage('one', doc).files[0].status, 'partially supplied');
  reader.read('one', doc, { ...first.next });
  assert.equal(reader.coverage('one', doc).files[0].status, 'fully supplied');
});
test('long lines paginate without skipping or repeating characters', () => {
  const reader = new FileReview(), doc = { title: 'min.js', content: 'x'.repeat(40000) + '\nend' };
  let args = {}, count = 0, supplied = 0;
  do {
    const result = reader.read('id', doc, args);
    assert.ok(result.content.length <= 12000);
    supplied += result.returned_characters;
    args = result.next;
    assert.ok(++count < 10);
  } while (args);
  assert.equal(supplied, doc.content.length);
  assert.equal(reader.coverage('id', doc).all_imported_files_supplied, true);
});
test('coverage merges overlapping reads and resets for changed content and new instances', () => {
  const reader = new FileReview(), doc = { title: 'a', content: 'one\ntwo\nthree' };
  reader.read('a', doc, { line_count: 2 });
  reader.read('a', doc, { line_count: 2 });
  assert.equal(reader.coverage('a', doc).files[0].supplied_characters, 8);
  assert.equal(reader.coverage('a', { ...doc, content: 'changed' }).files[0].status, 'not supplied');
  assert.equal(new FileReview().coverage('a', doc).files[0].status, 'not supplied');
});
test('archive coverage includes skipped and unread entries, preserves source-relative lines', () => {
  const reader = new FileReview(), doc = { title: 'project.zip', content: 'intro\nhello\nworld\nother', archiveManifest: [
    { path: 'src/main.py', status: 'imported', contentStart: 6, contentEnd: 17 },
    { path: 'other.bat', status: 'imported', contentStart: 18, contentEnd: 23 },
    { path: 'binary.exe', status: 'skipped', reason: 'binary' },
  ] };
  assert.throws(() => reader.read('a', doc), /exact file_path/);
  const read = reader.read('a', doc, { file_path: 'src/main.py' });
  assert.equal(read.content, '1: hello\n2: world');
  const result = reader.coverage('a', doc);
  assert.equal(result.all_imported_files_supplied, false);
  assert.equal(result.skipped_files, 1);
  assert.equal(result.files[1].status, 'not supplied');
});
test('validates offsets and fails malformed archive metadata', () => {
  const reader = new FileReview(), doc = { title: 'a', content: 'abc' };
  for (const args of [{ start_line: -1 }, { line_count: 0 }, { character_offset: 99 }, { start_line: 20 }])
    assert.throws(() => reader.read('a', doc, args));
  assert.throws(() => reader.read('a', { ...doc, archiveManifest: [{ path: 'a', status: 'imported', contentStart: -1, contentEnd: 100 }] }), /offsets/);
});
test('large sources and archives are represented by reader notices; small ordinary text stays intact', () => {
  assert.match(attachedFileContext({ content: 'x'.repeat(20000), metadata: {} }), /not automatically injected/);
  const notice = attachedFileContext({ content: 'private code', metadata: { archiveManifest: [{ status: 'imported' }, { status: 'skipped' }] } });
  assert.match(notice, /1 files imported; 1 skipped/);
  assert.ok(!notice.includes('private code'));
  assert.equal(attachedFileContext({ content: 'small', metadata: {} }), 'small');
});
