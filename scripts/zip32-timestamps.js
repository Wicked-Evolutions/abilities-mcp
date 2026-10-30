'use strict';

/**
 * Normalize DOS timestamps in MCPB's unsigned single-disk ZIP32 output.
 *
 * This is intentionally not a general ZIP reader. It accepts only complete
 * local/central ZIP32 records without encryption, descriptors, ZIP64, or
 * extra fields, then changes only the four timestamp bytes per entry.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const MAX_EOCD_SEARCH = EOCD_SIZE + 0xffff;
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021; // 1980-01-01, the first valid DOS date.

function fail(message) {
  throw new Error(`Unsupported MCPB ZIP layout: ${message}`);
}

function requireRange(buffer, offset, length, context) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    fail(`${context} is truncated or out of bounds`);
  }
}

function u16(buffer, offset, context) {
  requireRange(buffer, offset, 2, context);
  return buffer.readUInt16LE(offset);
}

function u32(buffer, offset, context) {
  requireRange(buffer, offset, 4, context);
  return buffer.readUInt32LE(offset);
}

function signatureAt(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) return null;
  return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer) {
  const firstOffset = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let offset = buffer.length - EOCD_SIZE; offset >= firstOffset; offset -= 1) {
    if (signatureAt(buffer, offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = u16(buffer, offset + 20, 'EOCD comment length');
    if (offset + EOCD_SIZE + commentLength === buffer.length) return offset;
  }
  fail('missing a terminal EOCD record');
}

function equalBytes(a, b) {
  return a.length === b.length && a.equals(b);
}

function validateFlags(flags, context) {
  if ((flags & 0x0001) !== 0) fail(`${context} uses encryption`);
  if ((flags & 0x0008) !== 0) fail(`${context} uses a data descriptor`);
  // MCPB/fflate emits zero today. UTF-8 is the only additional general
  // purpose bit this narrow normalizer accepts for a future non-ASCII name.
  if ((flags & ~0x0800) !== 0) fail(`${context} uses unsupported flags`);
}

function validateMethod(method, context) {
  // Official MCPB output uses deflate; stored entries are also conventional
  // ZIP32. This normalizer intentionally accepts no other compression shape.
  if (method !== 0 && method !== 8) fail(`${context} uses an unsupported compression method`);
}

function validateNoExtra(extraLength, context) {
  if (extraLength !== 0) fail(`${context} has unsupported extra fields`);
}

function validateZip32(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('input is not a Buffer');
  if (buffer.length < EOCD_SIZE) fail('file is too short for EOCD');

  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = u16(buffer, eocdOffset + 4, 'EOCD disk number');
  const centralStartDisk = u16(buffer, eocdOffset + 6, 'EOCD central start disk');
  const entriesOnDisk = u16(buffer, eocdOffset + 8, 'EOCD entries on disk');
  const entryCount = u16(buffer, eocdOffset + 10, 'EOCD entry count');
  const centralSize = u32(buffer, eocdOffset + 12, 'EOCD central directory size');
  const centralOffset = u32(buffer, eocdOffset + 16, 'EOCD central directory offset');

  if (diskNumber !== 0 || centralStartDisk !== 0) fail('archive spans multiple disks');
  if (entriesOnDisk !== entryCount) fail('EOCD entry counts disagree');
  if (entriesOnDisk === 0xffff || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP64 fields are not supported');
  if (eocdOffset >= 20 && signatureAt(buffer, eocdOffset - 20) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) fail('ZIP64 locator is not supported');
  if (centralOffset + centralSize !== eocdOffset) fail('central directory does not terminate at EOCD');
  requireRange(buffer, centralOffset, centralSize, 'central directory');

  const centralEntries = [];
  const seenOffsets = new Set();
  const seenNames = new Set();
  let centralCursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(buffer, centralCursor, CENTRAL_HEADER_SIZE, `central header ${index}`);
    if (signatureAt(buffer, centralCursor) !== CENTRAL_DIRECTORY_HEADER) fail(`central header ${index} has an invalid signature`);
    const versionNeeded = u16(buffer, centralCursor + 6, `central header ${index} version needed`);
    const flags = u16(buffer, centralCursor + 8, `central header ${index} flags`);
    const method = u16(buffer, centralCursor + 10, `central header ${index} compression method`);
    const crc = u32(buffer, centralCursor + 16, `central header ${index} CRC`);
    const compressedSize = u32(buffer, centralCursor + 20, `central header ${index} compressed size`);
    const uncompressedSize = u32(buffer, centralCursor + 24, `central header ${index} uncompressed size`);
    const nameLength = u16(buffer, centralCursor + 28, `central header ${index} name length`);
    const extraLength = u16(buffer, centralCursor + 30, `central header ${index} extra length`);
    const commentLength = u16(buffer, centralCursor + 32, `central header ${index} comment length`);
    const diskStart = u16(buffer, centralCursor + 34, `central header ${index} disk start`);
    const localOffset = u32(buffer, centralCursor + 42, `central header ${index} local offset`);
    const recordLength = CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;

    if (versionNeeded >= 45) fail(`central header ${index} requires ZIP64`);
    validateFlags(flags, `central header ${index}`);
    validateMethod(method, `central header ${index}`);
    validateNoExtra(extraLength, `central header ${index}`);
    if (diskStart !== 0) fail(`central header ${index} starts on another disk`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) fail(`central header ${index} uses ZIP64 values`);
    requireRange(buffer, centralCursor, recordLength, `central header ${index}`);
    if (centralCursor + recordLength > centralOffset + centralSize) fail(`central header ${index} exceeds the central directory`);
    if (localOffset >= centralOffset) fail(`central header ${index} local record points into the central directory`);
    if (seenOffsets.has(localOffset)) fail(`central header ${index} reuses a local record offset`);
    const name = buffer.subarray(centralCursor + CENTRAL_HEADER_SIZE, centralCursor + CENTRAL_HEADER_SIZE + nameLength);
    const nameKey = name.toString('hex');
    if (seenNames.has(nameKey)) fail(`central header ${index} repeats a file name`);
    seenOffsets.add(localOffset);
    seenNames.add(nameKey);
    centralEntries.push({ index, centralOffset: centralCursor, localOffset, versionNeeded, flags, method, crc, compressedSize, uncompressedSize, name });
    centralCursor += recordLength;
  }
  if (centralCursor !== centralOffset + centralSize) fail('central directory has unexplained bytes');
  if (signatureAt(buffer, centralCursor) === ZIP64_END_OF_CENTRAL_DIRECTORY) fail('ZIP64 EOCD is not supported');

  const byLocalOffset = [...centralEntries].sort((a, b) => a.localOffset - b.localOffset);
  const timestampOffsets = [];
  let localCursor = 0;
  for (const entry of byLocalOffset) {
    if (entry.localOffset !== localCursor) fail(`local record ${entry.index} leaves an unexplained gap`);
    requireRange(buffer, entry.localOffset, LOCAL_HEADER_SIZE, `local header ${entry.index}`);
    if (signatureAt(buffer, entry.localOffset) !== LOCAL_FILE_HEADER) fail(`local header ${entry.index} has an invalid signature`);
    const versionNeeded = u16(buffer, entry.localOffset + 4, `local header ${entry.index} version needed`);
    const flags = u16(buffer, entry.localOffset + 6, `local header ${entry.index} flags`);
    const method = u16(buffer, entry.localOffset + 8, `local header ${entry.index} compression method`);
    const crc = u32(buffer, entry.localOffset + 14, `local header ${entry.index} CRC`);
    const compressedSize = u32(buffer, entry.localOffset + 18, `local header ${entry.index} compressed size`);
    const uncompressedSize = u32(buffer, entry.localOffset + 22, `local header ${entry.index} uncompressed size`);
    const nameLength = u16(buffer, entry.localOffset + 26, `local header ${entry.index} name length`);
    const extraLength = u16(buffer, entry.localOffset + 28, `local header ${entry.index} extra length`);
    const recordLength = LOCAL_HEADER_SIZE + nameLength + extraLength + compressedSize;

    if (versionNeeded !== entry.versionNeeded || flags !== entry.flags || method !== entry.method || crc !== entry.crc || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize) fail(`local header ${entry.index} does not match its central record`);
    validateFlags(flags, `local header ${entry.index}`);
    validateMethod(method, `local header ${entry.index}`);
    validateNoExtra(extraLength, `local header ${entry.index}`);
    requireRange(buffer, entry.localOffset, recordLength, `local record ${entry.index}`);
    if (entry.localOffset + recordLength > centralOffset) fail(`local record ${entry.index} overlaps the central directory`);
    const localName = buffer.subarray(entry.localOffset + LOCAL_HEADER_SIZE, entry.localOffset + LOCAL_HEADER_SIZE + nameLength);
    if (!equalBytes(localName, entry.name)) fail(`local header ${entry.index} name does not match its central record`);
    timestampOffsets.push({ local: entry.localOffset + 10, central: entry.centralOffset + 12 });
    localCursor = entry.localOffset + recordLength;
  }
  if (localCursor !== centralOffset) fail('local records do not end where the central directory begins');
  return { entryCount, timestampOffsets };
}

function normalizeZip32Timestamps(filePath) {
  const original = fs.readFileSync(filePath);
  const { entryCount, timestampOffsets } = validateZip32(original);
  const normalized = Buffer.from(original);
  for (const offsets of timestampOffsets) {
    normalized.writeUInt16LE(DOS_TIME, offsets.local);
    normalized.writeUInt16LE(DOS_DATE, offsets.local + 2);
    normalized.writeUInt16LE(DOS_TIME, offsets.central);
    normalized.writeUInt16LE(DOS_DATE, offsets.central + 2);
  }

  const directory = path.dirname(filePath);
  const base = path.basename(filePath);
  const temporary = path.join(directory, `.${base}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let temporaryCreated = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    temporaryCreated = true;
    try {
      fs.writeFileSync(descriptor, normalized);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, filePath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) fs.rmSync(temporary, { force: true });
  }
  return { entryCount, sha256: crypto.createHash('sha256').update(normalized).digest('hex') };
}

module.exports = { DOS_DATE, DOS_TIME, normalizeZip32Timestamps, validateZip32 };
