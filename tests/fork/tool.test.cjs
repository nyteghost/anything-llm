const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-tool-test-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const scopes = [];
const original = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/models/documents')) return { Document: {
    where: async scope => { scopes.push(scope); return [{ docId: 'one', metadata: JSON.stringify({ title: 'shared.txt' }) }]; },
    content: async id => { assert.equal(id, 'one'); return { title: 'shared.txt', content: 'workspace source' }; },
  } };
  if (request.endsWith('/models/workspaceParsedFiles')) return { WorkspaceParsedFiles: { where: async scope => {
    scopes.push(scope);
    return [{ id: 2, filename: 'upload', metadata: JSON.stringify({ title: 'upload.bat', location: 'direct-uploads/file.json' }) }];
  } } };
  if (request.endsWith('/http')) return { safeJsonParse: (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } } };
  if (request === '../utils/summarize') return { summarizeContent: async () => 'summary' };
  if (request.endsWith('/providers/ai-provider')) return { contextLimit: () => 100 };
  if (request.endsWith('/helpers/tiktoken')) return { TokenManager: class { countFromString(s) { return s.length; } } };
  if (request === '../../../files') return { directUploadsPath: temporary };
  return original.call(this, request, parent, isMain);
};
const { docSummarizer } = require('../../server/utils/agents/aibitat/plugins/summarize');
fs.writeFileSync(path.join(temporary, 'file.json'), JSON.stringify({ title: 'upload.bat', pageContent: '@echo off\necho done' }));
function tool() {
  let definition;
  const aibitat = { handlerProps: { invocation: { workspace_id: 9, thread_id: 4, user_id: 7 }, log() {} }, function(d) { definition = d; }, introspect() {}, addCitation() {} };
  docSummarizer.plugin().setup(aibitat);
  return args => definition.handler.call(definition, args).then(value => { try { return JSON.parse(value); } catch { return value; } });
}

test('lists workspace docs and current-user/current-thread uploads with exact scope', async () => {
  const invoke = tool(), result = await invoke({ action: 'list' });
  assert.equal(result.total, 2);
  assert.deepEqual(scopes.slice(-2), [{ workspaceId: 9 }, { workspaceId: 9, threadId: 4, userId: 7 }]);
  assert.ok(!JSON.stringify(result).includes('location'));
});
test('raw reading works for parsed attachments, coverage and workspace docs', async () => {
  const invoke = tool();
  const upload = await invoke({ action: 'read', document_id: 'upload:2' });
  assert.equal(upload.content, '1: @echo off\n2: echo done');
  const coverage = await invoke({ action: 'coverage', document_id: 'upload:2' });
  assert.equal(coverage.items[0].status, 'fully supplied');
  const workspace = await invoke({ action: 'read', document_id: 'workspace:one' });
  assert.equal(workspace.content, '1: workspace source');
});
test('invented or cross-workspace IDs fail closed', async () => {
  const result = await tool()({ action: 'read', document_id: 'workspace:foreign' });
  assert.match(result.error, /not found/);
});
test('condensed summaries are explicitly marked and not credited as raw reads', async () => {
  fs.writeFileSync(path.join(temporary, 'file.json'), JSON.stringify({ title: 'upload.bat', pageContent: 'x'.repeat(200) }));
  const invoke = tool();
  assert.match(await invoke({ action: 'summarize', document_id: 'upload:2' }), /SUMMARY ONLY/);
  const coverage = await invoke({ action: 'coverage', document_id: 'upload:2' });
  assert.equal(coverage.items[0].status, 'not supplied');
});
