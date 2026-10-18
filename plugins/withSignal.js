const { withPodfile, withProjectBuildGradle } = require('expo/config-plugins');
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
module.exports = function withSignal(config) {
  config = withPodfile(config, (mod) => { mod.modResults.contents = addPodfile(mod.modResults.contents); return mod; });
  return withProjectBuildGradle(config, (mod) => {
    if (!mod.modResults.contents.includes('// Whisper libsignal repository')) mod.modResults.contents += ANDROID;
    return mod;
  });
};
module.exports.addPodfile = addPodfile;
module.exports.androidRepository = ANDROID;
