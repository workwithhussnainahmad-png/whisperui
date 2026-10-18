# Privacy Policy
Last updated: October 18, 2026

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
- Invite routing locators (not the full invite secret)
- Connection and rate-limit counters (for abuse prevention)

This data is ephemeral. It is not used to build user profiles, and it is not retained as chat history after the session ends.

### Messages and Media

Private invite chats encrypt messages and attachments on your device before relay. Protocol 7 requires a secret invite and an installed build with the native libsignal integration. Share the full invite only through a trusted channel: possession of it does not independently prove a person's identity. The implementation uses libsignal for key agreement and ratcheting encryption. Whisper's integration and invite authentication have not received an independent cryptographic audit.

The protocol 7 app disables random chat and public groups. The backend retains optional legacy group functionality; if an operator enables it for other clients, those public group messages are readable by the server and are not end-to-end encrypted.

The app connects directly over HTTPS. The server and its hosting/network providers can observe the connection IP address, timing, and traffic volume. Whisper does not currently route connections through Tor.

Text conversations and messaging keys are held in memory. Completed chat attachment caches use temporary per-file encryption keys and are cleared with the chat. Files you explicitly save remain encrypted in Whisper's private vault after the chat ends or the app restarts. Vault keys use Android Keystore or non-synchronizing, device-only iOS Keychain protection. The vault is excluded from backups; losing its master key makes saved files inaccessible. You can view or delete files in Saved Files, or erase the entire vault and key with Reset Whisper.

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
