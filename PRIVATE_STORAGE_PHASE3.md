> External sharing update: the user explicitly authorized sanitized copies from Saved Files. The sharing provider now exposes both `cache/whisper-share/` (QR) and `cache/whisper-vault-share/` (sanitized exports), while vault/chat-cache paths remain blocked. See [VAULT_EXTERNAL_SHARING.md](VAULT_EXTERNAL_SHARING.md). Earlier QR-only statements below describe the original Phase 3 scope.

# Phase 3: backup and sharing hardening

## Implementation

`app.config.js` registers `plugins/withPrivateStorage.js`. Every prebuild writes
Android `whisper_backup_rules.xml`, `whisper_extraction_rules.xml`, and three
FileProvider path resources. The manifest disables backup and references both
backup resources. Cloud and device transfer exclude root/file/database/sharedpref/
external plus all four device-protected domains.

The app resource `sharing_provider_paths.xml` overrides Expo Sharing's library
resource and permits only cache/whisper-share/. Expo FileSystem and ImagePicker
provider resources contain no roots. Current library imports and the in-app
camera do not need their export providers; adding external camera/cropping or
getContentUriAsync later requires reviewing this policy.

The iOS plist mod forces UIFileSharingEnabled, LSSupportsOpeningDocumentsInPlace
and UISupportsDocumentBrowser false, removes CFBundleDocumentTypes, and sets the
default data protection entitlement to NSFileProtectionComplete. Native
preparePrivateStorage protects Caches and tmp roots and existing contents using
complete protection and isExcludedFromBackup. New children inherit directory
protection; picker/manipulator outputs and QR files are explicitly protected too.
The existing vault's Application Support protection is unchanged.

`mediaExport.shareInviteQr` awaits startup cleanup, creates a random PNG inside
whisper-share, protects directory/file, checks invite validity, invokes the share
sheet, then deletes the PNG in finally. Startup removes abandoned whisper-share
and legacy whisper-exports directories. Sharing an invite intentionally lets the
selected recipient app retain its own copy.

`cleanupStatus` logs only allowlisted categories and aggregate counts, never
error objects or supplied strings. getCleanupStatus returns a detached in-memory
snapshot: last result, attempts, failures, category counts. Native deferred cleanup
failures also log fixed categories/counts and appear in the debug report. Counts
reset on restart. Failed initialization can be retried.

## Debug self-check

Native debug build: Home -> Privacy self-check. Release JS and native methods both
reject access. Output contains no paths, filenames, keys or content. Android reads
the installed manifest's backup references and runtime allowBackup flag. It checks
the native vault location and attempts FileProvider URI mapping for fixed nonexistent
probe paths; no files are created. Expect fileProvidersBlockPrivateStorage=true
and qrDirectoryShareable=true. iOS reads Bundle Info.plist, verifies the native
vault location and backup marker.

Both report potentialPlaintextTempFiles and cleanup counts. The temp count is
conservative: it includes non-wenc SDK/debug cache files, so nonzero is an inspection
signal, not proof of an attachment leak. A never-used iOS vault may report its backup
marker false because the directory does not exist yet.

## Verification

Automated tests compile the actual plugin into temporary Android projects, parse
generated manifest/XML, check all domains, provider restrictions and repeat-prebuild
stability. Tests also cover plist/config output, protection entitlement, QR sharing
and deletion on success/error, abandoned QR cleanup, logger input redaction and
debug/release gating. QR tests substitute the OS sharing adapter.

A fresh full Android prebuild ran in a disposable project without changing the
existing native tree. The same plugin was then applied to the existing Android
project to generate its manifest/resources. Android/iOS JavaScript exports and the two-client integration
test passed. Native compilation, final merged APK resources, provisioning and real
backups remain device/build checks. Windows Expo refuses iOS prebuild; iOS checks
here use the plist mod output.

## Manual device checklist

Use disposable test content. Build after prebuild: OTA JavaScript cannot apply
manifest, resources, entitlements or native changes.

1. Fresh prebuild in an isolated checkout; build Android and iOS (iOS on Mac).
   Inspect the final merged Android manifest/APK: allowBackup=false and both backup
   XML references. All exclusions must use path=".". The only nonempty provider
   paths resource must expose whisper-share/. Inspect iOS plist and signed protection
   entitlement too.
2. Home -> Privacy self-check: verify flags, location, provider checks and cleanup
   counts. Open Saved Files once before checking the iOS vault backup marker.
   Release builds must not show the entry.
3. Save received media, restart, view/close and send from Saved Files. Test image
   import, document import and the in-app camera.
4. Share a QR to a real target and scan it; repeat with cancellation. The private
   whisper-share directory must be empty after returning. Kill the app while sharing,
   relaunch and verify cleanup. Test iOS lock/unlock and inspect protection/backup
   attributes on picker, manipulator, chat, QR and native temporary directories.
5. Android debug self-check must reject vault/chat/ordinary files for all three
   providers and accept the QR directory only for SharingFileProvider. Verify merged
   resources with APK Analyzer. A separate app without URI permission must fail to
   read provider content.
6. Android backup tests:

   ```sh
   adb shell dumpsys package com.hussnainahmadsahi.chat
   adb shell bmgr enabled
   adb shell bmgr list transports
   adb shell bmgr backupnow com.hussnainahmadsahi.chat
   ```

   Expect ineligible/skipped/no user data (transport wording varies). Inspect
   BackupManager logs. On legacy devices/tools supporting it:

   ```sh
   adb backup -f whisper-test.ab -noapk com.hussnainahmadsahi.chat
   ```

   Inspect the archive using a trusted local tool: no vault/chat/QR/scratch payload.
   Unsupported adb-backup or an empty archive alone does not prove device-transfer
   exclusion. Exercise cloud restore and Android 12+ device migration on disposable
   devices after seeding saved files. Destination must have no saved/chat media.
   Restore transport settings if changed; do not erase an everyday device to test.
7. iOS: create a fresh Finder/iTunes backup and inspect its decrypted Manifest.db
   with a trusted local backup viewer. In app domain
   AppDomain-com.hussnainahmadsahi.chat, no payload should appear under
   Library/Application Support/vault, Library/Caches/whisper-chat-media,
   Library/Caches/whisper-share or tmp. Test iCloud restore and Quick Start to a
   disposable destination too. Whisper must not expose documents in Files or
   Finder/iTunes File Sharing.
8. Inject a cleanup failure using debug tooling or a temporary file-permission fault.
   Check failure counts and device logs: no paths, filenames, error details, invite
   contents or keys may appear.

Platform behavior cannot be certified by configuration alone. Apple's backup
exclusion attribute is guidance to the OS, not an absolute guarantee against every
restore mechanism. Validate supported OS versions and transfer tools.

References:
- https://developer.android.com/identity/data/autobackup
- https://developer.android.com/identity/data/testingbackup
- https://developer.apple.com/documentation/foundation/optimizing-your-app-s-data-for-icloud-backup
