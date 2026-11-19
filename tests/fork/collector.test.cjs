const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { zip } = require('./fixtures.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-test-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const saved = [];
const fileUtils = {
  directUploadsFolder: temporary,
  writeToServerDocuments({ data, filename, options = {} }) {
    const location = `direct-uploads/${filename}.json`;
    fs.writeFileSync(path.join(temporary, `${filename}.json`), JSON.stringify(data));
    saved.push(data);
    return { ...data, location, isDirectUpload: options.parseOnly || false };
  },
  createdDate: () => 'test',
  trashFile(file) { fs.rmSync(file, { force: true }); },
  normalizePath: value => path.normalize(value),
  isWithin: (outer, inner) => inner.startsWith(outer + path.sep),
  isTextType: () => false,
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/utils/files')) return fileUtils;
  if (request.endsWith('/utils/tokenizer')) return { tokenizeString: value => value.length };
  if (request === 'uuid') return { v4: randomUUID };
  if (request === 'slugify') return { default: value => value.replace(/[^a-zA-Z0-9]/g, '-') };
  if (request.endsWith('/convert/asDocx.js')) return async () => ({ success: true, documents: [fileUtils.writeToServerDocuments({ data: { id: 'inner', pageContent: 'Word document text' }, filename: 'inner', options: { parseOnly: true } })] });
  return originalLoad.call(this, request, parent, isMain);
};
const asZip = require('../../collector/processSingleFile/convert/asZip');
const asTxt = require('../../collector/processSingleFile/convert/asTxt');
const { processSingleFile } = require('../../collector/processSingleFile');
const { SUPPORTED_FILETYPE_CONVERTERS, ACCEPTED_MIMES } = require('../../collector/utils/constants');

function upload(name, data) {
  const target = path.join(temporary, name);
  fs.writeFileSync(target, data);
  return target;
}

test('ZIP collector returns one complete bundle, manifest paths and skipped binaries', async () => {
  const fullFilePath = upload('project.zip', zip([{ name: 'src/a.py', content: 'print(1)' }, { name: 'setup.bat', content: '@echo off\r\necho hello' }, { name: 'pic.png', content: 'binary' }, { name: '../escape.py', content: 'bad' }]));
  const result = await asZip({ fullFilePath, filename: 'project.zip', options: { parseOnly: true } });
  assert.equal(result.success, true);
  assert.equal(result.documents.length, 1);
  const doc = result.documents[0];
  assert.deepEqual(doc.archiveSummary, { imported: 2, skipped: 2, total: 4 });
  assert.ok(doc.pageContent.includes('print(1)'));
  for (const entry of doc.archiveManifest.filter(e => e.status === 'imported')) {
    const text = doc.pageContent.slice(entry.contentStart, entry.contentEnd);
    assert.ok(text.length);
    assert.equal(entry.lines, text.split('\n').length);
  }
  assert.equal(fs.existsSync(fullFilePath), false);
  assert.equal(fs.existsSync(path.join(temporary, 'escape.py')), false);
});
test('batch script decoding handles UTF-16 and Windows-1252, rejects binary source', () => {
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from('@echo hello', 'utf16le')]);
  assert.equal(asZip.decodeSource(utf16), '@echo hello');
  assert.equal(asTxt.decodeText(Buffer.from([0x80, 0x20, 0x93, 0x78, 0x94])), '€ “x”');
  assert.throws(() => asZip.decodeSource(Buffer.from([0, 1, 2])), /binary/);
});
test('empty or all-skipped ZIPs fail explicitly and preserve caller-owned originals', async () => {
  const fullFilePath = upload('empty.zip', zip([{ name: 'binary.exe', content: 'exe' }]));
  const result = await asZip({ fullFilePath, filename: 'empty.zip', options: { absolutePath: fullFilePath } });
  assert.equal(result.success, false);
  assert.match(result.reason, /no readable/);
  assert.equal(fs.existsSync(fullFilePath), true);
});
test('document converter output is bundled and intermediate documents are removed', async () => {
  const inner = zip([{ name: 'word/document.xml', content: '<p>Hello</p>' }]);
  const fullFilePath = upload('docs.zip', zip([{ name: 'report.docx', content: inner }]));
  const result = await asZip({ fullFilePath, filename: 'docs.zip' });
  assert.equal(result.success, true);
  assert.match(result.documents[0].pageContent, /Word document text/);
  assert.equal(fs.existsSync(path.join(temporary, 'inner.json')), false);
});
test('registered ZIP converter works through processSingleFile with unique upload names', async () => {
  const target = upload('unique-123.zip', zip([{ name: 'code.js', content: 'const answer = 42;' }]));
  const result = await processSingleFile(path.basename(target), { absolutePath: target, originalFilename: 'friendly.zip', parseOnly: true });
  assert.equal(result.success, true);
  assert.equal(result.documents[0].title, 'friendly.zip');
  assert.equal(fs.existsSync(target), true);
});
test('direct bat/cmd/ps1 use text converter and accept-list includes scripts and ZIP', async () => {
  for (const extension of ['.bat', '.cmd', '.ps1']) {
    assert.equal(SUPPORTED_FILETYPE_CONVERTERS[extension], './convert/asTxt.js');
    assert.ok(ACCEPTED_MIMES['text/plain'].includes(extension));
    const target = upload('script' + extension, '@echo hello');
    const result = await processSingleFile(path.basename(target), { absolutePath: target });
    assert.equal(result.documents[0].pageContent, '@echo hello');
  }
  assert.ok(ACCEPTED_MIMES['application/zip'].includes('.zip'));
});

test('rejects oversized aggregate text instead of returning a partial bundle', async () => {
  const { randomBytes } = require('node:crypto');
  const pattern = randomBytes(128000).map(byte => 32 + byte % 95);
  const content = Buffer.concat(Array(63).fill(pattern));
  const target = upload('too-much.zip', zip(Array.from({ length: 8 }, (_, i) => ({ name: `source-${i}.txt`, content }))));
  const before = saved.length;
  const result = await asZip({ fullFilePath: target, filename: 'too-much.zip' });
  assert.equal(result.success, false);
  assert.match(result.reason, /64,000,000/);
  assert.equal(result.documents.length, 0);
  assert.equal(saved.length, before);
});
test('rejects corrupted embedded Office containers before invoking a converter', async () => {
  const inner = zip([{ name: 'word/document.xml', content: '<p>Hello</p>', method: 0 }]);
  inner[30 + Buffer.byteLength('word/document.xml')] ^= 1;
  const target = upload('bad-office.zip', zip([{ name: 'bad.docx', content: inner }]));
  const result = await asZip({ fullFilePath: target, filename: 'bad-office.zip' });
  assert.equal(result.success, false);
  assert.match(result.reason, /CRC/);
});
