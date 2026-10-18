import { preparePrivateStorage } from './privateStorage';
import * as FileSystem from 'expo-file-system/legacy';
let cleanup;
// Known private scratch directories used by the installed Expo media modules.
// Never remove the cache root or user-library originals. Await before new picks.
export function cleanAbandonedCaptures() {
  if (!cleanup) cleanup = preparePrivateStorage().then(() => FileSystem.cacheDirectory
    ? Promise.all(['Camera', 'ImagePicker', 'ImageManipulator', 'DocumentPicker'].map((name) =>
      FileSystem.deleteAsync(`${FileSystem.cacheDirectory}${name}/`, { idempotent: true })))
    : Promise.resolve()).catch(error => { cleanup = null; throw error; });
  return cleanup;
}
