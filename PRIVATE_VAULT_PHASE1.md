# Private vault, phase 1

Phase 2 adds in-chat sending and format-2 chunk headers; see
[PRIVATE_VAULT_PHASE2.md](PRIVATE_VAULT_PHASE2.md). Phase 1 preview behavior remains.

Implemented locally; new native builds are required. No deployment performed.
The existing native-build workflow can compile the registered WhisperVault module.
Native compilation and installed-device validation have not run in this Windows
workspace, which has no JDK/Android SDK or Xcode/Swift toolchain.

## User flow

With the sender's saving permission enabled, received attachment Save now calls
`privateVault.saveToVault`. It copies authenticated plaintext chunks directly
from the encrypted chat-cache reader into newly encrypted vault records. Save
does not create a plaintext file or invoke a document picker/share sheet.

Home -> Saved Files lists name, MIME type, byte size and saved date. Tap opens
the existing AttachmentViewer. Delete removes the encrypted payload and its
wrapped key/index entry. Saved files survive chat teardown and restart.
Reset Whisper is the app's anonymous-session logout/account-reset action:
it disconnects the session and erases the whole vault and platform master-key
storage. Ordinary leaving a chat deliberately does not erase saved files.

There is no sending from vault or biometric/PIN feature in this phase. Invite QR
sharing remains unchanged. There is no migration/import of files previously
exported outside Whisper, and this update cannot remove those external copies.

## Storage and crypto

- Android: `context.noBackupFilesDir/vault`. A random master key is wrapped with
  a non-exportable Android Keystore AES-256-GCM key under alias
  `whisper.private-vault.v1`. Only its encrypted representation is in `master.key`.
- iOS: Application Support/vault; directory/files have complete file protection
  and `isExcludedFromBackup=true`. The random master key is a non-synchronizing
  Keychain item under service `whisper.private-vault.v1`, account `master`, with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Both document-sharing plist
  flags are explicitly false. See [Apple accessibility semantics](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly)
  and [Android Keystore parameters](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec).
- File encryption remains NaCl secretbox (XSalsa20-Poly1305), not AES-GCM.
  Each file gets an independent random 32-byte key. Each record gets a freshly
  generated random 24-byte nonce, with authenticated record index and length.
  Random nonce collision probability is negligible; no deterministic nonce reuse.
- Files are named random UUIDs with `.box`; incomplete writes use UUID `.tmp`.
  `index.v1` is secretbox-encrypted under the master key. Original names, MIME,
  size, timestamp and separately secretbox-wrapped file keys exist only inside
  that encrypted index. Structural names and ciphertext lengths are observable.
- File bytes are flushed before an atomic same-directory rename. Atomic index
  replacement is the commit point. Crash orphans are removed when the index is
  reopened; committed files are retained. There is no plaintext master-key file.
- All vault operations serialize through a queue. Reset invalidates in-flight
  operations before erasing keys/files. There is no automatic key replacement
  for an existing vault whose key is missing. Errors are surfaced with Retry and
  Reset available; corrupt bytes are not presented as successful previews.
- Limits: 64 MiB per file, 2,000 entries, encrypted index below 2 MiB, 64 MiB
  free-space reserve. Chunking bounds memory usage for large attachments.

## Preview and deletion boundaries

Phase 1 intentionally uses temporary decrypted image/video/audio preview leases
in the existing private chat-media cache. A lease is returned only after every
record authenticates. Close, background/unmount and failed decryption clean it;
startup removes abandoned previews. Saved ciphertext lives outside that cache.
Small document reads go directly into memory; Android's existing PDF renderer
still uses its existing short-lived private temporary PDF file.

Existing viewer limits remain: JPEG/PNG image validation, supported native media
codecs, and up to 3 MB for PDF/text/Office previews. Unsupported types and larger
documents remain stored privately but show an explicit preview-unavailable
message. No external viewer fallback exists.

Delete atomically removes the wrapped key from the live encrypted index, then
unlinks the encrypted payload. Reset deletes the platform key first, then all
vault files. This is not a guarantee of forensic flash erasure or immediate
runtime-memory zeroization. Cleanup errors are visible and can require retry.

## Automated evidence

`node --test test/privateVault.test.cjs` covers private-path-only writes,
ciphertext/metadata confidentiality, restart reopening, tamper/truncation/append/
record-reordering rejection, missing key, corrupt index, low storage, failed
commit, crash orphan recovery, deletion, logout/reset and reset during Save.
An adapter-level test exercises actual save/list/preview/document/delete code,
including plaintext preview release and cleanup after late authentication failure.
Native storage and secure key APIs are replaced by filesystem/test adapters;
these tests do not certify Keystore/Keychain or OS backup behavior.

## Installed-device checklist

1. Build/install updated Android and iOS apps; Expo Go is insufficient.
2. In an invite chat, enable saving and receive JPEG, MP4, small PDF/text and
   an unsupported binary file. Save each. No OS destination picker/share sheet
   should appear. Check Files/Downloads/Gallery/Photos for newly created copies.
3. Leave the chat, open Home -> Saved Files, verify metadata and view supported
   files. Unsupported files must show a clear message, never open another app.
4. Close previews and background the app during a preview. Inspect private cache
   on a test build for removal. Kill/restart during a preview and check startup
   cleanup. Saved ciphertext must remain.
5. Force-stop and reopen; reboot/unlock and reopen. Saved files must still work.
6. Delete a file, restart, and confirm it stays absent. Inspect the vault directory
   and index with test tooling; payload names must be opaque and contents encrypted.
7. Interrupt a large Save and restart. The vault must contain either a fully
   committed readable item or no item, never a partially valid item.
8. On a disposable test vault, mutate a `.box` or `index.v1`, and separately remove
   its secure key. Expect a visible error, no garbage preview and no key overwrite.
9. Test low storage and locked-device access; errors must leave existing files
   readable after recovery. Retry must work without an app crash.
10. Reset Whisper, confirm the warning, then inspect vault and secure storage;
    restart and confirm an empty vault. Test reset while a long save is pending.
11. Inspect Android backup/device-transfer output and iOS backup/container
    attributes. Confirm no vault content migrates and the Keychain item does not
    synchronize. Verify final iOS plist flags are false.
12. Share an invite QR and confirm its previous external sharing flow still works.
