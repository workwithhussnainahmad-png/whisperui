import { recordCleanup } from './cleanupStatus';
import { File, Directory, Paths } from 'expo-file-system';
import * as Legacy from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { MAX_ATTACHMENT_BYTES, STORAGE_RESERVE_BYTES, validateAttachmentSize } from './mediaLimits';
import { createEncryptedFileStore, CACHE_CHUNK_BYTES } from './encryptedFileStore';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { isExpoGoFeatureTest } from './captureProtection';

const nativeFiles = Platform.OS === 'ios' ? requireOptionalNativeModule('WhisperAttachments') : null;
function protectFile(uri) {
  if (Platform.OS !== 'ios' || isExpoGoFeatureTest) return;
  if (!nativeFiles?.protectTemporaryFile) throw new Error('Install the updated Whisper build for protected attachment storage');
  nativeFiles.protectTemporaryFile(uri);
}

const root = new Directory(Paths.cache, 'whisper-chat-media');
let initialized = false;
let generation = 0;
const owned = new Set();
const vault = createEncryptedFileStore({
  createFile: () => newAttachmentFile('wenc'),
  removeFile: (uri) => deleteAttachment(uri),
  randomBytes: (length) => Crypto.getRandomBytes(length),
  requireStorage,
  maxBytes: MAX_ATTACHMENT_BYTES,
});
export function initializeAttachmentFiles() {
  if (initialized) return;
  if (root.exists) root.delete();
  root.create({ intermediates: true });
  protectFile(root.uri);
  initialized = true;
}
export function newAttachmentFile(extension = 'bin') {
  initializeAttachmentFiles();
  const suffix = /^[a-z0-9]{1,8}$/i.test(extension) ? extension : 'bin';
  const file = new File(root, `${Crypto.randomUUID()}.${suffix}`);
  file.create();
  try { protectFile(file.uri); } catch (error) { file.delete(); throw error; }
  owned.add(file.uri);
  return file;
}
export function isOwnedAttachment(uri) { return typeof uri === 'string' && owned.has(uri); }
export function deleteAttachment(uri) {
  vault.forget(uri);
  if (!owned.has(uri)) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
    owned.delete(uri);
    recordCleanup('attachment-delete', true);
  } catch { recordCleanup('attachment-delete', false); /* Retain ownership for retry. */ }
}
export function clearAttachmentFiles() {
  generation += 1;
  vault.clear();
  for (const uri of [...owned]) deleteAttachment(uri);
}
export async function stageAttachment(uri, extension = 'bin', ownedSource = false) {
  if (vault.has(uri)) return vault.seal(uri);
  const source = new File(uri);
  let output;
  try {
    validateAttachmentSize(source.size);
    output = newEncryptedAttachmentFile();
    await copyAttachment(source, output);
    return vault.seal(output.uri);
  } catch (error) {
    if (output) deleteAttachment(output.uri);
    throw error;
  } finally {
    if (isOwnedAttachment(uri)) deleteAttachment(uri);
    else if (ownedSource || (Legacy.cacheDirectory && uri.startsWith(Legacy.cacheDirectory))) {
      try { if (source.exists) source.delete(); } catch { recordCleanup('scratch-delete', false); }
    }
  }
}

export function newEncryptedAttachmentFile() { return vault.create(); }
export function finishEncryptedAttachment(uri) { return vault.seal(uri); }
export function openAttachmentFile(uri) {
  if (!isOwnedAttachment(uri) || !vault.has(uri)) throw new Error('Encrypted attachment is unavailable');
  return vault.get(uri);
}

async function copyAttachment(source, destination) {
  const epoch = generation;
  const size = source.size;
  requireStorage(size + Math.ceil(size / CACHE_CHUNK_BYTES) * 48);
  let reader; let writer;
  try {
    reader = source.open(); writer = destination.open();
    for (let offset = 0, count = 0; offset < size; count += 1) {
      if (epoch !== generation) throw new Error('Chat ended');
      const length = Math.min(CACHE_CHUNK_BYTES, size - offset);
      const bytes = reader.readBytes(length);
      try {
        if (bytes.length !== length) throw new Error('Attachment changed');
        writer.writeBytes(bytes);
      } finally { bytes.fill(0); }
      offset += length;
      if (count % 8 === 7) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (epoch !== generation || source.size !== size) throw new Error('Attachment changed or chat ended');
  } finally { reader?.close(); writer?.close(); }
}

// Native media players require a file URI. Callers must release this short-lived
// plaintext lease when the viewer closes or export completes. Never keep it in
// a message object. Session/startup cleanup removes abandoned leases as well.
export async function acquireAttachmentFile(uri, extension = 'bin') {
  const source = openAttachmentFile(uri);
  const file = newAttachmentFile(extension);
  try {
    await copyAttachment(source, file);
    return { uri: file.uri, release: () => deleteAttachment(file.uri) };
  } catch (error) { deleteAttachment(file.uri); throw error; }
}

export function readAttachmentBase64(uri, limit = 3_000_000) {
  const file = openAttachmentFile(uri);
  if (file.size > limit) throw new Error('Attachment is too large to preview');
  const reader = file.open();
  let result = '';
  try {
    while (reader.offset < file.size) {
      const bytes = reader.readBytes(Math.min(CACHE_CHUNK_BYTES, file.size - reader.offset));
      try { result += encodeChunk(bytes); } finally { bytes.fill(0); }
    }
    return result;
  } finally { reader.close(); }
}
export function encodeChunk(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 16384) result += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(result);
}
export function decodeChunk(data) { return Uint8Array.from(atob(data), (char) => char.charCodeAt(0)); }
export function requireStorage(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > Paths.availableDiskSpace - STORAGE_RESERVE_BYTES) {
    throw new Error('Not enough private storage for this attachment');
  }
}
export function mediaExtension(mime) {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4', 'audio/mp4': 'm4a',
    'application/pdf': 'pdf', 'text/plain': 'txt' })[mime] || 'bin';
}

// Strip JPEG application metadata without reading the compressed image into RAM.
export function cleanJpegFile(uri, brandedHeader = null) {
  const source = new File(uri);
  const output = newAttachmentFile('jpg');
  let reader; let writer;
  try {
    reader = source.open(); writer = output.open();
    const first = reader.readBytes(2);
    if (first[0] !== 255 || first[1] !== 216) throw new Error('Invalid JPEG');
    writer.writeBytes(first);
    if (brandedHeader) writer.writeBytes(brandedHeader);
    while (reader.offset < source.size) {
      const marker = reader.readBytes(2);
      if (marker.length !== 2 || marker[0] !== 255) throw new Error('Invalid JPEG segment');
      if (marker[1] === 218 || marker[1] === 217) {
        writer.writeBytes(marker);
        while (reader.offset < source.size) {
          const bytes = reader.readBytes(98304);
          requireStorage(bytes.length);
          writer.writeBytes(bytes);
        }
        return { fileUri: output.uri, fileSize: output.size };
      }
      const lengthBytes = reader.readBytes(2);
      const length = (lengthBytes[0] << 8) | lengthBytes[1];
      if (lengthBytes.length !== 2 || length < 2 || reader.offset + length - 2 > source.size) throw new Error('Invalid JPEG segment');
      const bytes = reader.readBytes(length - 2);
      if (!(marker[1] >= 225 && marker[1] <= 239) && marker[1] !== 254) {
        writer.writeBytes(marker); writer.writeBytes(lengthBytes); writer.writeBytes(bytes);
      }
    }
    throw new Error('Incomplete JPEG');
  } catch (error) { deleteAttachment(output.uri); throw error; }
  finally { reader?.close(); writer?.close(); }
}
