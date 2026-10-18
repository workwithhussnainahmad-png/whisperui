# Phase 2: send from Saved Files

Implemented locally. Installed native builds and two physical devices still
require verification; the development workspace has no native build toolchain.
No biometrics, preview-hardening or external-share feature was added.

## Step 0

- New saved files use authenticated record format 2: chunk index (uint32),
  plaintext length (uint32), final marker (one byte), then plaintext. All are
  inside NaCl secretbox. Readers check record order, final marker, total size
  and exact ciphertext size. Format-1 files remain readable, protected by their
  authenticated index/length and encrypted-index total size; they are not rewritten.
- Android Keystore already defaulted to no authentication. Its builder now
  explicitly sets `setUserAuthenticationRequired(false)` and
  `setInvalidatedByBiometricEnrollment(false)`. Physical-device enrollment,
  passcode-change and lock/unlock behavior is not certified by Node tests.
- A retained iOS Keychain master with a missing/empty vault already initializes
  a clean encrypted index. A regression test now covers that reinstall case.
- App startup already calls `initializeAttachmentFiles`, removing abandoned
  preview files under the chat cache. It never cleans persistent vault storage.
  The existing restart-cleanup test covers this boundary.

## Send path

`MediaPickerButton` -> `VaultAttachmentPicker` -> `ChatScreen.sendSavedFile` ->
`socket.sendVaultFile` -> `privateVault.openVaultSend` ->
`privateVaultStore.openForSend` -> `socket.sendMedia`.

The picker lists name, MIME, size and date, including empty/error/retry states.
It stays inside the protected chat window. Android back closes it. Selection
creates an outgoing bubble with checking/sending/finishing status and Cancel.

The reader authenticates the entire file before network transmission, then
reopens it and authenticates each bounded chunk again while sending. It returns
decrypted bytes in memory only. No cache/preview file, OS picker or share sheet
is involved. Saved bytes and metadata are reused without another conversion;
normal transport MIME/name checks, 64 MiB file limit, 256 MiB per-chat send budget,
two-transfer limit and four-chunk window remain enforced. Existing sender saving
permission applies; enable it if the recipient should save into their vault.

The sender checks connection, verified encryption and chat epoch before opening
the source, throughout sends and before completion. The backend continues to
enforce peer routing/presence. A read lease prevents deleting that vault item;
closing/cancelling releases it, and reset invalidates all active readers.

## Recipient publication and compatibility

Vault sends negotiate support through an encrypted `media-policy` capability
request/reply before media is sent. Older peers do not reply and receive no vault
chunks; the sender gets an update-required error. Both peers should run this
phase's client. The protocol-7 relay remains unchanged and sees opaque ciphertext.

Vault chunks set `commitRequired`. The receiver writes only to its existing
encrypted chat cache and does not publish an attachment until an authenticated
`media-complete` request arrives after all chunk acknowledgements. It checks
total bytes, seals the cache and returns `media-complete-ack`. Only then does
the sender report success. Normal non-vault transfers keep their existing path.

Cancel is offered during checking/transmission. Once the completion request is
issued, the UI says Finishing and removes Cancel: publication is irreversible.
Cancellation/error sends an authenticated abort and waits for cleanup acknowledgement.
Cancelled IDs reject late chunks. If disconnected, chat teardown or the bounded
idle timeout removes unfinished receiver caches. A lost completion acknowledgement
is reported as uncertain delivery; a complete valid file may already be present.

The outgoing bubble refers to the saved item for its existing in-app viewer.
Deleting the saved item after sending can make that outgoing preview unavailable;
it does not affect the recipient's independently received copy. Viewing remains
Phase 1 behavior and may create a temporary private plaintext preview.

## Verification

Unit tests cover format-1 compatibility, final-marker checks, byte and whole-record
truncation, reordering/duplication, restart, send-reader exact bytes/no writes,
cancelled reads, deletion locks, reset and staged receiver completion/abort.
The two-client integration uses real mobile service code, the real relay and
official libsignal bindings, with platform storage adapters. It sends from A's
persistent vault to B, saves into B's vault and compares SHA-256. It checks no
sender cache files, unchanged source vault bytes, cancellation, deletion attempts,
preflight corruption and corruption/deletion after preflight. No filenames,
keys or plaintext are logged by the added implementation.

## Two-device checklist

1. Install current native builds on A/B. Test Android-to-iOS and the reverse.
2. Save files into A's vault, leave chat and restart A to confirm persistence.
3. Establish/verify an invite chat. Open Attach -> Saved Files. Check empty state
   on a fresh vault, then name/type/size/date and single selection on A.
4. Enable saving for A's outgoing media. Send image, supported video and PDF/file.
   Check progress, normal chat bubbles, exact original hashes and B's Save action.
5. Restart B and reopen its saved copy. Confirm Files/Photos/Gallery/Downloads
   have no new exported copy. Inspect A's cache: sending must create no preview.
6. Cancel a large transfer before Finishing. B must not display a partial file;
   A's vault stays unchanged and the file can be sent again.
7. Disconnect/leave during checking and sending. Confirm visible failure and
   receiver cleanup. Final-ack loss may report uncertain delivery of a valid file.
8. Using disposable debug data, truncate/tamper with a vault file before Send,
   then mutate/delete a later record during a large send. B must publish no file.
9. Attempt deletion via test tooling while sending: expect a busy error. After
   cancel/completion it should succeed. Test reset invalidating a running reader.
10. Test an older peer: capability negotiation must fail before vault chunks.
11. Change Android lock-screen/biometric settings; confirm the vault key remains
    usable. Test iOS reinstall with retained Keychain key and missing vault.
12. Kill the app during a preview, restart, and inspect preview cleanup while
    confirming that saved vault files survive.
