import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, Alert, BackHandler, AppState, Platform, useWindowDimensions } from 'react-native';
import { CameraView, Camera } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import Icon from './Icon';
import PrivateVideo from './PrivateVideo';
import { SafeAreaView } from 'react-native-safe-area-context';
import { recordCleanup } from '../services/cleanupStatus';
import { MAX_ATTACHMENT_BYTES } from '../services/mediaLimits';

// Android reports the previous camera state as OPEN immediately after a rebind,
// before the new session streams; wait for readiness events to settle.
const READY_SETTLE_MS = 400;
// Stopping before the encoder writes a keyframe yields an empty, unusable file.
const MIN_RECORDING_MS = 1000;
const MAX_RECORDING_BYTES = MAX_ATTACHMENT_BYTES - 2 * 1024 * 1024;
// Prefer ~12 MP on Android; fall back to the largest available size.
const MAX_PICTURE_PIXELS = 16_000_000;

// Render inside the chat's secure native window, never an external camera app.
export default function ChatCamera({ onDone, hd = true, onHdChange }) {
  const { width, height } = useWindowDimensions();
  const [area, setArea] = useState({ width, height });
  const camera = useRef(null);
  const active = useRef(true);
  const busy = useRef(false);
  const requestingPermission = useRef(false);
  const owned = useRef(null);
  const callback = useRef(onDone);
  callback.current = onDone;
  const [mode, setMode] = useState('picture');
  const [facing, setFacing] = useState('back');
  const [ready, setReady] = useState(false);
  const [pictureSize, setPictureSize] = useState(undefined);
  const configuredCamera = useRef(null);
  const configuration = useRef('picture-back');
  configuration.current = `${mode}-${facing}`;
  const stopping = useRef(false);
  const recordingStartedAt = useRef(0);
  const readyTimer = useRef(null);
  const markReady = (expected) => {
    clearTimeout(readyTimer.current);
    readyTimer.current = setTimeout(() => {
      if (active.current && configuration.current === expected) setReady(true);
    }, READY_SETTLE_MS);
  };
  // Picture sizes differ per lens, so re-read them after every reconfiguration.
  const resetReady = () => { clearTimeout(readyTimer.current); configuredCamera.current = null; setReady(false); };
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState(null);
  const remove = (uri) => uri ? FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => recordCleanup('scratch-delete', false)) : Promise.resolve();
  const close = () => {
    active.current = false;
    camera.current?.stopRecording();
    callback.current(null);
  };
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
    const state = AppState.addEventListener('change', (next) => {
      if (next === 'background' && !requestingPermission.current) close();
    });
    return () => {
      active.current = false;
      clearTimeout(readyTimer.current);
      camera.current?.stopRecording();
      remove(owned.current);
      back.remove(); state.remove();
    };
  }, []);
  const capture = async () => {
    if (recording) {
      if (!stopping.current) {
        stopping.current = true;
        const wait = Math.max(0, MIN_RECORDING_MS - (Date.now() - recordingStartedAt.current));
        setTimeout(() => camera.current?.stopRecording(), wait);
      }
      return;
    }
    if (!ready || busy.current) return;
    busy.current = true; setWorking(true);
    try {
      if (mode === 'video') {
        stopping.current = false; recordingStartedAt.current = Date.now();
        setRecordingSeconds(0); setRecording(true);
      }
      const result = mode === 'video'
        ? await camera.current.recordAsync({ maxFileSize: MAX_RECORDING_BYTES })
        // skipProcessing keeps the camera JPEG; re-encoding adds grain.
        : await camera.current.takePictureAsync({ quality: 1, skipProcessing: true, exif: false, shutterSound: false });
      if (!result?.uri) throw new Error('Capture returned no media');
      if (!active.current) { await remove(result.uri); return; }
      owned.current = result.uri;
      setPreview({ ...result, type: mode === 'video' ? 'video' : 'image' });
    } catch (error) {
      if (active.current) {
        const code = /^[A-Z][A-Z0-9_]{1,60}$/.test(error?.code || '') ? ` (${error.code})` : '';
        Alert.alert('Capture failed', `Could not finish this ${mode === 'video' ? 'video' : 'photo'}. Check camera/microphone permissions and available storage, then retry.${code}`);
      }
    } finally {
      busy.current = false;
      stopping.current = false;
      if (active.current) { setWorking(false); setRecording(false); setRecordingSeconds(0); }
    }
  };
  useEffect(() => {
    if (!recording) return undefined;
    const timer = setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  const recordingTime = `${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, '0')}`;
  const selectMode = async (next) => {
    if (busy.current || next === mode) return;
    busy.current = true;
    try {
      if (next === 'video') {
        requestingPermission.current = true;
        const permission = await Camera.requestMicrophonePermissionsAsync();
        if (!active.current) return;
        if (!permission.granted) { Alert.alert('Microphone permission', 'Allow microphone access to record video with sound.'); return; }
      }
      setPictureSize(undefined); resetReady(); setMode(next);
    } catch {
      Alert.alert('Microphone unavailable', 'Could not request microphone access. Check Whisper permissions in Settings.');
    } finally { busy.current = false; requestingPermission.current = false; }
  };
  const dimensions = pictureSize?.split('x').map(Number);
  const ratio = mode === 'video' ? 16 / 9 : dimensions?.[0] / dimensions?.[1] || 4 / 3;
  const displayRatio = width > height ? ratio : 1 / ratio;
  const previewWidth = Math.min(area.width, area.height * displayRatio);
  return <SafeAreaView style={s.cover}>
    <View style={s.header}><TouchableOpacity onPress={close} style={s.button} accessibilityLabel="Close camera"><Icon name="close" size={28} color="#fff" /></TouchableOpacity>
      <View style={s.headerTitle}>{recording && <View style={s.recordingDot} />}<Text style={s.text}>{recording ? `Recording ${recordingTime}` : preview ? 'Review capture' : 'Camera'}</Text></View>
      {onHdChange && <TouchableOpacity onPress={() => onHdChange(!hd)} hitSlop={8}
        accessibilityRole="switch" accessibilityState={{ checked: hd }} accessibilityLabel="Send in HD"
        accessibilityHint="Sends a quick standard copy first, then replaces it with full quality"
        style={[s.hdToggle, hd && s.hdToggleOn]}>
        <Text style={[s.hdText, !hd && s.hdTextOff]}>HD</Text>
      </TouchableOpacity>}
    </View>
    {preview ? <>
      {preview.type === 'image' ? <Image source={{ uri: preview.uri }} style={s.preview} resizeMode="contain" />
        : <PrivateVideo uri={preview.uri} playing={true} style={s.preview} />}
      <View style={s.row}>
        <TouchableOpacity style={s.button} accessibilityLabel="Discard capture" onPress={close}><Icon name="trash-outline" size={28} color="#fff" /></TouchableOpacity>
        <TouchableOpacity accessibilityLabel="Retake capture" disabled={working} style={s.button} onPress={async () => {
          if (busy.current) return;
          busy.current = true; setWorking(true);
          await remove(owned.current); owned.current = null;
          busy.current = false;
          if (active.current) { setWorking(false); resetReady(); setPreview(null); }
        }}><Icon name="refresh" size={28} color="#fff" /></TouchableOpacity>
        <TouchableOpacity accessibilityLabel="Send capture" disabled={working} style={s.button} onPress={() => {
          if (!active.current || busy.current) return;
          owned.current = null; // Ownership transfers to attachment preparation.
          active.current = false;
          callback.current(preview);
        }}><Icon name="send" size={28} color="#fff" /></TouchableOpacity>
      </View>
    </> : <>
      <View style={s.preview} onLayout={({ nativeEvent: { layout } }) => setArea(layout)}>
      <CameraView ref={camera} style={{ width: previewWidth, height: previewWidth / displayRatio, alignSelf: 'center' }} ratio={mode === 'video' ? '16:9' : '4:3'} mode={mode} facing={facing}
        videoQuality="1080p" videoBitrate={12000000} videoStabilizationMode="off"
        pictureSize={mode === 'video' ? undefined : Platform.OS === 'ios' ? 'Photo' : pictureSize}
        onCameraReady={async () => {
          const view = camera.current;
          const expected = `${mode}-${facing}`;
          if (!view || configuration.current !== expected) return;
          if (Platform.OS === 'android' && mode === 'picture' && configuredCamera.current !== view) {
            configuredCamera.current = view;
            try {
              const sizes = await view.getAvailablePictureSizesAsync();
              if (!active.current || camera.current !== view || configuration.current !== expected) return;
              const supported = sizes.map((size) => {
                const match = /^(\d+)x(\d+)$/.exec(size);
                return { size, area: match ? Number(match[1]) * Number(match[2]) : 0 };
              }).filter((item) => item.area > 0).sort((a, b) => b.area - a.area);
              const chosen = supported.find((item) => item.area <= MAX_PICTURE_PIXELS) || supported[supported.length - 1];
              if (chosen) setPictureSize(chosen.size);
            } catch {
              if (active.current) Alert.alert('Camera quality', 'Could not read available photo sizes. The camera will use its default size.');
            }
          }
          if (active.current && configuration.current === expected) markReady(expected);
        }}
        onMountError={() => { Alert.alert('Camera unavailable', 'Close the camera and try again.'); close(); }} />
      </View>
      <View style={s.row}>
        <TouchableOpacity disabled={working} style={s.button} accessibilityLabel="Photo mode" onPress={() => selectMode('picture')}><Icon name="camera" size={26} color={mode === 'picture' ? '#ffd54f' : '#fff'} /></TouchableOpacity>
        <TouchableOpacity disabled={working} style={s.button} accessibilityLabel="Video mode" onPress={() => selectMode('video')}><Icon name="videocam" size={26} color={mode === 'video' ? '#ffd54f' : '#fff'} /></TouchableOpacity>
      </View>
      <Text style={[s.text, { textAlign: 'center', fontSize: 12, padding: 8 }]}>Private capture · Not saved to Photos or Gallery</Text>
      <View style={s.row}>
        <TouchableOpacity accessibilityLabel="Switch camera" disabled={working || !ready} style={s.button} onPress={() => { setPictureSize(undefined); resetReady(); setFacing(facing === 'back' ? 'front' : 'back'); }}><Icon name="camera-reverse-outline" size={28} color="#fff" /></TouchableOpacity>
        <TouchableOpacity disabled={!ready || (working && !recording)} style={s.shutter} onPress={capture} accessibilityLabel={recording ? 'Stop recording' : mode === 'video' ? 'Record video' : 'Take photo'}>
          <View style={{ width: recording ? 28 : 54, height: recording ? 28 : 54, borderRadius: recording ? 6 : 27, backgroundColor: mode === 'video' ? '#ff453a' : '#fff' }} />
        </TouchableOpacity>
      </View>
    </>}
  </SafeAreaView>;
}
const s = StyleSheet.create({
  cover: { ...StyleSheet.absoluteFill, backgroundColor: '#000', zIndex: 20 },
  preview: { flex: 1, minHeight: 0, width: '100%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 16 },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recordingDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#ff453a' },
  row: { flexWrap: 'wrap', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingBottom: 12 },
  button: { padding: 18 }, text: { color: '#fff', fontSize: 16 },
  selected: { color: '#ffd54f', fontWeight: '700' },
  hdToggle: { height: 30, paddingHorizontal: 10, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', justifyContent: 'center' },
  hdToggleOn: { borderColor: '#ffd54f', backgroundColor: 'rgba(255,213,79,0.18)' },
  hdText: { color: '#ffd54f', fontSize: 13, fontWeight: '700' },
  hdTextOff: { color: 'rgba(255,255,255,0.6)', textDecorationLine: 'line-through' },
  shutter: { width: 76, height: 76, alignItems: 'center', justifyContent: 'center', marginHorizontal: 24, borderWidth: 2, borderColor: '#fff', borderRadius: 40 },
});
