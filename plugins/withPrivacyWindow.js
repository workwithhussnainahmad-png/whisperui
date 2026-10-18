const { withMainActivity, withAndroidManifest, withDangerousMod, withAppBuildGradle } = require('expo/config-plugins');

const fs = require('node:fs/promises');
const path = require('node:path');

const marker = '// Whisper native window privacy';
const onCreateCode = `    ${marker}
    window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
    if (android.os.Build.VERSION.SDK_INT >= 31) window.setHideOverlayWindows(true)
    if (android.os.Build.VERSION.SDK_INT >= 29) {
      (getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager)
        .setAllowedCapturePolicy(android.media.AudioAttributes.ALLOW_CAPTURE_BY_NONE)
    }
`;
const touchCode = `
  // Discard obscured input; report evidence rather than scanning installed apps.
  private var lastPrivacyEventAt = 0L
  override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
    val obscured = (event.flags and android.view.MotionEvent.FLAG_WINDOW_IS_OBSCURED) != 0 ||
      (android.os.Build.VERSION.SDK_INT >= 29 &&
        (event.flags and android.view.MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED) != 0)
    if (obscured) {
      val now = android.os.SystemClock.elapsedRealtime()
      if (now - lastPrivacyEventAt > 1000L) {
        lastPrivacyEventAt = now
        val context = (application as com.facebook.react.ReactApplication).reactHost?.currentReactContext
        context?.getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          ?.emit("WhisperPrivacyViolation", "overlay")
      }
      return true
    }
    return super.dispatchTouchEvent(event)
  }
`;

module.exports = function withPrivacyWindow(config) {
  config = withAppBuildGradle(config, (mod) => {
    if (!mod.modResults.contents.includes('// Whisper release signing guard')) {
      mod.modResults.contents += require('./releaseSigning');
    }
    return mod;
  });
  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const permissions = manifest['uses-permission'] || [];
    if (!permissions.some((entry) => entry.$?.['android:name'] === 'android.permission.HIDE_OVERLAY_WINDOWS')) {
      permissions.push({ $: { 'android:name': 'android.permission.HIDE_OVERLAY_WINDOWS' } });
    }
    manifest['uses-permission'] = permissions;
    manifest.application[0].$['android:allowAudioPlaybackCapture'] = 'false';
    manifest.application[0].$['android:networkSecurityConfig'] = '@xml/network_security_config';
    manifest.application[0].$['android:usesCleartextTraffic'] = 'false';
    return mod;
  });
  config = withDangerousMod(config, ['android', async (mod) => {
    const directory = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'network_security_config.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors><certificates src="system"/></trust-anchors>
  </base-config>
</network-security-config>
`);
    return mod;
  }]);
  return withMainActivity(config, (mod) => {
    if (mod.modResults.language !== 'kt') throw new Error('Privacy window plugin requires Kotlin MainActivity');
    let contents = mod.modResults.contents;
    if (!contents.includes(marker)) {
      const anchor = '    super.onCreate(null)';
      if (!contents.includes(anchor)) throw new Error('Cannot install privacy flags before activity initialization');
      contents = contents.replace(anchor, onCreateCode + anchor);
    }
    if (!contents.includes('override fun dispatchTouchEvent(')) {
      const closing = contents.lastIndexOf('}');
      contents = contents.slice(0, closing) + touchCode + contents.slice(closing);
    } else if (!contents.includes('WhisperPrivacyViolation')) {
      throw new Error('Review existing touch handler before installing privacy guard');
    }
    mod.modResults.contents = contents;
    return mod;
  });
};
