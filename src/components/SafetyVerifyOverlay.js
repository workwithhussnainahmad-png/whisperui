import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Button from './Button';
import Icon from './Icon';
import { sp, radius, shadows } from '../theme';
import { useTheme } from '../hooks/useTheme';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';

/**
 * Blocks chat until the user confirms they verified the safety code out-of-band.
 * Safety code is chunked into groups of 3 for easier comparison by voice.
 */
export default function SafetyVerifyOverlay({ safetyCode, onVerify, onLeave }) {
  const { colors, typography } = useTheme();
  const { isTablet } = useResponsiveLayout();

  // Chunk the code into triplets so users compare it digit-group by digit-group.
  const groups = (safetyCode || '').replace(/\s/g, '').match(/.{1,3}/g) || [];

  return (
    <View style={[s.overlay, { backgroundColor: colors.overlay }]}>
      <View
        style={[
          s.card,
          { backgroundColor: colors.surface1, borderColor: colors.hairline, ...shadows.lg },
          isTablet && s.cardTablet,
        ]}
      >
        <View style={[s.iconWrap, { backgroundColor: colors.accentTint }]}>
          <Icon name="shield-checkmark-outline" size={26} color={colors.accent} />
        </View>

        <Text style={[typography.title2, { color: colors.text, textAlign: 'center', marginBottom: sp.sm }]}>
          Verify invite
        </Text>
        <Text style={[typography.caption, { color: colors.textSecondary, textAlign: 'center', lineHeight: 19, marginBottom: sp.lg }]}>
          Compare this Safety Code with your contact by call or in person. Only continue if both screens match exactly.
        </Text>

        <Text style={[typography.overline, { color: colors.textTertiary, textAlign: 'center', marginBottom: sp.xs + 2 }]}>
          Your Safety Code
        </Text>
        <View style={[s.codeBox, { backgroundColor: colors.surface2, borderColor: colors.hairline }]}>
          {groups.length ? (
            <Text
              selectable={false}
              style={[typography.mono, { color: colors.accent, letterSpacing: 3 }]}
            >
              {groups.join('  ')}
            </Text>
          ) : (
            <Text style={[typography.mono, { color: colors.textTertiary }]}>— — —</Text>
          )}
        </View>
        <Text style={[typography.caption, { color: colors.textTertiary, textAlign: 'center', marginBottom: sp.lg }]}>
          Both users must see the same code.
        </Text>

        <Button
          variant="primary"
          size="lg"
          fullWidth
          title="I compared codes - start chat"
          icon="checkmark-circle"
          onPress={onVerify}
        />
        <Button
          variant="ghost"
          title="Leave chat"
          onPress={onLeave}
          style={{ marginTop: sp.xs }}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
    paddingHorizontal: sp.lg,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    borderRadius: radius.xl,
    padding: sp.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardTablet: { maxWidth: 480, padding: sp.xl },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginBottom: sp.md,
  },
  codeBox: {
    borderRadius: radius.lg,
    paddingVertical: sp.md,
    paddingHorizontal: sp.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: sp.sm,
  },
});
