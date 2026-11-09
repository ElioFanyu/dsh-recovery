"use strict";
// Minimal ZIP writer (store method, no compression).
//
// The recovery console must be able to hand the user a diagnostics archive
// without pulling in a compression dependency, so this writes a plain
// stored-entry ZIP: local headers, central directory, EOCD. Every modern
// unpacker reads it; the files inside are small text reports.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let value = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ -1) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build a ZIP archive.
 * @param {Array<{name: string, data: string|Buffer, date?: Date}>} entries
 * @returns {Buffer}
 */
function createZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  let count = 0;

  for (const entry of entries) {
    const name = String(entry.name).replace(/\\/gu, "/").replace(/^\/+/u, "");
    if (name === "") continue;
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ""), "utf8");
    const nameBuffer = Buffer.from(name, "utf8");
    const { time, date } = dosDateTime(entry.date instanceof Date ? entry.date : new Date());
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuffer, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(time, 12);
    directory.writeUInt16LE(date, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBuffer.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
    count += 1;
  }

  const centralBuffer = Buffer.concat(central);
  const reported = Math.min(count, 0xffff);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(reported, 8);
  end.writeUInt16LE(reported, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

/**
 * Read a ZIP archive into memory.
 *
 * `createZip` above writes stored (uncompressed) entries, which is all the
 * console needs to *produce*. Reading is different: a bundle the user re-packed
 * with Explorer or 7-Zip usually comes back deflated, so both methods are
 * supported (deflate through the built-in zlib, no dependency).
 *
 * Only what a backup bundle contains is supported: no ZIP64, no encryption, no
 * multi-disk. Anything else reports a readable error instead of guessing.
 *
 * @param {Buffer} buffer complete archive bytes
 * @returns {Map<string, Buffer>} entry name (forward slashes) to raw bytes
 */
function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error("不是有效的 ZIP 文件（文件太小）");

  // The end-of-central-directory record is last, but a trailing comment of up
  // to 64 KiB may follow it, so scan backwards for the signature.
  let end = -1;
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end === -1) throw new Error("不是有效的 ZIP 文件（找不到中央目录）");

  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (centralOffset === 0xffffffff || centralSize === 0xffffffff) throw new Error("不支持 ZIP64 格式的备份文件");
  if (centralOffset + centralSize > buffer.length) throw new Error("ZIP 中央目录越界（文件可能已损坏）");

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`ZIP 中央目录第 ${index + 1} 项损坏（文件可能已损坏）`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    // Explorer and PowerShell's Compress-Archive write backslash separators,
    // which the ZIP spec forbids but every extractor tolerates. Normalising
    // here keeps the caller from having to match both spellings.
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength).replace(/\\/gu, "/");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;
    if ((flags & 0x0001) === 0x0001) throw new Error(`${name} 是加密条目，无法读取`);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${name} 的本地文件头损坏`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start + compressedSize > buffer.length) throw new Error(`${name} 的数据越界（文件可能已损坏）`);
    const raw = buffer.subarray(start, start + compressedSize);

    if (method === 0) {
      entries.set(name, Buffer.from(raw));
    } else if (method === 8) {
      const inflated = require("node:zlib").inflateRawSync(raw);
      if (inflated.length !== uncompressedSize) throw new Error(`${name} 解压后长度不符（期望 ${uncompressedSize}，实际 ${inflated.length}）`);
      entries.set(name, inflated);
    } else {
      throw new Error(`${name} 使用了不支持的压缩方式 ${method}`);
    }
  }
  return entries;
}

module.exports = { crc32, createZip, readZip };
