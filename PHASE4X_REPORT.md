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
