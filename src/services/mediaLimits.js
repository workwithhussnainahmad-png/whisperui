// Bound disk consumption even when an authenticated peer is malicious.
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const MAX_CHAT_MEDIA_BYTES = 256 * 1024 * 1024;
export const STORAGE_RESERVE_BYTES = 64 * 1024 * 1024;

export function validateAttachmentSize(size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ATTACHMENT_BYTES) {
    throw new Error('Attachments must be between 1 byte and 64 MiB');
  }
}
