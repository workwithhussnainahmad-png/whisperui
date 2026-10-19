> Phase 4X update: six-character join codes are lookup IDs only. New sessions use
> libsignal with public bundle envelopes; authenticate a contact by comparing safety
> codes over a trusted channel. Random one-to-one chat is enabled with unverified-peer
> notices and bilateral media consent; public groups remain disabled. Earlier secret-
> invite-only statements below describe the superseded design. Disabling vault lock
> now permanently erases Saved Files after authentication and typed DELETE confirmation.
> See PHASE4X_REPORT.md and PRIVACY_POLICY.md for implementation, retention and limits.

# Security policy

> Phase 1 saved-file update: [PRIVATE_VAULT_PHASE1.md](PRIVATE_VAULT_PHASE1.md)
> supersedes attachment-export descriptions below. Save now persists encrypted
> files privately; invite QR sharing is unchanged. Native device verification
> remains pending.


Current source status (October 18, 2026): protocol 7, mandatory secret invites,
native libsignal messaging, and encrypted ephemeral attachment caching. See
[protocol and release gates](SECURITY_PROTOCOL.md) for the design and
[hardening results](SECURITY_HARDENING.md) for validation. These changes are local
source changes, not a deployed or independently audited security guarantee.

## Reporting

Use GitHub private vulnerability reporting for this repository. Never attach
production secrets, signing keys, private conversations, or real user data.

## Security boundaries

- Updated native builds and a protocol 7 relay are required together. Missing or
  mismatched native encryption bridges fail closed; Expo Go cannot chat.
- The mobile client requires secret invites and disables random/public groups.
  Keep `ALLOW_UNVERIFIED_CHATS=false` on the backend.
- libsignal owns ephemeral session agreement and message ratcheting. Whisper's
  invite authentication, native integration and lifecycle require independent
  review. Protocol keys and text conversations are held in memory.
- Completed attachment caches contain authenticated ciphertext with ephemeral
  per-file keys. Camera, preparation, explicit preview and export can still use
  private temporary plaintext files. Cleanup is not forensic erasure. Explicit
  exported copies remain outside the chat lifecycle.
- Images/videos require a tap to preview. Native JPEG/PNG image validation caps
  dimensions at 8192 per axis and 16 million pixels. File transfers are limited
  to 64 MiB per file and 256 MiB per direction per chat, with a 64 MiB storage
  reserve, two concurrent transfers and four chunks in flight.
- Production networking requires HTTPS. Direct connections expose IP, timing
  and traffic volume to infrastructure; native Tor transport is unfinished.
  `EXPO_PUBLIC_SERVER_URL` selects the HTTPS origin at build time.
- Authenticated peer receipts distinguish relay acceptance from peer receipt.
  Peer liveness expires after a provisional 35 seconds without an authenticated
  response; network partitions prevent instantaneous remote shutdown.

Android secure windows/overlay restrictions and the iOS privacy cover require
installed-build verification. iOS screenshot prevention for arbitrary UI is not
an Apple-supported guarantee. Saving permission is independent in each direction
and never disables capture protection. Certificate pinning and platform
attestation require production lifecycle controls and credentials; placeholder
pins or unverified tokens must not be enabled.

## Build and release status

Local automated tests exercise the real pinned libsignal Node/Rust library,
encrypted cache and client/relay exchange. Android/iOS JavaScript exports pass.
Neither result compiles or verifies the Kotlin/Swift bridges. Native builds,
cross-platform device tests, cache/network inspection and independent security
review remain release requirements.

EAS generates native projects from Expo config because `.easignore` excludes
`android/` and `ios/`. Keep changes in config plugins as well as retained local
Android sources. The manual native-build workflow provides compile checks
without publishing; it has not been run remotely.

libsignal is AGPL-3.0-only and unsupported upstream for third-party use. Whisper
has not been relicensed. Resolve licensing/source obligations before distribution.
Remaining upstream dependency advisories are recorded in SECURITY_HARDENING.md;
the audit gate must remain enabled. No application can promise immunity from
every attack.
