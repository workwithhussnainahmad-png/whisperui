> Phase 4X update: six-character join codes are lookup IDs only. New sessions use
> libsignal with public bundle envelopes; authenticate a contact by comparing safety
> codes over a trusted channel. Random one-to-one chat is enabled with unverified-peer
> notices and bilateral media consent; public groups remain disabled. Earlier secret-
> invite-only statements below describe the superseded design. Disabling vault lock
> now permanently erases Saved Files after authentication and typed DELETE confirmation.
> See PHASE4X_REPORT.md and PRIVACY_POLICY.md for implementation, retention and limits.

# Protocol 7 and encrypted attachment storage

> Phase 1 saved-file update: [PRIVATE_VAULT_PHASE1.md](PRIVATE_VAULT_PHASE1.md)
> supersedes attachment-export descriptions below. Save now persists encrypted
> files privately; invite QR sharing is unchanged. Native device verification
> remains pending.


Implemented in source, not deployed or approved for production release. This
document describes the design and remaining verification; it is not an audit.

## Messaging

- `WhisperSignal` bridges pinned official **libsignal 0.105.1** on Android and
  iOS. It uses libsignal's PQXDH prekey setup and ratcheting message encryption,
  rather than the old JavaScript retained-root message-key construction.
- A fresh identity, one-time prekey, signed prekey, Kyber prekey, registration
  identifier, and random address are created per chat. No protocol state is
  persisted. Reconnection ends the old chat instead of restoring its keys.
- The existing 256-bit client-only invite secret authenticates the public
  bundle exchange. NaCl secretbox encrypts a versioned, room-bound bundle using
  a domain-separated SHA-512 derivation from that high-entropy secret. The relay
  receives only the locator and encrypted bundle, never the full invite.
- Both peers pin the authenticated identity in their libsignal store. The
  lexicographically smaller serialized identity initiates the session. The
  first libsignal message and the responder's reply confirm both identities
  and the room. Application data is forbidden before mutual confirmation.
- Safety codes bind both encrypted bundles and the room. Secret possession
  establishes invite authentication, not a person's real-world identity.
- Each application envelope authenticates protocol version, room, sequence,
  message identifier and body. Messages, media descriptors, chunk indices,
  counts, receipts and control events all pass through libsignal. There is no
  separate plaintext thumbnail or filename upload.
- The relay only accepts protocol 7 bundles (16 KiB encoded maximum) and
  confirmation messages (16 KiB encoded maximum). Ciphertexts retain the
  192 KiB decoded limit. The first ciphertext byte identifies libsignal's
  prekey (3) or regular (2) message representation; both bridges reject others.
- Native operations are serialized. The JavaScript bridge queue is bounded;
  epoch checks and native session identifiers prevent stale operations from
  mutating a replacement chat. Private protocol keys never cross the bridge.
- Native stores are released on teardown; managed runtimes and native library
  allocation behavior do not permit a claim of verified immediate RAM erasure.
- Missing/mismatched native bridges fail closed. **Expo Go and older installed
  builds cannot chat.** There is no downgrade or old-protocol fallback.

The invite wrapper, native bridges and lifecycle are Whisper-specific and need
independent review even though the protocol implementation is upstream libsignal.
Do not describe the whole application as audited or unbreakable.

## Attachments

Completed outgoing and incoming attachment caches contain authenticated
ciphertext under independently generated per-file 256-bit keys held only in
JavaScript memory. The cache uses NaCl XSalsa20-Poly1305 secretbox, random
192-bit nonces per record, and bounded 96 KiB records. Encrypted record indices
and lengths, plus an in-memory index and expected file length, detect changes,
reordering, substitution and truncation. Cache metadata and keys are never
written to disk. Completed files are immutable; reads require sealing.

Receiving writes directly to this encrypted cache. Sending reads/decrypts bounded
chunks; it does not materialize a second complete plaintext file. Conversation
objects contain cache references rather than inline base64 attachments. The old
inline-media receive path is rejected.

Local preparation still needs plaintext in the camera, picker, image processor
and native remuxer. Images/videos open only on tap. Native image/video viewers
and explicit exports use temporary plaintext leases, removed when released,
when the chat ends, and at startup after an interrupted run. Documents up to
3 MB can be read directly into memory without a plaintext preview file.
Known Expo Camera/ImagePicker/ImageManipulator/DocumentPicker scratch folders
are cleaned before new picks after startup. Do not claim zero plaintext ever
touches device storage or forensic deletion. Verify OS/player caches on devices.

64 MiB per file, 256 MiB per direction per chat, two concurrent transfers, four
chunks in flight and a 64 MiB disk reserve remain enforced. Encryption overhead
also counts toward free-space checks. Explicit exported copies are outside the
ephemeral cache lifecycle.

## Dependency and build pins

- Android: `org.signal:libsignal-client` and `libsignal-android` 0.105.1 from
  Signal's Maven repository. Use JDK 21 for native builds.
- iOS: upstream commit `1738ead8a12ffe539f6309958123dadb16dc3b95`, tag v0.105.1.
  The prebuilt FFI archive is verified against upstream SHA-256
  `338a98c2a6a11e48b5666de4b89d0877757f474a06be968f8568bf783a45b823`.
- Expo's `withSignal` plugin applies the pod pin, archive checksum and Android
  repository to generated projects. iOS uses static frameworks and the upstream
  explicit-module workaround.
- Node's `@signalapp/libsignal-client` is **test-only**, pinned to the same
  version. It is not imported into mobile bundles or deployed on the backend.
- Upstream explicitly does not support use outside Signal; Whisper must track
  API changes and maintain these bridges. See [upstream README](https://github.com/signalapp/libsignal/tree/v0.105.1).
- libsignal is AGPL-3.0-only. The project has **not been relicensed**. Distribution
  is blocked until its owner resolves compatible licensing/source obligations
  or replaces this dependency with an appropriately licensed implementation.

## Verification and release gates

Local verification uses the real pinned libsignal Node/Rust implementation, not
a fake cipher. Unit tests cover invite/room mismatch, key substitution,
reflection, tampering, replay, reordered messages, confirmation gating, teardown,
and missing bridges. Cache tests cover on-disk ciphertext, random access,
record/file substitution, truncation, write failure, key cleanup, preview leases,
teardown during copying and startup cleanup. The client/relay integration covers
two-way chunked media through libsignal and the encrypted cache.

Android/iOS production **JavaScript exports** pass; this is not native compilation.
The manually triggered `Native security builds` workflow prepares native compile
checks without production credentials. It has not been run remotely.

Before release:

1. Build both native bridges; run Android-to-iOS and iOS-to-Android invite,
   confirmation, text and media exchanges on installed builds.
2. Check late handshake events, app background/foreground, cancellation, crash
   recovery, concurrent transfers, low disk space and permitted export.
3. Inspect device files/backups, player/image caches and release network traffic.
   Confirm no readable media, invite secrets or keys reach logging/analytics.
4. Review the integration, cache framing and protocol lifecycle independently.
5. Resolve licensing and remaining dependency advisories; audit gates stay on.
6. Coordinate backend protocol 7 deployment and new signed mobile releases.
   Review real TLS/proxy/firewall settings, host logs, swap/dumps and retention.

No Microsoft content-scanning integration or image-fingerprint evasion is added.
Direct HTTPS still exposes IP, timing and traffic volume to infrastructure.
