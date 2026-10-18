const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { transformSync } = require('@babel/core');
const { loadE2e, pair, confirmPair, INVITE } = require('./helpers/loadE2e.cjs');
const close = (p) => { p.a.destroy(); p.b.destroy(); };

test('official libsignal clients mutually confirm and exchange ratcheted messages', async () => {
  const p = await pair();
  try {
    await confirmPair(p);
    assert.equal(p.a.isConfirmed(), true); assert.equal(p.b.isConfirmed(), true);
    assert.equal(await p.a.getSafetyCode(), await p.b.getSafetyCode());
    assert.match(await p.a.getSafetyCode(), /^\d{3}(?: \d{3}){4}$/);
    for (let i = 0; i < 12; i++) {
      assert.equal(await p.b.decrypt(await p.a.encrypt('alice ' + i)), 'alice ' + i);
      assert.equal(await p.a.decrypt(await p.b.encrypt('bob ' + i)), 'bob ' + i);
    }
  } finally { close(p); }
});
test('out-of-order messages decrypt once, while replay and tampering fail', async () => {
  const p = await pair();
  try {
    await confirmPair(p);
    const messages = await Promise.all(['one', 'two', 'three'].map((text) => p.a.encrypt(text)));
    const broken = Buffer.from(messages[0], 'base64'); broken[broken.length - 5] ^= 1;
    await assert.rejects(p.b.decrypt(broken.toString('base64')), /authentication/);
    assert.equal(await p.b.decrypt(messages[2]), 'three');
    assert.equal(await p.b.decrypt(messages[0]), 'one');
    assert.equal(await p.b.decrypt(messages[1]), 'two');
    await assert.rejects(p.b.decrypt(messages[0]), /replayed/);
  } finally { close(p); }
});
test('wrong invite or room cannot authenticate a key bundle', async () => {
  for (const options of [{ inviteB: INVITE.replace('ABCD', 'EFGH') }, { roomB: 'other-room' }]) {
    const p = await pair(options);
    try { await assert.rejects(p.a.deriveSharedKey(p.pubB), /authentication/); }
    finally { close(p); }
  }
});
test('reflected identities, changed bundles, obsolete payloads and modified bundles fail', async () => {
  const p = await pair();
  try {
    await assert.rejects(p.a.deriveSharedKey(p.pubA), /Reflected/);
    await assert.rejects(p.a.deriveSharedKey(Buffer.alloc(32).toString('base64')), /protocol/);
    const broken = Buffer.from(p.pubB, 'base64'); broken[60] ^= 1;
    await assert.rejects(p.a.deriveSharedKey(broken.toString('base64')), /authentication/);
    await confirmPair(p);
    await assert.rejects(p.a.deriveSharedKey(p.pubA), /identity changed/);
  } finally { close(p); }
});
test('application data cannot be sent until both key confirmations complete', async () => {
  const p = await pair();
  try {
    await p.a.deriveSharedKey(p.pubB);
    await assert.rejects(p.a.encrypt('too early'), /unavailable/);
    assert.equal(await p.a.getSafetyCode(), null);
  } finally { close(p); }
});
test('teardown cancels queued operations and old ciphertext fails in a fresh session', async () => {
  const p = await pair();
  await confirmPair(p);
  const old = await p.a.encrypt('old chat');
  const pending = p.a.encrypt('cancelled'); p.a.destroy();
  await assert.rejects(pending, /ended/);
  p.b.destroy();
  const fresh = await pair();
  try { await confirmPair(fresh); await assert.rejects(fresh.b.decrypt(old), /authentication/); }
  finally { close(fresh); }
});
test('missing or mismatched native protocol fails closed, including Expo Go', async () => {
  for (const native of [null, { protocolVersion: 6 }, { protocolVersion: 7, libsignalVersion: 'old' }]) {
    const e = loadE2e({ native }); e.setInviteBinding(INVITE); e.setRoomBinding('room');
    await assert.rejects(e.generateKeys(), /native build/);
  }
});
test('chat encryption requires a full secret invite', async () => {
  const e = loadE2e(); e.setRoomBinding('room');
  await assert.rejects(e.generateKeys(), /secret invite/);
});

function loadService(name) {
  const filename = path.resolve(__dirname, '../src/services/' + name + '.js');
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), { filename, configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-modules-commonjs'] });
  const module = { exports: {} }; new Function('require', 'module', 'exports', code)(require, module, module.exports); return module.exports;
}
test('automatic reconnection is limited to two attempts and two seconds', () => {
  const policy = loadService('reconnectPolicy');
  assert.equal(policy.MAX_RECONNECT_ATTEMPTS, 2); assert.equal(policy.RECONNECT_WINDOW_MS, 2000);
  assert.equal(policy.shouldStopReconnect(2, 1999), false); assert.equal(policy.shouldStopReconnect(3, 1000), true);
  assert.equal(policy.shouldStopReconnect(1, 2000), true);
});
test('group proof-of-work is solved locally and cheaply verified', async () => {
  const proof = loadService('proofOfWork'); const id = crypto.randomUUID(); const nonce = '0123456789abcdef0123456789abcdef';
  const solution = await proof.solveProofOfWork(id, nonce, 8);
  assert.equal(crypto.createHash('sha512').update(`${id}|${nonce}|${solution}`).digest()[0], 0);
});
