const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('@babel/core');
const { createSignalBridge } = require('../helpers/signalBridge.cjs');
const backend = process.env.WHISPER_BACKEND_DIR || path.resolve(__dirname, '../../../whisper');
const { startServer } = require(path.join(backend, 'test/serverFixture.cjs'));

// Run the real mobile socket, envelope and crypto modules independently for
// each device. Only device APIs and the loopback transport URL are substituted.
function client(url) {
  const signal = createSignalBridge();
  const cache = new Map();
  const files = new Map();
  const savedFiles = new Map();
  let masterKey = crypto.randomBytes(32);
  let vaultPolicy = { enabled: false, timeout: 60 };
  const nativeVault = {
    lockStatus: async () => vaultPolicy, cancelAuthentication() {},
    setLock: async (enabled, timeout) => (vaultPolicy = { enabled, timeout }),
    list: () => [...savedFiles.keys()],
    size: (name) => { if (!savedFiles.has(name)) throw new Error('Saved file is missing'); return savedFiles.get(name).length; },
    create: (name) => { assert(!savedFiles.has(name)); savedFiles.set(name, Buffer.alloc(0)); },
    read: (name, at, count) => savedFiles.get(name).subarray(at, at + count).toString('base64'),
    write: (name, at, value) => {
      const bytes = Buffer.from(value, 'base64'), old = savedFiles.get(name), next = Buffer.alloc(Math.max(old.length, at + bytes.length));
      old.copy(next); bytes.copy(next, at); savedFiles.set(name, next);
    },
    commit: (from, to) => { savedFiles.set(to, savedFiles.get(from)); savedFiles.delete(from); },
    remove: (name) => savedFiles.delete(name),
    masterKey: async () => masterKey.toString('base64'),
    wipe: async () => { masterKey.fill(0); masterKey = crypto.randomBytes(32); savedFiles.clear(); },
  };
  let vault;
  const attachments = {
    clearAttachmentFiles: () => { vault.clear(); files.clear(); },
    isOwnedAttachment: (uri) => files.has(uri),
    requireStorage() {},
    mediaExtension: () => 'bin',
    decodeChunk: (data) => new Uint8Array(Buffer.from(data, 'base64')),
    encodeChunk: (data) => Buffer.from(data).toString('base64'),
    deleteAttachment: (uri) => { vault.forget(uri); files.delete(uri); },
    finishEncryptedAttachment: (uri) => vault.seal(uri),
    openAttachmentFile: (uri) => vault.get(uri),
    newEncryptedAttachmentFile: () => vault.create(),
    createRawFile() {
      const uri = 'memory://' + crypto.randomUUID();
      files.set(uri, Buffer.alloc(0));
      return { uri, get size() { return files.get(uri).length; }, open: () => {
        let offset = 0;
        return {
          get offset() { return offset; }, set offset(value) { offset = value; },
          writeBytes(bytes) {
            const before = files.get(uri), after = Buffer.alloc(Math.max(before.length, offset + bytes.length));
            before.copy(after); after.set(bytes, offset); offset += bytes.length; files.set(uri, after);
          },
          readBytes(n) { const value = new Uint8Array(files.get(uri).subarray(offset, offset + n)); offset += value.length; return value; },
          close() {},
        };
      } };
    },
  };
  const expoCrypto = {
    CryptoDigestAlgorithm: { SHA256: 'sha256' },
    getRandomBytes: (size) => new Uint8Array(crypto.randomBytes(size)),
    randomUUID: () => crypto.randomUUID(),
    digest: async (_, input) => new Uint8Array(crypto.createHash('sha256').update(input).digest()).buffer,
  };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
      filename, configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-modules-commonjs'],
    });
    const localRequire = (id) => {
      if (id === 'expo-crypto') return expoCrypto;
      if (id === 'expo-modules-core') return { requireOptionalNativeModule: (name) => name === 'WhisperVault' ? nativeVault : signal };
      if (id === 'expo-file-system') return { File: class {}, Paths: { availableDiskSpace: 1024 ** 3 } };
      if (id === '../config') return { getServerUrl: () => url, ALLOW_UNVERIFIED_CHATS: false };
      if (id === './captureProtection') return { ensureCaptureProtection: async () => {} };
      if (id === './attachmentFiles') return attachments;
      if (id.startsWith('.')) return load(path.resolve(path.dirname(filename), id + '.js'));
      return require(id);
    };
    new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
    return module.exports;
  }
  const services = path.resolve(__dirname, '../../src/services');
  vault = load(path.join(services, 'encryptedFileStore.js')).createEncryptedFileStore({
    createFile: attachments.createRawFile, removeFile: (uri) => files.delete(uri),
    randomBytes: expoCrypto.getRandomBytes, requireStorage() {}, maxBytes: 64 * 1024 * 1024,
  });
  return { api: load(path.join(services, 'socket.js')), crypto: load(path.join(services, 'e2e.js')), files, vault,
    saved: load(path.join(services, 'privateVault.js')), savedFiles };
}

function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error(`${name} timed out`)); }, 5000);
    const handler = (value) => { clearTimeout(timer); resolve(value); };
    socket.once(name, handler);
  });
}

for (const mode of ['invite', 'random']) test(`real mobile clients establish ${mode} chat and exchange authenticated messages and vault files`, async () => {
  const server = await startServer();
  const alice = client(server.url);
  const bob = client(server.url);
  try {
    const [a, b] = await Promise.all([alice.api.connectSocket(), bob.api.connectSocket()]);
    const invite = mode === 'invite' ? await alice.api.createInvite() : null;
    if (invite) assert.equal(alice.api.isValidInviteCode(invite), true);
    const matches = [event(a, 'matched'), event(b, 'matched')];
    if (mode === 'invite') await bob.api.joinInvite(invite);
    else { assert.equal((await alice.api.findRandom()).status, 'waiting'); await bob.api.findRandom(); }
    const [first, second] = await Promise.all(matches);
    assert.equal(first.roomId, second.roomId);
    for (const peer of [alice, bob]) peer.api.configureChatSecurity({ roomId: first.roomId, chatMode: mode, inviteCode: invite });
    await Promise.all([alice.api.ensureKeypair(), bob.api.ensureKeypair()]);
    const keys = [event(a, 'peer-key'), event(b, 'peer-key')];
    await Promise.all([alice.api.startKeyExchange(), bob.api.startKeyExchange()]);
    const [keyA, keyB] = await Promise.all(keys);
    assert.equal(keyA.protocolVersion, 7); assert.equal(keyB.protocolVersion, 7);
    await Promise.all([alice.crypto.deriveSharedKey(keyA.keyBundle), bob.crypto.deriveSharedKey(keyB.keyBundle)]);
    const confirmations = [event(a, 'peer-key-confirm'), event(b, 'peer-key-confirm')];
    const initial = await alice.crypto.createKeyConfirmation(first.roomId);
    if (initial) {
      a.emit('key-confirm', { proof: initial });
      assert.equal(await bob.crypto.verifyKeyConfirmation((await confirmations[1]).proof, first.roomId), true);
      b.emit('key-confirm', { proof: await bob.crypto.createKeyConfirmation(first.roomId) });
      assert.equal(await alice.crypto.verifyKeyConfirmation((await confirmations[0]).proof, first.roomId), true);
    } else {
      b.emit('key-confirm', { proof: await bob.crypto.createKeyConfirmation(first.roomId) });
      assert.equal(await alice.crypto.verifyKeyConfirmation((await confirmations[0]).proof, first.roomId), true);
      a.emit('key-confirm', { proof: await alice.crypto.createKeyConfirmation(first.roomId) });
      assert.equal(await bob.crypto.verifyKeyConfirmation((await confirmations[1]).proof, first.roomId), true);
    }
    await Promise.all([alice.api.confirmSecureChannel(), bob.api.confirmSecureChannel()]);
    const incoming = event(b, 'receive-encrypted');
    const messageId = await alice.api.sendMessage('Only Bob should read this');
    const packet = await incoming;
    assert.equal(packet.messageId, messageId);
    assert.equal(packet.encrypted.includes('Only Bob'), false);
    const bytes = Buffer.from(packet.encrypted, 'base64'); bytes[bytes.length - 1] ^= 1;
    await assert.rejects(bob.api.decryptIncoming(bytes.toString('base64'), messageId), /authentication/);
    assert.equal((await bob.api.decryptIncoming(packet.encrypted, messageId)).text, 'Only Bob should read this');
    await assert.rejects(bob.api.decryptIncoming(packet.encrypted, messageId), /replayed/i);
    const receipt = event(a, 'receive-encrypted');
    await bob.api.sendReceipt(messageId);
    const receiptPacket = await receipt;
    assert.equal((await alice.api.decryptIncoming(receiptPacket.encrypted, receiptPacket.messageId)).receiptFor, messageId);
    const completed = [];
    const processingErrors = [];
    const processPacket = (peer) => async (data) => {
      try {
        const message = await peer.api.decryptIncoming(data.encrypted, data.messageId);
        if (message?.fileUri) completed.push(message);
      } catch (error) { processingErrors.push(error); }
    };
    a.on('receive-encrypted', processPacket(alice));
    b.on('receive-encrypted', processPacket(bob));
    if (mode === 'random') {
      await assert.rejects(alice.api.sendFile('YQ==', 'text/plain', 'a.txt', 1), /enable media/);
      await assert.rejects(alice.api.sendVaultFile('missing'), /enable media/);
      await alice.api.enableMedia();
      await assert.rejects(alice.api.sendFile('YQ==', 'text/plain', 'a.txt', 1), /enable media/);
      await bob.api.enableMedia();
      const deadline = Date.now() + 3000;
      while ((!alice.api.canExchangeMedia() || !bob.api.canExchangeMedia()) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      assert.equal(alice.api.canExchangeMedia(), true); assert.equal(bob.api.canExchangeMedia(), true);
    }
    const content = crypto.randomBytes(400000);
    await alice.api.sendFile(content.toString('base64'), 'application/octet-stream', 'example.bin', content.length, crypto.randomUUID(), undefined, new AbortController().signal);
    assert.deepEqual(processingErrors, []);
    assert.equal(completed.length, 1);
    const receivedFile = bob.vault.get(completed[0].fileUri);
    assert.equal(bob.files.get(receivedFile.uri).includes(content.subarray(0, 100)), false);
    const reader = receivedFile.open(); const received = [];
    while (reader.offset < receivedFile.size) received.push(Buffer.from(reader.readBytes(Math.min(98304, receivedFile.size - reader.offset))));
    reader.close();
    assert.deepEqual(Buffer.concat(received), content);
    // Sending an existing encrypted attachment decrypts only bounded chunks.
    await bob.api.setMediaSavingAllowed(true);
    await bob.api.sendFile({ fileUri: receivedFile.uri }, 'application/octet-stream', 'reply.bin', content.length);
    assert.equal(completed.length, 2);
    const savedA = await alice.saved.saveToVault(completed[1], () => true);
    const diskBefore = [...alice.savedFiles].map(([name, bytes]) => [name, Buffer.from(bytes)]);
    const cacheBefore = [...alice.files.keys()];
    await alice.api.setMediaSavingAllowed(true);
    let deletionAttempt;
    await alice.api.sendVaultFile(savedA.id, crypto.randomUUID(), (progress, stage) => {
      if (progress > 0 && stage === 'sending' && !deletionAttempt) {
        deletionAttempt = assert.rejects(alice.saved.deleteSavedFile(savedA.id), /being sent/);
      }
    });
    await deletionAttempt;
    assert.equal(completed.length, 3);
    assert.equal(completed[2].allowSaving, true);
    const savedB = await bob.saved.saveToVault(completed[2], () => true);
    const fromB = await bob.saved.openVaultSend(savedB.id, () => true), pieces = [];
    for (let i = 0; i < Math.ceil(fromB.size / 98304); i++) pieces.push(Buffer.from(fromB.readChunk(i)));
    fromB.close();
    assert.equal(crypto.createHash('sha256').update(Buffer.concat(pieces)).digest('hex'), crypto.createHash('sha256').update(content).digest('hex'));
    assert.deepEqual([...alice.files.keys()], cacheBefore, 'sending must create no sender cache or preview files');
    assert.deepEqual([...alice.savedFiles], diskBefore, 'sending must leave vault bytes and index unchanged');
    // Cancel while staged: Bob must never publish a partial file.
    const cancel = new AbortController(), bobCache = [...bob.files.keys()];
    await assert.rejects(alice.api.sendVaultFile(savedA.id, crypto.randomUUID(), (progress, stage) => {
      if (stage === 'sending' && progress > 0) cancel.abort();
    }, cancel.signal), /cancelled/);
    assert.equal(completed.length, 3);
    assert.deepEqual([...bob.files.keys()], bobCache);
    assert.deepEqual([...alice.savedFiles], diskBefore);
    // Ordinary picked attachments use the same cancellable commit boundary.
    const pickedCancel = new AbortController();
    await assert.rejects(alice.api.sendFile(content.toString('base64'), 'application/octet-stream', 'cancel.bin', content.length,
      crypto.randomUUID(), (progress, stage) => { if (stage === 'sending' && progress > 0) pickedCancel.abort(); }, pickedCancel.signal), /cancelled/);
    assert.equal(completed.length, 3);
    assert.deepEqual([...bob.files.keys()], bobCache);
    await alice.saved.configureVaultLock(true, 60);
    await assert.rejects(alice.api.sendVaultFile(savedA.id, crypto.randomUUID(), (progress, stage) => {
      if (stage === 'sending' && progress > 0) alice.saved.setVaultAppActive(false);
    }), /cancelled|locked/);
    assert.equal(completed.length, 3); assert.deepEqual([...bob.files.keys()], bobCache);
    assert.equal(alice.saved.getVaultLockState().locked, true);
    assert.deepEqual([...alice.savedFiles], diskBefore);
    alice.saved.setVaultAppActive(true);
    (await alice.saved.beginVaultSession())();
    // Preflight rejects corrupt/truncated data before any media reaches Bob.
    const filename = `${savedA.id}.box`, original = Buffer.from(alice.savedFiles.get(filename));
    alice.savedFiles.set(filename, original.subarray(0, original.length - 1));
    await assert.rejects(alice.api.sendVaultFile(savedA.id), /corrupted/);
    const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 1; alice.savedFiles.set(filename, damaged);
    await assert.rejects(alice.api.sendVaultFile(savedA.id), /corrupted/);
    alice.savedFiles.set(filename, Buffer.from(original));
    // Mutation after preflight must also abort and erase Bob's staged chunks.
    let changed = false;
    await assert.rejects(alice.api.sendVaultFile(savedA.id, crypto.randomUUID(), (progress, stage) => {
      if (!changed && stage === 'sending' && progress > 0) { changed = true; alice.savedFiles.get(filename)[original.length - 1] ^= 1; }
    }), /corrupted/);
    assert.equal(completed.length, 3); assert.deepEqual([...bob.files.keys()], bobCache);
    alice.savedFiles.set(filename, original);
    let removed = false;
    await assert.rejects(alice.api.sendVaultFile(savedA.id, crypto.randomUUID(), (progress, stage) => {
      if (!removed && stage === 'sending' && progress > 0) { removed = true; alice.savedFiles.delete(filename); }
    }), /missing/);
    assert.equal(completed.length, 3); assert.deepEqual([...bob.files.keys()], bobCache);
    alice.savedFiles.set(filename, original);
    await alice.saved.deleteSavedFile(savedA.id);
    await assert.rejects(alice.api.sendVaultFile(savedA.id), /no longer available/);
    assert.deepEqual(processingErrors, []);
    await assert.rejects(alice.api.sendFile('YQ==', 'application/octet-stream', 'bad\0name', 1), /invalid/);
    bob.api.resetE2E();
    await assert.rejects(bob.api.sendVaultFile(savedB.id), /recipient/);
    assert.equal(bob.files.size, 0);
    assert.equal(bob.crypto.isReady(), false);
    await assert.rejects(bob.api.decryptIncoming(packet.encrypted, messageId), /ended/);
  } finally {
    alice.saved.lockSavedFiles(); bob.saved.lockSavedFiles();
    alice.api.disconnectSocket(); bob.api.disconnectSocket(); server.stop();
  }
});
