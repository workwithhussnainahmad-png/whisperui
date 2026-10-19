import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import StatusBar from '../components/StatusBar';
import Button from '../components/Button';
import Icon from '../components/Icon';
import { sp, radius, shadows } from '../theme';
import { useTheme } from '../hooks/useTheme';
import ScreenContainer from '../components/ScreenContainer';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { connectSocket, getSocket, resetE2E, findRandom } from '../services/socket';

const REASONS = {
  protection_unavailable: 'Screen protection could not stay enabled on this device.',
  peer_unavailable: 'The other device stopped confirming this session.',
  privacy_violation: 'A privacy protection was interrupted on this device.',
  peer_left: 'The other person left the chat.',
  session_expired: 'This session reached its privacy time limit.',
  reported: 'Chat ended after your report.',
  blocked: 'That person was blocked for a while. You can start a new random chat.',
  app_background: 'Chat ended after Whisper stayed in the background.',
  verification_cancelled: 'You left before finishing security verification.',
  user_left: 'You left the chat.',
  connection_lost: 'The connection was lost, so this session ended.',
};

export default function ChatEndedScreen({ navigation, route }) {
  const { colors, typography } = useTheme();
  const { isTablet, horizontalPadding } = useResponsiveLayout();
  const [busy, setBusy] = useState(false);
  const reason = REASONS[route.params?.reasonCode] || 'This conversation has ended.';
  const randomEnded = ['blocked', 'peer_left', 'user_left', 'connection_lost', 'session_expired', 'reported'].includes(route.params?.reasonCode);

  useEffect(() => { resetE2E(); }, []);

  const goHome = async () => {
    if (busy) return;
    setBusy(true);
    resetE2E();
    try {
      if (!getSocket()?.connected) await connectSocket();
    } catch { /* Home surfaces connection issues */ }
    navigation.replace('Home');
  };

  const nextRandom = async () => {
    if (busy) return;
    setBusy(true);
    resetE2E();
    try {
      await connectSocket();
      const result = await findRandom();
      navigation.replace(result.status === 'matched' ? 'Chat' : 'Waiting',
        result.status === 'matched' ? { roomId: result.roomId, chatMode: 'random' } : undefined);
    } catch {
      navigation.replace('Home');
    }
  };

  return (
    <SafeAreaView style={[s.safe, { backgroundColor: colors.surface }]} edges={['top', 'bottom']}>
      <StatusBar />
      <ScreenContainer variant="content">
        <View style={[s.body, { paddingHorizontal: horizontalPadding + sp.md }]}>
          <View style={[s.hero, { backgroundColor: colors.surface1, borderColor: colors.hairline }, shadows.sm]}>
            <View style={[s.iconWrap, { backgroundColor: colors.accentTint }, isTablet && s.iconWrapTablet]}>
              <Icon name="shield-checkmark-outline" size={isTablet ? 36 : 30} color={colors.accent} />
            </View>
            <Text style={[typography.title, { color: colors.text, textAlign: 'center' }]}>Chat ended</Text>
            <Text style={[typography.body, { color: colors.textSecondary, textAlign: 'center', marginTop: sp.sm }]}>
              Messages from this session were cleared from this app.
            </Text>
            <View style={[s.reasonBox, { backgroundColor: colors.surface2, borderColor: colors.separator }]}>
              <Text style={[typography.caption, { color: colors.textSecondary, textAlign: 'center' }]}>{reason}</Text>
            </View>
            <View style={s.keepRow}>
              <Icon name="lock-closed-outline" size={16} color={colors.textTertiary} />
              <Text style={[typography.caption, { color: colors.textTertiary, flex: 1 }]}>
                Files you saved privately stay in Saved Files.
              </Text>
            </View>
          </View>

          <View style={s.btns}>
            {busy && <ActivityIndicator color={colors.accent} style={{ marginBottom: sp.sm }} />}
            {randomEnded && (
              <Button title="Next random chat" icon="shuffle-outline" size="lg" fullWidth
                disabled={busy} onPress={nextRandom} />
            )}
            <Button variant={randomEnded ? 'ghost' : 'primary'} size="lg" fullWidth
              title="Back to Home" icon="home-outline" disabled={busy} onPress={goHome} />
          </View>
        </View>
      </ScreenContainer>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1 },
  body: { flex: 1, justifyContent: 'center', paddingVertical: sp.xl },
  hero: {
    borderRadius: radius.xxl,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: sp.lg,
    paddingVertical: sp.xl,
    alignItems: 'center',
  },
  iconWrap: {
    width: 68,
    height: 68,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: sp.lg,
  },
  iconWrapTablet: { width: 84, height: 84 },
  reasonBox: {
    marginTop: sp.lg,
    width: '100%',
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: sp.md,
    paddingVertical: sp.md,
  },
  keepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: sp.sm,
    marginTop: sp.lg,
    width: '100%',
  },
  btns: { width: '100%', marginTop: sp.xxl, gap: sp.md },
});
