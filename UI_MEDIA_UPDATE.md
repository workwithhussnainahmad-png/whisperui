# Media and UI update

- ChatBubble: automatic image previews and paused video previews using private attachment leases. No video autoplay; tap opens the existing viewer. Vault-only messages retain authenticated tap-to-open rather than automatically prompting or bypassing vault lock.
- ChatScreen / socket: cancellation controllers now cover ordinary attachments as well as Saved Files. Ordinary cancellable sends use the existing capability/commit handshake. Cancel removes staged recipient data; the final commit cannot be cancelled. Persistent composer controls remain visible when the bubble scrolls away. Bubble progress uses a circular meter with an X control.
- ChatCamera: icon controls, photo shutter/red video record/stop, 1080p capture, no photo-size setting in video mode, guarded microphone permission transition, visible permission/capture failures. Recording requires real-device verification; no claim of device validation.
- SavedFilesScreen: private collection header, security card, file-type icons, formatted sizes, date, delete icons, empty state. Existing locking/reset/deletion behavior preserved.
- HomeScreen: QR join bottom sheet with camera and photo choices, safe-area spacing, close control, and iOS dismissal before presenting another native picker.
- Privacy policy updated for automatic previews. Backup configuration and vault encryption unchanged.

## Verification
89 mobile tests passed. Both two-client integration tests passed, including ordinary attachment exact-byte delivery through the commit handshake and cancel-before-publication cleanup. Android and iOS production JavaScript exports passed. No phone/emulator render or native camera test was available.

## Device checks
1. Send photo/video/file in private and random chats (both peers must enable media in random chat). Confirm automatic images, paused videos, tap-to-open, and readable small-screen cards.
2. Send a large attachment; cancel using its circular X and the persistent composer Cancel send control. Recipient must receive no attachment. Confirm cancellation disappears during Finishing.
3. Camera: first deny then grant microphone permission; switch photo/video, record/stop, review, retake, discard and send. Test front/back cameras and background/return. Confirm no capture is exported to Gallery/Photos.
4. Saved Files: list/empty state, open/delete, lock/unlock and destructive disable confirmation. Vault-only chat cards must still require authentication when locked.
5. Join with QR: dismiss by backdrop/back/X, scan by camera, import from Photos on Android/iOS, and test large text and bottom safe areas.

Changes are local source; install/run an updated app to see them. Existing unrelated native build changes were preserved.

## Follow-up: composer, consent and defaults
- Attachment preparation now reports its own state to ChatScreen. The indicator appears above the composer and is removed in the preparation cleanup path; it no longer changes the + button layout. External-picker lifecycle tracking remains separate.
- Random media consent uses a styled card with icon buttons and clear enabled/waiting states. Both peers still opt in before media exchange.
- Allow downloads starts enabled in both UI and transport state for each new chat. It still means saving privately in Whisper, and can be disabled for subsequent attachments.
- Camera photo capture requests shutterSound=false. No app-added video recording sound is used; recorded microphone audio is preserved. Device-enforced capture sounds require physical-device verification and cannot be guaranteed silent by this setting.
- Both repositories use six-character codes from 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ. Backend uses crypto.randomInt(36), avoiding modulo bias. UI displays the six characters without punctuation; pasted spaces/dashes remain accepted as formatting. Underscores are rejected. Update backend and app together; already-issued underscore codes are incompatible with this validator.
- Verification: 23 backend tests, 89 mobile tests, and both two-client integrations passed. Tests cover all 36 characters, rejection of underscores, and default saving permission on received attachments.
- Device checks: prepare/cancel/send attachments in both chat modes and confirm the composer stays aligned; try both media-consent states; confirm downloads default on and switching off applies to new files; check camera sound with device silent mode on/off; create/join/scan codes containing 0, 1, I, L, and O.
