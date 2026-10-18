// Only invite QR images may enter the FileProvider-visible directory.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import { initializeAttachmentTools } from './documentMedia';
import { preparePrivateStorage, protectPrivateTemporary } from './privateStorage';
import { observeCleanup } from './cleanupStatus';
let startupCleanup;
export function cleanAbandonedExports() {
  if (!startupCleanup) startupCleanup = observeCleanup('startup-exports', async () => {
    await preparePrivateStorage();
    if (FileSystem.cacheDirectory) {
      for (const name of ['whisper-exports', 'whisper-share']) await FileSystem.deleteAsync(`${FileSystem.cacheDirectory}${name}/`, { idempotent: true });
    }
    await initializeAttachmentTools();
  }).catch(error => { startupCleanup = null; throw error; });
  return startupCleanup;
}
export async function shareInviteQr(base64, active = () => true) {
  if (!FileSystem.cacheDirectory || !(await Sharing.isAvailableAsync())) throw new Error('Sharing unavailable');
  await cleanAbandonedExports();
  const directory = `${FileSystem.cacheDirectory}whisper-share/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  protectPrivateTemporary(directory);
  const uri = `${directory}${Crypto.randomUUID()}.png`;
  try {
    await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
    protectPrivateTemporary(uri);
    if (!active()) throw new Error('Invite unavailable');
    await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Share invite QR' });
  } finally {
    await observeCleanup('qr-delete', () => FileSystem.deleteAsync(uri, { idempotent: true }));
  }
}
