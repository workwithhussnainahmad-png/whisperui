const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { transformSync } = require('@babel/core');

function fixture({ chatBudget } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-transfer-'));
  const handles = new Set();
  const owned = new Set();
  let largestWrite = 0;
  const helpers = {
    finishEncryptedAttachment() {},
    newEncryptedAttachmentFile() {
      const uri = path.join(directory, crypto.randomUUID());
      fs.writeFileSync(uri, ''); owned.add(uri);
      return { uri, open() {
        const fd = fs.openSync(uri, 'r+'); handles.add(fd);
        let closed = false;
        return {
          writeBytes(bytes) { largestWrite = Math.max(largestWrite, bytes.length); fs.writeSync(fd, bytes); },
          close() { if (!closed) { closed = true; handles.delete(fd); fs.closeSync(fd); } },
        };
      } };
    },
    deleteAttachment(uri) { fs.rmSync(uri, { force: true }); owned.delete(uri); },
    clearAttachmentFiles() { for (const uri of [...owned]) helpers.deleteAttachment(uri); },
    decodeChunk(data) { return Uint8Array.from(Buffer.from(data, 'base64')); },
    requireStorage() {}, mediaExtension() { return 'bin'; },
  };
  const filename = path.resolve(__dirname, '../src/services/mediaTransfer.js');
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-modules-commonjs'],
  });
  const result = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => {
    if (id === './mediaLimits') {
      const limitsPath = path.resolve(__dirname, '../src/services/mediaLimits.js');
      const transformed = transformSync(fs.readFileSync(limitsPath, 'utf8'), {
        filename: limitsPath, configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-modules-commonjs'],
      });
      const limits = { exports: {} };
      new Function('module', 'exports', transformed.code)(limits, limits.exports);
      if (chatBudget) limits.exports.MAX_CHAT_MEDIA_BYTES = chatBudget;
      return limits.exports;
    }
    assert.equal(id, './attachmentFiles'); return helpers;
  }, result, result.exports);
  const api = result.exports;
  return { api, directory, handles, largestWrite: () => largestWrite,
    close() { api.clearMediaTransfers(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
function chunks(bytes, id = crypto.randomUUID()) {
  const size = 98304;
  const descriptor = { type: 'file', mimeType: 'application/octet-stream', fileName: 'Whisperchat.bin', fileSize: bytes.length, allowSaving: false };
  return Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) => ({
    transferId: id, descriptor, index, count: Math.ceil(bytes.length / size), data: bytes.subarray(index * size, (index + 1) * size).toString('base64'),
  }));
}
test('vault transfers remain unpublished until commit; cancellation removes staged data and rejects late chunks', () => {
  const f = fixture();
  try {
    const packets = chunks(crypto.randomBytes(200000));
    for (const packet of packets) { packet.descriptor.commitRequired = true; assert.equal(f.api.acceptMediaChunk(packet), null); }
    const done = f.api.commitMediaTransfer(packets[0].transferId);
    assert.equal(done.fileSize, 200000);
    assert.throws(() => f.api.commitMediaTransfer(packets[0].transferId), /incomplete/);
    const abandoned = chunks(crypto.randomBytes(200000));
    abandoned[0].descriptor.commitRequired = true;
    f.api.acceptMediaChunk(abandoned[0]);
    f.api.abortMediaTransfer(abandoned[0].transferId);
    assert.throws(() => f.api.acceptMediaChunk(abandoned[0]), /cancelled/);
    assert.throws(() => f.api.commitMediaTransfer(abandoned[0].transferId), /incomplete/);
    assert.equal(fs.readdirSync(f.directory).length, 1, 'only the committed file remains');
  } finally { f.close(); }
});
test('streams a 17 MB attachment in reordered four-chunk windows with bounded writes', () => {
  const f = fixture();
  try {
    const source = crypto.randomBytes(17 * 1024 * 1024 + 7);
    const packets = chunks(source);
    let result;
    for (let at = 0; at < packets.length; at += 4) {
      for (const packet of packets.slice(at, at + 4).reverse()) result = f.api.acceptMediaChunk(packet) || result;
    }
    assert(result?.fileUri);
    assert.deepEqual(fs.readFileSync(result.fileUri), source);
    assert.equal(f.largestWrite(), 98304);
    assert.equal(f.handles.size, 0);
    f.api.clearMediaTransfers();
    assert.equal(fs.existsSync(result.fileUri), false);
  } finally { f.close(); }
});
test('rejects changed descriptors and deletes partial files', () => {
  const f = fixture();
  try {
    const packets = chunks(Buffer.alloc(300000, 42));
    f.api.acceptMediaChunk(packets[0]);
    assert.throws(() => f.api.acceptMediaChunk({ ...packets[1], descriptor: { ...packets[1].descriptor, allowSaving: true } }));
    assert.equal(f.handles.size, 0);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { f.close(); }
});
test('rejects oversized lookahead and wrong final chunk length without retaining files', () => {
  const f = fixture();
  try {
    const packets = chunks(Buffer.alloc(600000, 42));
    assert.throws(() => f.api.acceptMediaChunk(packets[5]));
    f.api.acceptMediaChunk(packets[0]);
    assert.throws(() => f.api.acceptMediaChunk({ ...packets[1], data: 'YQ==' }));
    assert.equal(f.handles.size, 0);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { f.close(); }
});
test('chat teardown removes both incomplete and completed attachments', () => {
  const f = fixture();
  try {
    f.api.acceptMediaChunk(chunks(Buffer.alloc(1))[0]);
    f.api.acceptMediaChunk(chunks(Buffer.alloc(200000))[0]);
    f.api.clearMediaTransfers();
    assert.equal(f.handles.size, 0);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { f.close(); }
});

test('rejects a peer advertising an oversized attachment before creating any file', () => {
  const f = fixture();
  try {
    const packet = chunks(Buffer.alloc(1))[0];
    packet.descriptor.fileSize = 64 * 1024 * 1024 + 1;
    assert.throws(() => f.api.acceptMediaChunk(packet), /64 MiB/);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { f.close(); }
});

test('completed media consumes the chat quota, while failed transfers release their reservation', () => {
  const f = fixture({ chatBudget: 300000 });
  try {
    for (const packet of chunks(Buffer.alloc(150000))) f.api.acceptMediaChunk(packet);
    const interrupted = chunks(Buffer.alloc(150000));
    f.api.acceptMediaChunk(interrupted[0]);
    assert.throws(() => f.api.acceptMediaChunk({ ...interrupted[1], data: 'YQ==' }));
    for (const packet of chunks(Buffer.alloc(150000))) f.api.acceptMediaChunk(packet);
    assert.throws(() => f.api.acceptMediaChunk(chunks(Buffer.alloc(1))[0]), /Chat attachment limit/);
    assert.equal(fs.readdirSync(f.directory).length, 2);
    f.api.clearMediaTransfers();
    assert(f.api.acceptMediaChunk(chunks(Buffer.alloc(1))[0]));
  } finally { f.close(); }
});
