const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../app.config');
const base = require('../app.json').expo;
test('release config persists ARM-only architecture, shrinkers, Hermes and JNI keep rules', () => {
 const old = process.env.EAS_BUILD_PROFILE;
 try { for (const profile of ['preview', 'production', 'preview-universal']) {
   process.env.EAS_BUILD_PROFILE = profile;
   const result = config({ config: base });
   const android = result.plugins.find(p => Array.isArray(p) && p[0] === 'expo-build-properties')[1].android;
   assert.deepEqual(android.buildArchs, profile === 'preview-universal' ? ['arm64-v8a','armeabi-v7a'] : ['arm64-v8a']);
   assert.equal(android.enableMinifyInReleaseBuilds, true); assert.equal(android.enableShrinkResourcesInReleaseBuilds, true);
   assert.equal(result.jsEngine, 'hermes'); assert.match(android.extraProguardRules, /org\.signal\.libsignal/);
   assert.match(android.extraProguardRules, /com\.whisper\.privacy/);
 }} finally { if (old === undefined) delete process.env.EAS_BUILD_PROFILE; else process.env.EAS_BUILD_PROFILE = old; }
 const eas = require('../eas.json'); assert.equal(eas.build.preview.android.buildType, 'apk'); assert.equal(eas.build.production.android.buildType, 'app-bundle');
});
test('desktop resource exclusion keeps Android runtime JNI library path intact', async () => {
 const plugin = require('../plugins/withReleasePackaging');
 const config = plugin({ name:'test', slug:'test' });
 const result = await config.mods.android.appBuildGradle({ ...config, modResults: { language:'groovy', contents:'android {}' }, modRequest: {} });
 assert.match(result.modResults.contents, /resources \{ excludes \+= \['libsignal_jni\*\.so'\]/);
 assert.match(result.modResults.contents, /jniLibs \{ excludes \+= \['\*\*\/libsignal_jni_testing\.so'\]/);
 assert.doesNotMatch(result.modResults.contents, /jniLibs.*libsignal_jni\*\.so/);
});
