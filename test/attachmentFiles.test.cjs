const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { transformSync } = require('@babel/core');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-vault-'));
  const handles = new Set();
  const uriOf = (...parts) => path.join(...parts.map((part) => typeof part === 'string' ? part : part.uri));
  class Directory {
    constructor(...parts) { this.uri = uriOf(...parts); }
    get exists() { return fs.existsSync(this.uri); }
    create() { fs.mkdirSync(this.uri, { recursive: true }); }
    delete() { fs.rmSync(this.uri, { recursive: true, force: true }); }
  }
  class File {
    constructor(...parts) { this.uri = uriOf(...parts); }
    get exists() { return fs.existsSync(this.uri); }
    get size() { return fs.statSync(this.uri).size; }
    create() { fs.writeFileSync(this.uri, ''); }
    delete() { fs.unlinkSync(this.uri); }
    open() {
      const fd = fs.openSync(this.uri, 'r+'); handles.add(fd);
      let offset = 0; let closed = false;
      return {
        get offset() { return offset; }, set offset(value) { offset = value; },
        readBytes(length) {
          const result = new Uint8Array(length); const n = fs.readSync(fd, result, 0, length, offset); offset += n; return result.slice(0, n);
        },
        writeBytes(bytes) { offset += fs.writeSync(fd, bytes, 0, bytes.length, offset); },
        close() { if (!closed) { closed = true; fs.closeSync(fd); handles.delete(fd); } },
      };
    }
  }
  function loadApi() {
    const cache = new Map();
    function load(filename) {
      if (cache.has(filename)) return cache.get(filename).exports;
      const m = { exports: {} }; cache.set(filename, m);
      const { code } = transformSync(fs.readFileSync(filename, 'utf8'), { filename, configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-modules-commonjs'] });
      new Function('require', 'module', 'exports', code)((id) => {
        if (id === 'expo-file-system') return { File, Directory, Paths: { cache: directory, availableDiskSpace: 1024 * 1024 * 1024 } };
        if (id === 'expo-file-system/legacy') return { cacheDirectory: directory + path.sep };
        if (id === 'expo-crypto') return { randomUUID: crypto.randomUUID, getRandomBytes: (n) => new Uint8Array(crypto.randomBytes(n)) };
        if (id === 'react-native') return { Platform: { OS: 'android' } };
        if (id === 'expo-modules-core') return { requireOptionalNativeModule: () => null };
        if (id === './captureProtection') return { isExpoGoFeatureTest: false };
        return id.startsWith('.') ? load(path.resolve(path.dirname(filename), id + '.js')) : require(id);
      }, m, m.exports);
      return m.exports;
    }
    return load(path.resolve(__dirname, '../src/services/attachmentFiles.js'));
  }
  const api = loadApi();
  return { api, loadApi, directory, handles, source(bytes) { const p = path.join(directory, crypto.randomUUID() + '.txt'); fs.writeFileSync(p, bytes); return p; },
    close() { api.clearAttachmentFiles(); for (const fd of handles) fs.closeSync(fd); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('staging encrypts files, removes owned source, and document reads avoid a plaintext cache', async () => {
  const f = fixture();
  try {
    const original = Buffer.alloc(200001, 'private document'); const source = f.source(original);
    const result = await f.api.stageAttachment(source);
    assert.equal(fs.existsSync(source), false);
    assert.equal(result.fileSize, original.length);
    assert.equal(fs.readFileSync(result.fileUri).includes(original.subarray(0, 100)), false);
    assert.deepEqual(Buffer.from(f.api.readAttachmentBase64(result.fileUri), 'base64'), original);
    assert.equal(fs.readdirSync(path.dirname(result.fileUri)).length, 1);
    assert.equal(f.handles.size, 0);
  } finally { f.close(); }
});
test('preview leases are separate plaintext files and release does not destroy the encrypted original', async () => {
  const f = fixture();
  try {
    const original = Buffer.from('preview only while opened');
    const result = await f.api.stageAttachment(f.source(original));
    const lease = await f.api.acquireAttachmentFile(result.fileUri, 'txt');
    assert.notEqual(lease.uri, result.fileUri);
    assert.deepEqual(fs.readFileSync(lease.uri), original);
    lease.release(); lease.release();
    assert.equal(fs.existsSync(lease.uri), false);
    assert.equal(fs.existsSync(result.fileUri), true);
    assert.equal(f.handles.size, 0);
  } finally { f.close(); }
});
test('chat teardown during a yielding preview cancels the copy and removes its plaintext', async () => {
  const f = fixture();
  try {
    const result = await f.api.stageAttachment(f.source(crypto.randomBytes(2 * 1024 * 1024)));
    const pending = f.api.acquireAttachmentFile(result.fileUri, 'mp4');
    f.api.clearAttachmentFiles();
    await assert.rejects(pending, /ended|available|closed/);
    assert.deepEqual(fs.readdirSync(path.dirname(result.fileUri)), []);
    assert.equal(f.handles.size, 0);
  } finally { f.close(); }
});
test('startup removes abandoned ciphertext and plaintext previews; keys are not recovered', async () => {
  const f = fixture();
  try {
    const result = await f.api.stageAttachment(f.source(Buffer.from('previous process')));
    const lease = await f.api.acquireAttachmentFile(result.fileUri, 'txt');
    const restarted = f.loadApi(); restarted.initializeAttachmentFiles();
    assert.equal(fs.existsSync(result.fileUri), false); assert.equal(fs.existsSync(lease.uri), false);
    assert.throws(() => restarted.openAttachmentFile(result.fileUri), /unavailable/);
  } finally { f.close(); }
});
