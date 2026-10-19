import { acquireAttachmentFile, mediaExtension } from './attachmentFiles';
import { validateImageFile } from './documentMedia';
import { recordCleanup } from './cleanupStatus';

// One decrypted, validated copy per attachment, shared by the chat bubble and
// the full-screen viewer. The copy is deleted when its last user releases it.
const entries = new Map();

export async function acquireValidatedImage(fileUri, mimeType) {
  let entry = entries.get(fileUri);
  if (!entry) {
    entry = { refs: 0, lease: null };
    entry.promise = (async () => {
      const lease = await acquireAttachmentFile(fileUri, mediaExtension(mimeType));
      try { await validateImageFile(lease.uri); } catch (error) { lease.release(); throw error; }
      entry.lease = lease;
      return lease.uri;
    })();
    entry.promise.catch(() => { if (entries.get(fileUri) === entry) entries.delete(fileUri); });
    entries.set(fileUri, entry);
  }
  entry.refs += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    if (entries.get(fileUri) === entry) entries.delete(fileUri);
    entry.promise.then(() => {
      try { entry.lease?.release(); } catch { recordCleanup('scratch-delete', false); }
    }, () => {});
  };
  try {
    return { uri: await entry.promise, release };
  } catch (error) {
    release();
    throw error;
  }
}
