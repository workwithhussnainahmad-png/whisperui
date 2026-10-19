const { withPodfile, withProjectBuildGradle, withAppBuildGradle } = require('expo/config-plugins');
const MARKER = '# Whisper libsignal 0.105.1';
// Pinned upstream tag commit and published iOS archive checksum. Update together
// with both native bridges and the test-only Node dependency.
const IOS = `${MARKER}
  ENV['LIBSIGNAL_FFI_PREBUILD_CHECKSUM'] = '338a98c2a6a11e48b5666de4b89d0877757f474a06be968f8568bf783a45b823'
  pod 'LibSignalClient', :git => 'https://github.com/signalapp/libsignal.git', :commit => '1738ead8a12ffe539f6309958123dadb16dc3b95'
`;
const ANDROID = `
// Whisper libsignal repository
allprojects {
  repositories {
    maven {
      url 'https://build-artifacts.signal.org/libraries/maven/'
      content { includeGroup 'org.signal' }
    }
  }
}
`;
function addPodfile(contents) {
  if (contents.includes(MARKER)) return contents;
  const anchor = 'use_expo_modules!';
  if (!contents.includes(anchor)) throw new Error('Cannot install the pinned libsignal pod');
  return contents.replace(anchor, `${anchor}\n  ${IOS}`);
}

function addAppBuildGradle(contents) {
  let updated = contents;

  // 1. Ensure coreLibraryDesugaring dependency is present
  const desugarDep = "    coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'";
  if (!updated.includes('coreLibraryDesugaring')) {
    const depAnchor = 'dependencies {';
    if (!updated.includes(depAnchor)) throw new Error('Cannot find dependencies block in app/build.gradle');
    updated = updated.replace(depAnchor, `${depAnchor}\n${desugarDep}`);
  }

  // 2. Ensure compileOptions has coreLibraryDesugaringEnabled true
  if (!updated.includes('coreLibraryDesugaringEnabled true')) {
    if (updated.includes('compileOptions {')) {
      updated = updated.replace('compileOptions {', 'compileOptions {\n        coreLibraryDesugaringEnabled true');
    } else {
      const androidAnchor = 'android {';
      if (!updated.includes(androidAnchor)) throw new Error('Cannot find android block in app/build.gradle');
      const compileOptionsBlock = `    compileOptions {
        coreLibraryDesugaringEnabled true
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }\n`;
      updated = updated.replace(androidAnchor, `${androidAnchor}\n${compileOptionsBlock}`);
    }
  }

  return updated;
}

module.exports = function withSignal(config) {
  config = withPodfile(config, (mod) => { mod.modResults.contents = addPodfile(mod.modResults.contents); return mod; });
  config = withAppBuildGradle(config, (mod) => { mod.modResults.contents = addAppBuildGradle(mod.modResults.contents); return mod; });
  return withProjectBuildGradle(config, (mod) => {
    if (!mod.modResults.contents.includes('// Whisper libsignal repository')) mod.modResults.contents += ANDROID;
    return mod;
  });
};
module.exports.addPodfile = addPodfile;
module.exports.androidRepository = ANDROID;
module.exports.addAppBuildGradle = addAppBuildGradle;
