import { newEncryptedAttachmentFile, finishEncryptedAttachment, deleteAttachment, decodeChunk, requireStorage, clearAttachmentFiles } from './attachmentFiles';
import { MAX_CHAT_MEDIA_BYTES, validateAttachmentSize } from './mediaLimits';
export const CHUNK_BYTES = 98304;
export const CHUNK_CHARS = 131072;
const incoming = new Map();
const aborted = new Set();
let receivedBudget = 0;
function dispose(id) {
  const transfer = incoming.get(id);
  if (!transfer) return;
  incoming.delete(id);
  receivedBudget -= transfer.reservedBytes;
  clearTimeout(transfer.timer);
  for (const part of transfer.parts.values()) part.fill(0);
  transfer.parts.clear();
  try { transfer.handle.close(); } catch { }
  deleteAttachment(transfer.file.uri);
}
export function clearMediaTransfers() {
  for (const id of [...incoming.keys()]) dispose(id);
  clearAttachmentFiles();
  receivedBudget = 0;
  aborted.clear();
}
export function abortMediaTransfer(id) {
  dispose(id); aborted.add(id);
  if (aborted.size > 512) aborted.delete(aborted.values().next().value);
}
export function commitMediaTransfer(id) {
  const transfer = incoming.get(id);
  if (!transfer || transfer.next !== transfer.count) throw new Error('Attachment is incomplete');
  const descriptor = JSON.parse(transfer.descriptor);
  if (transfer.bytes !== descriptor.fileSize) throw new Error('Attachment size mismatch');
  transfer.handle.close();
  finishEncryptedAttachment(transfer.file.uri);
  clearTimeout(transfer.timer);
  incoming.delete(id);
  const { type, mimeType, fileName, fileSize, allowSaving } = descriptor;
  return { type, mimeType, fileName, fileSize, allowSaving, messageId: id, fileUri: transfer.file.uri };
}
export function acceptMediaChunk(chunk) {
  let transfer = incoming.get(chunk.transferId);
  try {
    if (aborted.has(chunk.transferId)) throw new Error('Attachment was cancelled');
    if (!transfer) {
      validateAttachmentSize(chunk.descriptor.fileSize);
      if (receivedBudget + chunk.descriptor.fileSize > MAX_CHAT_MEDIA_BYTES) throw new Error('Chat attachment limit reached');
      if (incoming.size >= 2 || chunk.index >= 4) throw new Error('Too many pending attachments');
      requireStorage(chunk.descriptor.fileSize);
      const file = newEncryptedAttachmentFile();
      let handle;
      try { handle = file.open(); } catch (error) { deleteAttachment(file.uri); throw error; }
      transfer = { file, handle, descriptor: JSON.stringify(chunk.descriptor), count: chunk.count,
        parts: new Map(), next: 0, bytes: 0, timer: null, reservedBytes: chunk.descriptor.fileSize };
      incoming.set(chunk.transferId, transfer);
      receivedBudget += transfer.reservedBytes;
    }
    if (transfer.count !== chunk.count || transfer.descriptor !== JSON.stringify(chunk.descriptor) ||
        chunk.index < transfer.next || chunk.index >= transfer.next + 4 || transfer.parts.has(chunk.index)) {
      throw new Error('Invalid attachment sequence');
    }
    const bytes = decodeChunk(chunk.data);
    const expected = Math.min(CHUNK_BYTES, chunk.descriptor.fileSize - chunk.index * CHUNK_BYTES);
    if (bytes.length !== expected) { bytes.fill(0); throw new Error('Attachment size mismatch'); }
    transfer.parts.set(chunk.index, bytes);
    while (transfer.parts.has(transfer.next)) {
      const part = transfer.parts.get(transfer.next);
      requireStorage(part.length);
      try { transfer.handle.writeBytes(part); transfer.bytes += part.length; }
      finally { part.fill(0); }
      transfer.parts.delete(transfer.next++);
    }
    clearTimeout(transfer.timer);
    transfer.timer = setTimeout(() => dispose(chunk.transferId), 60_000); // Idle timeout, not total duration.
    if (transfer.next !== transfer.count) return null;
    if (transfer.bytes !== chunk.descriptor.fileSize) throw new Error('Attachment size mismatch');
    if (chunk.descriptor.commitRequired === true) return null;
    return commitMediaTransfer(chunk.transferId);
  } catch (error) { dispose(chunk.transferId); throw error; }
}
