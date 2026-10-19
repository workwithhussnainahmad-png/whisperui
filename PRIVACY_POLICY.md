# Privacy Policy
Last updated: October 19, 2026

Whisper ("we", "our", or "us") respects your privacy and is committed to protecting it. This Privacy Policy explains how Whisper handles information when you use our mobile application (the "App") and related chat relay service.

By using the App, you agree to this Privacy Policy.

---

## Important Disclaimer

Whisper is provided on an "as is" and "as available" basis for anonymous, ephemeral communication. **In any case, the developer, owner, and operators of Whisper are not responsible or liable for:**

- Any content you or others send, receive, share, or view through the App
- Misuse of the App by you or any third party
- Loss of messages, media, invite codes, or chat sessions
- Harm, damage, disputes, or legal consequences arising from chats or shared media
- Security incidents, interception, or disclosure caused by device compromise, peer misconduct, network issues, or factors outside our reasonable control
- Any decision you make based on information exchanged through the App

You use Whisper entirely at your own risk. You are solely responsible for how you use the App and for any content you transmit.

---

## Information We Collect

### Personal Information

Whisper does not require account registration and does not collect personally identifiable information such as name, email address, phone number, or payment details.

### Anonymous Session Data

When you connect to the chat service, the server may temporarily assign an anonymous session identifier and keep short-lived technical state needed to operate the App, such as:

- Matchmaking / waiting-queue status
- Active chat room pairing
- Six-character single-use join lookup IDs (ten minutes by default)
- Connection and rate-limit counters (for abuse prevention)

This data is ephemeral. It is not used to build user profiles, and it is not retained as chat history after the session ends.

### Messages and Media

Code-based and random one-to-one chats encrypt messages and attachments with native libsignal. Join codes only locate a waiting peer and are not encryption/authentication secrets. Compare the safety code by a trusted call or in person to verify a contact. Random peers are unverified: a malicious relay could misdirect pairing or substitute peer identities unless you compare fingerprints through a trusted channel. Public group chat is disabled.

Random chat is anonymous and uses no account. Files and Saved Files sending start disabled until both participants opt in for that chat. Images display inline previews once received; videos display paused previews and play only when opened. Temporary private preview files are released when the preview unmounts or chat is hidden. Saving requires sender permission. Ending a chat clears session keys and chat-cache media; saved vault files remain until you delete/reset them.

Waiting entries expire after two minutes, or are removed on cancellation/match/disconnect. Room pairing and relayed public-key state are removed on chat end. Anonymous connection/session state lasts until disconnect or the existing 30-minute session limit. Rate-limit buckets last their configured windows (normally one to five minutes) and are swept every minute. Block/Skip and Report retain only a pair of process-secret HMAC network-source labels for 30 minutes, swept within another minute; no raw IP is stored in these application records. This can affect other people on the same public IP/IPv6 prefix and can be evaded by changing network. These labels and blocks disappear on server restart. They are not persistent device identifiers.

Reports send only the category you select (spam, abuse, or other); no transcript, media or filename is included. The relay ends the chat and temporarily blocks the source pair. Category totals may appear in aggregate security logs; there is no content-review inbox. Hosting log retention is controlled separately by the operator.

The app connects directly over HTTPS. The server and its hosting/network providers can observe the connection IP address, timing, and traffic volume. Whisper does not currently route connections through Tor.

Text conversations and messaging keys are held in memory. Completed chat attachment caches use temporary per-file encryption keys and are cleared with the chat. Files you explicitly save remain encrypted in Whisper's private vault after the chat ends or the app restarts. Vault keys use Android Keystore or non-synchronizing, device-only iOS Keychain protection. The vault is excluded from backups; losing its master key makes saved files inaccessible. You can view or delete files in Saved Files, or erase the entire vault and key with Reset Whisper. Disabling Lock Saved Files authenticates first and requires typing DELETE, then permanently erases all saved files and keys.

Attachment saving no longer exports to Files, Gallery, Downloads, Photos or other apps. Invite QR sharing remains an explicit external share action. Media preparation and opened previews can still require private temporary plaintext files; cleanup runs on close, chat teardown and startup, but is not a forensic-erasure guarantee. Previously exported external copies are not removed by this update.

- Message content is not readable by us under normal operation of the E2E design.
- Undelivered or ended chats are not kept as history.
- Closing the App, leaving a chat, or ending a session removes access to that conversation from the App's in-memory state.

### Device Permissions

Depending on features you use, the App may request access to:

- **Camera** — to take photos for chat or scan invite QR codes
- **Photos / media library** — to select images, videos, or files to send in chat
- **Documents / files** — to attach files in chat

These permissions are used only to provide the feature you requested. Whisper does not upload your full photo library or device files. Only content you choose to send in a chat is processed for that chat.

Whisper requests microphone permission when recording audio as part of a video.

### Contacts

Whisper does not access, upload, or store your device contacts.

### Usage Data and Analytics

Whisper is designed not to collect personal analytics profiles. We do not sell user data. Basic operational logs (for example, server errors needed to keep the service running) may exist temporarily for reliability and abuse prevention, without identifying you as a named individual.

---

## How We Use Information

Information is used solely to:

- Provide core App functionality (anonymous matching, invite joining, encrypted message relay)
- Prevent abuse (rate limiting, connection limits)
- Maintain service availability and security
- Fix critical operational issues

We do not use your chat content for advertising, profiling, or marketing.

---

## Data Storage and Security

- Whisper does not create user accounts or permanent chat archives.
- Encryption keys and active chat content are handled in memory on your device for the duration of the session and are not designed to persist across app reinstalls or new sessions.
- The relay service is designed for ephemeral operation and does not provide message history recovery.
- Invite codes may include a client-side secret that is not sent to the server; you should share invite codes only with people you trust.
- Screenshot or screen-recording alerts shown in chat are peer-reported claims and are not guaranteed proof.
- We do not sell, rent, or share your personal information with third parties for their marketing.

No security measure is perfect. You acknowledge that absolute privacy or security cannot be guaranteed in all circumstances, and the developer is not responsible for any failure of privacy or security beyond what is reasonably within our control.

---

## Third-Party Services

Whisper's chat features rely on our own relay infrastructure (and, where used for scaling, ephemeral infrastructure such as Redis). We do not share chat content with advertising networks.

App distribution platforms (such as Google Play or the Apple App Store) and your device operating system may process their own data under their respective privacy policies. That processing is outside Whisper's control.

---

## User Control

You have control over your use of Whisper:

- You can leave a chat or close the App at any time.
- You can deny or revoke camera, photo, or file permissions in your device settings.
- Because Whisper does not keep permanent accounts or message history, there is no stored chat profile to download or delete from our servers after a session ends.
- Uninstalling the App removes the App and its local in-app state from your device.

---

## Children's Privacy

Whisper is not intended for children under the age of 13. We do not knowingly collect personal information from children. If you believe a child has used the App in a way that concerns you, stop use of the App and contact us using the email below.

---

## Your Responsibilities

By using Whisper, you agree that:

- You will not use the App for illegal, harmful, abusive, or unauthorized purposes
- You are solely responsible for the content you send and the people you chat with
- You understand chats are ephemeral and may be lost at any time
- The developer is not responsible for user-generated content, peer behavior, or outcomes of any conversation

---

## Changes to This Policy

We may update this Privacy Policy from time to time. Any changes will be reflected within the App, on the app listing, or in the project documentation. Continued use of the App after changes means you accept the updated Policy.

---

## Contact Us

If you have any questions or concerns about this Privacy Policy, please contact us at:

Email: workwithhussnainahmad@gmail.com
