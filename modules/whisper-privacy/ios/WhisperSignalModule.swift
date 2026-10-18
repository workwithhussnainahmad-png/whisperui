import ExpoModulesCore
import Foundation
import LibSignalClient

// Protocol key material never enters JavaScript or persistent storage.
public final class WhisperSignalModule: Module {
  private let lock = NSLock()
  private var current: State?
  private let context = NullContext()
  private final class State {
    let id: String
    let store: InMemorySignalProtocolStore
    let local: ProtocolAddress
    var peer: ProtocolAddress?
    init(_ id: String, _ store: InMemorySignalProtocolStore) throws {
      self.id = id; self.store = store
      self.local = try ProtocolAddress(name: id, deviceId: 1)
    }
  }
  private func locked<T>(_ work: () throws -> T) rethrows -> T {
    lock.lock(); defer { lock.unlock() }; return try work()
  }
  private func invalid() -> NSError { NSError(domain: "WhisperSignal", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid or unavailable secure session"]) }
  private func state(_ id: String) throws -> State {
    guard let state = current, state.id == id else { throw invalid() }; return state
  }
  private func decode(_ text: String, limit: Int = 262144) throws -> Data {
    guard text.utf8.count <= limit, let data = Data(base64Encoded: text), !data.isEmpty,
      data.base64EncodedString() == text else { throw invalid() }; return data
  }
  public func definition() -> ModuleDefinition {
    Name("WhisperSignal")
    Constants(["protocolVersion": 7, "libsignalVersion": "0.105.1"])
    AsyncFunction("initialize") { (id: String) throws -> String in try self.locked {
      guard UUID(uuidString: id)?.uuidString.lowercased() == id else { throw self.invalid() }
      self.current = nil
      let identity = IdentityKeyPair.generate()
      let store = InMemorySignalProtocolStore(identity: identity, registrationId: UInt32.random(in: 1...16380))
      let pre = PrivateKey.generate(), signed = PrivateKey.generate(), kyber = KEMKeyPair.generate()
      let signature = identity.privateKey.generateSignature(message: signed.publicKey.serialize())
      let kyberSignature = identity.privateKey.generateSignature(message: kyber.publicKey.serialize())
      let now = UInt64(Date().timeIntervalSince1970 * 1000)
      try store.storePreKey(PreKeyRecord(id: 1, privateKey: pre), id: 1, context: self.context)
      try store.storeSignedPreKey(SignedPreKeyRecord(id: 1, timestamp: now, privateKey: signed, signature: signature), id: 1, context: self.context)
      try store.storeKyberPreKey(KyberPreKeyRecord(id: 1, timestamp: now, keyPair: kyber, signature: kyberSignature), id: 1, context: self.context)
      let bundle: [String: Any] = ["address": id, "registrationId": try store.localRegistrationId(context: self.context),
        "identity": identity.identityKey.serialize().base64EncodedString(), "preKey": pre.publicKey.serialize().base64EncodedString(),
        "signedPreKey": signed.publicKey.serialize().base64EncodedString(), "signature": signature.base64EncodedString(),
        "kyberKey": kyber.publicKey.serialize().base64EncodedString(), "kyberSignature": kyberSignature.base64EncodedString()]
      let json = try JSONSerialization.data(withJSONObject: bundle, options: [.sortedKeys])
      self.current = try State(id, store)
      return String(decoding: json, as: UTF8.self)
    } }
    AsyncFunction("establish") { (id: String, bundleJson: String, initiator: Bool) throws in try self.locked {
      let s = try self.state(id)
      guard s.peer == nil, bundleJson.utf8.count <= 8192,
        let b = try JSONSerialization.jsonObject(with: Data(bundleJson.utf8)) as? [String: Any],
        let address = b["address"] as? String, UUID(uuidString: address)?.uuidString.lowercased() == address, address != id,
        let registration = b["registrationId"] as? Int, (1...16380).contains(registration) else { throw self.invalid() }
      func field(_ key: String) throws -> Data {
        guard let text = b[key] as? String else { throw self.invalid() }; return try self.decode(text, limit: 4096)
      }
      let identity = try IdentityKey(bytes: field("identity"))
      let peer = try ProtocolAddress(name: address, deviceId: 1)
      let bundle = try PreKeyBundle(registrationId: UInt32(registration), deviceId: 1,
        prekeyId: 1, prekey: PublicKey(field("preKey")), signedPrekeyId: 1,
        signedPrekey: PublicKey(field("signedPreKey")), signedPrekeySignature: field("signature"), identity: identity,
        kyberPrekeyId: 1, kyberPrekey: KEMPublicKey(field("kyberKey")), kyberPrekeySignature: field("kyberSignature"))
      _ = try s.store.saveIdentity(identity, for: peer, context: self.context)
      if initiator { try processPreKeyBundle(bundle, for: peer, ourAddress: s.local, sessionStore: s.store, identityStore: s.store, context: self.context) }
      s.peer = peer
    } }
    AsyncFunction("encrypt") { (id: String, plaintext: String) throws -> String in try self.locked {
      let s = try self.state(id)
      guard let peer = s.peer, plaintext.utf8.count <= 180000 else { throw self.invalid() }
      var input = Data(plaintext.utf8); defer { input.resetBytes(in: 0..<input.count) }
      let cipher = try signalEncrypt(message: input, for: peer, localAddress: s.local, sessionStore: s.store, identityStore: s.store, context: self.context)
      guard cipher.messageType == .whisper || cipher.messageType == .preKey else { throw self.invalid() }
      return (Data([cipher.messageType.rawValue]) + cipher.serialize()).base64EncodedString()
    } }
    AsyncFunction("decrypt") { (id: String, encoded: String) throws -> String in try self.locked {
      let s = try self.state(id)
      guard let peer = s.peer else { throw self.invalid() }
      let packed = try self.decode(encoded)
      guard packed.count > 1, packed.count <= 196608 else { throw self.invalid() }
      let message = Data(packed.dropFirst())
      var plain: Data
      switch packed.first! {
      case 2:
        plain = try signalDecrypt(message: SignalMessage(bytes: message), from: peer, to: s.local, sessionStore: s.store, identityStore: s.store, context: self.context)
      case 3:
        plain = try signalDecryptPreKey(message: PreKeySignalMessage(bytes: message), from: peer, localAddress: s.local,
          sessionStore: s.store, identityStore: s.store, preKeyStore: s.store, signedPreKeyStore: s.store, kyberPreKeyStore: s.store, context: self.context)
      default: throw self.invalid()
      }
      defer { plain.resetBytes(in: 0..<plain.count) }
      guard plain.count <= 180000, let text = String(data: plain, encoding: .utf8) else { throw self.invalid() }
      return text
    } }
    AsyncFunction("destroy") { (id: String) in self.locked { if self.current?.id == id { self.current = nil } } }
    OnDestroy { self.locked { self.current = nil } }
  }
}
