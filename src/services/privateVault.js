import { createVaultLock } from './vaultLock';
import { recordCleanup } from './cleanupStatus';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { createPrivateVaultStore } from './privateVaultStore';
import { openAttachmentFile, newAttachmentFile, deleteAttachment, encodeChunk, decodeChunk, mediaExtension } from './attachmentFiles';

const native = requireOptionalNativeModule('WhisperVault');
const previews = new Set();
function bridge() {
  if (!native) throw new Error('Install the updated Whisper build to use Saved Files.');
  return native;
}
function file(name) {
  return { get size() { return bridge().size(name); }, open() {
    let offset = 0, closed = false;
    const check = () => { if (closed) throw new Error('Saved file was closed.'); };
    return {
      readBytes(n) { check(); const bytes = decodeChunk(bridge().read(name, offset, n)); offset += bytes.length; return bytes; },
      writeBytes(bytes) { check(); bridge().write(name, offset, encodeChunk(bytes)); offset += bytes.length; },
      close() { closed = true; },
    };
  } };
}
function requireStorage(bytes) {
  if (!Number.isFinite(Paths.availableDiskSpace) || Paths.availableDiskSpace < bytes + 64 * 1024 * 1024) {
    throw new Error('Not enough storage to save or open this file privately. Free space and retry.');
  }
}
const store = createPrivateVaultStore({
  file, create: (name) => { bridge().create(name); return file(name); },
  list: () => bridge().list(), remove: (name) => bridge().remove(name), commit: (from, to) => bridge().commit(from, to),
  masterKey: async (create) => decodeChunk(await bridge().masterKey(create)),
  wipe: () => bridge().wipe(), requireStorage,
  onCleanupFailure: () => recordCleanup('attachment-delete', false),
  randomBytes: (n) => Crypto.getRandomBytes(n), uuid: () => Crypto.randomUUID(),
  yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
});
function cleanupPreviews() {
  for (const release of [...previews]) {
    try { release(); } catch { recordCleanup('attachment-delete', false); }
  }
}
const lock = createVaultLock({
  policy: () => { if (!bridge().lockStatus) throw new Error('Install the updated Whisper build to use Saved Files.'); return bridge().lockStatus(); },
  unlock: active => store.unlock(active), lock: () => store.lock(), prepare: () => store.list(),
  configure: (enabled, timeout) => bridge().setLock(enabled, timeout),
  cancelAuth: () => bridge().cancelAuthentication?.(), cleanup: cleanupPreviews,
  wipe: () => store.wipe(), setTimer: setTimeout, clearTimer: clearTimeout,
});
export const initializeVaultLock = () => lock.initialize();
export const getVaultLockState = () => lock.getState();
export const subscribeVaultLock = listener => lock.subscribe(listener);
export const beginVaultSession = () => lock.acquire();
export const lockSavedFiles = () => lock.lock();
export const setVaultAppActive = active => lock.background(active);
export const disableVaultLock = confirm => lock.disable(confirm);
export const configureVaultLock = (enabled, timeout) => lock.configure(enabled, timeout);
async function access(work) { const release = await lock.acquire(); try { return await work(); } catch (error) { lock.fail(error); throw error; } finally { release(); } }
export function vaultError(error) {
  const message = String(error?.message || '');
  if (/key unavailable|invalidated/i.test(message)) return 'Vault key unavailable. Device security changed or the key was lost. Retry unlocking or Reset Whisper to erase the inaccessible vault. There is no bypass.';
  if (/^(Vault authentication|Vault lock change|Saved Files.*lock|Set a device|Whisper was reset)/i.test(message)) return message;
  if (/storage|space|ENOSPC/i.test(message)) return 'Not enough storage to save or open this file privately. Free space and retry.';
  if (/key|Keystore|Keychain|AEADBadTag|BadPadding|UserNotAuthenticated/i.test(message)) return 'The private vault key is missing or unavailable. Unlock your device and retry. If the key was lost, Reset Whisper erases the inaccessible files.';
  if (/corrupt|authentication|JSON|missing/i.test(message)) return 'The saved file or vault index is missing or corrupted. It could not be opened.';
  if (/^(Install the updated|Saved files must|Saved Files is full|Chat ended|Whisper was reset|Preview was closed|This saved file|Could not delete|Send cancelled|The chat|The recipient|Recipient |Two attachments|This chat|Attachment metadata|Delivery confirmation)/.test(message)) return message;
  if (/disconnect|connection|network|timed out|relay|peer/i.test(message)) return 'The chat or recipient is unavailable. Check the connection and try again.';
  return 'The private file operation failed. Unlock your device, check available storage, and retry.';
}
export const listSavedFiles = () => access(() => store.list());
export function saveToVault(message, active) {
  if (message?.isSent || message?.allowSaving !== true) throw new Error('The sender has not allowed saving this attachment.');
  return access(() => store.save(openAttachmentFile(message.fileUri), { name: message.fileName || 'Attachment', mime: message.mimeType }, active));
}
export const deleteSavedFile = id => access(() => store.delete(id));
export async function openVaultSend(id, active) {
  const release = await lock.acquire();
  try {
    const reader = await store.openForSend(id, active);
    return { ...reader, onLock: callback => lock.subscribe(state => { if (state.locked) callback(); }),
      close() { try { reader.close(); } finally { release(); } } };
  } catch (error) { release(); throw error; }
}

export async function acquireVaultPreview(message, active = () => true) {
  const endSession = await lock.acquire();
  let output;
  try { requireStorage(message.fileSize); output = newAttachmentFile(mediaExtension(message.mimeType)); }
  catch (error) { endSession(); throw error; }
  /* output allocated only after authentication */
  let writer;
  const release = () => {
    deleteAttachment(output.uri);
    if (new File(output.uri).exists) throw new Error('Could not delete private preview. Close Whisper and retry.');
    previews.delete(release);
    endSession();
  };
  previews.add(release);
  try {
    writer = output.open();
    await store.read(message.vaultId, (bytes) => writer.writeBytes(bytes), active);
    writer.close(); writer = null;
    return { uri: output.uri, release };
  } catch (error) { writer?.close(); writer = null; release(); throw error; }
  finally { writer?.close(); }
}
export async function readVaultDocument(message, active = () => true) {
  if (message.fileSize > 3_000_000) throw new Error('This file is too large for an in-app document preview.');
  let result = '';
  await access(() => store.read(message.vaultId, (bytes) => { result += encodeChunk(bytes); }, active));
  return result;
}
export async function wipePrivateVault() {
  await lock.reset();
  cleanupPreviews();
}
