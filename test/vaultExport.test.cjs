const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { transformSync } = require('@babel/core');
function fixture({ failShare = false, failPrepare = false, cancel = false, lock = false, native = true, platform = 'ios', originalFallback = false, cleanupFailure = false } = {}) {
  const files = new Map(), original = Buffer.from('encrypted original vault bytes');
  const calls = []; let lockListener, appListener; let api;
  const appState = { currentState: 'active', addEventListener(_, listener) { appListener = listener; return { remove() {} }; } };
  const deps = {
    'expo-file-system/legacy': { cacheDirectory: 'file:///cache/', async getInfoAsync(uri) { return { exists: files.has(uri) }; }, async makeDirectoryAsync(uri) { calls.push(['mkdir', uri]); },
      async copyAsync({ from, to }) { files.set(to, files.get(from)); }, async deleteAsync(uri) { if (cleanupFailure && uri.includes('whisper-vault-share')) throw new Error('cleanup failed'); for (const key of [...files.keys()]) if (key.startsWith(uri)) files.delete(key); } },
    'expo-sharing': { async isAvailableAsync() { return true; }, async shareAsync(uri, options) {
      calls.push(['share', uri, options]); assert.match(uri, /^file:\/\/\/cache\/whisper-vault-share\/id\/Whisper\.jpg$/);
      assert.equal(files.get(uri), 'sanitized pixels'); assert.ok(!files.has('file:///preview'));
      assert.ok(!files.has('file:///sanitized')); assert.ok(!files.has('encrypted-stage'));
      if (platform === 'android') { appState.currentState = 'background'; setImmediate(() => { assert.ok(files.has(uri)); appState.currentState = 'active'; appListener('active'); }); }
      if (failShare) throw new Error('share failed');
    } },
    'expo-crypto': { randomUUID: () => 'id' },
    'react-native': { Platform: { OS: platform }, AppState: appState },
    './privateVault': { vaultError: e => e.message, subscribeVaultLock(listener) { lockListener = listener; return () => { lockListener = null; }; }, async acquireVaultPreview() {
      files.set('file:///preview', 'original pixels with metadata'); return { uri: 'file:///preview', release() { files.delete('file:///preview'); } };
    } },
    './prepareAttachment': { async prepareAttachment(asset, active, confirm) {
      if (originalFallback) await confirm('Send original file?', 'Original metadata included');
      if (failPrepare) throw new Error('sanitize failed'); if (cancel) return null;
      if (lock) { lockListener({ locked: true }); assert.equal(active(), false); throw new Error('locked'); }
      files.set('encrypted-stage', 'sanitized pixels'); return { fileUri: 'encrypted-stage', mimeType: 'image/jpeg' };
    } },
    './attachmentFiles': { deleteAttachment: uri => files.delete(uri), mediaExtension: () => 'jpg', async acquireAttachmentFile() {
      files.set('file:///sanitized', 'sanitized pixels'); return { uri: 'file:///sanitized', release() { files.delete('file:///sanitized'); } };
    } },
    './documentMedia': { hasNativeDocumentTools: () => native, isOffice: mime => mime.includes('officedocument') },
    './mediaExport': { async cleanAbandonedExports() {} },
    './privateStorage': { protectPrivateTemporary: uri => calls.push(['protect', uri]) },
    './cleanupStatus': { observeCleanup: async (_, work) => work() },
  };
  const code = transformSync(fs.readFileSync('src/services/vaultExport.js', 'utf8'), { configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-modules-commonjs'] }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', code)(id => { assert.ok(deps[id], id); return deps[id]; }, module, module.exports, fn => setImmediate(fn));
  api = module.exports;
  return { api, files, calls, original };
}
const item = { id: 'vault-id', mime: 'image/jpeg', name: 'private-name.jpg', size: 100 };
test('shares only sanitized private export; original unchanged and all temporary copies removed', async () => {
  const f = fixture(); const before = Buffer.from(f.original);
  assert.equal(await f.api.shareSavedFile(item, async () => true), true);
  assert.deepEqual(f.original, before); assert.equal(f.files.size, 0);
  assert.equal(f.calls.filter(c => c[0] === 'share').length, 1);
  assert.ok(f.calls.some(c => c[0] === 'protect' && c[1].endsWith('Whisper.jpg')));
});
for (const [label, options] of [['share failure', { failShare: true }], ['sanitizer failure', { failPrepare: true }], ['lock during preparation', { lock: true }]]) {
  test(`${label} cleans temporary files without modifying the saved original`, async () => {
    const f = fixture(options); const before = Buffer.from(f.original);
    await assert.rejects(f.api.shareSavedFile(item, async () => true)); assert.equal(f.files.size, 0); assert.deepEqual(f.original, before);
  });
}
test('conversion cancellation shares nothing and cleans its vault preview', async () => {
  const f = fixture({ cancel: true }); assert.equal(await f.api.shareSavedFile(item, async () => false), false);
  assert.equal(f.files.size, 0); assert.equal(f.calls.filter(c => c[0] === 'share').length, 0);
});
test('unsupported formats and unavailable native sanitization fail before vault decryption', async () => {
  const f = fixture({ native: false });
  await assert.rejects(f.api.shareSavedFile({ ...item, mime: 'application/zip' }), /not supported/);
  await assert.rejects(f.api.shareSavedFile({ ...item, mime: 'video/mp4' }), /native/);
  assert.equal(f.files.size, 0); assert.equal(f.calls.length, 0);
});
test('Android retains the export during the receiving activity and deletes after return', async () => {
  const f = fixture({ platform: 'android' }); await f.api.shareSavedFile(item, async () => true); assert.equal(f.files.size, 0);
});

test('sanitizer cannot fall back to sharing the original even if the user confirms conversions', async () => {
  const f = fixture({ originalFallback: true });
  await assert.rejects(f.api.shareSavedFile(item, async () => true), /Metadata removal/);
  assert.equal(f.files.size, 0); assert.equal(f.calls.filter(c => c[0] === 'share').length, 0);
});
test('cleanup failure is surfaced rather than claiming the export was deleted', async () => {
  const f = fixture({ cleanupFailure: true });
  await assert.rejects(f.api.shareSavedFile(item, async () => true), /cleanup failed/);
  assert.equal(f.files.size, 1);
});
test('reset cleanup removes abandoned export copies', async () => {
  const f = fixture(); f.files.set('file:///cache/whisper-vault-share/old/Whisper.jpg', 'copy');
  await f.api.clearExternalShareFiles(); assert.equal(f.files.size, 0);
});
