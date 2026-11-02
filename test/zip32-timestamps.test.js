'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const { DOS_DATE, DOS_TIME, normalizeZip32Timestamps, validateZip32 } = require('../scripts/zip32-timestamps');

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryFile(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'abilities-mcp-zip32-'));
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function buildZip(entries, options = {}) {
  const comment = Buffer.from(options.comment || '');
  const locals = [];
  const layout = { entries: [] };
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const header = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0x7c00), u16(0x53a1),
      u32(0), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data,
    ]);
    locals.push(header);
    layout.entries.push({ localOffset });
    localOffset += header.length;
  }

  const centralOffset = localOffset;
  const central = [];
  let centralCursor = centralOffset;
  entries.forEach((entry, index) => {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const header = Buffer.concat([
      u32(0x02014b50), u16(0x0314), u16(20), u16(0), u16(0), u16(0x7c00), u16(0x53a1),
      u32(0), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0x81a40000), u32(layout.entries[index].localOffset), name,
    ]);
    central.push(header);
    layout.entries[index].centralOffset = centralCursor;
    centralCursor += header.length;
  });

  layout.eocdOffset = centralCursor;
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralCursor - centralOffset), u32(centralOffset), u16(comment.length), comment,
  ]);
  return { buffer: Buffer.concat([...locals, ...central, eocd]), layout };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertInvalid(buffer, expected) {
  assert.throws(() => validateZip32(buffer), new RegExp(expected));
}

describe('ZIP32 timestamp normalizer', () => {
  it('changes only local and central DOS timestamps and is idempotent', () => {
    const { buffer, layout } = buildZip([
      { name: 'alpha.txt', data: 'alpha' },
      { name: 'bin/tool', data: 'tool' },
    ], { comment: 'preserved comment' });
    const file = temporaryFile('bundle.mcpb');
    fs.writeFileSync(file, buffer);

    const first = normalizeZip32Timestamps(file);
    const normalized = fs.readFileSync(file);
    assert.equal(first.entryCount, 2);
    assert.equal(first.sha256, sha256(normalized));
    assert.equal(normalized.subarray(layout.eocdOffset + 22).toString(), 'preserved comment');

    const allowed = new Set();
    for (const entry of layout.entries) {
      for (const offset of [entry.localOffset + 10, entry.localOffset + 11, entry.localOffset + 12, entry.localOffset + 13, entry.centralOffset + 12, entry.centralOffset + 13, entry.centralOffset + 14, entry.centralOffset + 15]) allowed.add(offset);
      assert.equal(normalized.readUInt16LE(entry.localOffset + 10), DOS_TIME);
      assert.equal(normalized.readUInt16LE(entry.localOffset + 12), DOS_DATE);
      assert.equal(normalized.readUInt16LE(entry.centralOffset + 12), DOS_TIME);
      assert.equal(normalized.readUInt16LE(entry.centralOffset + 14), DOS_DATE);
    }
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== normalized[index]) assert.ok(allowed.has(index), `unexpected mutation at byte ${index}`);
    }

    const second = normalizeZip32Timestamps(file);
    assert.equal(second.sha256, first.sha256);
    assert.deepEqual(fs.readFileSync(file), normalized);
  });

  it('rejects malformed count, bounds, local-central mismatch, duplicate offsets, ZIP64, and unsupported layouts', () => {
    const { buffer, layout } = buildZip([
      { name: 'one.txt', data: 'one' },
      { name: 'two.txt', data: 'two' },
    ]);

    assertInvalid(Buffer.from([0x50, 0x4b]), 'too short');

    const countMismatch = Buffer.from(buffer);
    countMismatch.writeUInt16LE(3, layout.eocdOffset + 8);
    assertInvalid(countMismatch, 'entry counts disagree');

    const bounds = Buffer.from(buffer);
    bounds.writeUInt32LE(buffer.length, layout.eocdOffset + 16);
    assertInvalid(bounds, 'central directory does not terminate');

    const mismatch = Buffer.from(buffer);
    mismatch.writeUInt16LE(8, layout.entries[0].centralOffset + 10);
    assertInvalid(mismatch, 'does not match');

    const duplicateOffset = Buffer.from(buffer);
    duplicateOffset.writeUInt32LE(layout.entries[0].localOffset, layout.entries[1].centralOffset + 42);
    assertInvalid(duplicateOffset, 'reuses a local record offset');

    const zip64 = Buffer.from(buffer);
    zip64.writeUInt16LE(0xffff, layout.eocdOffset + 8);
    zip64.writeUInt16LE(0xffff, layout.eocdOffset + 10);
    assertInvalid(zip64, 'ZIP64');

    const extra = Buffer.from(buffer);
    extra.writeUInt16LE(1, layout.entries[0].centralOffset + 30);
    assertInvalid(extra, 'extra fields');

    const encrypted = Buffer.from(buffer);
    encrypted.writeUInt16LE(1, layout.entries[0].centralOffset + 8);
    assertInvalid(encrypted, 'encryption');

    const descriptor = Buffer.from(buffer);
    descriptor.writeUInt16LE(8, layout.entries[0].centralOffset + 8);
    assertInvalid(descriptor, 'data descriptor');

    const unsupportedMethod = Buffer.from(buffer);
    unsupportedMethod.writeUInt16LE(99, layout.entries[0].localOffset + 8);
    unsupportedMethod.writeUInt16LE(99, layout.entries[0].centralOffset + 10);
    assertInvalid(unsupportedMethod, 'unsupported compression method');

    const unsupportedFlags = Buffer.from(buffer);
    unsupportedFlags.writeUInt16LE(0x2000, layout.entries[0].localOffset + 6);
    unsupportedFlags.writeUInt16LE(0x2000, layout.entries[0].centralOffset + 8);
    assertInvalid(unsupportedFlags, 'unsupported flags');
  });

  it('preserves the original file and removes temporary output when validation fails', () => {
    const { buffer, layout } = buildZip([{ name: 'entry.txt', data: 'unchanged' }]);
    const file = temporaryFile('invalid.mcpb');
    const invalid = Buffer.from(buffer);
    invalid.writeUInt32LE(0xffffffff, layout.eocdOffset + 16);
    fs.writeFileSync(file, invalid);

    assert.throws(() => normalizeZip32Timestamps(file), /ZIP64/);
    assert.deepEqual(fs.readFileSync(file), invalid);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['invalid.mcpb']);
  });

  it('preserves the original file and removes temporary output when writing or renaming fails', () => {
    const { buffer } = buildZip([{ name: 'entry.txt', data: 'unchanged' }]);
    const file = temporaryFile('atomic.mcpb');
    fs.writeFileSync(file, buffer);

    const originalWrite = fs.writeFileSync;
    try {
      fs.writeFileSync = (target, contents) => {
        if (typeof target === 'number') throw new Error('injected write failure');
        return originalWrite(target, contents);
      };
      assert.throws(() => normalizeZip32Timestamps(file), /injected write failure/);
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.deepEqual(fs.readFileSync(file), buffer);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['atomic.mcpb']);

    const originalRename = fs.renameSync;
    try {
      fs.renameSync = () => { throw new Error('injected rename failure'); };
      assert.throws(() => normalizeZip32Timestamps(file), /injected rename failure/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.deepEqual(fs.readFileSync(file), buffer);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['atomic.mcpb']);
  });
});
