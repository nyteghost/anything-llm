const { deflateRawSync } = require('node:zlib');
const { crc32 } = require('../../collector/utils/archives/zip');
function zip(items) {
  const local = [], central = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name);
    const bytes = Buffer.isBuffer(item.content) ? item.content : Buffer.from(item.content || '');
    const method = item.method ?? 8;
    const packed = method === 8 ? deflateRawSync(bytes) : bytes;
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(item.flags || 0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(item.declaredSize ?? bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, packed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(item.flags || 0, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(packed.length, 20);
    directory.writeUInt32LE(item.declaredSize ?? bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
module.exports = { zip };
