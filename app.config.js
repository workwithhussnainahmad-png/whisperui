const { withMainActivity } = require('expo/config-plugins');

const TABLET_ORIENTATION_MARKER = '// Keep the tablet UI in landscape while phones remain unrestricted.';
const DEPLOYED_SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'https://mywhisperchat.duckdns.org';

const withTabletLandscape = (config) => withMainActivity(config, (modConfig) => {
  if (modConfig.modResults.language !== 'kt') return modConfig;

  let { contents } = modConfig.modResults;
  if (!contents.includes('import android.content.pm.ActivityInfo')) {
    contents = contents.replace(
      'import android.os.Build\n',
      'import android.content.pm.ActivityInfo\nimport android.content.res.Configuration\nimport android.os.Build\n',
    );
  }

  if (!contents.includes(TABLET_ORIENTATION_MARKER)) {
    contents = contents.replace(
      '    setTheme(R.style.AppTheme);\n    super.onCreate(null)',
      `    setTheme(R.style.AppTheme);\n    ${TABLET_ORIENTATION_MARKER}\n    if (isTablet()) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE\n    super.onCreate(null)`,
    );
    contents = contents.replace(
      '\n  /**\n   * Returns the name of the main component registered from JavaScript.',
      `\n  private fun isTablet(): Boolean {\n    val size = resources.configuration.screenLayout and Configuration.SCREENLAYOUT_SIZE_MASK\n    return size >= Configuration.SCREENLAYOUT_SIZE_LARGE\n  }\n\n  /**\n   * Returns the name of the main component registered from JavaScript.`,
    );
  }

  modConfig.modResults.contents = contents;
  return modConfig;
});

module.exports = ({ config }) => {
  const buildPropertyPlugins = (config.plugins || []).filter((plugin) =>
    Array.isArray(plugin) && plugin[0] === 'expo-build-properties'
  );
  if (buildPropertyPlugins.length !== 1) {
    throw new Error('Exactly one configured expo-build-properties plugin is required');
  }

  const plugins = (config.plugins || []).map((plugin) => {
    if (!Array.isArray(plugin) || plugin[0] !== 'expo-build-properties') return plugin;
    const options = plugin[1];
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('expo-build-properties must use an options object');
    }
    return [plugin[0], {
      ...options,
      android: {
        ...(options.android || {}),
        usesCleartextTraffic: false,
        packagingOptions: {
          ...(options.android?.packagingOptions || {}),
          exclude: [...new Set([...(options.android?.packagingOptions?.exclude || []), '**/*.dll', '**/*.dylib'])],
        },
      },
      ios: { ...(options.ios || {}), useFrameworks: 'static' },
    }];
  });
  plugins.push(withTabletLandscape);
  plugins.push(require('./plugins/withPrivacyWindow'));
  plugins.push(require('./plugins/withSignal'));
  plugins.push(require('./plugins/withPrivateStorage'));

  return {
    ...config,
    plugins,
    extra: {
      ...(config.extra || {}),
      serverUrl: DEPLOYED_SERVER_URL,
    },
    ios: {
      ...(config.ios || {}),
      infoPlist: {
        ...(config.ios?.infoPlist || {}),
        NSFaceIDUsageDescription: 'Use Face ID to unlock your private Saved Files.',
        UIFileSharingEnabled: false,
        UISupportsDocumentBrowser: false,
        LSSupportsOpeningDocumentsInPlace: false,
        'UISupportedInterfaceOrientations~ipad': [
          'UIInterfaceOrientationLandscapeLeft',
          'UIInterfaceOrientationLandscapeRight',
        ],
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: false,
        },
      },
    },
  };
};
