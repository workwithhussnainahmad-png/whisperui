import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import Icon from './Icon';
import { acquireAttachmentFile } from '../services/attachmentFiles';
import { recordCleanup } from '../services/cleanupStatus';

const fmt = (seconds) => {
  const total = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

// The decrypted copy exists only while this note is playing.
export default function VoiceNote({ message, active, tint, textColor, mutedColor }) {
  const [state, setState] = useState('idle');
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(message.durationMs ? message.durationMs / 1000 : 0);
  const playback = useRef(null);

  const stop = () => {
    const current = playback.current;
    playback.current = null;
    if (!current) return;
    current.subscription?.remove();
    try { current.player?.remove(); } catch { /* already released */ }
    try { current.lease?.release(); } catch { recordCleanup('scratch-delete', false); }
  };

  useEffect(() => () => stop(), []);
  useEffect(() => {
    if (!active) { stop(); setState('idle'); setPosition(0); }
  }, [active]);

  const toggle = async () => {
    const current = playback.current;
    if (current?.player) {
      if (current.player.playing) { current.player.pause(); setState('paused'); }
      else { current.player.play(); setState('playing'); }
      return;
    }
    if (!active || !message.fileUri || state === 'loading') return;
    setState('loading');
    const session = {};
    playback.current = session;
    try {
      session.lease = await acquireAttachmentFile(message.fileUri, 'm4a');
      if (playback.current !== session) { session.lease.release(); return; }
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      session.player = createAudioPlayer(session.lease.uri, { updateInterval: 250 });
      session.player.volume = 1;
      session.subscription = session.player.addListener('playbackStatusUpdate', (status) => {
        if (playback.current !== session) return;
        if (status.duration) setDuration(status.duration);
        setPosition(status.currentTime || 0);
        if (status.didJustFinish) { stop(); setState('idle'); setPosition(0); }
      });
      session.player.play();
      setState('playing');
    } catch {
      if (playback.current === session) stop();
      setState('failed');
    }
  };

  const progress = duration > 0 ? Math.min(1, position / duration) : 0;
  const playing = state === 'playing';
  return (
    <View style={s.row}>
      <TouchableOpacity onPress={toggle} disabled={!active || !message.fileUri} hitSlop={8}
        accessibilityRole="button" accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}
        style={[s.play, { backgroundColor: tint }]}>
        {state === 'loading'
          ? <ActivityIndicator size="small" color={textColor} />
          : <Icon name={playing ? 'pause' : 'play'} size={18} color={textColor} style={!playing && { marginLeft: 2 }} />}
      </TouchableOpacity>
      <View style={s.body}>
        <View style={[s.track, { backgroundColor: mutedColor }]}>
          <View style={[s.fill, { width: `${progress * 100}%`, backgroundColor: textColor }]} />
        </View>
        <Text style={[s.time, { color: mutedColor }]}>
          {state === 'failed' ? 'Cannot play' : playing || state === 'paused' ? fmt(position) : duration ? fmt(duration) : 'Voice message'}
        </Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 200, paddingVertical: 2 },
  play: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 6 },
  track: { height: 3, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 3 },
  time: { fontSize: 12 },
});
