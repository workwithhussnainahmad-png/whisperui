import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { getCleanupStatus, observeCleanup } from './cleanupStatus';
const native = requireOptionalNativeModule('WhisperAttachments');
let preparation;
export function protectPrivateTemporary(uri) {
  if (Platform.OS !== 'ios') return;
  if (!native?.protectTemporaryFile) throw new Error('Install the updated Whisper build for private storage.');
  native.protectTemporaryFile(uri);
}
export async function preparePrivateStorage() {
  if (Platform.OS !== 'ios') return;
  if (!native?.preparePrivateStorage) throw new Error('Install the updated Whisper build for private storage.');
  if (!preparation) preparation = observeCleanup('storage-protection', () => native.preparePrivateStorage())
    .catch(error => { preparation = null; throw error; });
  await preparation;
}
export async function privacySelfCheck() {
  if (!__DEV__) throw new Error('Privacy self-check is available only in debug builds.');
  if (!native?.privacySelfCheck) throw new Error('Install the updated native debug build.');
  return { ...(await native.privacySelfCheck()), cleanup: getCleanupStatus() };
}
