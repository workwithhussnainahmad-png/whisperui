const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseStringPromise } = require('xml2js');
const { compileModsAsync } = require('expo/config-plugins');
const plist = require('@expo/plist').default;
const plugin = require('../plugins/withPrivateStorage');
const { transformSync } = require('@babel/core');

test('prebuild plugin generates deny-all backup rules and QR-only FileProvider; repeat is stable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'android/app/src/main');
  fs.mkdirSync(main, { recursive: true });
  fs.writeFileSync(path.join(main, 'AndroidManifest.xml'), '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.whisper.test"><application android:allowBackup="true" /></manifest>');
  for (let i = 0; i < 2; i++) {
    const config = plugin({ name: 'Test', slug: 'test', android: { package: 'com.whisper.test' } });
    await compileModsAsync(config, { projectRoot: root, platforms: ['android'] });
    const parsed = await parseStringPromise(fs.readFileSync(path.join(main, 'AndroidManifest.xml'), 'utf8'));
    const app = parsed.manifest.application[0].$;
    assert.equal(app['android:allowBackup'], 'false');
    assert.equal(app['android:fullBackupContent'], '@xml/whisper_backup_rules');
    assert.equal(app['android:dataExtractionRules'], '@xml/whisper_extraction_rules');
    const xml = async name => parseStringPromise(fs.readFileSync(path.join(main, 'res/xml', name), 'utf8'));
    const full = (await xml('whisper_backup_rules.xml'))['full-backup-content'];
    const extraction = (await xml('whisper_extraction_rules.xml'))['data-extraction-rules'];
    for (const node of [full, extraction['cloud-backup'][0], extraction['device-transfer'][0]]) {
      assert.equal(node.include, undefined);
      const domains = node.exclude.map(item => { assert.equal(item.$.path, '.'); return item.$.domain; }).sort();
      assert.deepEqual(domains, ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'].sort());
    }
    for (const name of ['file_system_provider_paths.xml', 'image_picker_provider_paths.xml']) assert.equal((await xml(name)).paths, '');
    const provider = (await xml('sharing_provider_paths.xml')).paths;
    assert.deepEqual(Object.keys(provider), ['cache-path']);
    assert.deepEqual(provider['cache-path'], [{ $: { name: 'whisper_qr', path: 'whisper-share/' } }]);
    for (const forbidden of ['../no_backup/vault/a.box', 'whisper-chat-media/a.png', 'Camera/a.jpg', 'whisper-share/../whisper-chat-media/a.png']) {
      const allowed = path.resolve('/cache/whisper-share') + path.sep;
      assert.equal(path.resolve('/cache', forbidden).startsWith(allowed), false);
    }
  }
  const library = await parseStringPromise(fs.readFileSync('node_modules/expo-sharing/android/src/main/AndroidManifest.xml', 'utf8'));
  assert.equal(library.manifest.application[0].provider[0]['meta-data'][0].$['android:resource'], '@xml/sharing_provider_paths');
});

test('iOS config mod explicitly disables every document sharing entry', async () => {
  const config = plugin({ name: 'Test', slug: 'test' });
  const result = await config.mods.ios.infoPlist({ ...config, modResults: { UIFileSharingEnabled: true, LSSupportsOpeningDocumentsInPlace: true, UISupportsDocumentBrowser: true, CFBundleDocumentTypes: [{}] }, modRequest: {}, modRawConfig: {}, });
  const parsed = plist.parse(plist.build(result.modResults));
  for (const key of ['UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace', 'UISupportsDocumentBrowser']) assert.equal(parsed[key], false);
  assert.equal(parsed.CFBundleDocumentTypes, undefined);
  const entitlements = await config.mods.ios.entitlements({ ...config, modResults: {}, modRequest: {}, modRawConfig: {} });
  assert.equal(entitlements.modResults['com.apple.developer.default-data-protection'], 'NSFileProtectionComplete');
});
function load(name, mocks = {}, logger = console, dev = false) {
  const filename = path.resolve('src/services', name + '.js');
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), { filename, configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-modules-commonjs'] });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'console', '__DEV__', code)(id => { if (id in mocks) return mocks[id]; throw new Error('Unmocked ' + id); }, module, module.exports, logger, dev);
  return module.exports;
}
test('cleanup status logs only allowlisted categories and counts even with malicious input', async () => {
  const logs = [];
  const api = load('cleanupStatus', {}, { warn: (...args) => logs.push(args) });
  api.recordCleanup('/private/secret-name.png KEY-SECRET', false);
  await assert.rejects(api.observeCleanup('qr-delete', () => { throw new Error('/secret/document.pdf'); }));
  api.recordCleanup('startup-media', true);
  assert.deepEqual(logs, [['[Whisper cleanup]', 'other', 1], ['[Whisper cleanup]', 'qr-delete', 1]]);
  assert.equal(api.getCleanupStatus().failures, 2);
  assert.equal(api.getCleanupStatus().last, 'ok');
  const snapshot = api.getCleanupStatus(); snapshot.categories.other = 100;
  assert.equal(api.getCleanupStatus().categories.other, 1);
});
for (const failure of [false, true]) test(`QR sharing uses only dedicated directory and deletes on ${failure ? 'failure' : 'success'}`, async () => {
  const files = new Map([['file:///cache/whisper-share/old.png', 'old']]);
  const protectedPaths = [], shared = [];
  const api = load('mediaExport', {
    'expo-file-system/legacy': { cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' }, makeDirectoryAsync: async () => {},
      deleteAsync: async uri => { for (const key of files.keys()) if (key === uri || key.startsWith(uri)) files.delete(key); },
      writeAsStringAsync: async (uri, bytes) => files.set(uri, bytes) },
    'expo-sharing': { isAvailableAsync: async () => true, shareAsync: async uri => { shared.push(uri); assert.equal(files.get(uri), 'PNG'); if (failure) throw new Error('cancel'); } },
    'expo-crypto': { randomUUID: () => 'random-id' },
    './documentMedia': { initializeAttachmentTools: async () => {} },
    './privateStorage': { preparePrivateStorage: async () => {}, protectPrivateTemporary: uri => protectedPaths.push(uri) },
    './cleanupStatus': { observeCleanup: async (_, work) => work() },
  });
  if (failure) await assert.rejects(api.shareInviteQr('PNG')); else await api.shareInviteQr('PNG');
  assert.deepEqual(shared, ['file:///cache/whisper-share/random-id.png']);
  assert.deepEqual(protectedPaths, ['file:///cache/whisper-share/', 'file:///cache/whisper-share/random-id.png']);
  assert.equal(files.size, 0);
});


test('privacy self-check is debug-only and reads native flags plus cleanup status', async () => {
  let calls = 0;
  const mocks = {
    'react-native': { Platform: { OS: 'android' } },
    'expo-modules-core': { requireOptionalNativeModule: () => ({ privacySelfCheck: async () => { calls++; return { allowBackup: false, potentialPlaintextTempFiles: 0 }; } }) },
    './cleanupStatus': { getCleanupStatus: () => ({ last: 'ok', failures: 0 }), observeCleanup: async (_, fn) => fn() },
  };
  await assert.rejects(load('privateStorage', mocks).privacySelfCheck(), /debug builds/);
  assert.equal(calls, 0);
  assert.deepEqual(await load('privateStorage', mocks, console, true).privacySelfCheck(), { allowBackup: false, potentialPlaintextTempFiles: 0, cleanup: { last: 'ok', failures: 0 } });
});
