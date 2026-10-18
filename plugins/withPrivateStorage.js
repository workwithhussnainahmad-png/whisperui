const { withAndroidManifest, withDangerousMod, withInfoPlist, withEntitlementsPlist } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');
const domains = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'];
const excludes = domains.map(domain => `    <exclude domain="${domain}" path="." />`).join('\n');
const resources = {
  'whisper_backup_rules.xml': `<full-backup-content>\n${excludes}\n</full-backup-content>\n`,
  'whisper_extraction_rules.xml': `<data-extraction-rules>\n  <cloud-backup>\n${excludes}\n  </cloud-backup>\n  <device-transfer>\n${excludes}\n  </device-transfer>\n</data-extraction-rules>\n`,
  // App resources override the dependency's identically named broad resource.
  'file_system_provider_paths.xml': '<paths />\n',
  'image_picker_provider_paths.xml': '<paths />\n',
  'sharing_provider_paths.xml': '<paths><cache-path name="whisper_qr" path="whisper-share/" /></paths>\n',
};
module.exports = function withPrivateStorage(config) {
  config = withEntitlementsPlist(config, mod => {
    mod.modResults['com.apple.developer.default-data-protection'] = 'NSFileProtectionComplete';
    return mod;
  });
  config = withInfoPlist(config, mod => {
    Object.assign(mod.modResults, { UIFileSharingEnabled: false, LSSupportsOpeningDocumentsInPlace: false, UISupportsDocumentBrowser: false });
    delete mod.modResults.CFBundleDocumentTypes;
    return mod;
  });
  config = withAndroidManifest(config, mod => {
    const manifest = mod.modResults.manifest;
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    const app = manifest.application[0];
    Object.assign(app.$, { 'android:allowBackup': 'false', 'android:fullBackupContent': '@xml/whisper_backup_rules', 'android:dataExtractionRules': '@xml/whisper_extraction_rules' });
    app.$['tools:replace'] = [...new Set([...(app.$['tools:replace'] || '').split(',').filter(Boolean), 'android:allowBackup', 'android:fullBackupContent', 'android:dataExtractionRules'])].join(',');
    return mod;
  });
  return withDangerousMod(config, ['android', async mod => {
    const directory = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    await fs.mkdir(directory, { recursive: true });
    for (const [name, xml] of Object.entries(resources)) await fs.writeFile(path.join(directory, name), '<?xml version="1.0" encoding="utf-8"?>\n' + xml);
    return mod;
  }]);
};
