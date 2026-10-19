import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ActivityIndicator } from 'react-native';
import Icon from './Icon';
import PrivateVideo from './PrivateVideo';
import { acquireAttachmentFile, mediaExtension } from '../services/attachmentFiles';
import { validateImageFile } from '../services/documentMedia';
import { recordCleanup } from '../services/cleanupStatus';
import { sp, radius } from '../theme';
import { useTheme } from '../hooks/useTheme';

const fmtSize = (b) => {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
};

const fmtTime = (ts) => {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
};


function InlinePreview({ message, active }) {
  const [uri, setUri] = useState(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true, lease;
    setUri(null); setFailed(false);
    const release = () => { try { lease?.release(); } catch { recordCleanup('scratch-delete', false); } };
    if (active && message.fileUri) {
      (async () => {
        lease = await acquireAttachmentFile(message.fileUri, mediaExtension(message.mimeType));
        if (!alive) { release(); return; }
        if (message.type === 'image') await validateImageFile(lease.uri);
        if (alive) setUri(lease.uri);
      })().catch(() => { release(); if (alive) setFailed(true); });
    }
    return () => { alive = false; release(); };
  }, [active, message.fileUri, message.mimeType, message.type]);
  return <View style={{ width: 240, height: 200, backgroundColor: '#171c24', alignItems: 'center', justifyContent: 'center' }}>
    {uri ? message.type === 'image'
      ? <Image source={{ uri }} resizeMode="cover" style={StyleSheet.absoluteFill} onError={() => setFailed(true)} />
      : <View pointerEvents="none" style={StyleSheet.absoluteFill}><PrivateVideo uri={uri} playing={false} style={{ flex: 1 }} /></View>
      : <Icon name={message.type === 'image' ? 'image-outline' : 'videocam-outline'} color="#fff" size={36} />}
    {message.type === 'video' && uri && <View style={{ backgroundColor: '#0009', borderRadius: 30, padding: 12 }}><Icon name="play" color="#fff" size={28} /></View>}
    {(failed || !message.fileUri) && <Text style={{ color: '#fff', padding: 12 }}>{failed ? 'Preview unavailable' : 'Saved privately. Tap to open'}</Text>}
  </View>;
}

export default function ChatBubble({ message, isSent, onSave, onOpen, onCancelSend, mediaActive = true }) {
  const [saving, setSaving] = useState(false);
  const { colors, typography } = useTheme();
  const save = async () => {
    if (!mediaActive || saving || isSent || message?.allowSaving !== true || !onSave) return;
    setSaving(true);
    try { await onSave(message); } finally { setSaving(false); }
  };

  if (!message || !message.type) return null;

  const isMedia = message.type === 'image' || message.type === 'video';
  const isSystem = message.type === 'system';
  const time = fmtTime(message.ts);

  // Media bubbles render their own content with the bubble chrome around it.
  const mediaRadius = radius.xl;

  const content = () => {
    if (['image', 'video'].includes(message.type)) {
      return <InlinePreview message={message} active={mediaActive} />;
    }
    switch (message.type) {
      case 'file':
        return (
          <View style={s.fileRow}>
            <View style={[s.fileIcon, { backgroundColor: colors.accentTint }]}>
              <Icon name="document-outline" size={20} color={colors.accent} />
            </View>
            <View style={s.fileMeta}>
              <Text style={[typography.bodyStrong, { color: isSent ? colors.bubbleSentText : colors.bubbleReceivedText }]} numberOfLines={1}>
                {message.fileName}
              </Text>
              {message.fileSize > 0 && (
                <Text style={[typography.caption, { color: isSent ? 'rgba(255,255,255,0.78)' : colors.textSecondary, marginTop: 1 }]}>
                  {fmtSize(message.fileSize)}
                </Text>
              )}
            </View>
          </View>
        );
      case 'system':
        return <Text style={[typography.caption, { color: colors.textTertiary, textAlign: 'center' }]}>{message.text}</Text>;
      default:
        if (!message.text) return null;
        return (
          <Text style={[typography.body, { color: isSent ? colors.bubbleSentText : colors.bubbleReceivedText }]}>
            {message.text}
          </Text>
        );
    }
  };

  const body = content();
  if (!body) return null;

  // System messages render as a centered muted pill, no tail or timestamp.
  if (isSystem) {
    return (
      <View style={s.systemRow}>
        <View style={[s.systemPill, { backgroundColor: colors.surface3 }]}>
          {body}
        </View>
      </View>
    );
  }

  // Footer (timestamp + ticks) shown inside the bubble's bottom corner for
  // text/file; under media for legibility on photos/video.
  const meta = (
    <View style={[s.meta, isMedia && s.metaMedia]}>
      <Text style={[typography.micro, { color: isSent ? 'rgba(255,255,255,0.78)' : colors.textTertiary }]}>
        {time}
      </Text>
      {isSent && (
        <Icon
          name={
            ['failed', 'cancelled'].includes(message.delivery)
              ? 'alert-circle'
              : message.delivery === 'sending'
                ? 'time-outline'
                : message.delivery === 'delivered'
                  ? 'checkmark-done'
                  : 'checkmark'
          }
          size={13}
          color={['failed', 'cancelled'].includes(message.delivery) ? colors.warning : 'rgba(255,255,255,0.85)'}
          style={s.tick}
        />
      )}
    </View>
  );

  return (
    <View style={[s.row, isSent ? s.rowR : s.rowL]}>
      <View
        style={[
          s.bubble,
          { borderRadius: mediaRadius },
          isSent
            ? { backgroundColor: colors.bubbleSent, borderBottomRightRadius: radius.xs }
            : { backgroundColor: colors.bubbleReceived, borderBottomLeftRadius: radius.xs, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.bubbleReceivedBorder },
          isMedia && s.media,
        ]}
      >
        {['image', 'video', 'file'].includes(message.type) && onOpen ?
          <TouchableOpacity disabled={!mediaActive} accessibilityLabel="Open attachment" onPress={() => {
            onOpen(message);
          }}>{body}</TouchableOpacity> : body}
        {isSent && ['image', 'video', 'file'].includes(message.type) && message.delivery === 'sending' && (
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 10, gap: 12, backgroundColor: '#0009', borderRadius: 16,
            ...(isMedia ? { position: 'absolute', top: 70, alignSelf: 'center' } : {}) }}>
            <View style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }} accessibilityRole="progressbar"
              accessibilityValue={{ min: 0, max: 100, now: Math.round((message.progress || 0) * 100) }}>
              {['checking', 'finishing'].includes(message.sendStage) ? <ActivityIndicator size="large" color="#fff" style={StyleSheet.absoluteFill} />
                : Array.from({ length: 32 }, (_, i) => <View key={i} style={{ position: 'absolute', width: 4, height: 4, borderRadius: 2,
                  left: 22 + 21 * Math.sin(i * Math.PI / 16), top: 22 - 21 * Math.cos(i * Math.PI / 16),
                  backgroundColor: i / 32 < (message.progress || 0) ? '#fff' : '#ffffff40' }} />)}
              {message.sendStage !== 'finishing' && onCancelSend && <TouchableOpacity accessibilityRole="button" accessibilityLabel="Cancel file send"
                style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }} onPress={() => onCancelSend(message.id)}>
                <Icon name="close" color="#fff" size={24} />
              </TouchableOpacity>}
            </View>
            <Text style={{ color: '#fff', fontWeight: '600' }}>{message.sendStage === 'checking' ? 'Checking...' : message.sendStage === 'finishing' ? 'Finishing...' : `${Math.round((message.progress || 0) * 100)}%`}</Text>
          </View>
        )}
        {!isSent && message.allowSaving === true && ['image', 'video', 'file'].includes(message.type) && onSave && (
          <TouchableOpacity onPress={save} disabled={saving || !mediaActive}
            accessibilityRole="button" accessibilityLabel="Save privately in Whisper" style={{ padding: 10 }}>
            <Icon name={saving ? 'hourglass-outline' : 'download-outline'} size={24} color={colors.accent} />
          </TouchableOpacity>
        )}
        {message.delivery === 'cancelled' && <Text style={{ color: colors.textSecondary, padding: 8 }}>Cancelled</Text>}
        {meta}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  row: { marginVertical: 3, marginHorizontal: sp.md },
  rowR: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  rowL: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  media: {
    padding: 3,
    overflow: 'hidden',
  },
  // Timestamp / ticks row, anchored bottom-right inside the bubble.
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    marginTop: 4,
    gap: 2,
  },
  metaMedia: {
    // Sit the meta slightly off the media edge.
    marginRight: 4,
    marginBottom: 2,
    marginTop: 5,
  },
  tick: {
    marginLeft: 1,
    marginTop: 0,
  },
  // System message
  systemRow: {
    alignItems: 'center',
    marginVertical: 6,
    marginHorizontal: sp.xl,
  },
  systemPill: {
    paddingHorizontal: sp.md,
    paddingVertical: 6,
    borderRadius: radius.full,
    maxWidth: '90%',
  },
  // File attachment
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 2,
    minWidth: 180,
    gap: sp.sm,
  },
  fileIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileMeta: {
    flex: 1,
  },
});
