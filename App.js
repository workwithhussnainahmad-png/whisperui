import { initializeVaultLock, setVaultAppActive } from './src/services/privateVault';
/**
 * App.js — Anonymous Chat App Entry Point
 *
 * Navigation and chat state are held in memory. Files explicitly saved by the
 * user persist encrypted in the private vault until deletion or Reset Whisper.
 * See SECURITY.md for unfinished protections and platform limitations.
 */

import React, { useEffect, useMemo } from 'react';
import { useColorScheme, AppState } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { ensureCaptureProtection } from './src/services/captureProtection';
import { initializeAttachmentFiles } from './src/services/attachmentFiles';
import { cleanAbandonedCaptures } from './src/services/cameraCache';
import { cleanAbandonedExports } from './src/services/mediaExport';
import { recordCleanup, observeCleanup } from './src/services/cleanupStatus';
import SplashScreen from './src/screens/SplashScreen';
import HomeScreen from './src/screens/HomeScreen';
import WaitingScreen from './src/screens/WaitingScreen';
import ChatScreen from './src/screens/ChatScreen';
import GroupJoinScreen from './src/screens/GroupJoinScreen';
import GroupChatScreen from './src/screens/GroupChatScreen';
import ChatEndedScreen from './src/screens/ChatEndedScreen';
import SavedFilesScreen from './src/screens/SavedFilesScreen';
import { light, dark, brand } from './src/theme';

const Stack = createNativeStackNavigator();

function buildNavTheme(isDark) {
  const palette = isDark ? dark : light;
  const base = isDark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark: isDark,
    colors: {
      ...base.colors,
      primary: brand.accent,
      background: palette.surface,
      card: palette.surface1,
      text: palette.text,
      border: palette.border,
      notification: brand.accent,
    },
  };
}

export default function App() {
  const scheme = useColorScheme();
  const isDark = scheme !== 'light';
  const theme = useMemo(() => buildNavTheme(isDark), [isDark]);
  const contentBg = isDark ? dark.surface : light.surface;

  useEffect(() => {
    initializeVaultLock().catch(() => { /* Saved Files presents recovery without exposing key details. */ });
    setVaultAppActive(AppState.currentState === 'active');
    const vaultLifecycle = AppState.addEventListener('change', state => setVaultAppActive(state === 'active'));
    // Chat awaits the same promise and fails closed on initialization errors.
    ensureCaptureProtection().catch(() => recordCleanup('capture-protection', false));
    (async () => {
      // These services record failures before rejecting; do not log their Error objects.
      try { await cleanAbandonedExports(); } catch { /* Recorded by startup-exports. */ }
      try { await observeCleanup('startup-captures', cleanAbandonedCaptures); } catch { /* Recorded above. */ }
      try { initializeAttachmentFiles(); recordCleanup('startup-media', true); } catch { recordCleanup('startup-media', false); }
    })();
    return () => vaultLifecycle.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
        <NavigationContainer theme={theme}>
          <Stack.Navigator
            initialRouteName="Splash"
            screenOptions={{
              headerShown: false,
              animation: 'fade',
              gestureEnabled: false,
              contentStyle: { backgroundColor: contentBg },
            }}
          >
            <Stack.Screen name="Splash" component={SplashScreen} />
            <Stack.Screen name="Home" component={HomeScreen} />
            <Stack.Screen name="SavedFiles" component={SavedFilesScreen} />
            <Stack.Screen name="Waiting" component={WaitingScreen} />
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen name="GroupJoin" component={GroupJoinScreen} />
            <Stack.Screen name="GroupChat" component={GroupChatScreen} />
            <Stack.Screen name="ChatEnded" component={ChatEndedScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
