# Phase 4: optional device-authenticated vault lock

Implemented in the native key adapters, vault service/store, lifecycle controller,
Saved Files screen, picker and viewer. No file/index format, message protocol,
backup configuration or preview rendering changes. Native builds and real-device
authentication/migration testing remain required; this Windows workspace has no
Android SDK/JDK or Xcode/Swift toolchain.

## Key enforcement and migration

Android: AES-256-GCM wrapping keys use AndroidKeyStore. Enabled keys set
setUserAuthenticationRequired(true). Android 11+ uses a five-second authorization
window with AUTH_BIOMETRIC_STRONG | AUTH_DEVICE_CREDENTIAL. Android 9/10 uses the
five-second validity setting and the system device-credential confirmation screen.
Android 11+ offers biometrics/device credentials and falls back to credential
confirmation for unavailable hardware, enrollment or biometric lockout. The native
masterKey method always requests authentication when lock is enabled; skipping the
application prompt alone cannot authorize the Keystore operation outside the OS
window. A recently successful OS authentication can authorize that five-second
window; this is not a per-use CryptoObject design.

Migration reads the existing master after confirmation, creates a fresh alias,
wraps and verifies the same master, fsyncs a temporary envelope and atomically
renames it to master.key. It syncs the parent before deleting obsolete aliases.
A post-rename failure must not delete a key referenced by the published envelope.
Startup prunes orphan aliases using the committed selector. Legacy 60-byte wrappers
are accepted. Ciphertext files/index and per-file wrapped keys do not change.

iOS: protected master items use SecAccessControl.userPresence with
WhenPasscodeSetThisDeviceOnly, non-synchronizing. This enforces biometrics OR device
passcode in Keychain itself. Fresh LAContexts are invalidated after use. A device
owner confirmation is also required before changing the setting.

The original master Keychain item retains its original accessibility. Initially it
holds the legacy master. Enabling creates and verifies a unique protected item,
then atomically replaces the original item's value with a selector and lock policy.
That one SecItemUpdate removes the unauthenticated master value at the commit point.
Disabling authenticates, reads the protected master, and atomically replaces the
selector with a normal Keychain-protected master record. Old protected items are
removed after commit, or pruned at startup. There is no fallback to an obsolete item
if the selected protected key is unavailable. Reset deletes the entire service.

This corrects the initial Step 0 proposal: do not mutate an existing item's ACL;
Apple documents access-control attributes as add-only. Creating a new protected
item and replacing the selector avoids that unsupported update.

Fingerprint enrollment changes and normal authenticated passcode changes are
intentionally tolerated by these credential-fallback policies. Removing device
security, an OS invalidation or losing the key can make files inaccessible. The
recovery UI offers Retry and Reset Whisper, never a bypass or silent replacement.

## Lifecycle and UI

Lock Saved Files is off by default. Enable/disable warnings explain the consequences.
Foreground unlock-session options: Immediate, 1 minute (default), 5 minutes.
Immediate means the final vault screen/operation closing releases access; it does
not make a screen unreadable immediately after successful authentication. The timed
options expire from successful unlock, even if an operation is still active.
Background/inactive transitions and Lock now lock immediately. System authentication
UI may temporarily change app state while keys are already absent; its result is
discarded if Whisper has not returned to foreground. Android credential results wait
for activity resume; iOS waits for active application state before returning a key.

The service acquires access for list/delete/save/view/send, not only UI navigation.
Saving while locked authenticates before opening the attachment source or writing
vault data. Reset requires no vault authentication. A missing native Phase 4 bridge
fails visibly instead of silently substituting a UI-only prompt.

privateVaultStore.lock zeroes the master and every tracked per-file key, drops the
decrypted index, invalidates pending operations and closes send readers. Late key
responses are zeroed rather than installed. inspectState reports only booleans/counts
for tests; it never returns keys. These are application-owned buffer/reference
guarantees, not proof that managed runtimes, the bridge or OS leave no transient
copies in physical RAM.

Lock closes vault viewers and removes temporary preview leases. Vault sends use
the existing cancellation/abort mechanism. Uncommitted recipient data is discarded;
a send already at the irreversible completion boundary may finish as a complete,
valid attachment. No protocol messages or encryption formats were changed.
Previously sent attachment names remain part of the ordinary chat history; the
vault lock protects access to the saved content, not already-sent chat metadata.

## Automated verification and its limits

- Store tests inspect locked state and zeroed key buffers; reject reads while locked;
  cancel yielding saves, reads and preflight; discard late auth results; wipe locked
  files without accessing the master key.
- Controller tests cover cancelled/failed auth, invalidation/recovery, background,
  manual and timed locks, immediate release, locked reset, and migration interruption
  before/after the native adapter's commit contract in both directions.
- Service tests cover preview cleanup at background lock and cancelled authentication
  before Save, with unchanged vault contents.
- Two-client integration locks A during a vault send and checks B publishes no partial
  attachment and retains no staged cache. Existing exact-byte and vault-save tests pass.
- Native migration crash durability, real biometric lockout/fallback, enrollment
  changes and native compiler correctness are NOT verified by these adapter tests.
  No real OS process-kill migration test has run here.

## Real-device checklist

1. Install updated native Android/iOS builds (not an OTA-only update). Begin with
   files saved by Phase 1/2/3. Record hashes and verify lock is initially off.
2. Enable Lock Saved Files. Check the loss-of-access warning. Cancel authentication:
   the setting must stay off and existing files remain readable. Retry successfully.
3. Unlock using biometrics, then using PIN/pattern/passcode. Test no biometric
   enrollment, hardware unavailable and biometric lockout. Android 9/10 intentionally
   uses device credentials. Cancel/wrong credentials must not reveal a list or file.
4. Test 1-minute and 5-minute foreground expiration, Immediate on screen/operation
   close, Lock now, Home/app switch and screen locking. Reopening must authenticate.
5. Open a vault image/video/document and background. Confirm it closes and its private
   preview is removed. Repeat during a large save and during send preflight/transmission.
   The receiver must show no incomplete file. At Finishing, a complete delivery is valid.
6. Tap Save on received media while locked. Cancel: no new item. Authenticate: save,
   restart, unlock and verify the original bytes.
7. Change/add/remove fingerprints; change PIN/passcode normally. Expected: device
   credential remains usable. If the OS invalidates access, recovery must show Retry
   and Reset, with no fabricated empty vault or alternative key.
8. On disposable data, remove the device PIN/passcode. Expect inability to unlock and
   recovery guidance. Re-adding a PIN does not guarantee restoration of an invalidated
   key. Reset while locked must erase files, index, wrapping keys and Keychain items
   without requiring authentication.
9. Enable and disable repeatedly, verifying hashes and restart persistence. With
   debugger breakpoints kill the process before wrapper/selector commit, immediately
   after commit, and during obsolete-key cleanup. Restart must use either the previous
   or new committed wrapping, never regenerate a key for existing ciphertext. Test
   both directions. Android: also fault parent-directory sync and verify the active
   alias is retained. iOS: check the primary item contains only a selector when enabled;
   no unauthenticated master copy may remain after enabling.
10. Check device logs: no key material, filenames or authentication details beyond
    generic success/failure categories. Verify normal chat, invite QR sharing and
    Phase 3 backup/provider checks still work.

References:
- https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder
- https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/userpresence
- https://developer.apple.com/forums/thread/724013
