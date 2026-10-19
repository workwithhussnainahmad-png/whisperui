import { recordCleanup } from './cleanupStatus';
import * as FileSystem from 'expo-file-system/legacy';
import { isExpoGoFeatureTest } from './captureProtection';
import { stageAttachment, isOwnedAttachment } from './attachmentFiles';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Unzip, UnzipInflate } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { isValidBase64 } from './payloadValidation';

export const nativeAttachments = requireOptionalNativeModule('WhisperAttachments');
let initialization;
export function initializeAttachmentTools() {
  if (!initialization) initialization = nativeAttachments
    ? nativeAttachments.cleanTemporaryFiles().catch(error => { initialization = null; recordCleanup('native-temp', false); throw error; }) : Promise.resolve();
  return initialization;
}
export async function cleanVideo(uri, confirmOriginal, originalMime = null) {
  if (!nativeAttachments?.cleanVideoFile) {
    if (!isExpoGoFeatureTest) throw new Error('Install the updated native build to prepare media.');
    if (!confirmOriginal || !(await confirmOriginal('Expo Go video test',
      'Native metadata removal is unavailable in Expo Go. Send the original test file, including its metadata? Use non-sensitive test media.'))) return null;
    const mimeType = originalMime || (/\.mov(?:$|[?#])/i.test(uri) ? 'video/quicktime' : 'video/mp4');
    const extension = ({ 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
      'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
      'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm' })[mimeType]
      || uri.match(/\.([a-z0-9]{1,8})$/i)?.[1] || 'bin';
    return { ...(await stageAttachment(uri, extension)), mimeType, fileName: `Whisperchat.${extension}` };
  }
  await initializeAttachmentTools();
  const output = await nativeAttachments.cleanVideoFile(uri);
  try { return await stageAttachment(output, 'mp4', true); }
  finally { await FileSystem.deleteAsync(output, { idempotent: true }).catch(() => recordCleanup('scratch-delete', false)); }
}
// Resolves to a scratch 720p MP4 URI, or null when the build cannot convert or
// the source is already standard size. Callers own and delete the output.
export async function transcodeVideo(uri) {
  if (!nativeAttachments?.transcodeVideo) return null;
  await initializeAttachmentTools();
  return (await nativeAttachments.transcodeVideo(uri)) || null;
}
export function hasNativeDocumentTools() { return Boolean(nativeAttachments); }
export async function validateImageFile(uri) {
  if (!isOwnedAttachment(uri) || !nativeAttachments?.validateImageFile) throw new Error('Protected local image validation is unavailable');
  return nativeAttachments.validateImageFile(uri);
}

const decode = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
export function encodeBytes(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}
export const isOffice = (mime, name = '') => /\.(docx|xlsx|pptx)$/i.test(name) || /officedocument\.(wordprocessingml|spreadsheetml|presentationml)/.test(mime);
const entities = (value) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code) => {
  if (code.startsWith('#')) {
    const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
  }
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[code.toLowerCase()];
});
function tags(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g'))].map((match) => entities(match[1].replace(/<[^>]*>/g, '')));
}

// Only chosen document-body XML entries are inflated. No macros, relationships,
// external resources, HTML, or arbitrary entities are evaluated.
export function officeText(base64) {
  if (!isValidBase64(base64, 4_000_000)) throw new Error('Invalid document');
  const input = decode(base64);
  const files = new Map();
  const completed = new Set();
  let total = 0;
  let failed = null;
  const unzip = new Unzip((entry) => {
    if (!/^(word\/document\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|ppt\/slides\/slide\d+\.xml)$/.test(entry.name)) return;
    if (files.has(entry.name) || files.size >= 100 || (entry.originalSize || 0) > 2_000_000) { failed = new Error('Invalid or overly complex document'); return; }
    files.set(entry.name, []);
    entry.ondata = (error, bytes, final) => {
      if (error) { failed = error; entry.terminate(); return; }
      total += bytes.length;
      if (total > 5_000_000) { failed = new Error('Document too complex'); entry.terminate(); return; }
      files.get(entry.name).push(bytes);
      if (final) completed.add(entry.name);
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let offset = 0; offset < input.length; offset += 1024) {
      if (failed) throw failed;
      unzip.push(input.subarray(offset, offset + 1024), offset + 1024 >= input.length);
    }
    if (failed) throw failed;
    if (completed.size !== files.size) throw new Error('Incomplete document');
    const xmlFiles = new Map();
    for (const [name, parts] of files) {
      const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
      let at = 0;
      for (const part of parts) { bytes.set(part, at); at += part.length; }
      const xml = new TextDecoder().decode(bytes);
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Document entities are unsupported');
      xmlFiles.set(name, xml);
    }
    const output = [];
    const shared = tags(xmlFiles.get('xl/sharedStrings.xml') || '', 'si').map((value) => value);
    for (const [name, xml] of [...xmlFiles].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
      if (name === 'word/document.xml') {
        for (const paragraph of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) output.push(tags(paragraph[1], 'w:t').join(''));
      } else if (name.startsWith('ppt/slides/')) {
        output.push(`\n${name.match(/slide\d+/)?.[0]}\n`);
        for (const text of tags(xml, 'a:t')) output.push(text);
      } else if (name.startsWith('xl/worksheets/')) {
        output.push(`\n${name.match(/sheet\d+/)?.[0]}\n`);
        for (const row of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
          const cells = [...row[1].matchAll(/<c(\s[^>]*)?>([\s\S]*?)<\/c>/g)].map((cell) => {
            const value = tags(cell[2], 'v')[0] || tags(cell[2], 't').join('');
            return /\bt=["']s["']/.test(cell[1] || '') ? shared[Number(value)] || '' : value;
          });
          output.push(cells.join('\t'));
        }
      }
    }
    const text = output.join('\n');
    if (!text.trim() || text.length > 500000) throw new Error('No supported text or document too large');
    return text;
  } finally { input.fill(0); files.clear(); }
}

export async function renderPdfPage(data, page) {
  if (!nativeAttachments) throw new Error('Install the updated native build');
  await initializeAttachmentTools();
  return nativeAttachments.renderPdfPage(data, page);
}

export async function rebuildPdf(data, branded = false, isActive = () => true) {
  // Rebuild from rendered page pixels, excluding original metadata, scripts,
  // attachments, revisions and hidden non-rendered document objects.
  const result = await PDFDocument.create();
  const first = await renderPdfPage(data, 0);
  if (first.pageCount > 20) throw new Error('PDFs are limited to 20 pages');
  let imageBytes = 0;
  for (let page = 0; page < first.pageCount; page += 1) {
    if (!isActive()) throw new Error('Chat ended');
    const rendered = page === 0 ? first : await renderPdfPage(data, page);
    imageBytes += rendered.image.length;
    if (imageBytes > 4_000_000) throw new Error('Rendered PDF exceeds attachment limit');
    const image = await result.embedJpg(decode(rendered.image));
    const output = result.addPage([image.width, image.height]);
    output.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  const label = branded ? 'Whisperchat' : '';
  result.setTitle(label); result.setAuthor(label); result.setSubject(label);
  result.setCreator(label); result.setProducer(label); result.setKeywords(branded ? ['Whisperchat'] : []);
  result.setCreationDate(new Date(0)); result.setModificationDate(new Date(0));
  const bytes = await result.save();
  if (bytes.length > 3_000_000) throw new Error('Rendered PDF exceeds attachment limit');
  if (!isActive()) throw new Error('Chat ended');
  return encodeBytes(bytes);
}
