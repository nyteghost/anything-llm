const { inflateRawSync } = require("zlib");

const LIMITS = Object.freeze({
  archiveBytes: 64 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  entries: 1000,
  ratio: 250,
});

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Never extract archive paths onto the filesystem. Only return bounded buffers.
// ZIP64, split volumes, encryption and compression other than store/deflate
// are deliberately unsupported; each is rejected or reported explicitly.
function openZip(buffer, limits = LIMITS) {
  if (!Buffer.isBuffer(buffer) || buffer.length > limits.archiveBytes)
    throw new Error("ZIP exceeds the 64 MiB upload limit.");
  const need = (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > buffer.length)
      throw new Error("Invalid ZIP: out-of-bounds record.");
  };
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Invalid ZIP: end record not found.");
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) ||
      buffer.readUInt16LE(end + 8) !== buffer.readUInt16LE(end + 10))
    throw new Error("Split-volume ZIPs are not supported.");
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralStart = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff)
    throw new Error("ZIP64 is not supported. Upload smaller ZIPs.");
  if (count > limits.entries) throw new Error("ZIP exceeds the 1,000-entry limit.");
  if (centralStart + centralSize !== end) throw new Error("Invalid ZIP directory layout.");
  let cursor = centralStart;
  let total = 0;
  const seen = new Set();
  const entries = [];
  for (let index = 0; index < count; index++) {
    need(cursor, 46);
    if (buffer.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Invalid ZIP directory entry.");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const disk = buffer.readUInt16LE(cursor + 34);
    const mode = buffer.readUInt32LE(cursor + 38) >>> 16;
    const localOffset = buffer.readUInt32LE(cursor + 42);
    need(cursor + 46, nameLength + extraLength + commentLength);
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    let name;
    try { name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes); }
    catch { throw new Error("ZIP filenames must use UTF-8. Repack this archive."); }
    cursor += 46 + nameLength + extraLength + commentLength;
    if (cursor > end || disk || size === 0xffffffff || compressed === 0xffffffff || localOffset === 0xffffffff)
      throw new Error("ZIP64, split volumes, or invalid directory entries are unsupported.");
    total += size;
    if (total > limits.totalBytes) throw new Error("ZIP expands beyond 128 MiB.");
    const normalized = name.replace(/\\/g, "/");
    let skipReason = null;
    if (!name || name.length > 1024 || /[\x00-\x1f\x7f]/.test(name) ||
        /^(\/|[a-z]:)/i.test(normalized) || normalized.split("/").includes(".."))
      skipReason = "unsafe path";
    else if (seen.has(normalized)) skipReason = "duplicate archive path";
    else if ((mode & 0o170000) === 0o120000) skipReason = "symbolic link";
    else if (flags & 0x41) skipReason = "encrypted entry";
    else if (![0, 8].includes(method)) skipReason = "unsupported compression";
    else if (size > limits.entryBytes || size > Math.max(compressed, 1) * limits.ratio)
      skipReason = "entry size or expansion limit";
    else if (/\.(zip|7z|rar|tar|gz|bz2|xz)$/i.test(name)) skipReason = "nested archive; upload separately";
    else if (normalized.split("/").some(p => [".git", "node_modules", ".venv", "__pycache__"].includes(p)))
      skipReason = "dependency or repository-internal directory";
    seen.add(normalized);
    entries.push({
      path: normalized, size, skipReason, directory: normalized.endsWith("/"),
      read() {
        if (skipReason) throw new Error(skipReason);
        need(localOffset, 30);
        if (localOffset >= centralStart || buffer.readUInt32LE(localOffset) !== 0x04034b50)
          throw new Error("Invalid local ZIP header.");
        if (buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method)
          throw new Error("ZIP local/directory header mismatch.");
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        need(localOffset + 30, localNameLength + localExtraLength);
        if (!buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes) || start + compressed > centralStart)
          throw new Error("ZIP entry name or data bounds mismatch.");
        if (!(flags & 8) && (buffer.readUInt32LE(localOffset + 18) !== compressed || buffer.readUInt32LE(localOffset + 22) !== size))
          throw new Error("ZIP entry size mismatch.");
        need(start, compressed);
        const raw = buffer.subarray(start, start + compressed);
        const result = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: limits.entryBytes });
        if (result.length !== size || crc32(result) !== crc)
          throw new Error("ZIP entry failed size/CRC verification.");
        return result;
      },
    });
  }
  if (cursor !== end) throw new Error("ZIP directory count mismatch.");
  return entries;
}
module.exports = { openZip, crc32, LIMITS };
