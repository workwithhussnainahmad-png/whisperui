package com.whisper.privacy

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.app.Activity
import android.app.KeyguardManager
import android.hardware.biometrics.BiometricPrompt
import android.hardware.biometrics.BiometricManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import org.json.JSONObject
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class WhisperVaultModule : Module() {
  companion object {
    // Linux fcntl.h O_DIRECTORY flag:
    // ARM32/ARM64 (armeabi, armeabi-v7a, arm64-v8a, aarch64): 040000 octal = 0x4000 (16384)
    // x86/x86_64/generic (x86, i686, x86_64, amd64, riscv64): 0200000 octal = 0x10000 (65536)
    internal const val O_DIRECTORY_ARM = 0x4000
    internal const val O_DIRECTORY_X86 = 0x10000

    internal fun resolveODirectory(primaryAbi: String? = Build.SUPPORTED_ABIS?.firstOrNull() ?: System.getProperty("os.arch")): Int {
      val abi = (primaryAbi ?: "").trim().lowercase()
      return when {
        abi.startsWith("arm") || abi.startsWith("aarch64") -> O_DIRECTORY_ARM
        abi.startsWith("x86") || abi.startsWith("i386") || abi.startsWith("i686") || abi.startsWith("amd64") || abi.startsWith("riscv64") -> O_DIRECTORY_X86
        else -> error("Unsupported device architecture for private vault: $abi")
      }
    }
  }

  private val alias = "whisper.private-vault.v1"
  private val root: File get() {
    synchronized(keyMutex) { recoverWipe() }
    val directory = File(requireNotNull(appContext.reactContext).noBackupFilesDir, "vault")
    check(directory.exists() || directory.mkdirs()) { "Cannot open private vault storage" }
    val path = directory.toPath()
    check(!Files.isSymbolicLink(path)) { "Vault root cannot be a symbolic link" }
    check(Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) { "Vault root is not a directory" }
    return directory
  }
  private fun file(name: String): File {
    require(name == "index.v1" || name == "master.key" || name.matches(Regex("[0-9a-f-]{36}\\.(tmp|box)")))
    val base = root.canonicalFile
    return File(base, name).canonicalFile.also { require(it.parentFile == base) }
  }
  private fun commit(from: String, to: String) {
    RandomAccessFile(file(from), "rw").use { it.fd.sync() }
    Files.move(file(from).toPath(), file(to).toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
  }
  private fun syncDirectory() {
    val path = root.toPath()
    check(!Files.isSymbolicLink(path)) { "Vault root cannot be a symbolic link" }
    check(Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) { "Vault root is not a directory" }
    val flags = android.system.OsConstants.O_RDONLY or
      android.system.OsConstants.O_CLOEXEC or
      android.system.OsConstants.O_NOFOLLOW or
      resolveODirectory()
    val directory = android.system.Os.open(root.path, flags, 0)
    try {
      val stat = android.system.Os.fstat(directory)
      check(android.system.OsConstants.S_ISDIR(stat.st_mode)) { "Vault root is not a directory" }
      check(!android.system.OsConstants.S_ISLNK(stat.st_mode)) { "Vault root cannot be a symbolic link" }
      android.system.Os.fsync(directory)
    } finally {
      android.system.Os.close(directory)
    }
  }
  private fun wipeMarker() = File(requireNotNull(appContext.reactContext).noBackupFilesDir, "vault-wipe.pending")
  private fun syncParent(directory: File) {
    val fd = android.system.Os.open(directory.path, android.system.OsConstants.O_RDONLY or android.system.OsConstants.O_NOFOLLOW or resolveODirectory(), 0)
    try { android.system.Os.fsync(fd) } finally { android.system.Os.close(fd) }
  }
  private fun recoverWipe() {
    val marker = wipeMarker()
    if (!marker.exists()) return
    val directory = File(marker.parentFile, "vault")
    check(!Files.isSymbolicLink(directory.toPath())) { "Vault root cannot be a symbolic link" }
    val store = keys()
    store.aliases().toList().filter { it == alias || it.startsWith(wrapPrefix) }.forEach { store.deleteEntry(it) }
    check(!directory.exists() || directory.deleteRecursively()) { "Could not finish private vault reset. Retry." }
    syncParent(marker.parentFile!!)
    check(marker.delete()) { "Could not finish private vault reset. Retry." }
    syncParent(marker.parentFile!!)
  }
  private val wrapPrefix = "whisper.vault-wrap."
  private var pending: (() -> Unit)? = null
  private var pendingPromise: Promise? = null
  private var cancellation: CancellationSignal? = null
  private var credentialAccepted = false
  private var credentialRequest = -1
  private val keyMutex = Any()
  private val authEpoch = java.util.concurrent.atomic.AtomicInteger(0)
  private val main = Handler(Looper.getMainLooper())
  private fun keys() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  private fun envelope(): JSONObject? {
    val f = file("master.key")
    if (!f.exists() || f.length() == 60L) return null
    val value = JSONObject(f.readText())
    check(value.getInt("v") == 2 && value.getString("alias").startsWith(wrapPrefix)) { "Vault key unavailable" }
    return value
  }
  private fun policy(): Map<String, Any> {
    val e = envelope()
    return mapOf("enabled" to (e?.getBoolean("locked") ?: false), "timeout" to (e?.getInt("timeout") ?: 60))
  }
  private fun pruneKeys() {
    syncDirectory()
    val keep = envelope()?.getString("alias") ?: alias
    val store = keys()
    store.aliases().toList().filter { (it == alias || it.startsWith(wrapPrefix)) && it != keep }.forEach { store.deleteEntry(it) }
  }
  private fun generate(name: String, locked: Boolean): SecretKey {
    val builder = KeyGenParameterSpec.Builder(name, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256).setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(locked)
      .setInvalidatedByBiometricEnrollment(false)
    if (locked) {
      if (Build.VERSION.SDK_INT >= 30) builder.setUserAuthenticationParameters(5, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
      else builder.setUserAuthenticationValidityDurationSeconds(5)
    }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run { init(builder.build()); generateKey() }
  }
  private fun pack(master: ByteArray, key: SecretKey): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    return cipher.iv + cipher.doFinal(master)
  }
  private fun unpack(bytes: ByteArray, key: SecretKey): ByteArray {
    check(bytes.size == 60) { "Vault key unavailable" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
    return cipher.doFinal(bytes.copyOfRange(12, bytes.size))
  }
  private fun master(create: Boolean): ByteArray {
    pruneKeys()
    val wrapped = file("master.key")
    if (!wrapped.exists()) {
      check(create) { "Vault key unavailable" }
      val value = ByteArray(32).also { SecureRandom().nextBytes(it) }
      try {
        val temp = "${java.util.UUID.randomUUID()}.tmp"
        try { file(temp).writeBytes(pack(value, generate(alias, false))); commit(temp, "master.key"); syncDirectory() }
        finally { file(temp).delete() }
        return value.copyOf()
      } finally { value.fill(0) }
    }
    val e = envelope()
    val key = keys().getKey(e?.getString("alias") ?: alias, null) as? SecretKey ?: error("Vault key unavailable")
    return unpack(if (e == null) wrapped.readBytes() else Base64.decode(e.getString("cipher"), Base64.NO_WRAP), key)
  }
  private fun migrate(locked: Boolean, timeout: Int): Map<String, Any> {
    require(locked) { "Disable lock by confirming permanent vault deletion." }
    require(timeout in listOf(0, 60, 300))
    val value = master(false)
    val name = wrapPrefix + java.util.UUID.randomUUID()
    val temp = "${java.util.UUID.randomUUID()}.tmp"
    var committed = false
    try {
      val key = generate(name, locked)
      val packed = pack(value, key)
      val verified = unpack(packed, key)
      try { check(verified.contentEquals(value)) } finally { verified.fill(0) }
      val e = JSONObject().put("v", 2).put("alias", name).put("locked", locked).put("timeout", timeout)
        .put("cipher", Base64.encodeToString(packed, Base64.NO_WRAP))
      file(temp).writeText(e.toString())
      commit(temp, "master.key"); syncDirectory(); committed = true
      pruneKeys()
      return policy()
    } finally {
      value.fill(0); file(temp).delete()
      // Rename may have committed even if the following directory fsync failed.
      // Never delete a wrapping key referenced by the current envelope.
      val referenced = runCatching { envelope()?.getString("alias") == name }.getOrDefault(true)
      if (!committed && !referenced) keys().deleteEntry(name)
    }
  }
  private fun reject(promise: Promise, error: Throwable) {
    val unavailable = error is java.security.UnrecoverableKeyException || error is android.security.keystore.KeyPermanentlyInvalidatedException ||
      error is javax.crypto.AEADBadTagException || error.message == "Vault key unavailable"
    promise.reject(if (unavailable) "E_VAULT_KEY_UNAVAILABLE" else "E_VAULT_AUTH", if (unavailable)
      "Vault key unavailable. Device security changed or the key was lost. Retry or Reset Whisper." else "Vault authentication unavailable. Unlock your device and retry with its PIN, pattern or password.", null)
  }
  private fun finishAuthentication(ok: Boolean) {
    val work = pending; val promise = pendingPromise
    pending = null; pendingPromise = null; cancellation = null; credentialAccepted = false; credentialRequest = -1
    if (ok) work?.invoke() else promise?.reject("E_VAULT_AUTH_CANCELLED", "Vault authentication cancelled. Saved Files remains locked.", null)
  }
  private fun authenticate(promise: Promise, work: () -> Any) {
    val epoch = authEpoch.get()
    main.post {
      if (epoch != authEpoch.get()) { promise.reject("E_VAULT_AUTH_CANCELLED", "Vault authentication cancelled.", null); return@post }
      if (pending != null) { promise.reject("E_VAULT_AUTH", "Vault authentication is already in progress.", null); return@post }
      val activity = appContext.currentActivity
      val manager = activity?.getSystemService(KeyguardManager::class.java)
      if (activity == null || manager?.isDeviceSecure != true) {
        if (runCatching { policy()["enabled"] == true }.getOrDefault(true)) promise.reject("E_VAULT_KEY_UNAVAILABLE", "Vault key unavailable. Device security was removed. Retry or Reset Whisper.", null)
        else promise.reject("E_VAULT_AUTH", "Set a device PIN, pattern or password before enabling Saved Files.", null)
        return@post
      }
      pendingPromise = promise
      pending = { try { synchronized(keyMutex) { check(epoch == authEpoch.get()) { "Vault authentication cancelled" }; promise.resolve(work()) } } catch (e: Throwable) { reject(promise, e) } }
      fun credential() {
        try {
          val intent = manager.createConfirmDeviceCredentialIntent("Unlock Saved Files", "Confirm your device credential for Whisper")
          if (intent == null) finishAuthentication(false) else { credentialRequest = 41781 + epoch % 1000; activity.startActivityForResult(intent, credentialRequest) }
        } catch (_: Throwable) { finishAuthentication(false) }
      }
      if (Build.VERSION.SDK_INT >= 30) {
        cancellation = CancellationSignal()
        try {
          BiometricPrompt.Builder(activity).setTitle("Unlock Saved Files")
            .setSubtitle("Use biometrics or your device credential")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
            .build().authenticate(cancellation!!, activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
              override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                if (epoch == authEpoch.get() && pendingPromise === promise) finishAuthentication(true)
              }
              override fun onAuthenticationError(code: Int, message: CharSequence) {
                if (epoch != authEpoch.get() || pendingPromise !== promise) return
                if (code in listOf(1, 7, 9, 11, 12)) credential() else finishAuthentication(false)
              }
            })
        } catch (_: Throwable) { credential() }
      } else credential()
    }
  }
  override fun definition() = ModuleDefinition {
    Name("WhisperVault")
    Function("list") { root.list()?.toList() ?: error("Cannot list private vault") }
    Function("size") { name: String -> val f = file(name); check(f.isFile) { "Saved file is missing or corrupted" }; f.length().toDouble() }
    Function("create") { name: String -> check(file(name).createNewFile()) { "Vault file already exists" }; true }
    Function("read") { name: String, offset: Int, count: Int ->
      require(offset >= 0 && count in 0..131072)
      RandomAccessFile(file(name), "r").use { input ->
        input.seek(offset.toLong())
        val bytes = ByteArray(minOf(count.toLong(), maxOf(0L, input.length() - offset)).toInt())
        input.readFully(bytes)
        Base64.encodeToString(bytes, Base64.NO_WRAP)
      }
    }
    Function("write") { name: String, offset: Int, value: String ->
      require(offset >= 0 && value.length <= 174764)
      val bytes = Base64.decode(value, Base64.NO_WRAP)
      require(bytes.size <= 131072)
      RandomAccessFile(file(name), "rw").use { output -> output.seek(offset.toLong()); output.write(bytes) }
      true
    }
    Function("commit") { from: String, to: String -> commit(from, to); true }
    Function("remove") { name: String -> val f = file(name); check(!f.exists() || f.delete()) { "Could not delete private vault file. Retry." }; true }
    OnActivityResult { _, result ->
      if (result.requestCode == credentialRequest && pending != null) {
        if (result.resultCode == Activity.RESULT_OK) credentialAccepted = true else finishAuthentication(false)
      }
    }
    OnActivityEntersForeground { if (credentialAccepted) main.post { finishAuthentication(true) } }
    OnActivityDestroys { main.post { cancellation?.cancel(); finishAuthentication(false) } }
    Function("cancelAuthentication") {
      authEpoch.incrementAndGet()
      main.post { cancellation?.cancel(); finishAuthentication(false) }
    }
    AsyncFunction("lockStatus") { synchronized(keyMutex) { pruneKeys(); policy() } }
    AsyncFunction("setLock") { enabled: Boolean, timeout: Int, promise: Promise ->
      authenticate(promise) { migrate(enabled, timeout) }
    }
    AsyncFunction("masterKey") { create: Boolean, promise: Promise ->
      val work = {
        val value = master(create)
        try { Base64.encodeToString(value, Base64.NO_WRAP) } finally { value.fill(0) }
      }
      try { if (policy()["enabled"] == true) authenticate(promise, work) else synchronized(keyMutex) { promise.resolve(work()) } }
      catch (e: Throwable) { reject(promise, e) }
    }
    AsyncFunction("wipe") {
      authEpoch.incrementAndGet()
      synchronized(keyMutex) {
        main.post { cancellation?.cancel(); finishAuthentication(false) }
        val marker = wipeMarker()
        RandomAccessFile(marker, "rw").use { it.write(1); it.fd.sync() }
        syncParent(marker.parentFile!!)
        recoverWipe()
        true
      }
    }
  }
}
