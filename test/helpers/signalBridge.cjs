// Test-only adapter using the same pinned official libsignal Rust core through
// its Node bindings. This does not substitute for Android/iOS bridge tests.
const S = require('@signalapp/libsignal-client');
const crypto = require('node:crypto');
const encode = (value) => Buffer.from(value).toString('base64');
const decode = (value) => Buffer.from(value, 'base64');

class Sessions extends S.SessionStore {
  data = new Map();
  async saveSession(address, record) { this.data.set(address.toString(), record.serialize()); }
  async getSession(address) { const value = this.data.get(address.toString()); return value ? S.SessionRecord.deserialize(value) : null; }
  async getExistingSessions(addresses) { return Promise.all(addresses.map((address) => this.getSession(address))); }
}
class Identities extends S.IdentityKeyStore {
  privateKey = S.PrivateKey.generate();
  registrationId = crypto.randomInt(1, 16381);
  peers = new Map();
  async getIdentityKey() { return this.privateKey; }
  async getLocalRegistrationId() { return this.registrationId; }
  async getIdentity(address) { return this.peers.get(address.toString()) || null; }
  async saveIdentity(address, key) {
    const old = await this.getIdentity(address); this.peers.set(address.toString(), key);
    return old && !old.equals(key) ? S.IdentityChange.ReplacedExisting : S.IdentityChange.NewOrUnchanged;
  }
  async isTrustedIdentity(address, key) { const saved = await this.getIdentity(address); return !!saved && saved.equals(key); }
}
class PreKeys extends S.PreKeyStore {
  data = new Map();
  async savePreKey(id, record) { this.data.set(id, record); }
  async getPreKey(id) { const value = this.data.get(id); if (!value) throw new Error('Missing prekey'); return value; }
  async removePreKey(id) { this.data.delete(id); }
}
class SignedKeys extends S.SignedPreKeyStore {
  data = new Map();
  async saveSignedPreKey(id, record) { this.data.set(id, record); }
  async getSignedPreKey(id) { return this.data.get(id); }
}
class KyberKeys extends S.KyberPreKeyStore {
  data = new Map(); used = new Set();
  async saveKyberPreKey(id, record) { this.data.set(id, record); }
  async getKyberPreKey(id) { return this.data.get(id); }
  async markKyberPreKeyUsed(id, signedId, key) {
    const token = `${id}:${signedId}:${encode(key.serialize())}`;
    if (this.used.has(token)) throw new Error('Reused base key'); this.used.add(token);
  }
}

function createSignalBridge() {
  let current;
  const state = (id) => { if (current?.id !== id) throw new Error('Session ended'); return current; };
  return {
    protocolVersion: 7, libsignalVersion: '0.105.1',
    async initialize(id) {
      const s = { id, local: S.ProtocolAddress.new(id, 1), sessions: new Sessions(), identity: new Identities(), pre: new PreKeys(), signed: new SignedKeys(), kyber: new KyberKeys() };
      const pre = S.PrivateKey.generate(), signed = S.PrivateKey.generate(), kyber = S.KEMKeyPair.generate();
      const signature = s.identity.privateKey.sign(signed.getPublicKey().serialize());
      const kyberSignature = s.identity.privateKey.sign(kyber.getPublicKey().serialize());
      await s.pre.savePreKey(1, S.PreKeyRecord.new(1, pre.getPublicKey(), pre));
      await s.signed.saveSignedPreKey(1, S.SignedPreKeyRecord.new(1, Date.now(), signed.getPublicKey(), signed, signature));
      await s.kyber.saveKyberPreKey(1, S.KyberPreKeyRecord.new(1, Date.now(), kyber, kyberSignature));
      current = s;
      return JSON.stringify({ address: id, registrationId: s.identity.registrationId,
        identity: encode(s.identity.privateKey.getPublicKey().serialize()), preKey: encode(pre.getPublicKey().serialize()),
        signedPreKey: encode(signed.getPublicKey().serialize()), signature: encode(signature),
        kyberKey: encode(kyber.getPublicKey().serialize()), kyberSignature: encode(kyberSignature) });
    },
    async establish(id, json, initiator) {
      const s = state(id), b = JSON.parse(json);
      s.peer = S.ProtocolAddress.new(b.address, 1);
      const pub = (name) => S.PublicKey.deserialize(decode(b[name]));
      await s.identity.saveIdentity(s.peer, pub('identity'));
      if (initiator) await S.processPreKeyBundle(S.PreKeyBundle.new(b.registrationId, 1, 1, pub('preKey'),
        1, pub('signedPreKey'), decode(b.signature), pub('identity'), 1, S.KEMPublicKey.deserialize(decode(b.kyberKey)), decode(b.kyberSignature)),
      s.peer, s.local, s.sessions, s.identity);
    },
    async encrypt(id, text) {
      const s = state(id);
      const message = await S.signalEncrypt(Buffer.from(text), s.peer, s.local, s.sessions, s.identity);
      return encode(Buffer.concat([Buffer.from([message.type()]), message.serialize()]));
    },
    async decrypt(id, value) {
      const s = state(id), packed = decode(value), message = packed.subarray(1);
      const plain = packed[0] === 3
        ? await S.signalDecryptPreKey(S.PreKeySignalMessage.deserialize(message), s.peer, s.local, s.sessions, s.identity, s.pre, s.signed, s.kyber)
        : packed[0] === 2 ? await S.signalDecrypt(S.SignalMessage.deserialize(message), s.peer, s.local, s.sessions, s.identity)
          : (() => { throw new Error('Invalid message type'); })();
      return Buffer.from(plain).toString('utf8');
    },
    destroy(id) { if (current?.id === id) current = null; },
  };
}
module.exports = { createSignalBridge };
