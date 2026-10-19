# Media and UI update

- ChatBubble: automatic image previews and paused video previews using private attachment leases. No video autoplay; tap opens the existing viewer. Vault-only messages retain authenticated tap-to-open rather than automatically prompting or bypassing vault lock.
- ChatScreen / socket: cancellation controllers cover ordinary attachments as well as Saved Files. Ordinary cancellable sends use the existing capability/commit handshake. Cancel removes staged recipient data; the final commit cannot be cancelled. Bubble progress uses a circular meter with an X control; the duplicate composer cancel row has been removed.
- ChatCamera: icon controls, recording timer, photo shutter/red video record/stop, 720p HD capture at a requested 2.5 Mbps, no photo-size setting in video mode, guarded microphone permission transition, visible permission/capture failures. Recording requires real-device verification; no claim of device validation.
- SavedFilesScreen: private collection header, security card, file-type icons, formatted sizes, date, delete icons, empty state. Existing locking/reset/deletion behavior preserved.
- HomeScreen: QR join bottom sheet with camera and photo choices, safe-area spacing, close control, and iOS dismissal before presenting another native picker.
- Privacy policy updated for automatic previews. Backup configuration and vault encryption unchanged.

## Verification
89 mobile tests passed. Both two-client integration tests passed, including ordinary attachment exact-byte delivery through the commit handshake and cancel-before-publication cleanup. Android and iOS production JavaScript exports passed. No phone/emulator render or native camera test was available.

## Device checks
1. Send photo/video/file in private and random chats (both peers must enable media in random chat). Confirm automatic images, paused videos, tap-to-open, and readable small-screen cards.
2. Send a large attachment; cancel using its circular X. Recipient must receive no attachment. Confirm cancellation disappears during Finishing.
3. Camera: first deny then grant microphone permission; switch photo/video, record/stop, review, retake, discard and send. Test front/back cameras and background/return. Confirm no capture is exported to Gallery/Photos.
4. Saved Files: list/empty state, open/delete, lock/unlock and destructive disable confirmation. Vault-only chat cards must still require authentication when locked.
5. Join with QR: dismiss by backdrop/back/X, scan by camera, import from Photos on Android/iOS, and test large text and bottom safe areas.

Changes are local source; install/run an updated app to see them. Existing unrelated native build changes were preserved.

## Camera lifecycle and transfer follow-up
The installed Android camera implementation calls unbindAll during native view cleanup. Replacing the view on every mode/lens change can interfere with a replacement camera's binding. ChatCamera now changes props on one mounted view instead, rejects stale asynchronous photo-size/readiness results, and ignores repeated Stop presses. This is a source-identified lifecycle risk, not a device-confirmed diagnosis of every black-screen failure. Video stabilization is disabled for compatibility; new camera recordings request 720p/2.5 Mbps to reduce encoder load and upload size. Existing picked/vault files are not recompressed by these changes.

The sender previously waited for all four chunks in a batch. It now refills a sliding window as the earliest acknowledgements arrive, while keeping at most four indices ahead of the first unacknowledged chunk. UI progress updates only when the displayed percentage or stage changes. No encryption, integrity, cancellation, or backend rate limits were removed. No numerical speedup is claimed without device/network measurements.

102 mobile tests and both two-client integrations passed. New scheduler tests cover early refill, out-of-order acknowledgements, and failure draining. Test a 10-second front/back recording, repeated photo/video switches, rapid Stop taps, retake, playback and send on the affected device. Compare transfer duration for the same existing file on the same network; new camera files will also be smaller. If recording still fails, the dialog now includes a safe native error code when available, rather than discarding it.

## Follow-up: composer, consent and defaults
- Attachment preparation now reports its own state to ChatScreen. The indicator appears above the composer and is removed in the preparation cleanup path; it no longer changes the + button layout. External-picker lifecycle tracking remains separate.
- Random media consent uses a styled card with icon buttons and clear enabled/waiting states. Both peers still opt in before media exchange.
- Allow downloads starts enabled in both UI and transport state for each new chat. It still means saving privately in Whisper, and can be disabled for subsequent attachments.
- Camera photo capture requests shutterSound=false. No app-added video recording sound is used; recorded microphone audio is preserved. Device-enforced capture sounds require physical-device verification and cannot be guaranteed silent by this setting.
- Both repositories use six-character codes from 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ. Backend uses crypto.randomInt(36), avoiding modulo bias. UI displays the six characters without punctuation; pasted spaces/dashes remain accepted as formatting. Underscores are rejected. Update backend and app together; already-issued underscore codes are incompatible with this validator.
- Verification: 23 backend tests, 89 mobile tests, and both two-client integrations passed. Tests cover all 36 characters, rejection of underscores, and default saving permission on received attachments.
- Device checks: prepare/cancel/send attachments in both chat modes and confirm the composer stays aligned; try both media-consent states; confirm downloads default on and switching off applies to new files; check camera sound with device silent mode on/off; create/join/scan codes containing 0, 1, I, L, and O.

## HD follow-up (standard copy first)
- Camera records 1080p at 6 Mbps. Photos and videos (camera and gallery) send a standard copy first: 720p video at 2 Mbps (native Media3 Transformer on Android, AVAssetExportPreset1280x720 on iOS) or a 1600 px JPEG at quality 0.8. Small originals (under about 1.5 MB photo / 4 MB video, or already at most 720p) send once, unchanged.
- With the composer HD toggle on (default), the full-quality original follows as a second encrypted transfer whose descriptor carries `replaces: <standard message id>`. It always uses the commit handshake. The receiver swaps the bubble file in place and deletes the standard copy. If the standard copy was saved to Saved Files and the vault is unlocked, the HD file replaces it there; when locked, the chat asks the user to save again (no surprise unlock prompt).
- Receivers advertise `mediaUpgrade: true` in the capability reply. Senders never transmit an HD replacement to older peers (rejected before any chunk is sent).
- HD uploads run one at a time and only start when no ordinary send is active. A second ordinary send cancels the HD upload in flight and requeues it from the start. Chat end drops pending HD uploads; the receiver keeps the standard copy.
- Originals over 64 MiB now still send as the standard copy.
- Requires a new native build (new `transcodeVideo` in WhisperAttachments; Android adds media3-transformer/effect 1.9.0, matching expo-video). Older native builds fall back to sending the original once.
- Verification: 102 unit tests and both two-client integrations pass, including standard-then-HD delivery with exact bytes. Native code was not compiled locally (no Android SDK/Xcode on this machine).

## Capture quality, Chat Ended, memory
- Grain fixes: expo-camera patched for Android `CAPTURE_MODE_MAXIMIZE_QUALITY` + JPEG 97, iOS photo quality prioritization `.quality`. Applied via `patch-package` (`patches/expo-camera+57.0.6.patch`, `postinstall`). Camera photos use `skipProcessing` so the sensor JPEG is not decoded/recompressed. Full JPEG attachments strip metadata without a second ImageManipulator pass. Video capture bitrate 12 Mbps @ 1080p; standard preview copy ~3.5 Mbps.
- ChatEndedScreen: clearer reason card, Saved Files reminder, primary/ghost actions, loading state.
- Memory: chat list no longer mounts a video decoder per bubble (tap opens viewer); FlatList window/batch limits; pause PrivateVideo on unmount; fewer retained messages.
- Still requires a new native EAS build for the camera patch and transformer bitrate change.
