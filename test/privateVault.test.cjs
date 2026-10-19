const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { transformSync } = require('@babel/core');

function moduleFrom(name, replacements = {}) {
  const filename = path.resolve(__dirname, '../src/services/' + name + '.js');
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), { filename, configFile: false, babelrc: false,
    plugins: ['@babel/plugin-transform-modules-commonjs'] });
  const m = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => id in replacements ? replacements[id] : id.startsWith('./') ? moduleFrom(id.slice(2)) : require(id), m, m.exports);
  return m.exports;
}
const { createPrivateVaultStore } = moduleFrom('privateVaultStore');
function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-private-vault-'));
  const root = path.join(sandbox, 'no-backup', 'vault');
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(sandbox, { force: true, recursive: true }));
  // A separate secure-storage surrogate persists across JS store instances.
  // Native Keystore/Keychain security must also be checked on devices.
  let master = null, free = Infinity, failCommit = false, yieldHook = async () => {};
  const touched = [];
  const target = (name) => {
    assert.match(name, /^(index\.v1|[a-f0-9-]{36}\.(box|tmp))$/);
    const p = path.resolve(root, name); assert.equal(path.dirname(p), root); touched.push(p); return p;
  };
  function file(name) {
    return { get size() { return fs.statSync(target(name)).size; }, open() {
      const fd = fs.openSync(target(name), 'r+'); let offset = 0, closed = false;
      return {
        readBytes(n) { const bytes = new Uint8Array(n); const count = fs.readSync(fd, bytes, 0, n, offset); offset += count; return bytes.slice(0, count); },
        writeBytes(bytes) { offset += fs.writeSync(fd, bytes, 0, bytes.length, offset); },
        close() { if (!closed) { closed = true; fs.closeSync(fd); } },
      };
    } };
  }
  const io = {
    file, list: () => { fs.mkdirSync(root, { recursive: true }); return fs.readdirSync(root); },
    create: (name) => { fs.writeFileSync(target(name), '', { flag: 'wx' }); return file(name); },
    remove: (name) => fs.rmSync(target(name), { force: true }),
    commit: (from, to) => { if (failCommit && to === 'index.v1') throw new Error('Injected disk failure'); fs.renameSync(target(from), target(to)); },
    masterKey: async (create) => { if (!master && create) master = crypto.randomBytes(32); if (!master) throw new Error('Private vault key is missing'); return new Uint8Array(master); },
    wipe: async () => { master?.fill(0); master = null; fs.rmSync(root, { recursive: true, force: true }); },
    requireStorage: (n) => { if (n > free) throw new Error('Not enough storage'); },
    randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)), uuid: crypto.randomUUID, yield: () => yieldHook(),
  };
  const source = (bytes) => ({ size: bytes.length, open() { let at = 0; return {
    readBytes(n) { const part = new Uint8Array(bytes.subarray(at, at + n)); at += part.length; return part; }, close() {},
  }; } });
  const read = async (store, id) => { const pieces = []; await store.read(id, (bytes) => pieces.push(Buffer.from(bytes))); return Buffer.concat(pieces); };
  return { root, sandbox, touched, io, source, read, store: () => createPrivateVaultStore(io),
    loseKey: () => { master = null; }, hasKey: () => !!master,
    setFree: (n) => { free = n; }, failCommit: () => { failCommit = true; }, setYield: (fn) => { yieldHook = fn; } };
}
const metadata = { name: 'private holiday.jpg', mime: 'image/jpeg' };

test('send reader returns exact bytes without writes and blocks deletion until released', async (t) => {
  const f = fixture(t), store = f.store(), plain = crypto.randomBytes(400123);
  const e = await store.save(f.source(plain), metadata);
  const before = fs.readdirSync(f.root).map((name) => [name, fs.readFileSync(path.join(f.root, name))]);
  const lease = await store.openForSend(e.id), parts = [];
  await assert.rejects(store.delete(e.id), /being sent/);
  for (let i = 0; i < Math.ceil(lease.size / 98304); i++) parts.push(Buffer.from(lease.readChunk(i)));
  assert.deepEqual(Buffer.concat(parts), plain);
  assert.deepEqual(fs.readdirSync(f.root).map((name) => [name, fs.readFileSync(path.join(f.root, name))]), before);
  lease.close(); await store.delete(e.id);
});
test('send cancellation stops reads and reset invalidates active leases', async (t) => {
  const f = fixture(t), store = f.store(), e = await store.save(f.source(crypto.randomBytes(200000)), metadata);
  let active = true;
  const lease = await store.openForSend(e.id, () => active);
  lease.readChunk(0).fill(0); active = false;
  await assert.rejects(async () => lease.readChunk(1), /cancelled/);
  lease.close();
  const again = await store.openForSend(e.id); await store.wipe();
  assert.throws(() => again.readChunk(0), /cancelled/);
});

test('existing secure key with missing vault directory starts a clean vault (reinstall)', async (t) => {
  const f = fixture(t); await f.store().list();
  const key = await f.io.masterKey(false);
  fs.rmSync(f.root, { recursive: true });
  assert.deepEqual(await f.store().list(), []);
  assert.deepEqual(await f.io.masterKey(false), key);
});
test('legacy format 1 files remain readable with authenticated index size', async (t) => {
  const f = fixture(t), nacl = require('tweetnacl'), master = await f.io.masterKey(true);
  const seal = (plain, key) => { const nonce = crypto.randomBytes(24); return Buffer.concat([nonce, Buffer.from(nacl.secretbox(plain, nonce, key))]); };
  const key = crypto.randomBytes(32), id = crypto.randomUUID(), plain = Buffer.from('legacy file');
  const record = Buffer.alloc(plain.length + 8); record.writeUInt32BE(0, 0); record.writeUInt32BE(plain.length, 4); plain.copy(record, 8);
  fs.writeFileSync(path.join(f.root, `${id}.box`), seal(record, key));
  const e = { id, ...metadata, size: plain.length, savedAt: Date.now(), wrappedKey: seal(key, master).toString('base64') };
  fs.writeFileSync(path.join(f.root, 'index.v1'), seal(Buffer.from(JSON.stringify({ v: 1, entries: [e] })), master));
  assert.deepEqual(await f.read(f.store(), id), plain);
});

test('Save writes only ciphertext and opaque names below vault; encrypted index hides metadata', async (t) => {
  const f = fixture(t), store = f.store(), plain = Buffer.from('private attachment content '.repeat(6000));
  const e = await store.save(f.source(plain), metadata);
  assert.equal((await store.list())[0].name, metadata.name);
  assert.equal(e.size, plain.length);
  assert.deepEqual(fs.readdirSync(f.root).sort(), [`${e.id}.box`, 'index.v1'].sort());
  for (const name of fs.readdirSync(f.root)) {
    const disk = fs.readFileSync(path.join(f.root, name));
    assert.equal(disk.includes(Buffer.from('private attachment content')), false);
    assert.equal(disk.includes(Buffer.from(metadata.name)), false);
    assert.equal(disk.includes(Buffer.from(metadata.mime)), false);
  }
  assert(f.touched.every((p) => path.dirname(p) === f.root));
  assert.deepEqual(await f.read(store, e.id), plain);
});
test('saved file and metadata reopen after restart from durable key and encrypted index', async (t) => {
  const f = fixture(t), plain = crypto.randomBytes(400001);
  const e = await f.store().save(f.source(plain), metadata);
  const restarted = f.store();
  assert.deepEqual(await restarted.list(), [e]);
  assert.deepEqual(await f.read(restarted, e.id), plain);
});
test('format 2 rejects an authenticated record with an incorrect final marker', async (t) => {
  const f = fixture(t), nacl = require('tweetnacl'), store = f.store();
  const e = await store.save(f.source(Buffer.from('final record')), metadata);
  const unpack = (b, key) => nacl.secretbox.open(b.subarray(24), b.subarray(0, 24), key);
  const index = JSON.parse(Buffer.from(unpack(fs.readFileSync(path.join(f.root, 'index.v1')), await f.io.masterKey(false))).toString());
  const key = unpack(Buffer.from(index.entries[0].wrappedKey, 'base64'), await f.io.masterKey(false));
  const p = path.join(f.root, `${e.id}.box`), packed = fs.readFileSync(p), plain = unpack(packed, key);
  plain[8] = 0;
  const nonce = crypto.randomBytes(24);
  fs.writeFileSync(p, Buffer.concat([nonce, Buffer.from(nacl.secretbox(plain, nonce, key))]));
  await assert.rejects(f.read(store, e.id), /corrupted/);
});
for (const mode of ['tamper', 'truncate', 'append', 'swap-records', 'duplicate-record', 'drop-final-record']) {
  test(`vault rejects ${mode} without returning a successful preview`, async (t) => {
    const f = fixture(t), store = f.store(), e = await store.save(f.source(crypto.randomBytes(200000)), metadata);
    const p = path.join(f.root, `${e.id}.box`); let b = fs.readFileSync(p);
    if (mode === 'tamper') b[30] ^= 1;
    if (mode === 'truncate') b = b.subarray(0, b.length - 1);
    if (mode === 'append') b = Buffer.concat([b, Buffer.from([0])]);
    if (mode === 'swap-records') { const n = 98304 + 49; b = Buffer.concat([b.subarray(n, 2*n), b.subarray(0, n), b.subarray(2*n)]); }
    if (mode === 'drop-final-record') b = b.subarray(0, 2 * (98304 + 49));
    if (mode === 'duplicate-record') { const n = 98304 + 49; b.copy(b, n, 0, n); }
    fs.writeFileSync(p, b);
    await assert.rejects(f.read(store, e.id), /corrupted/);
  });
}
test('missing master key and modified index fail closed without replacing stored files', async (t) => {
  const f = fixture(t); await f.store().save(f.source(Buffer.from('private')), metadata);
  const p = path.join(f.root, 'index.v1'), original = fs.readFileSync(p);
  const changed = Buffer.from(original); changed[30] ^= 1; fs.writeFileSync(p, changed);
  await assert.rejects(f.store().list(), /corrupted/);
  assert.deepEqual(fs.readFileSync(p), changed);
  fs.writeFileSync(p, original); f.loseKey();
  await assert.rejects(f.store().list(), /key is missing/);
  assert.deepEqual(fs.readFileSync(p), original);
});
test('low storage and failed index publication never expose a half-saved entry', async (t) => {
  const f = fixture(t), store = f.store(); await store.list();
  f.setFree(1); await assert.rejects(store.save(f.source(Buffer.from('private')), metadata), /storage/);
  f.setFree(Infinity); f.failCommit();
  await assert.rejects(store.save(f.source(Buffer.from('private')), metadata), /disk failure/);
  assert.deepEqual(await f.store().list(), []);
  assert.deepEqual(fs.readdirSync(f.root), ['index.v1']);
});
test('restart cleans orphaned encrypted and temporary files without losing committed items', async (t) => {
  const f = fixture(t), e = await f.store().save(f.source(Buffer.from('keep me')), metadata);
  fs.writeFileSync(path.join(f.root, `${crypto.randomUUID()}.box`), crypto.randomBytes(80));
  fs.writeFileSync(path.join(f.root, `${crypto.randomUUID()}.tmp`), crypto.randomBytes(80));
  assert.deepEqual(await f.store().list(), [e]);
  assert.equal(fs.readdirSync(f.root).length, 2);
});
test('delete removes the file and encrypted index entry permanently across restart', async (t) => {
  const f = fixture(t), store = f.store(), e = await store.save(f.source(Buffer.from('delete me')), metadata);
  await store.delete(e.id);
  assert.equal(fs.existsSync(path.join(f.root, `${e.id}.box`)), false);
  assert.deepEqual(await f.store().list(), []);
  await assert.rejects(f.read(store, e.id), /no longer available/);
});
test('Reset Whisper disconnects and wipes files, index and durable master key', async (t) => {
  const f = fixture(t), store = f.store(); await store.save(f.source(Buffer.from('erase me')), metadata);
  let disconnected = false;
  const { resetWhisper } = moduleFrom('accountReset', {
    './socket': { disconnectSocket: () => { disconnected = true; } },
    './privateVault': { wipePrivateVault: () => store.wipe() },
  });
  await resetWhisper();
  assert(disconnected); assert.equal(f.hasKey(), false); assert.equal(fs.existsSync(f.root), false);
  assert.deepEqual(await f.store().list(), []);
});
test('reset cancels an in-flight save and cannot resurrect vault contents', async (t) => {
  const f = fixture(t), store = f.store(); let reset;
  f.setYield(async () => { if (!reset) reset = store.wipe(); });
  await assert.rejects(store.save(f.source(crypto.randomBytes(1000000)), metadata), /reset/);
  await reset;
  assert.equal(f.hasKey(), false); assert.equal(fs.existsSync(f.root), false);
});
test('reset still erases the vault if anonymous-session cleanup fails', async (t) => {
  const f = fixture(t), store = f.store(); await store.save(f.source(Buffer.from('erase anyway')), metadata);
  const { resetWhisper } = moduleFrom('accountReset', {
    './socket': { disconnectSocket: () => { throw new Error('Session cleanup failed'); } },
    './privateVault': { wipePrivateVault: () => store.wipe() },
  });
  await assert.rejects(resetWhisper(), /Session cleanup failed/);
  assert.equal(f.hasKey(), false); assert.equal(fs.existsSync(f.root), false);
});
test('fresh keys and nonces produce different ciphertext for identical attachments', async (t) => {
  const f = fixture(t), store = f.store(), plain = Buffer.from('same content');
  const a = await store.save(f.source(plain), metadata), b = await store.save(f.source(plain), metadata);
  assert.notDeepEqual(fs.readFileSync(path.join(f.root, `${a.id}.box`)), fs.readFileSync(path.join(f.root, `${b.id}.box`)));
});

test('app Save -> restart -> preview/document -> close -> delete uses vault adapter and cleans plaintext', async (t) => {
  const f = fixture(t), cache = path.join(f.sandbox, 'chat-cache'); fs.mkdirSync(cache);
  const plain = crypto.randomBytes(240000);
  let policy = { enabled: false, timeout: 60 }, authFailure = false;
  const native = {
    lockStatus: async () => policy, cancelAuthentication() {},
    setLock: async (enabled, timeout) => (policy = { enabled, timeout }),
    list: f.io.list, size: (n) => f.io.file(n).size, create: (n) => { f.io.create(n); },
    remove: f.io.remove, commit: f.io.commit, wipe: async () => { await f.io.wipe(); policy = { enabled: false, timeout: 60 }; },
    masterKey: async (create) => { if (authFailure) throw new Error('Vault authentication cancelled'); return Buffer.from(await f.io.masterKey(create)).toString('base64'); },
    read: (n, offset, count) => {
      const h = f.io.file(n).open();
      try { if (offset) h.readBytes(offset); return Buffer.from(h.readBytes(count)).toString('base64'); } finally { h.close(); }
    },
    write: (n, offset, data) => { const fd = fs.openSync(path.join(f.root, n), 'r+'); try { fs.writeSync(fd, Buffer.from(data, 'base64'), 0, Buffer.from(data, 'base64').length, offset); } finally { fs.closeSync(fd); } },
  };
  const attachments = {
    openAttachmentFile: () => f.source(plain), mediaExtension: () => 'jpg',
    encodeChunk: (bytes) => Buffer.from(bytes).toString('base64'), decodeChunk: (s) => new Uint8Array(Buffer.from(s, 'base64')),
    deleteAttachment: (uri) => fs.rmSync(uri, { force: true }),
    newAttachmentFile: () => {
      const uri = path.join(cache, crypto.randomUUID() + '.jpg'); fs.writeFileSync(uri, '');
      return { uri, open() { const fd = fs.openSync(uri, 'r+'); let at = 0; return {
        writeBytes(bytes) { at += fs.writeSync(fd, bytes, 0, bytes.length, at); }, close() { fs.closeSync(fd); },
      }; } };
    },
  };
  function app() { return moduleFrom('privateVault', {
    'expo-modules-core': { requireOptionalNativeModule: () => native },
    'expo-crypto': { getRandomBytes: (n) => new Uint8Array(crypto.randomBytes(n)), randomUUID: crypto.randomUUID },
    'expo-file-system': { Paths: { availableDiskSpace: 1024 ** 3 }, File: class { constructor(uri) { this.uri = uri; } get exists() { return fs.existsSync(this.uri); } } },
    './privateVaultStore': { createPrivateVaultStore }, './attachmentFiles': attachments,
  }); }
  const first = app();
  assert.throws(() => first.saveToVault({ allowSaving: false }, () => true), /not allowed/);
  const item = await first.saveToVault({ allowSaving: true, fileUri: 'encrypted-chat-cache', fileName: 'Private.jpg', mimeType: 'image/jpeg' }, () => true);
  assert.deepEqual(fs.readdirSync(cache), [], 'Save must not create a plaintext lease');
  const restarted = app(); assert.deepEqual(await restarted.listSavedFiles(), [item]);
  const message = { vaultId: item.id, mimeType: item.mime, fileSize: item.size };
  const lease = await restarted.acquireVaultPreview(message);
  assert.deepEqual(fs.readFileSync(lease.uri), plain);
  lease.release(); assert.deepEqual(fs.readdirSync(cache), []);
  assert.deepEqual(Buffer.from(await restarted.readVaultDocument(message), 'base64'), plain);
  await restarted.configureVaultLock(true, 60);
  const activePreview = await restarted.acquireVaultPreview(message);
  assert.ok(fs.existsSync(activePreview.uri));
  restarted.setVaultAppActive(false);
  assert.deepEqual(fs.readdirSync(cache), [], 'background lock releases the plaintext preview');
  restarted.setVaultAppActive(true); authFailure = true;
  const beforeSave = fs.readdirSync(f.root);
  await assert.rejects(restarted.saveToVault({ allowSaving: true, fileUri: 'encrypted-chat-cache', fileName: 'Private.jpg', mimeType: 'image/jpeg' }, () => true), /cancelled/);
  assert.deepEqual(fs.readdirSync(f.root), beforeSave, 'cancelled authentication cannot save while locked');
  authFailure = false; (await restarted.beginVaultSession())();
  const disk = path.join(f.root, `${item.id}.box`), cipher = fs.readFileSync(disk);
  cipher[cipher.length - 1] ^= 1; fs.writeFileSync(disk, cipher);
  await assert.rejects(restarted.acquireVaultPreview(message), /corrupted/);
  assert.deepEqual(fs.readdirSync(cache), [], 'late authentication failure removes partially decrypted preview');
  await restarted.deleteSavedFile(item.id);
  const next = app(); assert.deepEqual(await next.listSavedFiles(), []); next.lockSavedFiles();
  await restarted.disableVaultLock(async () => false);
  assert.equal(policy.enabled, true);
  await restarted.disableVaultLock(async () => true);
  assert.equal(policy.enabled, false); assert.equal(f.hasKey(), false); assert.equal(fs.existsSync(f.root), false);
  assert.deepEqual(await restarted.listSavedFiles(), []);
  const fresh = await restarted.saveToVault({ allowSaving: true, fileUri: 'encrypted-chat-cache', fileName: 'New.jpg', mimeType: 'image/jpeg' }, () => true);
  assert.ok(fresh.id); restarted.lockSavedFiles();
});

test('lock erases master and all live file keys, closes send leases, and denies reads', async t => {
  const f = fixture(t), buffers = [];
  const originalMaster = f.io.masterKey;
  f.io.masterKey = async create => { const key = await originalMaster(create); buffers.push(key); return key; };
  const random = f.io.randomBytes;
  f.io.randomBytes = n => { const key = random(n); if (n === 32) buffers.push(key); return key; };
  const store = f.store(), item = await store.save(f.source(crypto.randomBytes(250000)), metadata);
  const reader = await store.openForSend(item.id); reader.readChunk(0).fill(0);
  store.lock();
  assert.deepEqual(store.inspectState(), { locked: true, masterPresent: false, perFileKeys: 0, entriesPresent: false, leases: 0 });
  for (const key of buffers) assert.ok(key.every(value => value === 0));
  assert.throws(() => reader.readChunk(1), /cancelled/);
  await assert.rejects(store.list(), /locked/); await assert.rejects(f.read(store, item.id), /locked/);
  await store.unlock(); assert.equal((await store.list())[0].id, item.id);
});
test('lock during yielding save/read/preflight erases keys and aborts cleanly', async t => {
  const f = fixture(t), store = f.store(), data = crypto.randomBytes(98304 * 10);
  const item = await store.save(f.source(data), metadata);
  for (const operation of [() => f.read(store, item.id), () => store.openForSend(item.id), () => store.save(f.source(data), metadata)]) {
    f.setYield(async () => { store.lock(); });
    await assert.rejects(operation(), /locked|cancelled/);
    assert.equal(store.inspectState().masterPresent, false); assert.equal(store.inspectState().perFileKeys, 0);
    f.setYield(async () => {}); await store.unlock(); assert.equal((await store.list()).length, 1);
  }
});
test('late authentication response after lock is zeroed and never installed', async t => {
  const f = fixture(t), store = f.store(); await store.list(); store.lock();
  const original = f.io.masterKey; let returned;
  f.io.masterKey = async create => { returned = await original(create); store.lock(); return returned; };
  await assert.rejects(store.unlock(), /cancelled/);
  assert.ok(returned.every(value => value === 0)); assert.equal(store.inspectState().masterPresent, false);
});
test('reset erases the locked vault without requesting its master key', async t => {
  const f = fixture(t), store = f.store(); await store.save(f.source(Buffer.from('locked data')), metadata); store.lock();
  f.io.masterKey = async () => { throw new Error('Must not authenticate reset'); };
  await store.wipe(); assert.equal(f.hasKey(), false); assert.equal(fs.existsSync(f.root), false);
});
