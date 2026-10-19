// Never accept an Error, path, filename or arbitrary log text.
const allowed = new Set(['startup-media', 'startup-exports', 'startup-captures', 'capture-protection', 'attachment-delete', 'scratch-delete', 'qr-delete', 'external-share-delete', 'native-temp', 'storage-protection']);
let status = { last: 'not-run', attempts: 0, failures: 0, categories: {} };
export function recordCleanup(category, ok) {
  const safe = allowed.has(category) ? category : 'other';
  status.attempts++;
  status.last = ok ? 'ok' : 'failed';
  if (!ok) {
    status.failures++;
    status.categories[safe] = (status.categories[safe] || 0) + 1;
    console.warn('[Whisper cleanup]', safe, status.categories[safe]);
  }
}
export function getCleanupStatus() { return { ...status, categories: { ...status.categories } }; }
export async function observeCleanup(category, work) {
  try { const result = await work(); recordCleanup(category, true); return result; }
  catch (error) { recordCleanup(category, false); throw error; }
}
