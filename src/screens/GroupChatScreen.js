import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, Platform, Alert, AppState, Keyboard,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import {
  addScreenshotListener,
} from 'expo-screen-capture';
import { ensureCaptureProtection } from '../services/captureProtection';
import StatusBar from '../components/StatusBar';
import ScreenContainer from '../components/ScreenContainer';
import Icon from '../components/Icon';
import { getSocket, leaveGroupChat, sendGroupMessage } from '../services/socket';
import { sp, radius } from '../theme';
import { useTheme } from '../hooks/useTheme';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';

const DEFAULT_TTL_MS = 90 * 1000;
const MAX_RENDERED_MESSAGES = 300;
const USERNAME_COLORS = [
  '#007AFF', '#5856D6', '#AF52DE', '#FF2D55',
  '#FF9500', '#34C759', '#00A6A6', '#A2845E',
];

function pruneMessages(messages) {
  const current = Date.now();
  const kept = messages.filter((message) => !message.expiresAt || message.expiresAt > current);
  const bounded = kept.slice(-MAX_RENDERED_MESSAGES);
  if (bounded.length === messages.length && bounded.every((message, index) => message === messages[index])) {
    return messages;
  }
  return bounded;
}

function timeLeft(message) {
  if (!message.expiresAt) return '';
  const seconds = Math.max(0, Math.ceil((message.expiresAt - Date.now()) / 1000));
  return `${seconds}s`;
}

function colorForUsername(name) {
  let hash = 0;
  const value = String(name || '');
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return USERNAME_COLORS[Math.abs(hash) % USERNAME_COLORS.length];
}

function renderTextWithMentions(text, colors, mentionedMe) {
  const parts = String(text || '').split(/(@[A-Za-z0-9_]{3,20})/g);
  return parts.map((part, index) => {
    const isMention = /^@[A-Za-z0-9_]{3,20}$/.test(part);
    return (
      <Text
        key={`${part}-${index}`}
        style={isMention && {
          color: mentionedMe ? colors.success : colors.accent,
          fontWeight: '700',
        }}
      >
        {part}
      </Text>
    );
  });
}

export default function GroupChatScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { colors, typography } = useTheme();
  const { horizontalPadding, touchMin } = useResponsiveLayout();
  const username = route.params?.username || '';
  const ttlMs = route.params?.messageTtlMs || DEFAULT_TTL_MS;
  const [messages, setMessages] = useState(() => pruneMessages(route.params?.messages || []));
  const [activeUsers, setActiveUsers] = useState(route.params?.activeUsers || 1);
  const [users, setUsers] = useState(() => {
    const initial = Array.isArray(route.params?.users) ? route.params.users : [];
    return initial.length ? initial : [username].filter(Boolean);
  });
  const [usersVisible, setUsersVisible] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [privacyOverlayVisible, setPrivacyOverlayVisible] = useState(false);
  const listRef = useRef(null);
  const endedRef = useRef(false);
  const scrollTimerRef = useRef(null);

  const scrollToLatest = useCallback((animated = true) => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated });
      });
    }, 40);
  }, []);

  const finish = (reasonCode = 'user_left') => {
    if (endedRef.current) return;
    endedRef.current = true;
    leaveGroupChat();
    setMessages([]);
    navigation.replace('ChatEnded', { reasonCode });
  };

  const confirmLeave = () => Alert.alert(
    'Leave group chat?',
    'Your temporary messages and identity will disappear from this device.',
    [
      { text: 'Stay', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: () => finish('user_left') },
    ]
  );

  useEffect(() => {
    const socket = getSocket();
    if (!username || !socket?.connected) {
      navigation.replace('Home');
      return undefined;
    }

    const onMessage = (message) => {
      setMessages((previous) => pruneMessages([...previous, message]));
    };
    const onPresence = (data) => {
      if (Number.isInteger(data?.activeUsers)) setActiveUsers(data.activeUsers);
      if (Array.isArray(data?.users)) {
        setUsers(data.users.filter((name) => typeof name === 'string'));
      }
      const name = data?.left;
      if (typeof name === 'string') {
        setMessages((previous) => pruneMessages([...previous, {
          id: `${Date.now()}-${name}-left`,
          type: 'system',
          text: `${name} left...`,
          createdAt: Date.now(),
          expiresAt: Date.now() + Math.min(ttlMs, DEFAULT_TTL_MS),
        }]));
      }
    };
    const onDisconnect = () => finish('connection_lost');

    socket.on('group-message', onMessage);
    socket.on('group-presence', onPresence);
    socket.on('disconnect', onDisconnect);

    const pruneTimer = setInterval(() => {
      setMessages((previous) => pruneMessages(previous));
    }, 1000);

    const appStateSub = AppState.addEventListener('change', (state) => {
      setPrivacyOverlayVisible(state !== 'active');
      if (state === 'background') finish('app_background');
    });

    return () => {
      clearInterval(pruneTimer);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      appStateSub.remove();
      socket.off('group-message', onMessage);
      socket.off('group-presence', onPresence);
      socket.off('disconnect', onDisconnect);
      if (!endedRef.current) leaveGroupChat();
    };
  }, [navigation, username, ttlMs]);

  useEffect(() => {
    const setupCaptureProtection = async () => {
      try {
        await ensureCaptureProtection();
      } catch { /* optional platform support */ }
    };

    setupCaptureProtection();

    let sub = { remove() {} };
    try {
      sub = addScreenshotListener(() => {
        Alert.alert('Privacy reminder', 'Screenshots may violate chat privacy.');
      });
    } catch { /* optional platform support */ }

    return () => {
      sub.remove();
    };
  }, []);

  useEffect(() => {
    scrollToLatest(true);
  }, [messages.length, scrollToLatest]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => {
      setKeyboardVisible(true);
      scrollToLatest(true);
    });
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const doSend = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await sendGroupMessage(value);
      setText('');
    } catch (err) {
      Alert.alert('Send failed', err?.message || 'Please try again.');
    } finally {
      setSending(false);
    }
  };

  const renderItem = useCallback(({ item }) => {
    if (item.type === 'system') {
      return (
        <View style={s.systemRow}>
          <View style={[s.systemPill, { backgroundColor: colors.surface3 }]}>
            <Text style={[typography.caption, { color: colors.textTertiary }]}>{item.text}</Text>
          </View>
        </View>
      );
    }

    const isMine = item.username === username;
    const mentionedMe = item.mentions?.some((mention) => mention.toLowerCase() === username.toLowerCase());
    const isMentionRecipient = mentionedMe && !isMine;
    const bodyColor = isMentionRecipient ? colors.success : colors.bubbleReceivedText;
    return (
      <View style={[s.msgRow, isMine ? s.msgRight : s.msgLeft]}>
        <View
          style={[
            s.bubble,
            {
              backgroundColor: isMentionRecipient ? colors.successTint : colors.bubbleReceived,
              borderColor: isMentionRecipient ? colors.success : colors.bubbleReceivedBorder,
              borderBottomLeftRadius: isMine ? radius.xl : radius.xs,
              borderBottomRightRadius: isMine ? radius.xs : radius.xl,
            },
          ]}
        >
          <Text style={[typography.captionStrong, { color: colorForUsername(item.username), marginBottom: 3 }]}>
            @{item.username}
          </Text>
          <Text style={[typography.body, { color: bodyColor }]}>
            {renderTextWithMentions(item.text, colors, isMentionRecipient)}
          </Text>
          <Text style={[typography.micro, { color: colors.textTertiary, alignSelf: 'flex-end', marginTop: 4 }]}>
            {timeLeft(item)}
          </Text>
        </View>
      </View>
    );
  }, [colors, typography, username]);

  const keyExtractor = useCallback((item) => item.id, []);

  return (
    <SafeAreaView style={[s.safe, { backgroundColor: colors.surface }]} edges={['top', 'left', 'right']}>
      <StatusBar />
      <ScreenContainer variant="chat">
        <KeyboardAvoidingView
          style={s.flex}
          behavior="padding"
          // Offset is distance from screen top to this view (SafeAreaView top inset),
          // not the bottom nav inset — using bottom under-lifts on gesture-nav devices.
          keyboardVerticalOffset={insets.top}
          enabled
        >
          <View style={[s.header, { paddingHorizontal: horizontalPadding, backgroundColor: colors.surface1, borderBottomColor: colors.separator }]}>
            <TouchableOpacity
              onPress={confirmLeave}
              hitSlop={12}
              style={[s.headerSide, { width: touchMin }]}
              accessibilityRole="button"
              accessibilityLabel="Leave group chat"
            >
              <Icon name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
            <View style={s.headerCenter}>
              <Text style={[typography.bodyStrong, { color: colors.text }]}>Group Chat</Text>
              <Text style={[typography.micro, { color: colors.textTertiary, marginTop: 2 }]}>
                {activeUsers} online - @{username}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setUsersVisible((visible) => !visible)}
              hitSlop={8}
              style={[s.headerSide, { width: touchMin }]}
              accessibilityRole="button"
              accessibilityLabel={`${usersVisible ? 'Hide' : 'Show'} current group users`}
              accessibilityState={{ expanded: usersVisible }}
            >
              <Icon name={usersVisible ? 'chevron-up' : 'chevron-down'} size={21} color={colors.accent} />
            </TouchableOpacity>
          </View>

          {usersVisible && (
            <View style={[s.usersPanel, {
              marginHorizontal: horizontalPadding,
              backgroundColor: colors.surface1,
              borderColor: colors.border,
            }]}>
              <View style={[s.usersPanelHeader, { borderBottomColor: colors.separator }]}>
                <Text style={[typography.captionStrong, { color: colors.text }]}>CURRENT USERS</Text>
                <Text style={[typography.micro, { color: colors.textTertiary }]}>{users.length} online</Text>
              </View>
              <FlatList
                data={users}
                keyExtractor={(name) => name}
                style={s.usersList}
                contentContainerStyle={s.usersListContent}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                initialNumToRender={20}
                ListEmptyComponent={(
                  <View style={s.usersEmpty}>
                    <Icon name="people-outline" size={20} color={colors.textTertiary} />
                    <Text style={[typography.caption, { color: colors.textTertiary }]}>
                      No active users to display
                    </Text>
                  </View>
                )}
                renderItem={({ item }) => (
                  <View style={s.userRow}>
                    <View style={[s.userDot, { backgroundColor: colorForUsername(item) }]} />
                    <Text
                      numberOfLines={1}
                      style={[typography.body, { color: item === username ? colors.accent : colors.text }]}
                    >
                      @{item}{item === username ? ' (you)' : ''}
                    </Text>
                  </View>
                )}
              />
            </View>
          )}

          <FlatList
            ref={listRef}
            data={messages}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            style={s.list}
            contentContainerStyle={[s.listContent, { paddingHorizontal: horizontalPadding }]}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets={false}
            onContentSizeChange={() => scrollToLatest(true)}
            onLayout={() => scrollToLatest(false)}
            removeClippedSubviews={Platform.OS === 'android'}
            initialNumToRender={24}
            maxToRenderPerBatch={24}
            updateCellsBatchingPeriod={32}
            windowSize={9}
          />

          <View style={[s.bar, {
            paddingHorizontal: horizontalPadding,
            paddingBottom: Platform.OS === 'ios'
              ? (keyboardVisible ? sp.sm : Math.max(insets.bottom, sp.sm))
              : (keyboardVisible ? sp.xs : Math.max(insets.bottom, sp.xs)),
            backgroundColor: colors.surface1,
            borderTopColor: colors.separator,
          }]}>
            <TextInput
              style={[s.input, { backgroundColor: colors.surface2, color: colors.text }]}
              placeholder="Message or mention @username"
              placeholderTextColor={colors.textTertiary}
              value={text}
              onChangeText={setText}
              onFocus={() => scrollToLatest(true)}
              maxLength={1000}
              multiline
            />
            <TouchableOpacity
              style={[s.sendBtn, { backgroundColor: text.trim() && !sending ? colors.accent : colors.surface3 }]}
              disabled={!text.trim() || sending}
              onPress={doSend}
              accessibilityRole="button"
              accessibilityLabel="Send group message"
            >
              <Icon name="send" size={20} color={colors.bubbleSentText} style={{ marginLeft: 3 }} />
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </ScreenContainer>
      {privacyOverlayVisible && (
        <View pointerEvents="none" style={[s.privacyOverlay, { backgroundColor: colors.surface }]}>
          <Text style={[typography.caption, { color: colors.textTertiary }]}>Content hidden for privacy</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  privacyOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 30,
  },
  header: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerSide: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  usersPanel: {
    maxHeight: 240,
    marginTop: sp.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  usersPanelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: sp.md,
    paddingVertical: sp.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  usersEmpty: {
    minHeight: 88,
    alignItems: 'center',
    justifyContent: 'center',
    gap: sp.xs,
    padding: sp.md,
  },
  usersList: { flexGrow: 0, flexShrink: 1 },
  usersListContent: { paddingVertical: sp.xs },
  userRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: sp.md,
  },
  userDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: sp.sm,
  },
  list: { flex: 1 },
  listContent: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingVertical: sp.sm,
  },
  msgRow: {
    marginVertical: 3,
  },
  msgLeft: {
    alignItems: 'flex-start',
  },
  msgRight: {
    alignItems: 'flex-end',
  },
  bubble: {
    maxWidth: '84%',
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  systemRow: {
    alignItems: 'center',
    marginVertical: 6,
  },
  systemPill: {
    paddingHorizontal: sp.md,
    paddingVertical: 6,
    borderRadius: radius.full,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingVertical: sp.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderRadius: 20,
    paddingHorizontal: sp.md,
    paddingVertical: 10,
    fontSize: 16,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: sp.sm,
    marginBottom: 2,
  },
});
