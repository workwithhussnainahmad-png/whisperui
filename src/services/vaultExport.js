import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import { AppState, Platform } from 'react-native';
import { acquireVaultPreview, vaultError, subscribeVaultLock } from './privateVault';
import { prepareAttachment } from './prepareAttachment';
import { acquireAttachmentFile, deleteAttachment, mediaExtension } from './attachmentFiles';
import { hasNativeDocumentTools, isOffice } from './documentMedia';
import { cleanAbandonedExports } from './mediaExport';
import { protectPrivateTemporary } from './privateStorage';
import { observeCleanup } from './cleanupStatus';

let sharing = false;
let generation = 0;
const exportRoot = () => {
  if (!FileSystem.cacheDirectory) throw new Error('Private sharing storage is unavailable.');
  return `${FileSystem.cacheDirectory}whisper-vault-share/`;
};
export function externalShareDescription(item) {
  const mime = item.mime || '';
  let conversion;
  if (mime.startsWith('image/')) conversion = 'An image copy is converted to JPEG. Animation and transparency are not preserved.';
  else if (/^(video|audio)\//.test(mime)) {
    if (!hasNativeDocumentTools()) throw new Error('Install the updated native Whisper build to remove video/audio metadata before sharing.');
    conversion = 'A media copy is rebuilt with supported container metadata removed.';
  } else if (mime === 'application/pdf' && item.size <= 3000000 && hasNativeDocumentTools()) {
    conversion = 'PDF sharing requires flattening: text selection, forms, links, signatures and attachments are removed.';
  } else if (isOffice(mime, item.name) && item.size <= 3000000) {
    conversion = 'Office documents are shared as extracted plain text, without formatting, images, macros or comments.';
  } else if (mime === 'text/plain') conversion = 'Text content is preserved in a new file with a generic name.';
  else throw new Error('Metadata removal is not supported for this file type or size. This file cannot be shared externally.');
  return `${conversion} Your encrypted saved original stays unchanged. Visible content may still identify you. The receiving app controls its own copy.`;
}

// Android's chooser can return before the target finishes reading. Keep the
// authorized copy until Whisper returns to foreground, rather than deleting it
// while the receiving activity is open. Startup removes leftovers after a kill.
export async function shareAndWaitForReturn(uri, options) {
  let foregroundWaiter;
  const subscription = AppState.addEventListener('change', state => {
    if (state === 'active') foregroundWaiter?.();
  });
  try {
    await Sharing.shareAsync(uri, options);
    if (Platform.OS === 'android') {
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (AppState.currentState !== 'active') await new Promise(resolve => { foregroundWaiter = resolve; });
    }
  } finally { subscription.remove(); }
}

async function releasePreview(lease) {
  await lease.release();
  if ((await FileSystem.getInfoAsync(lease.uri)).exists) throw new Error('Temporary preview cleanup failed.');
}

export async function clearExternalShareFiles() {
  generation++;
  await observeCleanup('external-share-delete', () => FileSystem.deleteAsync(exportRoot(), { idempotent: true }));
}

export async function shareSavedFile(item, confirmConversion, active = () => true) {
  externalShareDescription(item); // Fail closed before decrypting unsupported formats.
  if (sharing) throw new Error('Another file is already being shared. Return to Whisper first.');
  sharing = true;
  const epoch = generation;
  const current = () => active() && epoch === generation && !locked;
  let original, prepared, sanitized, directory, unsubscribe;
  let locked = false;
  try {
    if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is unavailable on this device.');
    await cleanAbandonedExports();
    if (!current()) throw new Error('Sharing cancelled.');
    try { original = await acquireVaultPreview({ vaultId: item.id, mimeType: item.mime, fileSize: item.size }, current); }
    catch (error) { throw new Error(vaultError(error)); }
    unsubscribe = subscribeVaultLock(state => { if (state.locked) locked = true; });
    try { prepared = await prepareAttachment({ uri: original.uri, mimeType: item.mime, name: item.name, size: item.size }, current,
      async (title, message) => {
        if (title === 'Send original file?' || title === 'Expo Go video test') throw new Error('This file cannot be shared without metadata removal.');
        return confirmConversion(title, message.replace(/Send/g, 'Share').replace(/sent/g, 'shared'));
      }); } catch { throw new Error('Metadata removal failed or was interrupted. The file was not shared. Check available storage and retry with a supported file.'); }
    if (!prepared) return false;
    sanitized = await acquireAttachmentFile(prepared.fileUri, mediaExtension(prepared.mimeType));
    if (!current()) throw new Error('Sharing cancelled.');
    directory = `${exportRoot()}${Crypto.randomUUID()}/`;
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    protectPrivateTemporary(directory);
    const extension = mediaExtension(prepared.mimeType);
    const uri = `${directory}Whisper.${extension}`;
    await FileSystem.copyAsync({ from: sanitized.uri, to: uri });
    protectPrivateTemporary(uri);
    // No vault key or preview lease is needed while the other app is open.
    await releasePreview(sanitized); sanitized = null;
    deleteAttachment(prepared.fileUri); prepared = null;
    unsubscribe(); unsubscribe = null;
    await releasePreview(original); original = null;
    if (!current()) throw new Error('Sharing cancelled.');
    await shareAndWaitForReturn(uri, { mimeType: item.mime.startsWith('image/') ? 'image/jpeg' :
      item.mime.startsWith('audio/') ? 'audio/mp4' : item.mime.startsWith('video/') ? 'video/mp4' :
      isOffice(item.mime, item.name) ? 'text/plain' : item.mime, dialogTitle: 'Share a copy from Whisper' });
    return true;
  } finally {
    unsubscribe?.();
    const cleanup = [];
    if (directory) cleanup.push(() => FileSystem.deleteAsync(directory, { idempotent: true }));
    if (sanitized) cleanup.push(() => releasePreview(sanitized));
    if (prepared) cleanup.push(() => deleteAttachment(prepared.fileUri));
    if (original) cleanup.push(() => releasePreview(original));
    let failed = false;
    for (const remove of cleanup) {
      try { await observeCleanup('external-share-delete', remove); } catch { failed = true; }
    }
    sharing = false;
    if (failed) throw new Error('Temporary share cleanup failed. Close and reopen Whisper to retry cleanup. Your saved original is unchanged.');
  }
}
