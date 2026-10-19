import { protectPrivateTemporary } from './privateStorage';
import { recordCleanup } from './cleanupStatus';
import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import { cleanVideo, rebuildPdf, officeText, isOffice, encodeBytes, hasNativeDocumentTools, transcodeVideo } from './documentMedia';
import { cleanJpegFile, stageAttachment, newEncryptedAttachmentFile, finishEncryptedAttachment, decodeChunk, deleteAttachment } from './attachmentFiles';
import { MAX_ATTACHMENT_BYTES, validateAttachmentSize } from './mediaLimits';

const STANDARD_IMAGE_LONG_SIDE = 1920;
const STANDARD_IMAGE_QUALITY = 0.88;
// Full-quality JPEG: light re-encode only when the source is not already JPEG.
const HD_IMAGE_QUALITY = 0.97;
// Below these sizes the full file is already quick to send; skip the extra copy.
const MIN_IMAGE_BYTES_FOR_STANDARD = 2_000_000;
const MIN_VIDEO_BYTES_FOR_STANDARD = 6_000_000;

const imageSize = (uri) => new Promise((resolve, reject) => Image.getSize(uri,
  (width, height) => resolve({ width, height }), reject));

async function prepareJpeg(uri, actions, compress) {
  let converted;
  try {
    converted = await ImageManipulator.manipulateAsync(uri, actions,
      { compress, format: ImageManipulator.SaveFormat.JPEG, base64: false });
    protectPrivateTemporary(converted.uri);
    return cleanJpegFile(converted.uri);
  } finally {
    if (converted?.uri) await FileSystem.deleteAsync(converted.uri, { idempotent: true }).catch(() => recordCleanup('scratch-delete', false));
  }
}

async function finish(data, outputMime, name, isActive) {
  if (!isActive()) { deleteAttachment(data.fileUri); throw new Error('Chat ended'); }
  data = await stageAttachment(data.fileUri);
  if (!isActive()) { deleteAttachment(data.fileUri); throw new Error('Chat ended'); }
  return { ...data, mimeType: outputMime, fileName: name };
}

export async function prepareAttachment(asset, isActive, confirmConversion) {
  const mime = asset.mimeType || 'application/octet-stream';
  let data;
  let outputMime = mime;
  let name = 'Whisperchat.txt';
  const size = asset.size || asset.fileSize || (await FileSystem.getInfoAsync(asset.uri)).size;
  validateAttachmentSize(size);
  if (!isActive()) throw new Error('Chat ended');
  if (/^(video|audio)\//.test(mime)) {
    data = await cleanVideo(asset.uri, confirmConversion, mime);
    if (!data) return null;
    outputMime = data.mimeType || (mime.startsWith('audio/') ? 'audio/mp4' : 'video/mp4');
    name = data.fileName || 'Whisperchat.mp4';
  } else if (mime.startsWith('image/')) {
    const dimensions = await imageSize(asset.uri);
    if (dimensions.width * dimensions.height > 50_000_000) throw new Error('Image dimensions exceed this device processing limit.');
    // JPEG sources: strip metadata without a second lossy re-encode (grain cause).
    // Other formats convert once at high quality.
    data = mime === 'image/jpeg' || mime === 'image/jpg' || /\.jpe?g$/i.test(asset.uri)
      ? cleanJpegFile(asset.uri)
      : await prepareJpeg(asset.uri, [], HD_IMAGE_QUALITY);
    outputMime = 'image/jpeg'; name = 'Whisperchat.jpg';
  } else if ((mime === 'application/pdf' || /\.pdf$/i.test(asset.name || '')) && size <= 3_000_000 && hasNativeDocumentTools()) {
    if (!(await confirmConversion('PDF privacy', 'Send a flattened PDF? Visible pages are preserved, but selectable text, forms, links, signatures, attachments, and original metadata are removed.'))) return null;
    const original = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' });
    data = await rebuildPdf(original, false, isActive);
    outputMime = 'application/pdf'; name = 'Whisperchat.pdf';
  } else if (isOffice(mime, asset.name) && size <= 3_000_000) {
    if (!(await confirmConversion('Document privacy', 'Send the document as plain text? Formatting, images, macros, comments, and original file metadata are removed. Only extracted document text is sent. Review your document for sensitive text first.'))) return null;
    const original = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' });
    data = encodeBytes(new TextEncoder().encode(officeText(original)));
    outputMime = 'text/plain';
  } else if (mime === 'text/plain' || /\.txt$/i.test(asset.name || '')) {
    data = await stageAttachment(asset.uri, 'txt');
    outputMime = 'text/plain';
  } else {
    if (!(await confirmConversion('Send original file?', 'This format or large document cannot be stripped of metadata automatically. Its original metadata and embedded content will be included. Send it encrypted as-is?'))) return null;
    const extension = (asset.name || '').match(/\.([a-z0-9]{1,8})$/i)?.[1] || 'bin';
    data = await stageAttachment(asset.uri, extension);
    name = `Whisperchat.${extension}`;
  }
  if (typeof data === 'string') {
    const file = newEncryptedAttachmentFile();
    const bytes = decodeChunk(data);
    let writer;
    try {
      writer = file.open();
      for (let offset = 0; offset < bytes.length; offset += 98304) writer.writeBytes(bytes.subarray(offset, offset + 98304));
      data = finishEncryptedAttachment(file.uri);
    } catch (error) { deleteAttachment(file.uri); throw error; }
    finally { writer?.close(); bytes.fill(0); }
  }
  return finish(data, outputMime, name, isActive);
}

// A smaller copy sent before the full-quality original. Resolves to null when
// the original is already small enough, or when this build cannot convert it.
// Never deletes the source asset; the caller still prepares the original from it.
export async function prepareStandardCopy(asset, isActive) {
  const mime = asset.mimeType || '';
  const size = asset.size || asset.fileSize || (await FileSystem.getInfoAsync(asset.uri)).size || 0;
  if (!isActive()) throw new Error('Chat ended');
  if (mime.startsWith('image/')) {
    if (size < MIN_IMAGE_BYTES_FOR_STANDARD) return null;
    const { width, height } = await imageSize(asset.uri);
    if (Math.max(width, height) <= STANDARD_IMAGE_LONG_SIDE * 1.25) return null;
    if (width * height > 50_000_000) throw new Error('Image dimensions exceed this device processing limit.');
    const resize = width >= height ? { width: STANDARD_IMAGE_LONG_SIDE } : { height: STANDARD_IMAGE_LONG_SIDE };
    const data = await prepareJpeg(asset.uri, [{ resize }], STANDARD_IMAGE_QUALITY);
    return finish(data, 'image/jpeg', 'Whisperchat.jpg', isActive);
  }
  if (mime.startsWith('video/')) {
    if (size < MIN_VIDEO_BYTES_FOR_STANDARD) return null;
    const converted = await transcodeVideo(asset.uri);
    if (!converted) return null;
    try {
      const info = await FileSystem.getInfoAsync(converted);
      // A conversion that is not meaningfully smaller only delays delivery.
      if (!info.exists || !info.size || info.size > MAX_ATTACHMENT_BYTES || info.size > size * 0.8) return null;
      return await prepareAttachment({ uri: converted, mimeType: 'video/mp4', size: info.size }, isActive, null);
    } finally {
      await FileSystem.deleteAsync(converted, { idempotent: true }).catch(() => recordCleanup('scratch-delete', false));
    }
  }
  return null;
}
