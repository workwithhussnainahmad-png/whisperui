# Sharing a copy from Saved Files

Saved Files now has a share icon on each file card. Unlock when required, choose Share, review the conversion disclosure, and select WhatsApp or another installed receiving app in the system share sheet. The encrypted original remains in the vault. No watermark is added.

## Supported export behavior
- Images: JPEG conversion and application metadata stripping. Animation/transparency are lost, as disclosed before export.
- Video/audio: existing native remux removes original container metadata and retains media tracks. Unsupported codecs fail closed. Metadata hidden inside encoded streams is not claimed removed.
- PDF: native page rasterization/rebuilding, up to the existing size/page limits; confirmation explains loss of forms, links, selectable text, attachments and signatures.
- Office: bounded extraction of document text; explicit confirmation of lost formatting/images/comments/macros.
- Plain text: new generic-named file, original text preserved.
- Other formats or failed processing: no external share. No silent fallback to original metadata.

## Implementation
- src/services/vaultExport.js: authentication via acquireVaultPreview, sanitization via prepareAttachment, independent sanitized export, share sheet, foreground-aware Android cleanup and reset invalidation. Source and sanitized staging leases are released before handoff. Vault lock during preparation aborts sharing.
- src/screens/SavedFilesScreen.js: share action, confirmation, busy/error feedback.
- plugins/withPrivateStorage.js: only cache/whisper-share and cache/whisper-vault-share are exposed. Vault/chat cache remain inaccessible. Plugin-generated resources updated in the local Android project; fresh prebuild regenerates them.
- src/services/mediaExport.js: startup removes abandoned external exports along with QR exports.
- src/services/accountReset.js: deletes external exports even when vault/session cleanup fails.
- src/services/cleanupStatus.js: category-only cleanup logging; no file names or content.
- Existing iOS cache protection/exclusion applies to the dedicated export directory and each copy. Backup and document-browser restrictions remain enabled.

The export uses a generic Whisper filename in a random private subdirectory. Android shares are retained while the receiving activity is open and removed after return; startup cleans leftovers if Whisper is killed. iOS cleanup follows share-sheet completion. The receiving app can retain/upload/back up its own copy independently.

## Verification and limits
99 mobile tests and both two-client chat integrations passed. Android and iOS production JavaScript/Hermes exports passed. The actual generated Android provider XML was parsed and confirmed to contain exactly the QR and sanitized-export cache roots.

Automated tests cover the share lifecycle with OS/filesystem/sanitizer adapters mocked, success/failure/cancellation/lock cleanup, refusal of original fallback, reset cleanup and surfaced cleanup failures. Existing real vault/encryption and metadata tests remain enabled. Generated provider XML tests assert only the two allowed cache roots, with vault/chat directories blocked; backup and iOS flags still pass. Native WhatsApp/iOS/Android handoff and per-format output metadata must be checked on devices; JavaScript exports are not a native build.

## Device checklist
1. Build/install the updated native app (Android FileProvider resources changed; Metro reload alone is insufficient on an old installed build).
2. Save a GPS-tagged image, share to WhatsApp, inspect the received JPEG metadata, and confirm the saved original still opens unchanged after restart.
3. Share video/audio and inspect container metadata, playback, orientation, sound, and duration. Try an unsupported codec and confirm no original is shared.
4. Share PDF and Office documents: cancel conversion first, then approve and verify the disclosed output changes. Try an unsupported ZIP; it must show an error without opening a share sheet.
5. Cancel the chooser, complete a WhatsApp send, and stay in the target app before returning. Confirm the target can read the copy and the export directory empties after return.
6. Force-stop during sharing, reopen, and inspect export cleanup. Test Reset Whisper with abandoned exports.
7. Enable vault lock, authenticate to share, then background during preparation: it must abort. Background after handoff: vault locks while the already-authorized external copy remains usable until return.
8. Confirm invite QR sharing still works. Verify FileProvider cannot resolve vault or whisper-chat-media paths.
