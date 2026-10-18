import { protectPrivateTemporary } from './privateStorage';
import { recordCleanup } from './cleanupStatus';
import * as FileSystem from 'expo-file-system/legacy';
import { Image } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import { cleanVideo, rebuildPdf, officeText, isOffice, encodeBytes, hasNativeDocumentTools } from './documentMedia';
import { cleanJpegFile, stageAttachment, newEncryptedAttachmentFile, finishEncryptedAttachment, decodeChunk, deleteAttachment } from './attachmentFiles';
import { validateAttachmentSize } from './mediaLimits';

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
    const dimensions = await new Promise((resolve, reject) => Image.getSize(asset.uri,
      (width, height) => resolve({ width, height }), reject));
    if (dimensions.width * dimensions.height > 50_000_000) throw new Error('Image dimensions exceed this device processing limit.');
    let converted;
    try {
      converted = await ImageManipulator.manipulateAsync(asset.uri, [],
        { compress: 1, format: ImageManipulator.SaveFormat.JPEG, base64: false });
      protectPrivateTemporary(converted.uri);
      data = cleanJpegFile(converted.uri);
      outputMime = 'image/jpeg'; name = 'Whisperchat.jpg';
    } finally {
      if (converted?.uri) await FileSystem.deleteAsync(converted.uri, { idempotent: true }).catch(() => recordCleanup('scratch-delete', false));
    }
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
  if (!isActive()) { deleteAttachment(data.fileUri); throw new Error('Chat ended'); }
  data = await stageAttachment(data.fileUri);
  if (!isActive()) { deleteAttachment(data.fileUri); throw new Error('Chat ended'); }
  return { ...data, mimeType: outputMime, fileName: name };
}
