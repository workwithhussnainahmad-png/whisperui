import ExpoModulesCore
import Foundation
import Security
import Darwin
import LocalAuthentication
import UIKit

public final class WhisperVaultModule: Module {
  private func failure(_ text: String) -> NSError { NSError(domain: "WhisperVault", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
  private func protect(_ url: URL) throws {
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    var target = url, values = URLResourceValues()
    values.isExcludedFromBackup = true
    try target.setResourceValues(values)
  }
  private func root() throws -> URL {
    try recoverWipe()
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let directory = base.appendingPathComponent("vault", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
    try protect(directory)
    return directory
  }
  private func wipeMarker() throws -> URL {
    try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("vault-wipe.pending")
  }
  private func syncParent(_ url: URL) throws {
    let fd = open(url.path, O_RDONLY)
    guard fd >= 0 else { throw failure("Could not synchronize private vault reset") }
    defer { close(fd) }
    guard fsync(fd) == 0 else { throw failure("Could not synchronize private vault reset") }
  }
  private func recoverWipe() throws {
    stateLock.lock(); defer { stateLock.unlock() }
    let marker = try wipeMarker()
    if !FileManager.default.fileExists(atPath: marker.path) { return }
    var all = query; all.removeValue(forKey: kSecAttrAccount as String)
    let status = SecItemDelete(all as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw failure("Could not erase private vault key. Retry reset.") }
    let directory = marker.deletingLastPathComponent().appendingPathComponent("vault")
    if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    try syncParent(marker.deletingLastPathComponent())
    try FileManager.default.removeItem(at: marker)
    try syncParent(marker.deletingLastPathComponent())
  }
  private func file(_ name: String) throws -> URL {
    guard name == "index.v1" || name.range(of: "^[0-9a-f-]{36}\\.(tmp|box)$", options: .regularExpression) != nil else { throw failure("Invalid vault file") }
    let base = try root().resolvingSymlinksInPath()
    let url = base.appendingPathComponent(name).resolvingSymlinksInPath()
    guard url.deletingLastPathComponent() == base else { throw failure("Invalid vault path") }
    return url
  }
  private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "whisper.private-vault.v1", kSecAttrAccount as String: "master",
    kSecAttrSynchronizable as String: false] }
  private var authContext: LAContext?
  private let stateLock = NSRecursiveLock()
  private var epoch = 0
  private var pendingAccount: String?
  private func itemQuery(_ account: String) -> [String: Any] {
    var q = query; q[kSecAttrAccount as String] = account; return q
  }
  private func primaryData() throws -> Data? {
    var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw failure("Vault authentication unavailable. Unlock your device and retry.") }
    return data
  }
  private func record(_ data: Data) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      value["enabled"] is Bool, let timeout = value["timeout"] as? Int, [0, 60, 300].contains(timeout) else { throw failure("Vault key unavailable. Retry or Reset Whisper.") }
    if value["enabled"] as? Bool == true {
      guard let account = value["account"] as? String, account.hasPrefix("protected.") else { throw failure("Vault key unavailable. Retry or Reset Whisper.") }
    }
    return value
  }
  private func prune(_ account: String?) throws {
    var q = query; q.removeValue(forKey: kSecAttrAccount as String)
    q[kSecReturnAttributes as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitAll
    q[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw failure("Cannot inspect vault key storage. Retry.") }
    for attributes in (result as? [[String: Any]] ?? []) {
      if let name = attributes[kSecAttrAccount as String] as? String, name.hasPrefix("protected."), name != account, name != pendingAccount {
        let removed = SecItemDelete(itemQuery(name) as CFDictionary)
        guard removed == errSecSuccess || removed == errSecItemNotFound else { throw failure("Cannot finish vault key migration. Retry.") }
      }
    }
  }
  private func policy() throws -> [String: Any] {
    try recoverWipe()
    stateLock.lock(); defer { stateLock.unlock() }
    guard var data = try primaryData() else { try prune(nil); return ["enabled": false, "timeout": 60] }
    defer { data.resetBytes(in: 0..<data.count) }
    if data.count == 32 { try prune(nil); return ["enabled": false, "timeout": 60] }
    let value = try record(data)
    try prune(value["account"] as? String)
    return ["enabled": value["enabled"]!, "timeout": value["timeout"]!]
  }
  private func awaitForeground() throws {
    for _ in 0..<20 {
      let active: Bool
      if Thread.isMainThread { active = UIApplication.shared.applicationState == .active }
      else { active = DispatchQueue.main.sync { UIApplication.shared.applicationState == .active } }
      if active { return }
      Thread.sleep(forTimeInterval: 0.05)
    }
    throw failure("Vault authentication cancelled. Return to Whisper and retry.")
  }
  private func context() -> LAContext {
    let context = LAContext()
    context.localizedReason = "Unlock Saved Files in Whisper"
    context.localizedCancelTitle = "Cancel"
    context.touchIDAuthenticationAllowableReuseDuration = 0
    stateLock.lock(); authContext = context; stateLock.unlock()
    return context
  }
  private func readProtected(_ account: String, context: LAContext) throws -> Data {
    var q = itemQuery(account)
    q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    q[kSecUseAuthenticationContext as String] = context
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data, data.count == 32 { return data }
    if status == errSecUserCanceled || status == errSecAuthFailed || status == errSecInteractionNotAllowed {
      throw failure("Vault authentication cancelled or unavailable. Retry with your device passcode.")
    }
    throw failure("Vault key unavailable. Device security changed or the key was lost. Retry or Reset Whisper.")
  }
  private func readMaster(_ create: Bool, context: LAContext, expectedEpoch: Int) throws -> Data {
    if var data = try primaryData() {
      defer { data.resetBytes(in: 0..<data.count) }
      if data.count == 32 { return Data(data) }
      let value = try record(data)
      if value["enabled"] as? Bool == true { return try readProtected(value["account"] as! String, context: context) }
      guard let encoded = value["master"] as? String, let key = Data(base64Encoded: encoded), key.count == 32 else { throw failure("Vault key unavailable. Retry or Reset Whisper.") }
      return key
    }
    guard create else { throw failure("Vault key unavailable. Retry or Reset Whisper.") }
    var data = Data(count: 32)
    let randomStatus = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
    guard randomStatus == errSecSuccess else { throw failure("Cannot generate private vault key") }
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    stateLock.lock(); defer { stateLock.unlock() }
    guard expectedEpoch == epoch else { data.resetBytes(in: 0..<data.count); throw failure("Vault authentication cancelled.") }
    guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { data.resetBytes(in: 0..<data.count); throw failure("Cannot store private vault key") }
    return data
  }
  private func changeLock(_ enabled: Bool, timeout: Int) throws -> [String: Any] {
    guard enabled else { throw failure("Disable lock by confirming permanent vault deletion.") }
    guard [0, 60, 300].contains(timeout) else { throw failure("Invalid vault timeout") }
    stateLock.lock(); let operationEpoch = epoch; stateLock.unlock()
    let context = self.context()
    defer { context.invalidate(); stateLock.lock(); if authContext === context { authContext = nil }; stateLock.unlock() }
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
      throw failure("Set a device passcode before enabling or unlocking Saved Files.")
    }
    // This confirmation is required even when enabling from an unprotected item.
    let done = DispatchSemaphore(value: 0)
    var confirmed = false
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Change Saved Files lock in Whisper") { success, _ in confirmed = success; done.signal() }
    done.wait()
    guard confirmed else { throw failure("Vault authentication cancelled. Saved Files remains locked.") }
    var value = try readMaster(false, context: context, expectedEpoch: operationEpoch)
    defer { value.resetBytes(in: 0..<value.count) }
    var next: [String: Any] = ["enabled": enabled, "timeout": timeout]
    let account = "protected." + UUID().uuidString
    var added = false, committed = false
    defer {
      stateLock.lock(); defer { stateLock.unlock() }
      pendingAccount = nil
      if added && !committed { SecItemDelete(itemQuery(account) as CFDictionary) }
    }
    if enabled {
      guard let acl = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, nil) else { throw failure("Cannot protect private vault key") }
      var item = itemQuery(account)
      item[kSecValueData as String] = value
      item[kSecAttrAccessControl as String] = acl
      stateLock.lock()
      guard operationEpoch == epoch else { stateLock.unlock(); throw failure("Vault authentication cancelled.") }
      pendingAccount = account
      let addStatus = SecItemAdd(item as CFDictionary, nil)
      stateLock.unlock()
      guard addStatus == errSecSuccess else { throw failure("Cannot protect private vault key. Previous protection is unchanged.") }
      added = true
      var verified = try readProtected(account, context: context)
      defer { verified.resetBytes(in: 0..<verified.count) }
      guard verified == value else { throw failure("Vault key verification failed") }
      next["account"] = account
    }
    // Atomic value replacement: enabling removes the old unauthenticated master
    // from the primary item in the same commit that publishes the protected selector.
    var encoded = try JSONSerialization.data(withJSONObject: next)
    defer { encoded.resetBytes(in: 0..<encoded.count) }
    stateLock.lock(); defer { stateLock.unlock() }
    guard operationEpoch == epoch else { throw failure("Vault authentication cancelled.") }
    guard SecItemUpdate(query as CFDictionary, [kSecValueData as String: encoded] as CFDictionary) == errSecSuccess else { throw failure("Vault lock change failed. Previous protection remains in place.") }
    committed = true
    try prune(enabled ? account : nil)
    return ["enabled": enabled, "timeout": timeout]
  }

  public func definition() -> ModuleDefinition {
    Name("WhisperVault")
    Function("list") { () throws -> [String] in try FileManager.default.contentsOfDirectory(atPath: self.root().path) }
    Function("size") { (name: String) throws -> Double in
      let attrs = try FileManager.default.attributesOfItem(atPath: self.file(name).path)
      guard let size = attrs[.size] as? NSNumber else { throw self.failure("Saved file is missing or corrupted") }
      return size.doubleValue
    }
    Function("create") { (name: String) throws -> Bool in
      let url = try self.file(name)
      guard !FileManager.default.fileExists(atPath: url.path), FileManager.default.createFile(atPath: url.path, contents: nil,
        attributes: [.protectionKey: FileProtectionType.complete]) else { throw self.failure("Cannot create private vault file") }
      try self.protect(url); return true
    }
    Function("read") { (name: String, offset: Int, count: Int) throws -> String in
      guard offset >= 0, (0...131072).contains(count) else { throw self.failure("Invalid vault read") }
      let handle = try FileHandle(forReadingFrom: self.file(name)); defer { try? handle.close() }
      try handle.seek(toOffset: UInt64(offset))
      var bytes = Data()
      while bytes.count < count {
        guard let part = try handle.read(upToCount: count - bytes.count), !part.isEmpty else { break }
        bytes.append(part)
      }
      return bytes.base64EncodedString()
    }
    Function("write") { (name: String, offset: Int, value: String) throws -> Bool in
      guard offset >= 0, value.count <= 174764, let bytes = Data(base64Encoded: value), bytes.count <= 131072 else { throw self.failure("Invalid vault write") }
      let handle = try FileHandle(forWritingTo: self.file(name)); defer { try? handle.close() }
      try handle.seek(toOffset: UInt64(offset)); try handle.write(contentsOf: bytes); return true
    }
    Function("commit") { (from: String, to: String) throws -> Bool in
      let source = try self.file(from), destination = try self.file(to)
      let handle = try FileHandle(forWritingTo: source)
      do { try handle.synchronize(); try handle.close() } catch { try? handle.close(); throw error }
      guard rename(source.path, destination.path) == 0 else { throw self.failure("Could not commit private vault file") }
      return true
    }
    Function("remove") { (name: String) throws -> Bool in
      let url = try self.file(name)
      if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
      return true
    }
    AsyncFunction("lockStatus") { try self.policy() }
    Function("cancelAuthentication") {
      self.stateLock.lock(); self.epoch += 1; self.authContext?.invalidate(); self.stateLock.unlock()
    }
    AsyncFunction("setLock") { (enabled: Bool, timeout: Int) throws -> [String: Any] in
      try self.changeLock(enabled, timeout: timeout)
    }
    AsyncFunction("masterKey") { (create: Bool) throws -> String in
      self.stateLock.lock(); let epoch = self.epoch; self.stateLock.unlock()
      let context = self.context()
      defer { context.invalidate(); self.stateLock.lock(); if self.authContext === context { self.authContext = nil }; self.stateLock.unlock() }
      var data = try self.readMaster(create, context: context, expectedEpoch: epoch)
      defer { data.resetBytes(in: 0..<data.count) }
      try self.awaitForeground()
      self.stateLock.lock(); defer { self.stateLock.unlock() }
      guard epoch == self.epoch else { throw self.failure("Vault authentication cancelled. Saved Files remains locked.") }
      return data.base64EncodedString()
    }
    AsyncFunction("wipe") { () throws -> Bool in
      self.stateLock.lock(); defer { self.stateLock.unlock() }
      self.epoch += 1; self.authContext?.invalidate()
      let marker = try self.wipeMarker()
      try Data([1]).write(to: marker, options: [.atomic, .completeFileProtection])
      try self.protect(marker)
      let handle = try FileHandle(forWritingTo: marker)
      do { try handle.synchronize(); try handle.close() } catch { try? handle.close(); throw error }
      try self.syncParent(marker.deletingLastPathComponent())
      try self.recoverWipe()
      return true
    }
  }
}
