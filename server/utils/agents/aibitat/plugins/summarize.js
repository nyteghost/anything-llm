const { Document } = require("../../../../models/documents");
const { WorkspaceParsedFiles } = require("../../../../models/workspaceParsedFiles");
const { safeJsonParse } = require("../../../http");
const { summarizeContent } = require("../utils/summarize");
const { FileReview } = require("../utils/fileReview");
const Provider = require("../providers/ai-provider");

function page(items, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer.");
  const selected = [];
  let size = 0;
  for (const item of items.slice(offset, offset + 30)) {
    const length = JSON.stringify(item).length;
    if (selected.length && size + length > 16000) break;
    selected.push(item);
    size += length;
  }
  return { total: items.length, offset, items: selected, next_offset: offset + selected.length < items.length ? offset + selected.length : null };
}

const docSummarizer = {
  name: "document-summarizer",
  startupConfig: { params: {} },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        const review = new FileReview();
        aibitat.function({
          super: aibitat,
          name: this.name,
          description: "List workspace/current-thread uploads, inspect ZIP manifests, read exact numbered source sections, report raw-read coverage, or summarize a document. For code/security reviews use manifest, read, and coverage; summaries/search hits do NOT establish source review. Follow next/next_offset until complete. Never execute uploaded code.",
          examples: [
            { prompt: "List my uploaded files", call: JSON.stringify({ action: "list" }) },
            { prompt: "Look inside project.zip", call: JSON.stringify({ action: "manifest", document_filename: "project.zip" }) },
            { prompt: "Read the batch script in project.zip", call: JSON.stringify({ action: "read", document_filename: "project.zip", file_path: "setup.bat", start_line: 1 }) },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#", type: "object",
            properties: {
              action: { type: "string", enum: ["list", "manifest", "read", "coverage", "summarize"] },
              document_filename: { type: "string", "x-nullable": true, description: "Exact document title from list." },
              document_id: { type: "string", "x-nullable": true, description: "Exact ID from list; use to disambiguate repeated titles." },
              file_path: { type: "string", "x-nullable": true, description: "Exact path inside archive from manifest; omit for a single ordinary document." },
              start_line: { type: "integer", minimum: 1, description: "First source line, default 1. Follow read.next." },
              line_count: { type: "integer", minimum: 1, maximum: 200, description: "Maximum source lines to read; default 120." },
              character_offset: { type: "integer", minimum: 0, description: "Zero-based offset within start_line, from read.next; handles unusually long lines." },
              offset: { type: "integer", minimum: 0, description: "Pagination offset for list/manifest/coverage, default 0." },
            },
            required: ["action"], additionalProperties: false,
          },
          handler: async function (args) {
            try {
              const documents = await this.availableDocuments();
              if (args.action === "list") return JSON.stringify(page(documents.map(({ metadata, ...doc }) => doc), args.offset));
              const matches = documents.filter(doc => args.document_id ? doc.document_id === args.document_id : doc.filename === args.document_filename);
              if (matches.length !== 1) throw new Error(matches.length ? "Multiple matching documents; specify document_id from list." : "Document not found in this workspace/current thread. Call list first.");
              const info = matches[0];
              const document = await this.loadDocument(info);
              if (args.action === "manifest") return JSON.stringify({ document_id: info.document_id, ...page(review.sources(document).map(({ contentStart, contentEnd, ...entry }) => entry), args.offset), warning: "Imported is not reviewed. Skipped entries are unavailable for analysis." });
              if (args.action === "coverage") {
                const coverage = review.coverage(info.document_id, document);
                const { files, ...summary } = coverage;
                const result = { ...summary, ...page(files, args.offset) };
                this.super.introspect?.(`Source coverage: ${files.filter(f => f.status === "fully supplied").length}/${files.filter(f => f.status !== "skipped").length} imported files fully supplied; ${coverage.skipped_files} skipped. Not a security assurance.`);
                return JSON.stringify(result);
              }
              if (args.action === "read") {
                const result = review.read(info.document_id, document, args);
                this.super.introspect?.(`Reading ${result.file_path} from line ${args.start_line || 1}${result.next ? " (more remains)" : " (end reached)"}.`);
                this.super.addCitation?.({ id: `${info.document_id}:${result.file_path}:${args.start_line || 1}:${args.character_offset || 0}`, title: `${info.filename} :: ${result.file_path}, line ${args.start_line || 1}`, text: result.content, chunkSource: null, score: null });
                return JSON.stringify(result);
              }
              if (args.action !== "summarize") throw new Error("Unknown document action.");
              const { TokenManager } = require("../../../helpers/tiktoken");
              const tokenCount = new TokenManager(this.super.model).countFromString(document.content);
              const budget = Math.floor(Provider.contextLimit(this.super.provider, this.super.model) * 0.4);
              this.super.addCitation?.({ id: info.document_id, title: document.title || info.filename, text: document.content.slice(0, 1000), chunkSource: null, score: null });
              if (tokenCount < budget) return document.content + "\n\n[Raw document supplied by summarize. Use read/coverage for explicit source coverage; no security assurance is established.]";
              const summary = await summarizeContent({ provider: this.super.provider, model: this.super.model, content: document.content, aibitat: this.super });
              return "[SUMMARY ONLY: source details may be omitted. This is not a full code/security review. Use read to inspect raw source.]\n" + summary;
            } catch (error) {
              this.super.handlerProps.log?.(`document-summarizer failed: ${error.message}`);
              return JSON.stringify({ error: error.message, warning: "No successful review is established by this failed operation." });
            }
          },
          availableDocuments: async function () {
            const invocation = this.super.handlerProps.invocation;
            const workspaceId = Number(invocation.workspace_id);
            const [embedded, parsed] = await Promise.all([
              Document.where({ workspaceId }),
              WorkspaceParsedFiles.where({ workspaceId, threadId: invocation.thread_id || null, userId: invocation.user_id || null }),
            ]);
            return [
              ...embedded.map(doc => { const metadata = safeJsonParse(doc.metadata, {}); return { document_id: `workspace:${doc.docId}`, filename: metadata.title || "unknown.txt", source: "workspace", description: metadata.description || "", metadata }; }),
              ...parsed.map(doc => { const metadata = safeJsonParse(doc.metadata, {}); return { document_id: `upload:${doc.id}`, filename: metadata.title || doc.filename, source: "current-thread upload", description: metadata.description || "", metadata }; }),
            ];
          },
          loadDocument: async function (info) {
            if (info.document_id.startsWith("workspace:")) return Document.content(info.document_id.slice("workspace:".length));
            const fs = require("fs");
            const path = require("path");
            const { directUploadsPath } = require("../../../files");
            if (!info.metadata.location) throw new Error("Upload content location is missing.");
            const target = path.join(directUploadsPath, path.basename(info.metadata.location));
            const realRoot = fs.realpathSync(directUploadsPath);
            const realTarget = fs.realpathSync(target);
            if (path.dirname(realTarget) !== realRoot) throw new Error("Invalid upload location.");
            const data = JSON.parse(fs.readFileSync(realTarget, "utf-8"));
            if (typeof data.pageContent !== "string") throw new Error("Upload has no readable text.");
            return { title: data.title, content: data.pageContent, archiveManifest: data.archiveManifest || null };
          },
        });
      },
    };
  },
};
module.exports = { docSummarizer };
