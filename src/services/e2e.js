import * as Crypto from 'expo-crypto';
import { requireOptionalNativeModule } from 'expo-modules-core';
import nacl from 'tweetnacl';
import { isValidBase64 } from './payloadValidation';

// Protocol 7: libsignal owns message encryption, key agreement and ratcheting.
// Legacy secret bindings authenticate bundles; lookup mode relies on safety comparison. Private protocol
// keys stay native. There is no legacy-crypto or Expo Go fallback.
const native = requireOptionalNativeModule('WhisperSignal');
export const PROTOCOL_VERSION = 7;
const MAX_BUNDLE = 16384;
const MAX_CIPHER = 262144;
const INVITE_RE = /^TALK-[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let epoch = 0;
let session = null;
let invite = null;
let room = null;
let queue = Promise.resolve();
let queuedOperations = 0;
const bytes = (value) => new TextEncoder().encode(value);
const decode = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const encode = (value) => {
  let text = '';
  for (let offset = 0; offset < value.length; offset += 16384) text += String.fromCharCode(...value.subarray(offset, offset + 16384));
  return btoa(text);
};
function nativeQueue(operation, cleanup = false) {
  if (!cleanup && queuedOperations >= 64) return Promise.reject(new Error('Too many pending crypto operations'));
  queuedOperations += 1;
  const result = queue.then(operation).finally(() => { queuedOperations -= 1; });
  queue = result.catch(() => {});
  return result;
}
function active(s) {
  if (!s || session !== s || s.epoch !== epoch) throw new Error('Secure session ended');
}
function requireBridge() {
  if (!native || native.protocolVersion !== 7 || native.libsignalVersion !== '0.105.1') {
    throw new Error('Install the updated Whisper native build for encrypted chat');
  }
}
export function assertCryptoAvailable() { requireBridge(); }
function bindingKey() {
  if (!room || (invite !== null && !INVITE_RE.test(invite))) throw new Error('A valid binding and room are required');
  // In lookup mode this envelope key is PUBLIC, only preserving the bundle wire format.
  // Peer authentication comes from comparing libsignal identity fingerprints.
  const input = bytes(JSON.stringify([invite ? 'whisper-invite-bundle-v7' : 'whisper-public-bundle-v7', room, invite]));
  const digest = nacl.hash(input);
  const key = digest.slice(0, 32);
  input.fill(0); digest.fill(0);
  return key;
}
function validateBundle(bundle) {
  if (!bundle || !UUID_RE.test(bundle.address || '') ||
      !Number.isInteger(bundle.registrationId) || bundle.registrationId < 1 || bundle.registrationId > 16380) {
    throw new Error('Invalid peer bundle');
  }
  for (const [name, length] of Object.entries({ identity: 33, preKey: 33, signedPreKey: 33, signature: 64, kyberKey: 1569, kyberSignature: 64 })) {
    if (!isValidBase64(bundle[name], 4096)) throw new Error('Invalid peer bundle');
    const value = decode(bundle[name]);
    try { if (value.length !== length || encode(value) !== bundle[name]) throw new Error('Invalid peer bundle'); }
    finally { value.fill(0); }
  }
  return bundle;
}
function sealBundle(bundle, key) {
  const nonce = Crypto.getRandomBytes(24);
  const plain = bytes(JSON.stringify({ v: 7, room, bundle }));
  const cipher = nacl.secretbox(plain, nonce, key);
  const packed = new Uint8Array(1 + nonce.length + cipher.length);
  packed[0] = 7; packed.set(nonce, 1); packed.set(cipher, 25);
  const output = encode(packed);
  nonce.fill(0); plain.fill(0); cipher.fill(0); packed.fill(0);
  return output;
}
function openBundle(value, key) {
  if (!isValidBase64(value, MAX_BUNDLE)) throw new Error('Invalid peer bundle');
  const packed = decode(value);
  let plain;
  try {
    if (packed.length < 42 || packed[0] !== 7 || encode(packed) !== value) throw new Error('Unsupported security protocol');
    plain = nacl.secretbox.open(packed.subarray(25), packed.subarray(1, 25), key);
    if (!plain) throw new Error('Invite authentication failed');
    const body = JSON.parse(new TextDecoder().decode(plain));
    if (body.v !== 7 || body.room !== room) throw new Error('Incorrect room or protocol');
    return validateBundle(body.bundle);
  } finally { packed.fill(0); plain?.fill(0); }
}
export function setInviteBinding(value) { invite = typeof value === 'string' ? value.toUpperCase().trim() : null; }
export function setRoomBinding(value) { room = typeof value === 'string' && value ? value : null; }

export async function generateKeys() {
  requireBridge();
  if (session) throw new Error('A secure session already exists');
  const s = { id: Crypto.randomUUID(), epoch, key: bindingKey(), room, prepared: false, confirmed: false, proofSent: false };
  session = s;
  try {
    s.bundle = validateBundle(JSON.parse(await nativeQueue(() => { active(s); return native.initialize(s.id); })));
    active(s);
    s.publicBundle = sealBundle(s.bundle, s.key);
    return s.publicBundle;
  } catch (error) { if (session === s) destroy(); throw error; }
}

export async function deriveSharedKey(peerBundle) {
  const s = session;
  active(s);
  if (s.peerEncoded && s.peerEncoded !== peerBundle) throw new Error('Peer identity changed');
  if (s.preparing) return s.preparing;
  if (s.prepared) return;
  const peer = openBundle(peerBundle, s.key);
  if (peer.identity === s.bundle.identity || peer.address === s.bundle.address) throw new Error('Reflected peer identity');
  s.peerEncoded = peerBundle; s.peer = peer;
  s.initiator = s.bundle.identity < peer.identity;
  s.preparing = nativeQueue(async () => {
    active(s);
    await native.establish(s.id, JSON.stringify(peer), s.initiator);
    active(s);
    s.prepared = true;
    s.key.fill(0); s.key = null; invite = null;
  });
  return s.preparing;
}

export function isReady() { return Boolean(session?.prepared); }
export function isConfirmed() { return Boolean(session?.confirmed && session?.proofSent); }
function confirmation(s, sending) {
  return JSON.stringify(['whisper-confirm-v7', s.room,
    sending ? s.bundle.identity : s.peer.identity, sending ? s.peer.identity : s.bundle.identity]);
}
export async function createKeyConfirmation(roomId) {
  const s = session;
  return nativeQueue(async () => {
    active(s);
    if (!s.prepared || roomId !== s.room) throw new Error('Secure session is not ready');
    if (s.proofSent || (!s.initiator && !s.confirmed)) return null;
    const proof = await native.encrypt(s.id, confirmation(s, true));
    active(s); s.proofSent = true;
    return proof;
  });
}
export async function verifyKeyConfirmation(proof, roomId) {
  const s = session;
  return nativeQueue(async () => {
    active(s);
    if (!s.prepared || roomId !== s.room || !isValidBase64(proof, MAX_BUNDLE) || s.confirmed) return false;
    try {
      const text = await native.decrypt(s.id, proof);
      active(s);
      if (text !== confirmation(s, false)) return false;
      s.confirmed = true;
      return true;
    } catch { return false; }
  });
}
export async function getSafetyCode() {
  const s = session;
  if (!isConfirmed()) return null;
  const context = bytes(JSON.stringify(['whisper-safety-v7', s.room, ...[s.publicBundle, s.peerEncoded].sort()]));
  const digest = nacl.hash(context);
  const code = [...digest.subarray(0, 15)].map((byte) => byte % 10).join('').match(/.{3}/g).join(' ');
  context.fill(0); digest.fill(0);
  return code;
}
export async function encrypt(plaintext) {
  const s = session;
  return nativeQueue(async () => {
    active(s);
    if (!isConfirmed() || typeof plaintext !== 'string' || plaintext.length > 180000) throw new Error('Secure channel is unavailable');
    const cipher = await native.encrypt(s.id, plaintext);
    active(s);
    if (!isValidBase64(cipher, MAX_CIPHER)) throw new Error('Invalid encrypted payload');
    return cipher;
  });
}
export async function decrypt(ciphertext) {
  const s = session;
  return nativeQueue(async () => {
    active(s);
    if (!isConfirmed() || !isValidBase64(ciphertext, MAX_CIPHER)) throw new Error('Message authentication failed');
    try {
      const text = await native.decrypt(s.id, ciphertext);
      active(s);
      return text;
    } catch { throw new Error('Message authentication failed or replayed'); }
  });
}
export function destroy() {
  epoch += 1;
  const old = session;
  session = null; invite = null; room = null;
  old?.key?.fill(0);
  if (old && native) nativeQueue(() => native.destroy(old.id), true).catch(() => {});
}
