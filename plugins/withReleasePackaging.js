const { withAppBuildGradle } = require('expo/config-plugins');
const MARKER = '// Whisper release-only native packaging';
module.exports = config => withAppBuildGradle(config, mod => {
  if (!mod.modResults.contents.includes(MARKER)) mod.modResults.contents += `
${MARKER}
android {
  packaging {
    // Desktop JNI files in the Java JAR are not Android runtime libraries.
    resources { excludes += ['libsignal_jni*.so'] }
    // Native test-only APIs are never used by the app.
    jniLibs { excludes += ['**/libsignal_jni_testing.so'] }
  }
}
`;
  return mod;
});
