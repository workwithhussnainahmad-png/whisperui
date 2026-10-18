import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import StatusBar from '../components/StatusBar';
import Button from '../components/Button';
import Icon from '../components/Icon';
import { sp, radius } from '../theme';
import { useTheme } from '../hooks/useTheme';
import ScreenContainer from '../components/ScreenContainer';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { connectSocket, getSocket, resetE2E } from '../services/socket';

export default function ChatEndedScreen({ navigation, route }) {
  const { colors, typography } = useTheme();
  const { isTablet } = useResponsiveLayout();

  const reasons = {
    protection_unavailable: 'Required screen protection could not be enabled.',
    peer_unavailable: 'The other device stopped confirming this session. The chat was closed.',
    privacy_violation: 'The session ended because a privacy protection was interrupted.',
    peer_left: 'The other person left.',
    session_expired: 'The session reached its privacy time limit.',
    reported: 'Chat ended due to a report.',
    app_background: 'Chat ended when the app stayed in the background.',
    verification_cancelled: 'You left before completing security verification.',
    user_left: 'You left the chat.',
    connection_lost: 'The connection was lost. Your chat session ended.',
  };
  const reason = reasons[route.params?.reasonCode] || 'Chat ended.';

  useEffect(() => {
    resetE2E();
  }, []);

  const goHome = async () => {
    resetE2E();
    try {
      if (!getSocket()?.connected) {
        await connectSocket();
      }
    } catch {
      // Home will surface connection issues on next action
    }
    navigation.replace('Home');
  };

  return (
    <SafeAreaView style={[s.safe, { backgroundColor: colors.surface }]} edges={['top', 'bottom']}>
      <StatusBar />
      <ScreenContainer variant="content">
        <View style={s.body}>
          <View style={[s.iconWrap, { backgroundColor: colors.surface2, borderColor: colors.hairline }, isTablet && s.iconWrapTablet]}>
            <Icon name="checkmark" size={isTablet ? 34 : 28} color={colors.accent} />
          </View>
          <Text style={[typography.title, { color: colors.text, marginBottom: sp.xs }]}>Chat ended</Text>
          <Text style={[typography.body, { color: colors.textSecondary }]}>The conversation has been cleared from this app.</Text>
          <Text style={[typography.caption, { color: colors.textTertiary, marginTop: sp.sm }]}>Files saved privately in Whisper remain in Saved Files.</Text>
          <Text style={[typography.caption, { color: colors.textTertiary, fontStyle: 'italic', marginTop: sp.sm, textAlign: 'center' }]}>
            {reason}
          </Text>

          <View style={s.btns}>
            <Button
              variant="primary"
              size="lg"
              fullWidth
              title="Back to Home"
              icon="home-outline"
              onPress={goHome}
            />
          </View>
        </View>
      </ScreenContainer>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1 },
  body: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: sp.xl },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: sp.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  iconWrapTablet: { width: 80, height: 80 },
  btns: { width: '100%', marginTop: sp.xxl, gap: sp.md },
});
