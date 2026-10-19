import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, Platform, Alert,
  ActivityIndicator, AppState, Keyboard, Switch, DeviceEventEmitter,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import {
  blockPeer, enableMedia, canExchangeMedia, hasMediaConsent, getSocket, sendMessage, sendImage, sendVideo, sendFile, sendVaultFile, leaveRoom, reportUser,
  startKeyExchange, isE2EReady, ensureKeypair, resetE2E, configureChatSecurity,
  confirmSecureChannel, canSendMessages, decryptIncoming, sendTyping,
  createMessageId, sendReceipt, setMediaSavingAllowed, sendSecurityNotice,
  getChatEpoch, isChatEpochActive, sendHeartbeat,
} from '../services/socket';
import {
  addScreenshotListener,
} from 'expo-screen-capture';
import { ensureCaptureProtection, isScreenBeingCaptured, observeCaptureState, isExpoGoFeatureTest } from '../services/captureProtection';
import { saveToVault, vaultError, getVaultLockState } from '../services/privateVault';
import { startPeerLiveness } from '../services/peerLiveness';
import {
  deriveSharedKey,
  getSafetyCode,
  createKeyConfirmation,
  verifyKeyConfirmation,
} from '../services/e2e';
import ChatBubble from '../components/ChatBubble';
import AttachmentViewer from '../components/AttachmentViewer';
import MediaPickerButton from '../components/MediaPickerButton';
import VaultAttachmentPicker from '../components/VaultAttachmentPicker';
import ChatCamera from '../components/ChatCamera';
import ScreenContainer from '../components/ScreenContainer';
import SafetyVerifyOverlay from '../components/SafetyVerifyOverlay';
import TypingIndicator from '../components/TypingIndicator';
import StatusBar from '../components/StatusBar';
import Icon from '../components/Icon';
import { sp, radius } from '../theme';
import { useTheme } from '../hooks/useTheme';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const MAX_RENDERED_MESSAGES = 200;
const MAX_RENDERED_MEDIA_CHARS = 12_000_000;
const BACKGROUND_LEAVE_GRACE_MS = 4000;

function appendBoundedMessage(previous, message) {
  const candidates = [...previous, message].slice(-MAX_RENDERED_MESSAGES);
  const kept = [];
  let mediaChars = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const data = candidate?.imageData || candidate?.videoData || candidate?.fileData || '';
    if (data && mediaChars + data.length > MAX_RENDERED_MEDIA_CHARS) continue;
    mediaChars += data.length;
    kept.push(candidate);
  }
  return kept.reverse();
}

function endChatSession(navigation, reasonCode) {
  resetE2E();
  navigation.replace('ChatEnded', { reasonCode });
}

export default function ChatScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { colors, typography, isDark } = useTheme();
  const { isTablet, horizontalPadding, touchMin, height } = useResponsiveLayout();
  const roomId = route.params?.roomId;
  const chatMode = route.params?.chatMode || 'random';
  const inviteCode = route.params?.inviteCode || null;

  const [messages, setMessages] = useState([]);
  const [viewing, setViewing] = useState(null);
  const [text, setText] = useState('');
  const [securing, setSecuring] = useState(true);
  const [verified, setVerified] = useState(false);
  const [safetyCode, setSafetyCode] = useState(null);
  const [peerTyping, setPeerTyping] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [privacyOverlayVisible, setPrivacyOverlayVisible] = useState(false);
  const [pendingDropped, setPendingDropped] = useState(false);
  const [allowSaving, setAllowSaving] = useState(true);
  const [changingPolicy, setChangingPolicy] = useState(false);
  const [protectionReady, setProtectionReady] = useState(false);

  const listRef = useRef(null);
  const lastCountRef = useRef(0);
  const inChatRef = useRef(true);
  const verifiedRef = useRef(false);
  const pendingEncryptedRef = useRef([]);
  const pendingKeyConfirmationRef = useRef(null);
  const peerKeyConfirmedRef = useRef(false);
  const authFailureShownRef = useRef(false);
  const typingActiveRef = useRef(false);
  const typingIdleRef = useRef(null);
  const peerTypingIdleRef = useRef(null);
  const backgroundTimerRef = useRef(null);
  const endedRef = useRef(false);
  const protectionReadyRef = useRef(false);
  const testNoticeSentRef = useRef(false);
  const [preparingAttachment, setPreparingAttachment] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [vaultPickerOpen, setVaultPickerOpen] = useState(false);
  const vaultSends = useRef(new Map());
  const [mediaConsentVersion, setMediaConsentVersion] = useState(0);
  useEffect(() => () => { for (const controller of vaultSends.current.values()) controller.abort(); vaultSends.current.clear(); }, []);
  const cameraResolver = useRef(null);
  const closeCamera = (asset = null) => {
    const resolve = cameraResolver.current;
    cameraResolver.current = null;
    setCameraOpen(false);
    resolve?.(asset);
  };
  const openCamera = () => new Promise((resolve) => {
    cameraResolver.current?.(null);
    cameraResolver.current = resolve;
    Keyboard.dismiss();
    setCameraOpen(true);
  });
  useEffect(() => () => { cameraResolver.current?.(null); cameraResolver.current = null; }, []);
  const externalMediaRef = useRef(false);
  const livenessRef = useRef(null);

  const chatLocked = securing || !verified || !protectionReady || privacyOverlayVisible;
  const canSend = canSendMessages() && !chatLocked;

  const updateDelivery = (messageId, delivery) => {
    if (!inChatRef.current || endedRef.current) return;
    setMessages((previous) => previous.map((message) => {
      if (message.id !== messageId) return message;
      if (message.delivery === 'delivered') return message;
      if (delivery === 'relayed' && message.delivery === 'failed') return message;
      return { ...message, delivery };
    }));
  };

  const processIncoming = async (payload) => {
    if (!inChatRef.current || endedRef.current) return;
    const epoch = getChatEpoch();
    try {
      const msg = await decryptIncoming(payload?.encrypted, payload?.messageId);
      if (!inChatRef.current || endedRef.current || !isChatEpochActive(epoch)) return;
      if (!msg) return; // More encrypted attachment chunks are still arriving.
      if (msg.type === 'media-consent') { setMediaConsentVersion(v => v + 1); return; }
      if (msg.type === 'heartbeat') { sendHeartbeat(msg.challenge, true).catch(() => {}); return; }
      if (msg.type === 'heartbeat-response') { livenessRef.current?.accept(msg.challenge); return; }
      if (msg.type === 'session-close') { finishChat('peer_left'); return; }
      if (msg.type === 'typing') {
        if (peerTypingIdleRef.current) clearTimeout(peerTypingIdleRef.current);
        setPeerTyping(msg.active);
        if (msg.active) peerTypingIdleRef.current = setTimeout(() => setPeerTyping(false), 2500);
        return;
      }
      if (msg.type === 'receipt') {
        updateDelivery(msg.receiptFor, 'delivered');
        return;
      }
      sendReceipt(msg.messageId).catch(() => {});
      if (msg.type === 'media-policy' || msg.type === 'security-notice') {
        const notice = msg.type === 'media-policy'
          ? (msg.allowSaving ? 'Peer allows saving attachments they send from now on.' : 'Peer disabled saving for new attachments.')
          : `Peer's device reported ${msg.event === 'screenshot' ? 'a screenshot' : msg.event === 'recording' ? 'screen recording' : 'an overlay'}.`;
        setMessages((p) => appendBoundedMessage(p, {
          id: msg.messageId, type: 'system', text: notice, isSent: false, ts: Date.now(),
        }));
        return;
      }
      setMessages((p) => appendBoundedMessage(p, {
        id: msg.messageId,
        ...msg,
        isSent: false,
        ts: Date.now(),
      }));
    } catch {
      if (!inChatRef.current || endedRef.current || !isChatEpochActive(epoch)) return;
      if (!authFailureShownRef.current) {
        authFailureShownRef.current = true;
        setMessages((p) => appendBoundedMessage(p, {
          id: uid(),
          type: 'system',
          isSent: false,
          ts: Date.now(),
          text: 'An invalid, replayed, or unauthenticated message was blocked.',
        }));
      }
    }
  };

  const unlockChat = async () => {
    const epoch = getChatEpoch();
    await ensureCaptureProtection();
    if (!inChatRef.current || !isChatEpochActive(epoch)) return;
    await confirmSecureChannel();
    if (!inChatRef.current || !isChatEpochActive(epoch)) return;
    verifiedRef.current = true;
    setVerified(true);
    if (isExpoGoFeatureTest && !testNoticeSentRef.current) {
      testNoticeSentRef.current = true;
      sendMessage('Expo Go feature test: this device lacks Whisper native privacy and metadata protections. Please use test content.')
        .catch(() => { testNoticeSentRef.current = false; });
    }
    if (!livenessRef.current) {
      livenessRef.current = startPeerLiveness({
        createChallenge: createMessageId,
        sendChallenge: (challenge) => sendHeartbeat(challenge),
        onExpired: () => finishChat('peer_unavailable'),
      });
    }
    const pending = pendingEncryptedRef.current;
    pendingEncryptedRef.current = [];
    pending.forEach(processIncoming);
  };

  const stopOwnTyping = () => {
    if (typingIdleRef.current) clearTimeout(typingIdleRef.current);
    typingIdleRef.current = null;
    if (typingActiveRef.current) sendTyping(false);
    typingActiveRef.current = false;
  };

  const handleTextChange = (value) => {
    setText(value);
    if (!verifiedRef.current) return;
    if (typingIdleRef.current) clearTimeout(typingIdleRef.current);
    if (!value.trim()) {
      stopOwnTyping();
      return;
    }
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      sendTyping(true);
    }
    typingIdleRef.current = setTimeout(stopOwnTyping, 1400);
  };

  const finishChat = (reasonCode) => {
    if (endedRef.current) return;
    endedRef.current = true;
    livenessRef.current?.stop();
    livenessRef.current = null;
    inChatRef.current = false;
    setPrivacyOverlayVisible(true);
    setViewing(null);
    setVaultPickerOpen(false);
    for (const controller of vaultSends.current.values()) controller.abort();
    setText('');
    setVerified(false);
    setAllowSaving(false);
    setSafetyCode(null);
    stopOwnTyping();
    leaveRoom();
    setMessages([]);
    setPeerTyping(false);
    pendingEncryptedRef.current = [];
    pendingKeyConfirmationRef.current = null;
    peerKeyConfirmedRef.current = false;
    verifiedRef.current = false;
    if (backgroundTimerRef.current) {
      clearTimeout(backgroundTimerRef.current);
      backgroundTimerRef.current = null;
    }
    if (peerTypingIdleRef.current) clearTimeout(peerTypingIdleRef.current);
    endChatSession(navigation, reasonCode);
  };

  useEffect(() => {
    configureChatSecurity({ inviteCode, chatMode, roomId });
  }, [inviteCode, chatMode, roomId]);

  useEffect(() => {
    if (!roomId) {
      navigation.replace('Home');
      return;
    }

    const socket = getSocket();
    if (!socket?.connected) {
      navigation.replace('ChatEnded', { reasonCode: 'connection_lost' });
      return;
    }

    inChatRef.current = true;
    endedRef.current = false;
    const epoch = getChatEpoch();
    const stillActive = () => inChatRef.current && !endedRef.current && isChatEpochActive(epoch);

    const failKeyConfirmation = () => {
      if (!stillActive()) return;
      Alert.alert('Security Error', 'The peer could not prove possession of the same encryption key.');
      finishChat('connection_lost');
    };

    const acceptPeerKeyConfirmation = async (proof) => {
      if (!stillActive()) return;
      if (peerKeyConfirmedRef.current) return;
      if (!(await verifyKeyConfirmation(proof, roomId))) {
        failKeyConfirmation();
        return;
      }
      peerKeyConfirmedRef.current = true;
      const reply = await createKeyConfirmation(roomId);
      if (!stillActive()) return;
      if (reply) socket.emit('key-confirm', { proof: reply });
      const code = await getSafetyCode();
      if (!stillActive()) return;
      setSafetyCode(code);
      if (chatMode === 'random') await unlockChat();
      setSecuring(false);
    };

    const onPeerKey = async (d) => {
      try {
        if (d?.protocolVersion !== 7) throw new Error('Unsupported security protocol');
        await ensureCaptureProtection();
        if (!stillActive()) return;
        await ensureKeypair();
        if (!stillActive()) return;
        await deriveSharedKey(d.keyBundle);
        if (!stillActive()) return;
        const proof = await createKeyConfirmation(roomId);
        if (!stillActive()) return;
        if (proof) socket.emit('key-confirm', { proof });
        const pendingProof = pendingKeyConfirmationRef.current;
        pendingKeyConfirmationRef.current = null;
        if (pendingProof) await acceptPeerKeyConfirmation(pendingProof);
      } catch {
        failKeyConfirmation();
      }
    };

    const onPeerKeyConfirmation = async (d) => {
      if (!stillActive()) return;
      if (typeof d?.proof !== 'string') return;
      if (!isE2EReady()) {
        pendingKeyConfirmationRef.current = d.proof;
        return;
      }
      try {
        await acceptPeerKeyConfirmation(d.proof);
      } catch {
        failKeyConfirmation();
      }
    };

    const onEncrypted = (d) => {
      if (!stillActive()) return;
      if (typeof d?.encrypted !== 'string' || typeof d?.messageId !== 'string') return;
      if (!verifiedRef.current) {
        const queuedChars = pendingEncryptedRef.current
          .reduce((n, value) => n + value.encrypted.length, 0);
        if (pendingEncryptedRef.current.length < 64 && queuedChars + d.encrypted.length <= 5_592_408) {
          pendingEncryptedRef.current.push(d);
        } else {
          setPendingDropped(true);
        }
        return;
      }
      processIncoming(d);
    };

    const onEnd = (d) => {
      finishChat(d?.reasonCode || 'peer_left');
    };

    const onPeerReady = () => {
      if (stillActive()) startKeyExchange().catch(failKeyConfirmation);
    };

    const onRateLimited = (d) => {
      const labels = {
        'key-exchange': 'security setup',
        'key-confirm': 'security confirmation',
        'security-alert': 'security alert',
        report: 'report',
        'chat-ready': 'chat ready',
      };
      const action = labels[d?.action] || 'action';
      setMessages((p) => appendBoundedMessage(p, {
        id: uid(),
        type: 'system',
        isSent: false,
        ts: Date.now(),
        text: `The ${action} rate limit was reached. Please wait before retrying.`,
      }));
    };

    const onSocketError = (d) => {
      if (typeof d?.message !== 'string') return;
      setMessages((p) => appendBoundedMessage(p, {
        id: uid(),
        type: 'system',
        isSent: false,
        ts: Date.now(),
        text: d.message,
      }));
    };

    const onDisconnect = () => {
      if (!inChatRef.current || endedRef.current || socket.data?.localClosing) return;
      finishChat('connection_lost');
    };

    socket.on('peer-key', onPeerKey);
    socket.on('peer-key-confirm', onPeerKeyConfirmation);
    socket.on('receive-encrypted', onEncrypted);
    socket.on('chat-ended', onEnd);
    socket.on('peer-ready', onPeerReady);
    socket.on('rate-limited', onRateLimited);
    socket.on('error', onSocketError);
    socket.on('disconnect', onDisconnect);

    const setupCaptureProtection = async () => {
      try {
        await ensureCaptureProtection();
        if (!stillActive()) return;
        if (await isScreenBeingCaptured()) {
          finishChat('privacy_violation');
          return;
        }
        if (!stillActive()) return;
        protectionReadyRef.current = true;
        setProtectionReady(true);
        socket.emit('chat-ready');
        await startKeyExchange();
      } catch {
        if (stillActive()) finishChat('protection_unavailable');
      }
    };

    setupCaptureProtection();

    const nativePrivacySub = DeviceEventEmitter.addListener('WhisperPrivacyViolation', () => {
      if (stillActive()) finishChat('privacy_violation');
    });
    const captureStateSub = observeCaptureState(({ captured }) => {
      if (captured && stillActive()) finishChat('privacy_violation');
    });

    let sub = { remove() {} };
    try {
      sub = addScreenshotListener(() => {
        if (!stillActive()) return;
        setMessages((p) => appendBoundedMessage(p, {
          id: uid(), type: 'system', text: 'Your device reported a screenshot.', ts: Date.now(),
        }));
        sendSecurityNotice('screenshot').catch(() => {});
      });
    } catch { /* optional */ }

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (!inChatRef.current) return;
      if (state === 'active' && livenessRef.current && !livenessRef.current.check()) return;
      setPrivacyOverlayVisible(state !== 'active');
      if (state === 'background' && inChatRef.current && socket?.connected && !externalMediaRef.current) {
        if (backgroundTimerRef.current) clearTimeout(backgroundTimerRef.current);
        const leaveAfterAuthentication = () => {
          if (!inChatRef.current || endedRef.current) return;
          if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') return;
          if (externalMediaRef.current) return;
          if (getVaultLockState().authenticating) {
            backgroundTimerRef.current = setTimeout(leaveAfterAuthentication, BACKGROUND_LEAVE_GRACE_MS); return;
          }
          finishChat('app_background');
        };
        backgroundTimerRef.current = setTimeout(leaveAfterAuthentication, BACKGROUND_LEAVE_GRACE_MS);
        return;
      }
      if (state === 'active' && backgroundTimerRef.current) {
        clearTimeout(backgroundTimerRef.current);
        backgroundTimerRef.current = null;
      }
    });

    return () => {
      inChatRef.current = false;
      livenessRef.current?.stop();
      livenessRef.current = null;
      leaveRoom();
      if (backgroundTimerRef.current) {
        clearTimeout(backgroundTimerRef.current);
        backgroundTimerRef.current = null;
      }
      setMessages([]);
      pendingEncryptedRef.current = [];
      pendingKeyConfirmationRef.current = null;
      peerKeyConfirmedRef.current = false;
      verifiedRef.current = false;
      socket.off('peer-key', onPeerKey);
      socket.off('peer-key-confirm', onPeerKeyConfirmation);
      socket.off('receive-encrypted', onEncrypted);
      socket.off('chat-ended', onEnd);
      socket.off('peer-ready', onPeerReady);
      socket.off('rate-limited', onRateLimited);
      socket.off('error', onSocketError);
      socket.off('disconnect', onDisconnect);
      stopOwnTyping();
      if (peerTypingIdleRef.current) clearTimeout(peerTypingIdleRef.current);
      sub.remove();
      nativePrivacySub.remove();
      captureStateSub.remove();
      appStateSub.remove();
      resetE2E();
    };
  }, [roomId, navigation, chatMode]);

  useEffect(() => {
    if (messages.length > lastCountRef.current) {
      lastCountRef.current = messages.length;
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [messages.length]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, () => {
      setKeyboardVisible(true);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    });
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const handleVerify = async () => {
    try {
      await unlockChat();
    } catch {
      Alert.alert('Verification Error', 'Could not unlock this secure chat. Please leave and try again.');
    }
  };

  const changeSavingPolicy = async (allowed) => {
    if (!canSend || changingPolicy) return;
    setChangingPolicy(true);
    try {
      await setMediaSavingAllowed(allowed);
      if (inChatRef.current) setAllowSaving(allowed);
    } catch {
      if (inChatRef.current) Alert.alert('Setting not changed', 'The permission could not be sent. Try again.');
    } finally {
      if (inChatRef.current) setChangingPolicy(false);
    }
  };

  const saveMedia = async (message) => {
    if (!canSend || externalMediaRef.current || message.isSent || message.allowSaving !== true) return;
    const epoch = getChatEpoch();
    externalMediaRef.current = true;
    if (backgroundTimerRef.current) clearTimeout(backgroundTimerRef.current);
    try {
      const saved = await saveToVault(message, () => inChatRef.current && isChatEpochActive(epoch));
      if (saved && inChatRef.current) Alert.alert('Saved privately', 'The file is saved privately in Whisper. Open Saved Files from Home to view it.');
    } catch (error) {
      if (inChatRef.current) Alert.alert('Unable to save privately', vaultError(error));
    } finally {
      externalMediaRef.current = false;
      if (inChatRef.current && AppState.currentState !== 'active') {
        if (backgroundTimerRef.current) clearTimeout(backgroundTimerRef.current);
        backgroundTimerRef.current = setTimeout(() => {
          if (inChatRef.current && !externalMediaRef.current && AppState.currentState !== 'active') finishChat('app_background');
        }, BACKGROUND_LEAVE_GRACE_MS);
      }
    }
  };

  const handleLeaveFromVerify = () => {
    Alert.alert('Leave chat?', 'This clears the conversation from this app. Files saved privately in Whisper remain in Saved Files.', [
      { text: 'Stay', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          leaveRoom();
          finishChat('verification_cancelled');
        },
      },
    ]);
  };

  const doSend = async () => {
    const t = text.trim();
    if (!t || !canSend || endedRef.current) return;
    const messageId = createMessageId();
    stopOwnTyping();
    setMessages((p) => appendBoundedMessage(p, {
      id: messageId, type: 'text', text: t, isSent: true, ts: Date.now(), delivery: 'sending',
    }));
    setText('');
    try {
      await sendMessage(t, messageId);
      updateDelivery(messageId, 'relayed');
    } catch {
      updateDelivery(messageId, 'failed');
      Alert.alert('Send failed', 'Message could not be relayed. Check your connection.');
    }
  };

  const updateProgress = (messageId) => (progress, sendStage) => {
    if (!inChatRef.current || endedRef.current) return;
    setMessages((previous) => previous.map((message) => message.id === messageId ? { ...message, progress, sendStage } : message));
  };

  const sendSavedFile = async (item) => {
    setVaultPickerOpen(false);
    if (!canSendMessages() || endedRef.current || !protectionReadyRef.current) {
      Alert.alert('Cannot send', 'The chat or recipient is no longer available.'); return;
    }
    const messageId = createMessageId(), epoch = getChatEpoch(), controller = new AbortController();
    vaultSends.current.set(messageId, controller);
    const type = item.mime.startsWith('image/') ? 'image' : item.mime.startsWith('video/') ? 'video' : 'file';
    setMessages((p) => appendBoundedMessage(p, { id: messageId, type, vaultId: item.id, fileName: item.name,
      mimeType: item.mime, fileSize: item.size, isSent: true, ts: Date.now(), delivery: 'sending', sendStage: 'checking', progress: 0 }));
    try {
      await sendVaultFile(item.id, messageId, (progress, sendStage) => {
        if (!inChatRef.current || !isChatEpochActive(epoch)) return;
        setMessages((previous) => previous.map((message) => message.id === messageId ? { ...message, progress, sendStage } : message));
      }, controller.signal);
      updateDelivery(messageId, 'delivered');
    } catch (error) {
      if (inChatRef.current && isChatEpochActive(epoch)) {
        updateDelivery(messageId, 'failed');
        Alert.alert(controller.signal.aborted ? 'Send cancelled' : 'Saved file send status', controller.signal.aborted
          ? 'Sending stopped. Your saved file is unchanged.' : vaultError(error));
      }
    } finally { vaultSends.current.delete(messageId); }
  };

  const sendPicked = async (type, payload) => {
    if (!canSendMessages() || endedRef.current || !protectionReadyRef.current) return;
    const messageId = createMessageId(), controller = new AbortController();
    vaultSends.current.set(messageId, controller);
    setMessages(p => appendBoundedMessage(p, { id: messageId, type, ...payload,
      isSent: true, ts: Date.now(), delivery: 'sending', sendStage: 'sending', progress: 0 }));
    try {
      const data = payload.fileUri ? payload : payload[`${type}Data`];
      if (type === 'file') await sendFile(data, payload.mimeType, payload.fileName, payload.fileSize, messageId, updateProgress(messageId), controller.signal);
      else await (type === 'image' ? sendImage : sendVideo)(data, payload.mimeType, messageId, updateProgress(messageId), controller.signal);
      updateDelivery(messageId, 'delivered');
    } catch (error) {
      updateDelivery(messageId, controller.signal.aborted ? 'cancelled' : 'failed');
      if (!controller.signal.aborted && inChatRef.current) Alert.alert('Send failed', error.message || 'Please try again.');
    } finally { vaultSends.current.delete(messageId); }
  };
  const doImg = payload => sendPicked('image', payload);
  const doVid = payload => sendPicked('video', payload);
  const doFile = payload => sendPicked('file', payload);

  const confirmLeave = () => Alert.alert('Leave chat?', 'This clears the conversation from this app. Files saved privately in Whisper remain in Saved Files.', [
    { text: 'Stay', style: 'cancel' },
    {
      text: 'Leave',
      style: 'destructive',
      onPress: () => {
        leaveRoom();
        finishChat('user_left');
      },
    },
  ]);

  const confirmReport = () => Alert.alert('Report stranger', 'Choose a category. Only this category is sent; no messages, files or names are included. This blocks the source temporarily and ends the chat.', [
    { text: 'Cancel', style: 'cancel' },
    ...['spam', 'abuse', 'other'].map(category => ({ text: category, onPress: async () => { try { await reportUser(category); finishChat('reported'); } catch { if (!endedRef.current) Alert.alert('Report not sent', 'Please retry.'); } } })),
  ]);
  const blockStranger = async () => {
    try { await blockPeer(); finishChat('blocked'); }
    catch { Alert.alert('Could not block', 'Please retry or leave the chat.'); }
  };

  const inputPlaceholder = securing
    ? 'Securing…'
    : !verified
      ? (chatMode === 'invite' ? 'Verify security first…' : 'Starting chat…')
      : 'Message';

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.surface }]} edges={['top', 'left', 'right']}>
      <StatusBar />
      <ScreenContainer variant="chat">
        <KeyboardAvoidingView
          style={styles.flex}
          behavior="padding"
          // Offset is distance from screen top to this view (SafeAreaView top inset),
          // not the bottom nav inset — using bottom under-lifts on gesture-nav devices.
          keyboardVerticalOffset={insets.top}
          enabled
        >
          <View style={[
            styles.hdr,
            {
              paddingLeft: horizontalPadding,
              paddingRight: horizontalPadding,
              backgroundColor: colors.surface1,
              borderBottomColor: colors.separator,
            },
          ]}>
            <View style={[styles.hdrSide, styles.hdrSideLeft, { width: touchMin }]}>
              <TouchableOpacity
                onPress={confirmLeave}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Leave chat"
              >
                <Icon name="close" size={isTablet ? 24 : 22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <View style={styles.hdrCenter}>
              <View style={styles.hdrTitleWrap}>
                <Text style={[
                  typography.bodyStrong,
                  { color: colors.text, textAlign: 'center' },
                  isTablet && { fontSize: 18 },
                ]}>
                  {chatMode === 'invite' ? 'Private' : 'Anonymous'}
                </Text>
                <View style={[
                  styles.hdrDot,
                  { backgroundColor: colors.textTertiary },
                  verified && chatMode === 'invite' && { backgroundColor: colors.success },
                ]} />
              </View>
              {verified && safetyCode && (
                <Text style={[
                  typography.micro,
                  { color: colors.textTertiary, marginTop: 2, textAlign: 'center' },
                  isTablet && { fontSize: 12 },
                ]}>
                  {chatMode === 'invite'
                    ? `Safety code compared - ${safetyCode}`
                    : `Peer unverified - safety code: ${safetyCode}`}
                </Text>
              )}
            </View>
            <View style={[styles.hdrSide, styles.hdrSideRight, { width: touchMin }]}>
              <TouchableOpacity
                onPress={confirmReport}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Report user"
              >
                <Icon name="flag-outline" size={isTablet ? 22 : 20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>

          {chatMode === 'random' && <View style={{ marginHorizontal: horizontalPadding, marginVertical: 8, padding: 14, borderRadius: 18, backgroundColor: colors.surface2 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Icon name={canExchangeMedia() ? 'images-outline' : 'shield-checkmark-outline'} size={24} color={colors.accent} />
              <View style={{ flex: 1 }}>
                <Text style={[typography.bodyStrong, { color: colors.text }]}>{canExchangeMedia() ? 'Media sharing is on' : 'Choose when to share media'}</Text>
                <Text style={[typography.caption, { color: colors.textSecondary, marginTop: 3 }]}>{canExchangeMedia() ? 'You and your peer can send attachments.' : hasMediaConsent() ? 'Waiting for your peer to enable media.' : 'Both people must agree before sending attachments.'}</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 12 }}>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Block or skip this person" onPress={blockStranger}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, padding: 12, borderRadius: 12, backgroundColor: colors.surface1 }}>
                <Icon name="play-skip-forward-outline" size={18} /><Text style={{ color: colors.text }}>Skip / Block</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Enable media for this chat" disabled={chatLocked || hasMediaConsent()}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, padding: 12, borderRadius: 12, backgroundColor: hasMediaConsent() ? colors.accentTint : colors.accent, opacity: chatLocked ? 0.5 : 1 }}
                onPress={async () => { try { await enableMedia(); setMediaConsentVersion(v => v + 1); } catch { Alert.alert('Cannot enable media', 'Please retry when connected.'); } }}>
                <Icon name={canExchangeMedia() ? 'checkmark-circle' : hasMediaConsent() ? 'time-outline' : 'images-outline'} size={18} color={hasMediaConsent() ? colors.accent : '#fff'} />
                <Text style={{ color: hasMediaConsent() ? colors.accent : '#fff', fontWeight: '600' }}>{canExchangeMedia() ? 'Enabled' : hasMediaConsent() ? 'Waiting for peer' : 'Enable media'}</Text>
              </TouchableOpacity>
            </View>
          </View>}
          {isExpoGoFeatureTest && <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: colors.warningTint }]}>
            <Text style={[typography.caption, { color: colors.text }]}>Expo Go feature test</Text>
            <Text style={[typography.micro, { color: colors.textSecondary }]}>Encryption and chat features are active. Native recording detection, privacy covers and metadata tools require an installed build. Use test content.</Text>
          </View>}

          <View style={[styles.savingRow, { borderBottomColor: colors.separator }]}>
            <View style={styles.flex}>
              <Text style={[typography.caption, { color: colors.text }]}>Allow downloads</Text>
              <Text style={[typography.micro, { color: colors.textSecondary }]}>
                {isExpoGoFeatureTest ? 'Applies to new attachments. Native privacy checks are unavailable in this test.' : 'Your peer can save new attachments privately in Whisper.'}
              </Text>
            </View>
            <Switch value={allowSaving} onValueChange={changeSavingPolicy}
              disabled={!canSend || changingPolicy} accessibilityLabel="Allow peer to save my new attachments privately in Whisper" />
          </View>

          {pendingDropped && !verified && (
            <View style={[styles.notice, { backgroundColor: colors.warningTint }]}>
              <Text style={[typography.caption, { color: colors.warning, textAlign: 'center' }]}>
                Some early messages were dropped while securing the channel.
              </Text>
            </View>
          )}

          <FlatList
            ref={listRef}
            data={privacyOverlayVisible || !protectionReady ? [] : messages}
            renderItem={({ item }) => <ChatBubble message={item} isSent={item.isSent}
              onSave={saveMedia} onOpen={setViewing} onCancelSend={(id) => vaultSends.current.get(id)?.abort()} mediaActive={!chatLocked && !privacyOverlayVisible && !cameraOpen && !viewing && inChatRef.current} />}
            keyExtractor={(i) => i.id}
            style={styles.list}
            contentContainerStyle={[styles.listContent, { paddingHorizontal: horizontalPadding }]}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets={false}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
          />

          {preparingAttachment && <View accessibilityRole="progressbar" accessibilityLabel="Preparing attachment"
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: horizontalPadding, paddingVertical: 12, backgroundColor: colors.surface1 }}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={[typography.caption, { color: colors.textSecondary }]}>Preparing attachment...</Text>
          </View>}
          {messages.filter(message => ['image', 'video', 'file'].includes(message.type) && message.delivery === 'sending').map(message => (
            <View key={`transfer-${message.id}`} style={[styles.savingRow, { borderBottomColor: colors.separator }]}>
              <Text style={[styles.flex, typography.caption, { color: colors.text }]}>
                {message.sendStage === 'finishing' ? 'Finishing' : message.sendStage === 'checking' ? 'Checking saved file' : `Sending ${Math.round((message.progress || 0) * 100)}%`}
              </Text>
              {message.sendStage !== 'finishing' && <TouchableOpacity accessibilityRole="button" accessibilityLabel="Cancel file send"
                style={{ padding: sp.md }} onPress={() => vaultSends.current.get(message.id)?.abort()}>
                <Text style={{ color: colors.accent }}>Cancel send</Text>
              </TouchableOpacity>}
            </View>
          ))}
          <View style={[styles.typingRow, { paddingHorizontal: horizontalPadding, backgroundColor: colors.surface }]}>
            {peerTyping ? <TypingIndicator /> : <View style={{ height: 8 }} />}
          </View>

          <View style={[
            styles.bar,
            chatLocked && styles.barDisabled,
            {
              paddingHorizontal: horizontalPadding,
              backgroundColor: colors.surface1,
              borderTopColor: colors.separator,
              paddingBottom: Platform.OS === 'ios'
                ? (keyboardVisible ? sp.sm : Math.max(insets.bottom, sp.sm))
                : (keyboardVisible ? sp.xs : Math.max(insets.bottom, sp.xs)),
            },
          ]}>
            <MediaPickerButton
              onPreparingChange={setPreparingAttachment}
              onOpenCamera={openCamera}
              onProcessingChange={(active) => { externalMediaRef.current = active; }}
              onOpenVault={() => setVaultPickerOpen(true)}
              onImageSelected={doImg}
              onVideoSelected={doVid}
              onFileSelected={doFile}
              disabled={chatLocked || !canExchangeMedia()}
            />
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.surface2,
                  color: colors.text,
                  borderRadius: isTablet ? 24 : 20,
                  fontSize: isTablet ? 18 : 16,
                  minHeight: isTablet ? 48 : 40,
                  maxHeight: Math.max(touchMin, height * 0.18),
                },
              ]}
              placeholder={inputPlaceholder}
              placeholderTextColor={colors.textTertiary}
              value={text}
              onChangeText={handleTextChange}
              onFocus={() => setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 120)}
              multiline
              scrollEnabled
              textAlignVertical="center"
              maxLength={2000}
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              importantForAutofill="noExcludeDescendants"
              editable={!chatLocked}
            />
            <TouchableOpacity
              style={[
                styles.sendBtn,
                isTablet && styles.sendBtnTablet,
                { backgroundColor: colors.accent },
                (!text.trim() || !canSend) && { backgroundColor: colors.surface3 },
              ]}
              activeOpacity={0.7}
              disabled={!text.trim() || !canSend}
              onPress={doSend}
              accessibilityRole="button"
              accessibilityLabel="Send message"
            >
              <Icon name="send" size={isTablet ? 22 : 20} color={colors.bubbleSentText} style={{ marginLeft: 3 }} />
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </ScreenContainer>

      {vaultPickerOpen && !chatLocked && <VaultAttachmentPicker onSelect={sendSavedFile} onClose={() => setVaultPickerOpen(false)} />}
      {viewing && !chatLocked && inChatRef.current && <AttachmentViewer
        message={viewing} onClose={() => setViewing(null)} onSave={saveMedia} />}
      {securing && (
        <View style={[styles.securingOverlay, { backgroundColor: isDark ? 'rgba(0,0,0,0.85)' : 'rgba(242,242,247,0.92)' }]}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={[typography.title2, { color: colors.text, marginTop: sp.md }]}>
            Securing Connection
          </Text>
          <Text style={[typography.body, { color: colors.textTertiary, marginTop: sp.xs }]}>
            Establishing end-to-end encryption…
          </Text>
        </View>
      )}

      {chatMode === 'invite' && !securing && !verified && safetyCode && (
        <SafetyVerifyOverlay
          safetyCode={safetyCode}
          onVerify={handleVerify}
          onLeave={handleLeaveFromVerify}
        />
      )}

      {cameraOpen && <ChatCamera onDone={closeCamera} />}

      {privacyOverlayVisible && (
        <View pointerEvents="auto" style={[styles.privacyOverlay, { backgroundColor: colors.surface }]}>
          <Text style={[typography.caption, { color: colors.textTertiary }]}>Content hidden for privacy</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  savingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16,
    paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  safe: { flex: 1 },
  flex: { flex: 1 },
  typingRow: { minHeight: 28, justifyContent: 'center' },
  hdr: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: sp.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  hdrSide: { width: 44, alignItems: 'center', justifyContent: 'center' },
  hdrSideLeft: { alignItems: 'flex-start' },
  hdrSideRight: { alignItems: 'flex-end' },
  hdrCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hdrTitleWrap: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  hdrDot: {
    position: 'absolute',
    left: -14,
    top: '50%',
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: -4,
  },
  notice: { paddingVertical: sp.sm, paddingHorizontal: sp.md },
  securingOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  privacyOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 30,
  },
  list: { flex: 1 },
  listContent: { flexGrow: 1, justifyContent: 'flex-end', paddingVertical: sp.sm },
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingVertical: sp.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    paddingHorizontal: sp.md,
    paddingVertical: 10,
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
  sendBtnTablet: { width: 44, height: 44, borderRadius: 22 },
  barDisabled: { opacity: 0.5 },
});
