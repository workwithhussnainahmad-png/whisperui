const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { transformSync } = require('@babel/core');
const { createSignalBridge } = require('./signalBridge.cjs');
const INVITE = 'TALK-' + Array(17).fill('ABCD').join('-');
function loadE2e({ native = createSignalBridge() } = {}) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
      filename, configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-modules-commonjs'],
    });
    new Function('require', 'module', 'exports', code)((id) => {
      if (id === 'expo-modules-core') return { requireOptionalNativeModule: () => native };
      if (id === 'expo-crypto') return { randomUUID: crypto.randomUUID, getRandomBytes: (n) => new Uint8Array(crypto.randomBytes(n)) };
      return id.startsWith('.') ? load(path.resolve(path.dirname(filename), id + '.js')) : require(id);
    }, module, module.exports);
    return module.exports;
  }
  return load(path.resolve(__dirname, '../../src/services/e2e.js'));
}
async function pair({ inviteA = INVITE, inviteB = inviteA, roomA = 'room-1', roomB = roomA } = {}) {
  const a = loadE2e(), b = loadE2e();
  a.setInviteBinding(inviteA); b.setInviteBinding(inviteB); a.setRoomBinding(roomA); b.setRoomBinding(roomB);
  const [pubA, pubB] = await Promise.all([a.generateKeys(), b.generateKeys()]);
  return { a, b, pubA, pubB, roomA, roomB };
}
async function confirmPair(p) {
  await Promise.all([p.a.deriveSharedKey(p.pubB), p.b.deriveSharedKey(p.pubA)]);
  const first = await p.a.createKeyConfirmation(p.roomA);
  if (first) {
    if (!(await p.b.verifyKeyConfirmation(first, p.roomB))) throw new Error('Responder rejected confirmation');
    if (!(await p.a.verifyKeyConfirmation(await p.b.createKeyConfirmation(p.roomB), p.roomA))) throw new Error('Initiator rejected confirmation');
  } else {
    const proof = await p.b.createKeyConfirmation(p.roomB);
    if (!(await p.a.verifyKeyConfirmation(proof, p.roomA))) throw new Error('Responder rejected confirmation');
    if (!(await p.b.verifyKeyConfirmation(await p.a.createKeyConfirmation(p.roomA), p.roomB))) throw new Error('Initiator rejected confirmation');
  }
}
module.exports = { loadE2e, pair, confirmPair, INVITE };
