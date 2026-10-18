package com.whisper.privacy

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import org.signal.libsignal.protocol.*
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.kem.KEMKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyType
import org.signal.libsignal.protocol.kem.KEMPublicKey
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.message.SignalMessage
import org.signal.libsignal.protocol.state.*
import org.signal.libsignal.protocol.state.impl.InMemorySignalProtocolStore
import java.security.SecureRandom
import java.util.UUID

// No persistence, logging or key exports. libsignal stores are not thread-safe:
// every native operation, including teardown, holds the same lock.
class WhisperSignalModule : Module() {
  private val lock = Any()
  private var current: State? = null
  private class State(val id: String, val store: InMemorySignalProtocolStore, val local: SignalProtocolAddress) {
    var peer: SignalProtocolAddress? = null
    var cipher: SessionCipher? = null
  }
  private fun state(id: String): State = current?.takeIf { it.id == id }
    ?: throw IllegalStateException("Secure session ended")
  private fun b64(value: ByteArray) = Base64.encodeToString(value, Base64.NO_WRAP)
  private fun decode(value: String, limit: Int = 262144): ByteArray {
    require(value.length in 4..limit && value.length % 4 == 0) { "Invalid encrypted payload" }
    val result = Base64.decode(value, Base64.NO_WRAP)
    require(b64(result) == value) { "Invalid base64" }
    return result
  }
  override fun definition() = ModuleDefinition {
    Name("WhisperSignal")
    Constants("protocolVersion" to 7, "libsignalVersion" to "0.105.1")
    AsyncFunction("initialize") { id: String -> synchronized(lock) {
      require(UUID.fromString(id).toString() == id) { "Invalid session identifier" }
      current = null
      val identity = IdentityKeyPair.generate()
      val store = InMemorySignalProtocolStore(identity, SecureRandom().nextInt(16380) + 1)
      val pre = ECKeyPair.generate()
      val signed = ECKeyPair.generate()
      val kyber = KEMKeyPair.generate(KEMKeyType.KYBER_1024)
      val signature = identity.privateKey.calculateSignature(signed.publicKey.serialize())
      val kyberSignature = identity.privateKey.calculateSignature(kyber.publicKey.serialize())
      store.storePreKey(1, PreKeyRecord(1, pre))
      store.storeSignedPreKey(1, SignedPreKeyRecord(1, System.currentTimeMillis(), signed, signature))
      store.storeKyberPreKey(1, KyberPreKeyRecord(1, System.currentTimeMillis(), kyber, kyberSignature))
      val result = JSONObject().put("address", id).put("registrationId", store.localRegistrationId)
        .put("identity", b64(identity.publicKey.serialize())).put("preKey", b64(pre.publicKey.serialize()))
        .put("signedPreKey", b64(signed.publicKey.serialize())).put("signature", b64(signature))
        .put("kyberKey", b64(kyber.publicKey.serialize())).put("kyberSignature", b64(kyberSignature)).toString()
      current = State(id, store, SignalProtocolAddress(id, 1))
      result
    } }
    AsyncFunction("establish") { id: String, bundleJson: String, initiator: Boolean -> synchronized(lock) {
      val s = state(id)
      require(s.peer == null && bundleJson.length <= 8192) { "Peer already bound or invalid bundle" }
      val b = JSONObject(bundleJson)
      val name = b.getString("address")
      require(UUID.fromString(name).toString() == name && name != id)
      val registration = b.getInt("registrationId")
      require(registration in 1..16380)
      fun field(key: String) = decode(b.getString(key), 4096)
      val identity = IdentityKey(field("identity"))
      val peer = SignalProtocolAddress(name, 1)
      val bundle = PreKeyBundle(registration, 1, 1, ECPublicKey(field("preKey")),
        1, ECPublicKey(field("signedPreKey")), field("signature"), identity,
        1, KEMPublicKey(field("kyberKey")), field("kyberSignature"))
      // Pin the invite-authenticated identity before accepting any prekey message.
      s.store.saveIdentity(peer, identity)
      if (initiator) SessionBuilder(s.store, peer, s.local).process(bundle)
      s.peer = peer
      s.cipher = SessionCipher(s.store, s.local, peer)
    } }
    AsyncFunction("encrypt") { id: String, plaintext: String -> synchronized(lock) {
      require(plaintext.length <= 180000)
      val input = plaintext.toByteArray(Charsets.UTF_8)
      try {
        require(input.size <= 180000)
        val message = (state(id).cipher ?: error("Peer unavailable")).encrypt(input)
        require(message.type == 2 || message.type == 3)
        b64(byteArrayOf(message.type.toByte()) + message.serialize())
      } finally { input.fill(0) }
    } }
    AsyncFunction("decrypt") { id: String, encoded: String -> synchronized(lock) {
      val packed = decode(encoded)
      var plain: ByteArray? = null
      try {
        require(packed.size in 2..196608)
        val cipher = state(id).cipher ?: error("Peer unavailable")
        val message = packed.copyOfRange(1, packed.size)
        plain = when (packed[0].toInt()) {
          2 -> cipher.decrypt(SignalMessage(message))
          3 -> cipher.decrypt(PreKeySignalMessage(message))
          else -> throw IllegalArgumentException("Unsupported encrypted message")
        }
        require(plain.size <= 180000)
        plain.toString(Charsets.UTF_8)
      } finally { packed.fill(0); plain?.fill(0) }
    } }
    AsyncFunction("destroy") { id: String -> synchronized(lock) { if (current?.id == id) current = null } }
    OnDestroy { synchronized(lock) { current = null } }
  }
}
