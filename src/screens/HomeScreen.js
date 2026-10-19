import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Pressable, TextInput, StyleSheet, Image,
  Alert, KeyboardAvoidingView, Platform, Keyboard, Modal, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, scanFromURLAsync } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { privacySelfCheck, preparePrivateStorage, protectPrivateTemporary } from '../services/privateStorage';
import { recordCleanup } from '../services/cleanupStatus';
import { inviteQrPng } from '../services/inviteQrImage';
import { shareInviteQr } from '../services/mediaExport';
import StatusBar from '../components/StatusBar';
import Button from '../components/Button';
import Icon from '../components/Icon';
import {
  getSocket, connectSocket, findRandom, createInvite, cancelInvite,
  joinInvite, extractInviteCode, formatInviteCodeForUser, getGroupStatus,
} from '../services/socket';
import { sp, radius, shadows } from '../theme';
import { useTheme } from '../hooks/useTheme';
import ScreenContainer from '../components/ScreenContainer';
import InviteQr from '../components/InviteQr';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { ALLOW_UNVERIFIED_CHATS } from '../config';

export default function HomeScreen({ navigation }) {
  const { colors, typography, tracking } = useTheme();
  const { isTablet, horizontalPadding } = useResponsiveLayout();

  const [inviteCode, setInviteCode] = useState('');
  const [showJoin, setShowJoin] = useState(false);
  const [generatedCode, setGeneratedCode] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [isSharingQr, setIsSharingQr] = useState(false);
  const sharingQrRef = useRef(false);
  const qrOptionAction = useRef(null);
  const [showQrOptions, setShowQrOptions] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [isFindingRandom, setIsFindingRandom] = useState(false);
  const [isJoiningInvite, setIsJoiningInvite] = useState(false);
  const [inviteJoinError, setInviteJoinError] = useState('');
  const [groupStatus, setGroupStatus] = useState({ activeUsers: 0, isActive: true, loaded: false });
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const suppressInviteRef = useRef(false);
  const pendingInviteRef = useRef(null);
  const scanLockedRef = useRef(false);
  const randomNavigationHandledRef = useRef(false);
  const inviteJoinPendingRef = useRef(false);
  const inviteJoinTimerRef = useRef(null);

  useEffect(() => {
    let disposed = false;
    let detach = () => {};
    const setup = async () => {
      try { await connectSocket(); } catch { }
      const socket = getSocket();
      if (!socket || disposed) return;

      const onMatched = (d) => {
        if (disposed) return;
        detach();
        if (inviteJoinTimerRef.current) clearTimeout(inviteJoinTimerRef.current);
        inviteJoinTimerRef.current = null;
        inviteJoinPendingRef.current = false;
        setIsJoiningInvite(false);
        setInviteJoinError('');
        randomNavigationHandledRef.current = true;
        setIsFindingRandom(false);
        setGeneratedCode(null);
        setIsCreating(false);
        const code = pendingInviteRef.current;
        navigation.replace('Chat', {
          roomId: d.roomId,
          chatMode: code ? 'invite' : 'random',
          inviteCode: code,
        });
        pendingInviteRef.current = null;
      };
      const onWaiting = () => {
        if (disposed) return;
        detach();
        randomNavigationHandledRef.current = true;
        setIsFindingRandom(false);
        navigation.replace('Waiting');
      };
      const onErr = (d) => {
        if (inviteJoinPendingRef.current) {
          if (inviteJoinTimerRef.current) clearTimeout(inviteJoinTimerRef.current);
          inviteJoinTimerRef.current = null;
          inviteJoinPendingRef.current = false;
          pendingInviteRef.current = null;
          setIsJoiningInvite(false);
          setInviteJoinError(d?.message || 'Could not join. Check the code and tap Retry.');
          return;
        }
        randomNavigationHandledRef.current = true;
        setIsCreating(false);
        setIsFindingRandom(false);
        Alert.alert('Error', d.message || 'Something went wrong');
      };
      const applyGroupStatus = (status) => {
        if (!Number.isInteger(status?.activeUsers) || status.activeUsers < 0 || typeof status.isActive !== 'boolean') return;
        setGroupStatus({ activeUsers: status.activeUsers, isActive: status.isActive, loaded: true });
      };
      const refreshGroupStatus = async () => {
        try { applyGroupStatus(await getGroupStatus()); } catch { /* keep the last known status */ }
      };

      const onDisconnected = () => {
        const hadInvite = pendingInviteRef.current && !inviteJoinPendingRef.current;
        pendingInviteRef.current = null;
        setGeneratedCode(null);
        setShowQr(false);
        if (hadInvite) setInviteJoinError('The connection ended. Create a new invite; the previous code is no longer usable.');
      };
      socket.on('disconnect', onDisconnected);
      socket.on('matched', onMatched);
      socket.on('waiting', onWaiting);
      socket.on('error', onErr);
      socket.on('group-status', applyGroupStatus);
      refreshGroupStatus();

      detach = () => {
        if (inviteJoinTimerRef.current) clearTimeout(inviteJoinTimerRef.current);
        socket.off('disconnect', onDisconnected);
        socket.off('matched', onMatched);
        socket.off('waiting', onWaiting);
        socket.off('error', onErr);
        socket.off('group-status', applyGroupStatus);
      };
    };
    setup();
    return () => { disposed = true; detach(); };
  }, [navigation]);

  const groupRoomInactive = groupStatus.loaded && !groupStatus.isActive;
  useEffect(() => {
    let active = true;
    const accept = url => {
      const code = extractInviteCode(url);
      if (active && code) setInviteCode(formatInviteCodeForUser(code));
    };
    Linking.getInitialURL().then(accept).catch(() => {});
    const subscription = Linking.addEventListener('url', event => accept(event.url));
    return () => { active = false; subscription.remove(); };
  }, []);

  const homeActionBusy = isFindingRandom || isCreating || isJoiningInvite;
  const groupCount = groupStatus.loaded ? String(groupStatus.activeUsers) : '—';

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    if (!generatedCode) return;
    // Expire slightly before the relay's default ten-minute TTL (network transit time).
    const timer = setTimeout(() => {
      cancelInvite();
      pendingInviteRef.current = null;
      setGeneratedCode(null);
      setShowQr(false);
      Alert.alert('Invite expired', 'Create a new invite and share the complete code.');
    }, 590000);
    return () => clearTimeout(timer);
  }, [generatedCode]);

  const handleCreateInvite = async () => {
    if (isCreating) return;
    setIsCreating(true);
    pendingInviteRef.current = null;
    try {
      await connectSocket();
      const code = await createInvite();
      if (suppressInviteRef.current) {
        suppressInviteRef.current = false;
        cancelInvite();
      } else {
        setGeneratedCode(code);
        pendingInviteRef.current = code;
      }
    } catch (error) {
      Alert.alert('Error', error?.message || 'Could not create invite.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleFindRandom = async () => {
    if (isFindingRandom) return;
    pendingInviteRef.current = null;
    randomNavigationHandledRef.current = false;
    setIsFindingRandom(true);
    try {
      await connectSocket();
      const result = await findRandom();
      if (randomNavigationHandledRef.current) return;
      randomNavigationHandledRef.current = true;
      if (result.status === 'matched' && result.roomId) {
        navigation.replace('Chat', { roomId: result.roomId, chatMode: 'random', inviteCode: null });
      } else {
        navigation.replace('Waiting');
      }
    } catch (error) {
      if (!randomNavigationHandledRef.current) {
        Alert.alert('Could not start chat', error?.message || 'Please try again.');
      }
    } finally {
      setIsFindingRandom(false);
    }
  };

  const handleJoinInvite = async (code) => {
    if (isJoiningInvite) return;
    if (inviteJoinTimerRef.current) clearTimeout(inviteJoinTimerRef.current);
    inviteJoinPendingRef.current = true;
    pendingInviteRef.current = code;
    setInviteJoinError('');
    setIsJoiningInvite(true);

    try {
      await connectSocket();
      await joinInvite(code);
      if (!inviteJoinPendingRef.current) return;
      inviteJoinTimerRef.current = setTimeout(() => {
        inviteJoinTimerRef.current = null;
        inviteJoinPendingRef.current = false;
        setIsJoiningInvite(false);
        setInviteJoinError('No response from the server. Check the code and tap Retry.');
      }, 7000);
    } catch (error) {
      inviteJoinPendingRef.current = false;
      pendingInviteRef.current = null;
      setIsJoiningInvite(false);
      setInviteJoinError(error?.message || 'Cannot reach the server. Tap Retry.');
    }
  };

  const handleShareInvite = async () => {
    if (!generatedCode || sharingQrRef.current) return;
    const code = generatedCode;
    sharingQrRef.current = true;
    setIsSharingQr(true);
    try {
      await shareInviteQr(inviteQrPng(formatInviteCodeForUser(code)), () => pendingInviteRef.current === code && Boolean(getSocket()?.connected));
    } catch {
      Alert.alert('Could not share QR', 'Try again, or long-press the invite code to copy it.');
    } finally {
      sharingQrRef.current = false;
      setIsSharingQr(false);
    }
  };

  const handleDismissInvite = () => {
    cancelInvite();
    pendingInviteRef.current = null;
    setGeneratedCode(null);
    setShowQr(false);
  };

  const importQr = async () => {
    let ownedUri = null;
    try {
      await preparePrivateStorage();
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      if (FileSystem.cacheDirectory && asset.uri.startsWith(FileSystem.cacheDirectory)) { ownedUri = asset.uri; protectPrivateTemporary(ownedUri); }
      const scans = await scanFromURLAsync(asset.uri, ['qr']);
      const codes = [...new Set(scans.map((scan) => extractInviteCode(scan.data)).filter(Boolean))];
      if (codes.length !== 1) {
        Alert.alert('Choose one invite', codes.length ? 'The image contains multiple invites. Crop it to one QR code.' : 'No valid invite found. Choose a clear image of the complete QR code.');
        return;
      }
      scanLockedRef.current = false;
      handleQrScanned({ data: codes[0] });
    } catch { Alert.alert('Cannot read QR', 'Try a clearer image or paste the complete invite code.'); }
    finally { if (ownedUri) await FileSystem.deleteAsync(ownedUri, { idempotent: true }).catch(() => recordCleanup('scratch-delete', false)); }
  };

  const handleOpenScanner = () => { Keyboard.dismiss(); setShowQrOptions(true); };

  const openCameraScanner = async () => {
    let permission = cameraPermission;
    if (!permission?.granted) permission = await requestCameraPermission();
    if (!permission?.granted) {
      Alert.alert('Camera permission needed', 'Allow camera access to scan an invite QR code.');
      return;
    }
    scanLockedRef.current = false;
    setShowScanner(true);
  };

  const handleQrScanned = ({ data }) => {
    if (scanLockedRef.current) return;
    scanLockedRef.current = true;
    const code = extractInviteCode(data);
    if (!code) {
      Alert.alert('Not a Whisper invite', 'This QR does not contain a valid Whisper invite.', [
        { text: 'Cancel', style: 'cancel', onPress: () => setShowScanner(false) },
        { text: 'Try Again', onPress: () => { scanLockedRef.current = false; } },
      ]);
      return;
    }

    setShowScanner(false);
    setShowJoin(true);
    setInviteCode(formatInviteCodeForUser(code));
    handleJoinInvite(code);
  };

  return (
    <SafeAreaView style={[s.safe, { backgroundColor: colors.surface }]} edges={['top', 'bottom']}>
      <StatusBar />
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScreenContainer variant="content">
          <View style={[s.body, { paddingHorizontal: horizontalPadding }]}>
            {/* ── Header ── */}
            <View style={s.header}>
              <View style={s.logoRow}>
                <View style={[s.logoDot, { backgroundColor: colors.accent }]}>
                  <Image source={require('../../assets/icon.png')} style={s.logoImage} />
                </View>
                <Text style={[typography.title, { color: colors.text, letterSpacing: tracking.tight }]}>Whisper</Text>
              </View>
              <Text style={[typography.body, { color: colors.textSecondary }]}>Live conversations. No server chat history.</Text>
              {__DEV__ && <Button title="Privacy self-check" variant="ghost" onPress={async () => {
                try { Alert.alert('Privacy self-check', JSON.stringify(await privacySelfCheck(), null, 2)); }
                catch { Alert.alert('Privacy self-check', 'Check unavailable. Install the updated native debug build.'); }
              }} />}
              <Button title="Saved Files" variant="ghost" onPress={() => navigation.navigate('SavedFiles')} />
            </View>

            {/* ── Actions ── */}
            <View style={s.actions}>
              {<Button
                variant="primary"
                size="lg"
                fullWidth
                title={isFindingRandom ? 'Finding someone...' : 'Random Chat'}
                icon="shuffle-outline"
                subtitle="Encrypted - peer identity is not verified"
                loading={isFindingRandom}
                disabled={isCreating || isJoiningInvite}
                onPress={handleFindRandom}
              />}

              {ALLOW_UNVERIFIED_CHATS && <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open global group chat, ${groupCount} users online`}
                accessibilityHint="Join the public anonymous room"
                accessibilityState={{ disabled: homeActionBusy }}
                disabled={homeActionBusy}
                onPress={() => navigation.replace('GroupJoin')}
                android_ripple={{ color: colors.accentTint, borderless: false, foreground: true }}
                style={({ pressed }) => [
                  s.groupAction,
                  {
                    backgroundColor: colors.surface1,
                    borderColor: colors.border,
                  },
                  homeActionBusy && s.actionDisabled,
                  pressed && Platform.OS === 'ios' && s.groupActionPressed,
                ]}
              >
                <View style={[s.groupIcon, { backgroundColor: colors.accentTint }]}>
                  <Icon name="people" size={24} color={colors.accent} />
                </View>

                <View style={s.groupCopy}>
                  <View style={s.groupTitleRow}>
                    <Text style={[typography.bodyStrong, { color: colors.text }]}>Group Chat</Text>
                    <View style={[s.groupBadge, { backgroundColor: colors.accentTint }]}>
                      <Text style={[typography.micro, { color: colors.accent }]}>PUBLIC ROOM</Text>
                    </View>
                  </View>
                  <Text style={[typography.caption, { color: colors.textSecondary, marginTop: 3 }]}>
                    Public room - the server can read messages
                  </Text>
                </View>

                <View style={[s.groupCount, { backgroundColor: groupRoomInactive ? colors.dangerTint : colors.successTint }]}>
                  <Icon name={groupRoomInactive ? 'close-circle' : 'people'} size={15} color={groupRoomInactive ? colors.danger : colors.success} />
                  <Text style={[typography.captionStrong, { color: groupRoomInactive ? colors.danger : colors.success }]}>{groupCount}</Text>
                </View>

                <Icon name="chevron-forward" size={20} color={colors.textTertiary} />
              </Pressable>}

              {!ALLOW_UNVERIFIED_CHATS && <Text style={[typography.caption, { color: colors.textSecondary }]}>
                Use a join code for a contact, or Random Chat to meet a stranger.
              </Text>}

              <View style={s.halfRow}>
                <View style={{ flex: 1 }}>
                  <Button
                    variant="subtle"
                    size="lg"
                    fullWidth
                    title={isCreating ? 'Creating...' : 'Create Private Invite'}
                    icon="key-outline"
                    loading={isCreating}
                    disabled={isFindingRandom || isJoiningInvite}
                    onPress={handleCreateInvite}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    variant="subtle"
                    size="lg"
                    fullWidth
                    title="Join Code"
                    icon="arrow-forward"
                    disabled={homeActionBusy}
                    onPress={() => setShowJoin(!showJoin)}
                  />
                </View>
              </View>

              {/* ── Generated code card ── */}
              {generatedCode && (
                <View style={[s.codeCard, { backgroundColor: colors.surface1, borderColor: colors.accent }]}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Close and cancel invite"
                    hitSlop={10}
                    onPress={handleDismissInvite}
                    style={[s.codeClose, { backgroundColor: colors.surface3 }]}
                  >
                    <Icon name="close" size={17} color={colors.textSecondary} />
                  </TouchableOpacity>
                  <Text style={[typography.caption, { color: colors.textSecondary }]}>Your invite code</Text>
                  <Text
                    selectable
                    style={[typography.mono, s.inviteCode, { color: colors.accent }]}
                  >
                    {formatInviteCodeForUser(generatedCode)}
                  </Text>
                  <Text style={[typography.micro, { color: colors.textTertiary }]}>Expires in 10 min - One-time use</Text>
                  <Text style={[typography.micro, { color: colors.textSecondary, textAlign: 'center', marginTop: sp.xs }]}>
                    Share the full code to start a verified private chat.
                  </Text>
                  <View style={s.codeActions}>
                    <Button
                      variant="primary"
                      title={isSharingQr ? 'Preparing QR…' : 'Share QR'}
                      disabled={isSharingQr}
                      icon="share-outline"
                      style={s.codeAction}
                      onPress={handleShareInvite}
                    />
                    <Button
                      variant="ghost"
                      title="Show QR"
                      icon="qr-code-outline"
                      style={s.codeAction}
                      onPress={() => setShowQr(true)}
                    />
                  </View>
                </View>
              )}

              {/* ── Join area ── */}
              {showJoin && (
                <View style={s.joinArea}>
                  <View style={s.joinRow}>
                    <TextInput
                      style={[s.joinInput, { backgroundColor: colors.surface2, borderColor: colors.border, color: colors.text }]}
                      placeholder="ABC123"
                      placeholderTextColor={colors.textTertiary}
                      value={inviteCode}
                      onChangeText={(value) => {
                        setInviteCode(value);
                        setInviteJoinError('');
                      }}
                      editable={!isJoiningInvite}
                      autoCapitalize="characters"
                      maxLength={512}
                      selectTextOnFocus
                    />
                    <Button
                      variant="primary"
                      title={isJoiningInvite ? 'Joining...' : inviteJoinError ? 'Retry' : 'Join'}
                      loading={isJoiningInvite}
                      disabled={isFindingRandom || isCreating || !inviteCode.trim()}
                      onPress={() => {
                        const code = extractInviteCode(inviteCode);
                        if (!code) {
                          Alert.alert('Invalid code', 'Paste the complete invite code or shared message.');
                          return;
                        }
                        handleJoinInvite(code);
                      }}
                    />
                  </View>
                  {inviteJoinError ? (
                    <Text
                      accessibilityRole="alert"
                      style={[typography.caption, { color: colors.danger, textAlign: 'center' }]}
                    >
                      {inviteJoinError}
                    </Text>
                  ) : null}
                  <Button
                    variant="ghost"
                    title="Scan QR Code"
                    icon="qr-code-outline"
                    fullWidth
                    disabled={homeActionBusy}
                    onPress={handleOpenScanner}
                  />
                </View>
              )}
            </View>
          </View>
        </ScreenContainer>

        {!keyboardVisible && (
          <Text style={[s.footer, { color: colors.textTertiary }]}>
            Join codes only locate a chat. Compare safety codes to verify your contact.
          </Text>
        )}
      </KeyboardAvoidingView>

      {/* ── QR display modal ── */}
      <Modal visible={showQrOptions} onDismiss={() => { const action = qrOptionAction.current; qrOptionAction.current = null; action?.(); }} transparent animationType="slide" onRequestClose={() => setShowQrOptions(false)}>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay }}>
          <TouchableOpacity style={StyleSheet.absoluteFill} accessibilityLabel="Close QR options" onPress={() => setShowQrOptions(false)} />
          <SafeAreaView edges={['bottom']} style={{ backgroundColor: colors.surface1, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={[typography.title2, { color: colors.text }]}>Join with QR</Text>
              <TouchableOpacity accessibilityLabel="Close QR options" style={{ padding: 12 }} onPress={() => setShowQrOptions(false)}><Icon name="close" /></TouchableOpacity>
            </View>
            <Text style={[typography.body, { color: colors.textSecondary, marginBottom: 20 }]}>Scan an invite or choose a QR image.</Text>
            {[
              ['scan-outline', 'Scan with camera', 'Point your camera at an invite', openCameraScanner],
              ['images-outline', 'Choose from Photos', 'Use a QR image you already have', importQr],
            ].map(([icon, title, subtitle, action]) => <TouchableOpacity key={title} accessibilityRole="button"
              onPress={() => { if (Platform.OS === 'ios') qrOptionAction.current = action; setShowQrOptions(false); if (Platform.OS !== 'ios') action(); }}
              style={{ flexDirection: 'row', alignItems: 'center', padding: 18, borderRadius: 18, backgroundColor: colors.surface2, marginBottom: 12, gap: 16 }}>
              <Icon name={icon} size={28} color={colors.accent} /><View style={{ flex: 1 }}>
                <Text style={[typography.bodyStrong, { color: colors.text }]}>{title}</Text>
                <Text style={[typography.caption, { color: colors.textSecondary, marginTop: 4 }]}>{subtitle}</Text>
              </View><Icon name="chevron-forward" size={20} />
            </TouchableOpacity>)}
          </SafeAreaView>
        </View>
      </Modal>
      <Modal visible={showQr && !!generatedCode} transparent animationType="fade" onRequestClose={() => setShowQr(false)}>
        <View style={[s.qrOverlay, { backgroundColor: colors.overlay }]}>
          <View style={[s.qrCard, { backgroundColor: colors.surface1, borderColor: colors.hairline, ...shadows.lg }, isTablet && s.qrCardTablet]}>
            <Text style={[typography.title2, { color: colors.text, marginBottom: sp.sm }]}>Secure invite QR</Text>
            <Text style={[typography.caption, { color: colors.textSecondary, textAlign: 'center', lineHeight: 18, marginBottom: sp.md }]}>
              Share this QR image, or let your contact scan it directly.
            </Text>
            {generatedCode && <InviteQr value={formatInviteCodeForUser(generatedCode)} />}
            <Text style={[typography.micro, { color: colors.textTertiary, marginTop: sp.md }]}>One-time use - Expires in 10 minutes</Text>
            <Button variant="primary" fullWidth title={isSharingQr ? 'Preparing QR…' : 'Share QR Image'} disabled={isSharingQr} icon="share-outline" style={{ marginTop: sp.md }} onPress={handleShareInvite} />
            <Button variant="ghost" fullWidth title="Close" style={{ marginTop: sp.sm }} onPress={() => setShowQr(false)} />
          </View>
        </View>
      </Modal>

      {/* ── QR scanner modal ── */}
      <Modal visible={showScanner} animationType="slide" onRequestClose={() => setShowScanner(false)}>
        <View style={[s.scannerScreen, { backgroundColor: colors.surface }]}>
          <SafeAreaView style={s.scannerSafe} edges={['top', 'bottom']}>
            <View style={[s.scannerHeader, { borderBottomColor: colors.hairline }]}>
              <Text style={[typography.bodyStrong, { color: colors.text }]}>Scan invite QR</Text>
              <TouchableOpacity onPress={() => setShowScanner(false)} hitSlop={12}>
                <Text style={[typography.label, { color: colors.accent }]}>Close</Text>
              </TouchableOpacity>
            </View>
            <View style={s.cameraWrap}>
              <CameraView
                style={s.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={handleQrScanned}
              />
              <View pointerEvents="none" style={[s.scanFrame, { borderColor: colors.accent }]} />
            </View>
            <Text style={[typography.caption, { color: colors.textSecondary, textAlign: 'center', padding: sp.lg }]}>
              Point the camera at a Whisper invite QR code.
            </Text>
            <TouchableOpacity onPress={() => { setShowScanner(false); importQr(); }} style={{ padding: 18 }} accessibilityLabel="Choose QR from Photos">
              <Text style={{ color: colors.accent, textAlign: 'center' }}>Choose from Photos</Text>
            </TouchableOpacity>
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  body: { flex: 1, justifyContent: 'center' },
  header: { marginBottom: sp.xl + 8 },
  logoRow: { flexDirection: 'row', alignItems: 'center', marginBottom: sp.sm },
  logoDot: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: sp.sm,
    overflow: 'hidden',
  },
  logoImage: { width: 38, height: 38, resizeMode: 'contain' },
  actions: { gap: sp.md },
  halfRow: { flexDirection: 'row', gap: sp.md },
  groupAction: {
    width: '100%',
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: sp.md,
    paddingVertical: sp.sm + 2,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    ...shadows.sm,
  },
  groupActionPressed: { opacity: 0.84 },
  actionDisabled: { opacity: 0.45 },
  groupIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: sp.md,
  },
  groupCopy: { flex: 1, paddingRight: sp.sm },
  groupTitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: sp.sm },
  groupBadge: { borderRadius: radius.full, paddingHorizontal: 7, paddingVertical: 3 },
  groupCount: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 5, marginRight: sp.sm },
  codeCard: {
    borderRadius: radius.lg,
    paddingHorizontal: sp.md,
    paddingTop: sp.md,
    paddingBottom: sp.md,
    alignItems: 'center',
    borderWidth: 1.5,
    position: 'relative',
  },
  codeClose: {
    position: 'absolute',
    top: sp.sm,
    right: sp.sm,
    width: 28,
    height: 28,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  inviteCode: {
    maxWidth: '90%',
    fontSize: 16,
    lineHeight: 22,
    letterSpacing: 1.2,
    textAlign: 'center',
    marginVertical: sp.xs,
  },
  codeActions: { width: '100%', flexDirection: 'row', gap: sp.sm, marginTop: sp.sm },
  codeAction: { flex: 1 },
  joinArea: { gap: sp.sm },
  joinRow: { flexDirection: 'row', gap: sp.sm },
  joinInput: {
    flex: 1,
    borderRadius: radius.md,
    paddingHorizontal: sp.md,
    paddingVertical: 14,
    fontSize: 18,
    letterSpacing: 1.5,
    fontWeight: '600',
    borderWidth: StyleSheet.hairlineWidth,
    textAlign: 'center',
  },
  qrOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: sp.lg },
  qrCard: {
    width: '100%',
    maxWidth: 380,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: sp.lg,
    alignItems: 'center',
  },
  qrCardTablet: { maxWidth: 460, padding: sp.xl },
  scannerScreen: { flex: 1 },
  scannerSafe: { flex: 1 },
  scannerHeader: {
    minHeight: 58,
    paddingHorizontal: sp.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cameraWrap: { flex: 1, margin: sp.md, borderRadius: radius.lg, overflow: 'hidden' },
  camera: { flex: 1 },
  scanFrame: {
    position: 'absolute',
    width: 240,
    height: 240,
    alignSelf: 'center',
    top: '50%',
    marginTop: -120,
    borderWidth: 3,
    borderRadius: radius.lg,
  },
  footer: {
    fontSize: 12,
    textAlign: 'center',
    paddingBottom: sp.lg,
    letterSpacing: 0.2,
  },
});
