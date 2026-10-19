import React, { useEffect, useState } from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView, StyleSheet, BackHandler, Alert } from 'react-native';
import PrivateVideo from './PrivateVideo';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from './Icon';
import { acquireAttachmentFile, readAttachmentBase64, mediaExtension } from '../services/attachmentFiles';
import { renderPdfPage, officeText, isOffice, hasNativeDocumentTools, validateImageFile } from '../services/documentMedia';
import { acquireVaultPreview, readVaultDocument, vaultError, beginVaultSession, subscribeVaultLock } from '../services/privateVault';

// Same native window as the protected conversation; no external viewer or
// native fullscreen activity is opened for private attachments.
export default function AttachmentViewer({ message, onClose, onSave }) {
  const [authorized, setAuthorized] = useState(!message.vaultId);
  useEffect(() => {
    if (!message.vaultId) return;
    let active = true, release, opened = false;
    const unsubscribe = subscribeVaultLock(state => {
      if (state.locked && opened) { setAuthorized(false); onClose(); }
    });
    beginVaultSession().then(end => {
      release = end;
      if (!active) { end(); return; }
      opened = true; setAuthorized(true);
    }).catch(error => { if (active) { Alert.alert('Saved Files locked', vaultError(error)); onClose(); } });
    return () => { active = false; unsubscribe(); release?.(); };
  }, [message.vaultId]);
  if (!authorized) return null;
  return <AttachmentContent key={message.vaultId || message.messageId || message.fileUri} message={message} onClose={onClose} onSave={onSave} />;
}

function AttachmentContent({ message, onClose, onSave }) {
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState(null);
  const [page, setPage] = useState(0);
  const [pdf, setPdf] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [validatedImageUri, setValidatedImageUri] = useState(null);
  const [previewUri, setPreviewUri] = useState(null);
  const [data, setData] = useState(message.imageData || message.videoData || message.fileData || null);
  useEffect(() => {
    let active = true;
    if ((message.fileUri || message.vaultId) && !/^(image|video|audio)\//.test(message.mimeType)) {
      if (message.fileSize <= 3_000_000) {
        Promise.resolve().then(() => message.vaultId ? readVaultDocument(message, () => active) : readAttachmentBase64(message.fileUri))
          .then((value) => { if (active) setData(value); })
          .catch((error) => { if (active) setPreviewError(message.vaultId ? vaultError(error) : 'Preview unavailable.'); });
      } else setPreviewError('This file is too large for an in-app document preview.');
    }
    return () => { active = false; };
  }, [message.fileUri, message.vaultId]);
  const uri = previewUri;
  const image = message.mimeType.startsWith('image/');
  const playable = /^(video|audio)\//.test(message.mimeType);
  const isPdf = message.mimeType === 'application/pdf';
  useEffect(() => {
    let active = true;
    let lease;
    const release = () => { try { lease?.release(); } catch (error) { Alert.alert('Private preview cleanup failed', vaultError(error)); } };
    setValidatedImageUri(null);
    if (image || playable) {
      (async () => {
        lease = message.vaultId ? await acquireVaultPreview(message, () => active)
          : await acquireAttachmentFile(message.fileUri, mediaExtension(message.mimeType));
        if (!active) { release(); return; }
        if (image) await validateImageFile(lease.uri);
        if (!active) { release(); return; }
        setPreviewUri(lease.uri);
        if (image) setValidatedImageUri(lease.uri);
      })().catch((error) => {
        release();
        if (active) setPreviewError(message.vaultId ? vaultError(error) : 'This attachment cannot be previewed safely.');
      });
    }
    return () => { active = false; release(); };
  }, [message.fileUri, message.vaultId, image, playable]);
  useEffect(() => {
    let active = true;
    if (isPdf && !hasNativeDocumentTools()) setPreviewError('PDF preview requires the updated Whisper build.');
    if (isPdf && data && hasNativeDocumentTools()) {
      setPdf(null); setPreviewError('');
      renderPdfPage(data, page).then((value) => { if (active) setPdf(value); })
        .catch(() => { if (active) setPreviewError('This PDF could not be rendered safely.'); });
    }
    return () => { active = false; };
  }, [data, page, isPdf]);
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    if (message.mimeType === 'text/plain' && data && data.length <= 4_000_000) {
      try { setText(new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))); }
      catch { setText(null); }
    }
    if (data && isOffice(message.mimeType, message.fileName)) {
      try { setText(officeText(data)); }
      catch { setPreviewError('This document could not be rendered safely.'); }
    }
    return () => back.remove();
  }, [data]);
  return <SafeAreaView style={s.cover}>
    <View style={s.header}>
      <TouchableOpacity onPress={onClose} accessibilityLabel="Close attachment" style={s.button}>
        <Icon name="close" size={28} color="white" />
      </TouchableOpacity>
      <Text style={s.title} numberOfLines={1}>{message.fileName || 'Attachment'}</Text>
      {!message.isSent && message.allowSaving && <TouchableOpacity disabled={saving} style={s.button}
        accessibilityLabel="Save privately in Whisper" onPress={async () => {
          setPlaying(false); setSaving(true);
          try { await onSave(message); } finally { setSaving(false); }
        }}><Icon name={saving ? 'hourglass-outline' : 'download-outline'} color="white" size={26} /></TouchableOpacity>}
    </View>
    {isPdf ? <View style={s.content}>
      {pdf ? <Image source={{ uri: `data:image/jpeg;base64,${pdf.image}` }} resizeMode="contain" style={s.content} />
        : <Text style={s.label}>{previewError || 'Preparing page…'}</Text>}
      <View style={s.header}>
        <TouchableOpacity disabled={!pdf || page === 0} style={s.button} onPress={() => setPage(page - 1)}><Text style={s.label}>Previous</Text></TouchableOpacity>
        <Text style={s.title}>{page + 1}{pdf ? ` / ${pdf.pageCount}` : ''}</Text>
        <TouchableOpacity disabled={!pdf || page + 1 >= pdf.pageCount} style={s.button} onPress={() => setPage(page + 1)}><Text style={s.label}>Next</Text></TouchableOpacity>
      </View>
    </View> : image ? (uri && validatedImageUri === uri ? <Image source={{ uri, cache: 'reload' }} resizeMode="contain" style={s.content} />
      : <View style={s.content}><Text style={s.label}>{previewError || 'Checking image…'}</Text></View>)
      : playable ? <View style={s.content}>
        {uri ? <PrivateVideo uri={uri} style={s.content} playing={playing}
          onStopped={() => setPlaying(false)} /> : <Text style={s.label}>{previewError || 'Preparing preview…'}</Text>}
        <TouchableOpacity disabled={!uri} style={s.button} onPress={() => setPlaying(!playing)} accessibilityLabel={playing ? 'Pause' : 'Play'}>
          <Text style={s.label}>{playing ? 'Pause' : 'Play'}</Text>
        </TouchableOpacity>
      </View> : text !== null ? <ScrollView style={s.content}><Text style={s.label}>{text}</Text></ScrollView>
        : <View style={s.content}><Text style={s.label}>{previewError || 'Preview is unavailable for this file type.'}{message.allowSaving ? ' You can save it privately in Whisper.' : ''}</Text></View>}
  </SafeAreaView>;
}
const s = StyleSheet.create({
  cover: { ...StyleSheet.absoluteFill, backgroundColor: '#000', zIndex: 100 },
  header: { flexDirection: 'row', alignItems: 'center' },
  button: { padding: 16, alignItems: 'center' },
  title: { color: '#fff', flex: 1 },
  content: { flex: 1, width: '100%' },
  label: { color: '#fff', padding: 20, fontSize: 16 },
});
