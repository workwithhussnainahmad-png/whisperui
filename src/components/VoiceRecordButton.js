import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, PanResponder, Alert, AppState, Vibration } from 'react-native';
import {
  useAudioRecorder, RecordingPresets, getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync, setAudioModeAsync,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import Icon from './Icon';
import { protectPrivateTemporary } from '../services/privateStorage';
import { recordCleanup } from '../services/cleanupStatus';

const MIN_VOICE_MS = 700;
const MAX_VOICE_MS = 5 * 60 * 1000;
const CANCEL_DISTANCE = 80;
// voice_communication enables the device's automatic gain control, so quiet
// speech is recorded at a normal level instead of raw microphone level.
const VOICE_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 96000,
  android: { ...RecordingPresets.HIGH_QUALITY.android, audioSource: 'voice_communication' },
};

const removeFile = (uri) => uri
  ? FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => recordCleanup('scratch-delete', false))
  : Promise.resolve();

// Hold to record, release to send, slide left to cancel.
export default function VoiceRecordButton({
  size = 36, color, idleColor, disabled = false, blockedMessage = null, onRecorded, onStateChange,
}) {
  const recorder = useAudioRecorder(VOICE_OPTIONS);
  const [active, setActive] = useState(false);
  const session = useRef(null);
  const props = useRef({});
  props.current = { disabled, blockedMessage, onRecorded, onStateChange };

  const report = (state) => props.current.onStateChange?.(state);

  const finish = async (send) => {
    const current = session.current;
    if (!current || current.finishing) return;
    current.finishing = true;
    clearInterval(current.timer);
    clearTimeout(current.limit);
    const durationMs = Date.now() - current.startedAt;
    let uri = null;
    try {
      await recorder.stop();
      uri = recorder.uri;
    } catch { /* recorder already released */ }
    await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    session.current = null;
    setActive(false);
    report(null);
    if (uri) protectPrivateTemporary(uri);
    if (!send || current.cancelled || !uri || durationMs < MIN_VOICE_MS) {
      await removeFile(uri);
      if (send && !current.cancelled && durationMs < MIN_VOICE_MS) report({ hint: 'Hold to record, release to send' });
      return;
    }
    try { await props.current.onRecorded?.({ uri, durationMs }); }
    finally { await removeFile(uri); }
  };

  const begin = async () => {
    if (session.current) return;
    const { disabled: off, blockedMessage: blocked } = props.current;
    if (off) return;
    if (blocked) { Alert.alert('Voice messages', blocked); return; }
    const current = { startedAt: Date.now(), cancelled: false, finishing: false, released: false };
    session.current = current;
    current.started = (async () => {
      let permission = await getRecordingPermissionsAsync();
      if (!permission.granted) {
        permission = await requestRecordingPermissionsAsync();
        // The system prompt interrupts the hold; ask for a fresh press.
        throw new Error(permission.granted ? 'retry' : 'denied');
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (current.released) throw new Error('released');
      recorder.record();
      current.startedAt = Date.now();
      current.recording = true;
    })();
    try {
      await current.started;
    } catch (error) {
      session.current = null;
      await recorder.stop().catch(() => {});
      await removeFile(recorder.uri);
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      if (error?.message === 'denied') Alert.alert('Microphone permission', 'Allow microphone access in Settings to send voice messages.');
      else if (error?.message === 'retry') report({ hint: 'Hold to record, release to send' });
      else if (error?.message !== 'released') Alert.alert('Recording failed', 'Could not start the microphone. Please try again.');
      return;
    }
    if (session.current !== current || current.finishing) return;
    Vibration.vibrate(20);
    setActive(true);
    const tick = () => report({ recording: true, seconds: Math.floor((Date.now() - current.startedAt) / 1000), cancelling: current.cancelled });
    tick();
    current.timer = setInterval(tick, 250);
    current.limit = setTimeout(() => finish(true), MAX_VOICE_MS);
  };

  const release = (send) => {
    const current = session.current;
    if (!current) return;
    current.released = true;
    if (current.recording) finish(send);
    else if (send) report({ hint: 'Hold to record, release to send' });
  };

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { begin(); },
    onPanResponderMove: (_event, { dx }) => {
      const current = session.current;
      if (!current) return;
      const cancelling = dx < -CANCEL_DISTANCE;
      if (cancelling !== current.cancelled) {
        current.cancelled = cancelling;
        if (cancelling) Vibration.vibrate(10);
      }
    },
    onPanResponderRelease: () => release(true),
    onPanResponderTerminate: () => release(false),
  })).current;

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => { if (state !== 'active') release(false); });
    return () => {
      sub.remove();
      const current = session.current;
      if (!current) return;
      current.cancelled = true;
      clearInterval(current.timer);
      clearTimeout(current.limit);
      session.current = null;
      recorder.stop().catch(() => {}).finally(() => removeFile(recorder.uri));
      setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    };
  }, []);

  const scale = active ? 1.35 : 1;
  return (
    <View
      {...responder.panHandlers}
      accessible
      accessibilityRole="button"
      accessibilityLabel="Record voice message"
      accessibilityHint="Hold to record, release to send, slide left to cancel"
      accessibilityState={{ disabled }}
      hitSlop={8}
      style={[s.btn, {
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: active ? '#ff453a' : disabled ? idleColor : color,
        transform: [{ scale }],
      }]}
    >
      <Icon name="mic" size={Math.round(size * 0.55)} color="#fff" />
    </View>
  );
}

const s = StyleSheet.create({
  btn: { justifyContent: 'center', alignItems: 'center' },
});
