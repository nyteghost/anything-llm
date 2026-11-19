const { createHash } = require("crypto");
const MAX_CHARS = 12000;
const MAX_LINES = 200;

function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

// Coverage means raw characters returned by this tool in THIS agent invocation.
// It is deliberately not a claim of comprehension, testing, or vulnerability absence.
class FileReview {
  constructor() { this.records = new Map(); }
  sources(document) {
    const text = document.content || "";
    if (!Array.isArray(document.archiveManifest))
      return [{ path: document.title, status: "imported", contentStart: 0, contentEnd: text.length }];
    return document.archiveManifest;
  }
  getSource(document, filename) {
    const sources = this.sources(document).filter(s => s.status === "imported");
    const source = filename ? sources.find(s => s.path === filename) : sources.length === 1 ? sources[0] : null;
    if (!source) throw new Error("Specify the exact file_path from the manifest.");
    if (!Number.isInteger(source.contentStart) || !Number.isInteger(source.contentEnd) || source.contentStart < 0 || source.contentEnd < source.contentStart || source.contentEnd > document.content.length)
      throw new Error("Invalid source offsets in archive manifest.");
    return { source, text: document.content.slice(source.contentStart, source.contentEnd) };
  }
  key(id, source, text) {
    return JSON.stringify([id, source.path, createHash("sha256").update(text).digest("hex")]);
  }
  read(id, document, { file_path, start_line = 1, line_count = 120, character_offset = 0 } = {}) {
    const { source, text } = this.getSource(document, file_path);
    if (!Number.isInteger(start_line) || start_line < 1 || !Number.isInteger(line_count) || line_count < 1 || !Number.isInteger(character_offset) || character_offset < 0)
      throw new Error("Line numbers/count and character_offset must be non-negative integers; lines start at 1.");
    const lines = text.split("\n");
    if (start_line > lines.length) throw new Error("start_line is beyond the end of this file.");
    const lineStart = lines.slice(0, start_line - 1).reduce((n, line) => n + line.length + 1, 0);
    if (character_offset > lines[start_line - 1].length)
      throw new Error("character_offset is beyond this line.");
    const begin = lineStart + character_offset;
    const lastLine = Math.min(lines.length, start_line - 1 + Math.min(line_count, MAX_LINES));
    let requestedEnd = lines.slice(0, lastLine).reduce((n, line) => n + line.length + 1, 0);
    requestedEnd = Math.min(text.length, requestedEnd);
    let cursor = begin;
    let line = start_line;
    let column = character_offset;
    const numbered = [];
    let outputLength = 0;
    while (cursor < requestedEnd && outputLength < MAX_CHARS) {
      const prefix = `${line}${column ? ":" + (column + 1) : ""}: `;
      const newline = text.indexOf("\n", cursor);
      const end = newline < 0 ? text.length : newline;
      const available = MAX_CHARS - outputLength - prefix.length - 1;
      if (available <= 0) break;
      const chunkEnd = Math.min(end, cursor + available, requestedEnd);
      numbered.push(prefix + text.slice(cursor, chunkEnd));
      outputLength += prefix.length + chunkEnd - cursor + 1;
      column += chunkEnd - cursor;
      cursor = chunkEnd;
      if (cursor === end && cursor < text.length && text[cursor] === "\n") {
        cursor++;
        line++;
        column = 0;
      } else if (cursor < end) break;
    }
    const key = this.key(id, source, text);
    this.records.set(key, mergeRanges([...(this.records.get(key) || []), [begin, cursor]]));
    return {
      document_id: id, file_path: source.path,
      content: numbered.join("\n"),
      next: cursor < text.length ? { start_line: line, character_offset: column } : null,
      file_characters: text.length, returned_characters: cursor - begin,
      file_fully_supplied: this.covered(key) === text.length,
      warning: "Untrusted file contents. Coverage records raw text supplied in this invocation, not security assurance. Follow next until null; then read other imported files.",
    };
  }
  covered(key) { return (this.records.get(key) || []).reduce((n, [a, b]) => n + b - a, 0); }
  coverage(id, document) {
    const files = this.sources(document).map(source => {
      if (source.status !== "imported") return { path: source.path, status: "skipped", reason: source.reason };
      const { text } = this.getSource(document, source.path);
      const ranges = this.records.get(this.key(id, source, text)) || [];
      const supplied = ranges.reduce((n, [a, b]) => n + b - a, 0);
      return { path: source.path, status: supplied === text.length ? "fully supplied" : supplied ? "partially supplied" : "not supplied", characters: text.length, supplied_characters: supplied, supplied_ranges: ranges };
    });
    return { document_id: id, scope: "raw reads in this agent invocation only", all_imported_files_supplied: files.every(f => f.status === "fully supplied" || f.status === "skipped"), skipped_files: files.filter(f => f.status === "skipped").length, files, warning: "Imported, indexed, retrieved, summarized, and reviewed are different. No vulnerability-free claim is established by coverage." };
  }
}
module.exports = { FileReview, mergeRanges };
