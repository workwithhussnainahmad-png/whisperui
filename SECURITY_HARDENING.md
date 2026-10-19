> Phase 4X update: six-character join codes are lookup IDs only. New sessions use
> libsignal with public bundle envelopes; authenticate a contact by comparing safety
> codes over a trusted channel. Random one-to-one chat is enabled with unverified-peer
> notices and bilateral media consent; public groups remain disabled. Earlier secret-
> invite-only statements below describe the superseded design. Disabling vault lock
> now permanently erases Saved Files after authentication and typed DELETE confirmation.
> See PHASE4X_REPORT.md and PRIVACY_POLICY.md for implementation, retention and limits.

# Security hardening — October 18, 2026

> Phase 1 saved-file update: [PRIVATE_VAULT_PHASE1.md](PRIVATE_VAULT_PHASE1.md)
> supersedes attachment-export descriptions below. Save now persists encrypted
> files privately; invite QR sharing is unchanged. Native device verification
> remains pending.


Implemented locally. No app publication or backend deployment performed.

Protocol 7 and encrypted caching supersede the earlier protocol 6 implementation.
See [SECURITY_PROTOCOL.md](SECURITY_PROTOCOL.md) for the design, dependency pins,
licensing decision and native/device release gates.

## Implemented

- Private invites are mandatory in the protocol 7 client. Environment flags
  cannot re-enable random/public chat. Keep backend `ALLOW_UNVERIFIED_CHATS=false`.
- Native libsignal integration replaces the retained-root custom message cipher.
  Invite-authenticated bundles, mutual confirmation, native private keys and
  ratcheting messages require new installed builds and a protocol 7 backend.
- Completed media caches now use authenticated encryption with memory-only
  per-file keys. Preparation, opened previews and exports still need temporary
  plaintext; cleanup is not a forensic-erasure guarantee.
- Each attachment is limited to 64 MiB; received and sent media have separate
  256 MiB budgets per chat. Incomplete receiver reservations are released on
  failure; completed transfers count until teardown. A 64 MiB storage reserve
  reduces disk exhaustion risk. Failed sender attempts also consume its budget.
- Image/video bubbles no longer decode media automatically in either direction. Image
  previews require a native JPEG/PNG header check, dimensions at most 8192 on
  each axis, and at most 16 million pixels. iOS also rejects multi-frame images.
  Native parser vulnerabilities still require OS updates and device review.
- Native iOS attachment protection applies complete file protection and backup
  exclusion to app-owned temporary paths. An installed old bridge fails closed
  for protected storage/preview. Expo Go does not verify these native controls.
- Android release tasks reject missing credentials and the normal debug
  keystore/alias. The same guard is injected into EAS-generated projects.
  EAS may provide managed release credentials. Local builds can set
  `WHISPER_RELEASE_STORE_FILE`, `WHISPER_RELEASE_STORE_PASSWORD`,
  `WHISPER_RELEASE_KEY_ALIAS`, and `WHISPER_RELEASE_KEY_PASSWORD`; keep secrets
  outside the repository. Inspect the final APK/AAB signer before distribution.
- Chat inputs disable autocorrect, spellcheck and autofill. A malicious keyboard
  or compromised device can still observe plaintext.
- Updated compatible dependencies, including fflate, shell-quote, PostCSS,
  navigation/query parsing and browser build metadata. No framework downgrade.

## Validation and coordinated release

Verified locally: backend 17 tests, mobile 35 tests, and the real client/backend
integration test. Production Android and iOS JavaScript bundles exported with
Expo (without Hermes bytecode). This is JavaScript bundling, not a native build.

Run `npm test` and `npm run test:integration` with sibling `../whisper` installed.
The integration test uses the actual client socket/encryption modules and real
backend, including chunked attachments and encrypted acknowledgements; hardware
APIs and the loopback server URL are substituted; libsignal uses its official
Node bindings, and the encrypted cache uses an in-memory filesystem.
Set `WHISPER_BACKEND_DIR` to use another backend checkout.

The manually triggered `Client and relay integration` workflow accepts a backend
commit/branch. A private backend repository needs a read-only
`WHISPER_BACKEND_READ_TOKEN` GitHub secret; public checkout needs no extra token.
Coordinate both repository revisions before release. Existing security audit
gates remain enabled and are expected to fail while upstream findings remain.

Current runtime dependency audit: 18 high affected entries, zero critical or
moderate, reduced from 27 (including one critical). The remaining graph entries
derive from two advisories in build dependencies: braces <=3.0.3 and node-forge
<=1.4.0. The registry currently offers no patched releases of those packages.
Do not use the audit's suggested framework downgrades or pretend these findings
are fixed. Isolate CI/build inputs and update when reviewed fixes are published.

## Not solved by this change

- Native compilation/device interoperability and an independent review of the
  libsignal integration and invite wrapper remain required. Upstream's AGPL
  licensing must be resolved before distribution; no project license changed.
- Temporary plaintext processing/preview/export files still exist. Completed
  cache encryption does not certify crash/picker/player cache behavior or
  forensic deletion. Native/runtime memory clearing is not independently verified.
- Direct HTTPS exposes connection IP/timing metadata. Native Tor and the onion
  service are not implemented. Optional public groups remain server-readable.
- These changes do not defeat malicious recipients, compromised devices,
  malicious keyboards, external cameras or compromised signing infrastructure.

Native builds and physical Android/iOS tests are required for signing, image
validation, file protection, capture controls, export and crash cleanup. This
Windows workspace has no Android SDK/JDK or iOS build toolchain available.
