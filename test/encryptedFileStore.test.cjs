const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('@babel/core');
const filename = path.resolve(__dirname, '../src/services/encryptedFileStore.js');
const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
  filename, configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-modules-commonjs'],
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', code)(require, loaded, loaded.exports);
const { createEncryptedFileStore, CACHE_CHUNK_BYTES } = loaded.exports;

function fixture() {
  const files = new Map();
  const keys = [];
  let openHandles = 0;
  let failWrite = false;
  const store = createEncryptedFileStore({
    maxBytes: 64 * 1024 * 1024,
    requireStorage() {},
    randomBytes(size) { const bytes = new Uint8Array(crypto.randomBytes(size)); if (size === 32) keys.push(bytes); return bytes; },
    removeFile: (uri) => files.delete(uri),
    createFile() {
      const uri = crypto.randomUUID(); files.set(uri, Buffer.alloc(0));
      return { uri, get size() { return files.get(uri)?.length; }, open() {
        let offset = 0; let closed = false; openHandles += 1;
        return {
          get offset() { return offset; }, set offset(value) { offset = value; },
          readBytes(n) { assert(!closed); const result = new Uint8Array(files.get(uri).subarray(offset, offset + n)); offset += result.length; return result; },
          writeBytes(bytes) {
            assert(!closed); if (failWrite) throw new Error('Disk failure');
            const before = files.get(uri); const after = Buffer.alloc(Math.max(before.length, offset + bytes.length));
            before.copy(after); after.set(bytes, offset); offset += bytes.length; files.set(uri, after);
          },
          close() { if (!closed) { closed = true; openHandles -= 1; } },
        };
      } };
    },
  });
  function write(bytes) {
    const file = store.create(); const handle = file.open();
    try { for (let at = 0; at < bytes.length; at += CACHE_CHUNK_BYTES) handle.writeBytes(bytes.subarray(at, at + CACHE_CHUNK_BYTES)); }
    finally { handle.close(); }
    store.seal(file.uri); return file;
  }
  return { store, files, keys, write, openHandles: () => openHandles, failWrites: () => { failWrite = true; } };
}

test('cache stores authenticated ciphertext and supports bounded random reads across records', () => {
  const f = fixture();
  const original = Buffer.alloc(CACHE_CHUNK_BYTES * 3 + 7, 'private media');
  const file = f.write(original);
  assert.equal(file.size, original.length);
  assert.equal(f.files.get(file.uri).includes(original.subarray(0, 100)), false);
  const handle = file.open();
  for (const offset of [0, 17, CACHE_CHUNK_BYTES - 1, CACHE_CHUNK_BYTES * 3]) {
    handle.offset = offset;
    assert.deepEqual(Buffer.from(handle.readBytes(CACHE_CHUNK_BYTES)), original.subarray(offset, offset + CACHE_CHUNK_BYTES));
  }
  assert.throws(() => handle.readBytes(CACHE_CHUNK_BYTES + 1));
  assert.throws(() => handle.writeBytes(new Uint8Array([1])));
  handle.close(); f.store.clear();
  assert.equal(f.openHandles(), 0);
});

for (const mutation of ['modify', 'truncate', 'append', 'swap records', 'replace file']) {
  test(`cache rejects ${mutation}`, () => {
    const f = fixture();
    const file = f.write(crypto.randomBytes(CACHE_CHUNK_BYTES * 2));
    const bytes = f.files.get(file.uri);
    if (mutation === 'modify') bytes[80] ^= 1;
    if (mutation === 'truncate') f.files.set(file.uri, bytes.subarray(0, -1));
    if (mutation === 'append') f.files.set(file.uri, Buffer.concat([bytes, Buffer.from([0])]));
    if (mutation === 'swap records') {
      const recordSize = CACHE_CHUNK_BYTES + 48;
      f.files.set(file.uri, Buffer.concat([bytes.subarray(recordSize), bytes.subarray(0, recordSize)]));
    }
    if (mutation === 'replace file') f.files.set(file.uri, f.files.get(f.write(crypto.randomBytes(CACHE_CHUNK_BYTES * 2)).uri));
    const reader = file.open();
    assert.throws(() => reader.readBytes(32));
    reader.close(); f.store.clear();
  });
}

test('teardown erases keys, closes outstanding handles, and invalidates stale file objects', () => {
  const f = fixture(); const file = f.write(Buffer.from('secret')); const reader = file.open();
  f.store.clear();
  assert(f.keys.every((key) => key.every((byte) => byte === 0)));
  assert.equal(f.files.size, 0); assert.equal(f.openHandles(), 0);
  assert.throws(() => reader.readBytes(6)); assert.throws(() => file.open());
});

test('failed writes remove partial ciphertext and erase its key', () => {
  const f = fixture(); const file = f.store.create(); const writer = file.open(); f.failWrites();
  assert.throws(() => writer.writeBytes(new Uint8Array([1])), /Disk failure/);
  assert.equal(f.files.size, 0); assert.equal(f.openHandles(), 0);
  assert(f.keys[0].every((byte) => byte === 0));
});

test('unsealed files cannot be read and overwritten records are refused', () => {
  const f = fixture(); const file = f.store.create(); const writer = file.open();
  writer.writeBytes(new Uint8Array([1, 2, 3])); writer.offset = 0;
  assert.throws(() => writer.readBytes(3)); assert.throws(() => writer.writeBytes(new Uint8Array([4])));
  writer.close(); f.store.clear();
});
