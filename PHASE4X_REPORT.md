# Phase 4X implementation record

## Part 1 ? UI and cancellation
- Root cause confirmed against installed React Native 0.86: StyleSheet.absoluteFillObject no longer exists. Spreading undefined removed absolute positioning from camera, attachment viewer, vault picker, and privacy/security overlays. Replaced with supported absoluteFill. SafeAreaProvider and screen flex already existed; they were not missing.
- Camera lacked safe-area handling; attach sheet ignored navigation inset. Added both. Camera uses measured available area and window orientation to size its live preview, with review Send, Retake and Discard actions.
- Cancel was only in a scrollable bubble. Added a persistent transfer row above composer for checking/sending, with no button during finishing. Authentication checking now yields after each chunk so UI cancellation can execute promptly.
- Saved Files list explicitly flexes; controls wrap rather than overflow narrow widths.
- Received chat attachments remain independent of vault authentication (AttachmentViewer checks message.vaultId only).
- Verification: 84 mobile tests passed; Babel compiled components/screens. Existing tests cover cancellation, unchanged vault, and recipient abort behavior.
- Visual verification outstanding: no emulator used. Check 360x640, 411x891, tablet/landscape, font scale 1.3, gesture/3-button navigation, keyboard open; camera live/review, received image/video/PDF/file viewer, Saved Files controls/list, attach sheet, transfer Cancel. Source layout inspection is not a screenshot/device test.

## Part 2 ? destructive lock disable
- Authenticated access is forced before showing a typed DELETE confirmation. Cancellation changes no vault files or protection policy; background/timeout invalidates confirmation.
- Disabling no longer re-wraps a surviving master key. Native setLock rejects false. Enabling migration remains unchanged.
- Android noBackupFilesDir and iOS Application Support contain a protected pending-wipe marker. It is synchronized before deleting keys/files, retained on errors, and consumed only after completion. Startup/access resumes deletion.
- Tests: 86 mobile tests pass. Auth cancellation, confirmation cancellation, completion, empty key/files state, and saving again are covered through service/controller adapters. Native process-kill recovery is implemented but not executed on a device or native simulator here.

## Part 3 ? short lookup codes
- Previous code combined an 80-bit server routing locator with a client-generated 256-bit secret that authenticated public key bundles. It could not safely be truncated.
- New code is six CSPRNG characters and is ONLY a lookup ID. Bundle envelope in lookup mode uses a public room-derived key solely for wire-format compatibility; confidentiality is provided by libsignal, and peer authentication requires out-of-band safety-code comparison. UI no longer claims the join code verifies a peer. Legacy long codes are rejected by join UI/server.
- Alphabet: 23456789ABCDEFGHJKMNPQRSTUVWXYZ_. Excluding 0/O/1/I/L leaves only 31 alphanumeric symbols, so underscore is the 32nd symbol. Display ABC-DEF; accept case, spaces/dash, and whisperchat://join/ABC-DEF.
- Single use, default ten minutes (INVITE_TTL_MS configurable). Limits apply before parsing: 5 attempts/connection, 10/source IP (IPv6 /64), 1000 globally per minute. All attempts count, a stricter cap than failures alone; exhausted buckets lock out until window expiry. No codes logged.
- 87 mobile tests, 19 backend tests and two-client invite integration passed. Added normalization, alphabet, collision exhaustion, expiry/single-use, limiter-window and lookup-mode libsignal tests.

## Part 4 ? random one-to-one restore
- Git history identifies mobile commit 0e9f5e3 as the hardcoded ALLOW_UNVERIFIED_CHATS=false change. Security notes and e2e/socket guards required a high-entropy secret invite. The random queue code remained on the backend but default feature gates disabled access; this was a deliberate authentication restriction, not missing matchmaking code.
- Restored random button/queue and lookup-mode libsignal session; groups remain hard-disabled. Queue cancels, times out after two minutes, and prevents self/double claims. Added Block / Skip and Next random chat; reports transmit only explicitly chosen categories.
- Media opt-in is enforced in encrypted service paths before vault reads and before received chunks, not just by disabling buttons. Both participants must opt in; permission resets at chat end. Existing hidden-until-tapped image bubbles and sender saving policy apply. Safety fingerprint is visible with an unverified-peer label.
- Volatile block source-pair HMAC labels last 30 minutes (sweep within one minute), survive reconnect, and are capped at 10000. Shared-network collateral and network-change evasion are documented in PRIVACY_POLICY.md. No transcript/media collection for reports; only aggregate category counters.
- Verification: 87 mobile tests and 2 real-libsignal/two-client integrations pass for both lookup invite and random matching, exact media bytes, Saved Files transfer, cancellation/tampering and lock abort. 21 backend tests pass including queue cancel/timeout, self/double match prevention, reconnect block and room cleanup.

## Part 5 ? release size
- Measured app source assets: 319,298 bytes; none are oversized. All runtime dependencies found in use (including PDF/Office/QR helpers and native capture/picker/vault modules) were retained. Removed 18 unused bundled font families by importing Ionicons directly.
- Release defaults to arm64-v8a only; optional preview-universal selects arm64-v8a + armeabi-v7a. x86/x86_64 are absent from release profiles; development retains x86_64 for emulators.
- expo-build-properties enables R8 minification, resource shrinking and PNG crunching; app config explicitly selects Hermes. Added keep rules for org.signal.libsignal.**, com.whisper.privacy.**, ExpoModulesPackageList and subclasses of Expo Module. React Native/Hermes consumer JNI keep rules remain provided upstream.
- withReleasePackaging excludes desktop libsignal .so resources separately from Android JNI, and excludes test-only libsignal_jni_testing.so. Existing desktop DLL/dylib exclusions remain. Source: https://github.com/signalapp/libsignal/blob/v0.105.1/README.md and java/client/build.gradle (desktop resources), java/android/build.gradle (Android libraries).
- eas preview builds APK, production builds AAB; preview-universal is an optional two-ARM-ABI APK profile.

Measured byte counts (Hermes production exports, not APK sizes):

| Item | Before | After |
|---|---:|---:|
| Android Hermes bundle | 4,871,925 | 4,536,308 |
| iOS Hermes bundle | 4,868,069 | 4,531,771 |
| Android exported assets | 4,192,171 | 505,055 |
| iOS exported assets | 4,193,176 | 506,060 |
| Font bytes (either platform) | 4,076,840 | 389,724 |
| Font families | 19 | 1 |
| arm64 APK | No artifact supplied | Not built here |
| Universal APK | User reports 200+ MB; not independently measured | Not built here |

The 50 MB / 100 MB targets are unverified. No APK/AAB, JDK, Android SDK or Gradle cache is present. Attempts to download the pinned Signal Maven artifacts for native contributor measurements failed with TLS connection resets in both Python and curl. Therefore native .so-per-ABI and dex sizes cannot honestly be provided. This is not evidence the target is unreachable.

Fresh Android prebuild succeeded in an isolated temporary project. Parsed generated manifest/XML/gradle.properties/proguard/build.gradle confirm ARM-only release, both shrinkers, Hermes, keep rules, desktop/test exclusions, unchanged deny-all backup rules and QR-only providers. Both Android and iOS production JS/Hermes exports succeeded. 89 mobile tests pass after this part.

# Final report (A-H)

## A. Findings
See the five implementation sections above for exact causes and evidence. The principal UI regression was removal of absoluteFillObject in installed React Native. Cancel was inside a scrolling bubble and preflight yielded only every eight chunks. Short codes required removing the secret-invite binding from new sessions, not truncating its entropy. Git commit 0e9f5e3 disabled random chat deliberately with the secret-invite-only policy.

## B. Files changed/created, grouped by part
Paths are relative to whisperui unless prefixed whisper/.

1. src/components/{AttachmentViewer,ChatCamera,MediaPickerButton,SafetyVerifyOverlay,VaultAttachmentPicker}.js; src/screens/{ChatScreen,GroupChatScreen,SavedFilesScreen}.js; src/services/privateVaultStore.js; test/layoutCompatibility.test.cjs. GroupChatScreen received only the compatibility replacement; group access was not restored.
2. modules/whisper-privacy/android/src/main/java/com/whisper/privacy/WhisperVaultModule.kt; modules/whisper-privacy/ios/WhisperVaultModule.swift; src/services/{vaultLock,privateVault}.js; src/screens/SavedFilesScreen.js; test/{vaultLock,privateVault}.test.cjs; test/integration/protocol.test.cjs; PRIVATE_VAULT_PHASE4.md.
3. src/services/{joinCode,socket,e2e}.js; src/screens/{HomeScreen,ChatScreen}.js; test/e2e.test.cjs; whisper/{invites,inviteRateLimiter,handlers}.js; whisper/.env.example; whisper/test/{joinCodes,security}.test.js; whisper/SECURITY.md.
4. src/config.js; src/services/socket.js; src/screens/{HomeScreen,WaitingScreen,ChatScreen,ChatEndedScreen}.js; test/integration/protocol.test.cjs; PRIVACY_POLICY.md; SECURITY.md; SECURITY_PROTOCOL.md; SECURITY_HARDENING.md; whisper/{handlers,matchmaking}.js; whisper/test/{randomChat,security,transport}.test.js; whisper/SECURITY.md.
5. app.config.js; eas.json; src/components/Icon.js; plugins/withReleasePackaging.js; test/releaseConfig.test.cjs. PHASE4X_REPORT.md records all parts.

The previously present Android directory-validation/ABI corrections in WhisperVaultModule.kt were preserved and included with Part 2 because the new durable-wipe code uses them. Other pre-existing desugaring changes in android/app/build.gradle, modules/whisper-privacy/android/build.gradle and plugins/withSignal.js, plus test/vaultDirectoryHandling.test.cjs, remain in the working tree; they were not discarded or silently rewritten.

## C. Requirement-by-requirement status
Done below means implemented and checked with the stated source/automated evidence, not certified on a phone. Visual/native limitations are explicitly partial.

| Requirement | Status | Evidence / limitation |
|---|---|---|
| 1.1 Root causes | done | Installed StyleSheetExports.js lacks absoluteFillObject; source corrections and compatibility regression test. |
| 1.2 Responsive layouts | partial | Safe areas, flex, measured camera preview, responsive composer cap, scrollable DELETE confirmation; no native visual matrix. |
| 1.3 Camera and review | partial | ChatCamera live sizing, safe controls, Send/Retake/Discard implemented; sensor crop/rotation and playback need device checks. |
| 1.4 Received viewer | partial | Overlay repaired; received fileUri uses chat-cache lease without vault authentication; image/video/document rendering not device-tested here. |
| 1.5 Saved Files layout | partial | Explicit list flex, wrapping controls, header/empty/delete/lock paths; no visual device proof. |
| 1.6 Cancel | done | Persistent composer transfer row, per-chunk yields; existing/new integration checks recipient gets no cancelled attachment and vault unchanged. Finishing has no cancel. |
| 1.7 Screen matrix | partial | Source reviewed for 360x640, 411x891, tablet/landscape, font 1.3, navigation insets and keyboard; none rendered in emulator/device here. |
| 2 Authentication and typed confirmation | done | vaultLock.disable forces fresh authentication before confirmation; typed DELETE; cancel tests preserve files/policy. |
| 2 Remove disable re-wrap | done | JS configure(false) and both native setLock(false) paths reject; enable migration kept. |
| 2 Crash-safe wipe | partial | Synchronized pending marker and native recovery implemented; OS process-kill/fsync failure testing unavailable without native toolchain/device. |
| 2 Strings/docs | done | Destructive warning and Phase 4 documentation updated. |
| 2 Tests | partial | Auth/confirm cancellation, zero files/keys and saving again pass through adapters; actual native interrupted-wipe test not run. |
| 3.1 Code role | done | New socket session setup passes null secret binding; room-only public bundle envelope; libsignal and safety comparison provide security. |
| 3.2 CSPRNG/format | done | Six crypto.randomBytes bytes mapped uniformly to 32 symbols; ABC-DEF, case/spacing tests. |
| 3.3 Expiry/single use | done | INVITE_TTL_MS default 600000; atomic consume, expiry tests, uniform wrong/expired error. |
| 3.4 Abuse limits | done | Connection/source/global limits before parsing, window lockout; limiter tests. All attempts count, stricter than failures-only. |
| 3.5 UI/QR/deep links/docs | done | Shared formatter feeds QR and UI; initial/live whisperchat://join/ links populate join input; old long codes rejected; source/bundle tests. OS deep-link launch still needs device check. |
| 3.6 Tests | done | Alphabet, collision exhaustion/recovery, expiry, single use, normalization, limiter windows and two-client join pass. |
| 4.1 Removal reason | done | Git history plus secret-invite-only guard evidence above. |
| 4.2 Random E2E | done | Same libsignal/session/media/vault paths; independent real-libsignal integration for random matching. |
| 4.3 Queue | done | Cancel epoch guard, two-minute timeout, duplicate/self checks; backend tests. |
| 4.4 Privacy/retention | done | RAM-only state; explicit TTLs and source-block tradeoffs in PRIVACY_POLICY.md. |
| 4.5 Safety number | done | Chat displays safety code and unverified status; relay misdirection documented. |
| 4.6 Abuse controls | done | Block / Skip ends chat; Next random chat on ended screen; explicitly selected category-only Report; queue limits; stranger notice. |
| 4.7 Stranger defaults | done | Both service-side consents required before reads/sends/receive chunks; hidden attachment cards; sender saving permission retained; integration checks unilateral consent cannot send. |
| 4.8 End cleanup | done | Existing finishChat/resetE2E clears session/chat media; separate vault; integration/room teardown tests. |
| 4.9 Small-screen UI | partial | Reuses repaired layouts; device visual proof unavailable. |
| 4.10 Tests | done | Backend queue/cancel/timeout/self/double/block/cleanup and shared limiter tests; two-client message/file/vault integration. |
| 4.11 Docs | done | Privacy policy and backend/mobile security notes updated. |
| 5.1 Measure contributors | partial | Actual JS/assets/fonts measured above; no APK/dex/native binaries available and Maven download failed. |
| 5.2 ABIs | done | Fresh generated gradle.properties and config tests verify arm64 release, optional two-ARM universal. |
| 5.3 R8/shrinking | partial | Generated flags/keep rules verified; native release compilation and runtime not run. |
| 5.4 Hermes/minification | done | Production Expo exports generate .hbc for both platforms; generated hermesEnabled=true. |
| 5.5 Remove unused assets/dependencies | done | 18 font families removed; all app runtime dependencies found in use retained. Source assets total only 319298 bytes. |
| 5.6 EAS profiles | done | APK preview and AAB production plus optional ARM universal profile tested. |
| 5.7 Before/after APK | partial | No APK artifacts/toolchain; only measured export sizes supplied. Neither APK target is claimed met. |

## D. Verification
- Latest full mobile suite: 89 passed, 0 failed/skipped.
- Latest full backend suite: 21 passed, 0 failed/skipped.
- Two-client integration: 2 passed (invite and random), including real libsignal plus actual backend; device filesystem/OS adapters are mocked.
- Fresh isolated Android prebuild: passed. Generated backup/provider XML, manifest references, ABI/Hermes/shrinker flags and JNI rules parsed and checked.
- Android and iOS production Hermes exports: passed, including the final UI/controller refinements (.codex-final-verified).
- Babel UI/service syntax and git diff whitespace checks passed.
- Mobile baseline was 84 tests at the beginning of this task. Added overlay, lookup crypto/normalization, destructive-disable and release-config coverage; two obsolete preserve-on-disable migration tests were replaced because that behavior is now forbidden. Backend grew from 17 to 21 tests; the legacy group functionality test now asserts groups remain disabled.
- An initial test still required secret-only encryption and failed after intentional lookup redesign; replaced with real-libsignal lookup-mode coverage, then passed. A new test initially supplied the wrong helper room argument; corrected and passed. An old mock left lock timers running after removal of disable migration; added explicit teardown and passed. No unresolved automated failure is being hidden.

## E. Size results
See measured table above. Android bundle + exported assets reduced from 9,064,096 to 5,041,363 bytes before final small UI refinements (4,022,733 bytes reduction). These are uncompressed export totals, not compressed APK savings. arm64 <50 MB and universal <100 MB remain unverified, not declared impossible.

## F. Not verified
No emulator/device visuals, native Android/iOS compilation, R8 runtime smoke test, native sensor preview/capture aspect consistency, OS Keychain/Keystore wipe recovery, or actual APK size measurement was possible here. Check Home/join input, QR share modal, QR scanner, Waiting, Chat with keyboard, transfer row, camera live/review, received image/video/PDF/unsupported-file viewer, Saved Files locked/unlocked/list/empty/error states, DELETE confirmation with keyboard, safety comparison overlay and ChatEnded/Next on a phone. Backup config was not changed; installed merged-manifest and backup/provider behavior still require the existing Phase 3 device checklist.

## G. Decisions and risks
- Used underscore as the 32nd alphabet symbol because excluding 0/O/1/I/L leaves only 31 alphanumeric choices.
- Join codes no longer authenticate peers. Code chats require safety comparison; random peers are explicitly unverified. A malicious relay can substitute peers without trusted comparison.
- Block/Skip is a 30-minute source-hash-pair block, not a permanent account ban. Shared-IP collateral and network-change evasion are inherent to this choice.
- Reports send only a category and increment aggregate counters; no undisclosed content submission or moderation inbox.
- Release default is ARM64; the separate universal profile includes ARM32 for users who need it. Development keeps x86_64 for emulators.
- Existing private preview temp behavior remains; Phase 5 was not started. No vault file format/secretbox changes or backup-config changes were made.
- Native pending-wipe recovery is fail-closed on IO errors but needs process-kill device testing. Back up no vault material as a workaround; use disposable test files for destructive checks.

## H. Two-device manual checklist
1. Build/install fresh native preview APKs and update backend together. Old long invitations are incompatible. Use disposable vault files for destructive tests.
2. At 360x640 and 411x891 (or nearest real sizes), font scale 1.3, gesture and three-button navigation, keyboard shown/hidden, and tablet/landscape: inspect every screen listed in F for visible, tappable controls and unclipped content.
3. Code chat: create ABC-DEF, enter lowercase/spaces/dash, scan/import/share QR and open whisperchat://join/ABC-DEF. Compare safety codes over a trusted channel. Wrong/expired/reused/old long codes must fail; repeat guesses until lockout, then retry after its window.
4. Capture photo/video on front/back cameras. Compare live framing to review, test Retake/Discard/Send, rotation, close/back, received playback and PDFs. Lock Saved Files and verify received chat attachments still open without vault authentication.
5. Save, restart, list/view/delete in vault. Start a large vault send; cancel during checking and during progress. Recipient must get no attachment and sender vault remains unchanged. Finishing must have no cancel button and may complete normally.
6. Enable lock with existing files and verify they survive. Disable: cancel OS auth; retry/authenticate then cancel DELETE; verify files unchanged. Authenticate/type DELETE/confirm: vault empty, lock off, new saves work. Force-stop during deletion, reopen, confirm empty usable vault. Repeat with locked Reset Whisper. OS key deletion and marker recovery need native debugger/inspection for strong proof.
7. Random Chat on A: cancel waiting, retry and wait for timeout. Pair A/B, compare displayed safety codes and exchange text. Attempt ordinary/vault files before consent: blocked. Enable on one side: still blocked. Enable both: send image/video/PDF and saved file; compare original bytes, allow saving on sender, and save on receiver.
8. Block / Skip: chat ends, Next searches anew; the blocked source pair must not rematch for 30 minutes. With both devices behind one IP, collateral blocking is expected; use another network or wait to test a new permitted match. Report a selected category; both chats end, with no message/media upload.
9. End/reconnect repeatedly and verify old chat media/keys are unavailable while vault files remain. Verify no public group entry works.
10. Build preview and preview-universal release APKs plus production AAB. Measure actual file bytes (50 MB/100 MB targets). Inspect ZIP contents: no x86/x86_64, desktop DLL/dylib/root libsignal .so, or test JNI libraries; required ARM libsignal/Hermes libraries present. Smoke-test libsignal text/files, camera, picker, QR share, vault, lock, reset and random chat with R8 enabled. Re-run the Phase 3 backup/FileProvider checklist on these APKs.

Final review follow-ups: media consent becomes receive-ready before sending its announcement, avoiding a peer-response race. Cancelling DELETE locks the vault again without changing files/policy or automatically prompting again. Confirmed disable does not auto-list/recreate a master/index; the empty vault is initialized when subsequently used. DELETE confirmation is keyboard-aware and scrollable; composer height cap is window-relative. 89 mobile tests pass after these fixes; both integrations passed after the consent change.
