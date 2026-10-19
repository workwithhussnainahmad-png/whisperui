import { protectPrivateTemporary } from '../services/privateStorage';
import { recordCleanup } from '../services/cleanupStatus';
import React, { useState, useRef } from 'react';
import { View, TouchableOpacity, Text, StyleSheet, Modal, Pressable, Alert, Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { deleteAttachment } from '../services/attachmentFiles';
import { prepareAttachment, prepareStandardCopy } from '../services/prepareAttachment';
import { cleanAbandonedCaptures } from '../services/cameraCache';
import * as DocumentPicker from 'expo-document-picker';
import { Camera } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import Icon from './Icon';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sp, radius, shadows } from '../theme';
import { useTheme } from '../hooks/useTheme';
import { useResponsiveLayout } from '../hooks/useResponsiveLayout';
import { getChatEpoch, isChatEpochActive } from '../services/socket';

const OPTS = [
  { key: 'camera', icon: 'camera-outline', label: 'Camera' },
  { key: 'photo', icon: 'image-outline', label: 'Photo' },
  { key: 'video', icon: 'videocam-outline', label: 'Video' },
  { key: 'file', icon: 'document-text-outline', label: 'File' },
  { key: 'vault', icon: 'lock-closed-outline', label: 'Saved Files' },
];


function confirmPrivacyWarning(title, message) {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Send', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

export default function MediaPickerButton({ onImageSelected, onVideoSelected, onFileSelected, onProcessingChange, onPreparingChange, onOpenCamera, onOpenVault, hd = true, disabled = false }) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const updateProcessing = (value) => { setIsProcessing(value); onPreparingChange?.(value); };
  const hdRef = useRef(hd);
  hdRef.current = hd;

  // Deliver a quick standard copy first. With HD on, the full-quality original
  // follows as a promise that always settles (to null when unavailable).
  const prepareVisual = async (asset, type, epoch) => {
    const isActive = () => isChatEpochActive(epoch);
    const source = { ...asset, mimeType: asset.mimeType || (type === 'video' ? 'video/mp4' : 'image/jpeg') };
    const deliver = type === 'video' ? onVideoSelected : onImageSelected;
    const normalize = (prepared) => ({ ...prepared, mimeType: type === 'video' ? prepared.mimeType || 'video/mp4' : 'image/jpeg' });
    const standard = await prepareStandardCopy(source, isActive).catch((error) => { if (!isActive()) throw error; return null; });
    if (!standard) {
      const prepared = await prepareAttachment(source, isActive, confirmPrivacyWarning);
      if (!prepared) return;
      if (isActive()) deliver(normalize(prepared));
      else deleteAttachment(prepared.fileUri);
      return;
    }
    if (!isActive()) { deleteAttachment(standard.fileUri); return; }
    if (!hdRef.current) { deliver(normalize(standard)); return; }
    let settleUpgrade;
    deliver(normalize(standard), new Promise((resolve) => { settleUpgrade = resolve; }));
    let full = null;
    try {
      updateProcessing(false);
      full = await prepareAttachment(source, isActive, async () => false);
      if (full && !isActive()) { deleteAttachment(full.fileUri); full = null; }
    } catch { full = null; }
    finally { settleUpgrade(full && normalize(full)); }
  };
  const [isPicking, setIsPicking] = useState(false);
  const pickingRef = useRef(false);
  const pendingPick = useRef(null);
  const { colors, typography } = useTheme();
  const { isTablet, touchMin } = useResponsiveLayout();
  const isDisabled = disabled || isProcessing || isPicking;

  const pick = async (key) => {
    if (isDisabled || pickingRef.current) return;
    if (key === 'vault') { setOpen(false); onOpenVault?.(); return; }
    pickingRef.current = true;
    setIsPicking(true);
    setOpen(false);
    const epoch = getChatEpoch();
    const ownedCopies = [];
    const rememberCopy = (uri) => {
      if (typeof uri === 'string' && FileSystem.cacheDirectory && uri.startsWith(FileSystem.cacheDirectory)) { ownedCopies.push(uri); protectPrivateTemporary(uri); }
    };
    onProcessingChange?.(true);
    try {
      await cleanAbandonedCaptures();
      if (!isChatEpochActive(epoch)) return;
      if (key === 'camera') {
        const permission = await Camera.requestCameraPermissionsAsync();
        if (!permission.granted) { Alert.alert('Camera permission', 'Allow camera access to take photos or videos.'); return; }
        if (!isChatEpochActive(epoch)) return;
        const asset = await onOpenCamera?.();
        if (!asset) return;
        rememberCopy(asset.uri);
        if (!isChatEpochActive(epoch)) return;
        updateProcessing(true);
        await prepareVisual(asset, asset.type === 'video' ? 'video' : 'image', epoch);
      }
      else if (key === 'photo') {
        const p = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!p.granted) { updateProcessing(false); return; }
        const r = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 1,
          base64: false,
          allowsEditing: false,
          exif: false,
        });
        if (!r.canceled && r.assets?.[0]) {
          rememberCopy(r.assets[0].uri);
          if (!isChatEpochActive(epoch)) return;
          updateProcessing(true);
          await prepareVisual(r.assets[0], 'image', epoch);
        }
      }
      else if (key === 'video') {
        const r = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['videos'],
          allowsEditing: false,
        });
        if (!r.canceled && r.assets?.[0]) {
          const a = r.assets[0];
          rememberCopy(a.uri);
          if (!isChatEpochActive(epoch)) return;
          updateProcessing(true);
          await prepareVisual(a, 'video', epoch);
        }
      }
      else if (key === 'file') {
        const r = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
        if (!r.canceled && r.assets?.[0]) {
          const a = r.assets[0];
          rememberCopy(a.uri);
          if (!isChatEpochActive(epoch)) return;
          updateProcessing(true);
          const payload = await prepareAttachment(a, () => isChatEpochActive(epoch), async (...args) => {
            updateProcessing(false);
            const confirmed = await confirmPrivacyWarning(...args);
            if (confirmed) updateProcessing(true);
            return confirmed;
          });
          if (payload && isChatEpochActive(epoch)) onFileSelected(payload);
          else if (payload?.fileUri) deleteAttachment(payload.fileUri);
        }
      }
    } catch (err) {
      if (isChatEpochActive(epoch)) Alert.alert('Unable to attach', /^(For private sharing|Install the updated|Attachment must|Prepared attachment|PDFs are limited|Rendered PDF exceeds)/.test(err?.message || '') ? err.message : 'This file could not be prepared safely. Try a smaller file or convert it to PDF or plain text.');
    } finally {
      await Promise.all(ownedCopies.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => recordCleanup('scratch-delete', false))));
      pickingRef.current = false;
      setIsPicking(false);
      updateProcessing(false);
      onProcessingChange?.(false);
    }
  };

  return (
    <View>
      <TouchableOpacity
        style={[
          s.trigger,
          { width: touchMin, height: touchMin, borderRadius: touchMin / 2, backgroundColor: colors.surface2, borderColor: colors.border },
          isDisabled && s.triggerOff,
        ]}
        activeOpacity={0.7}
        disabled={isDisabled}
        onPress={() => { if (!isDisabled) setOpen(true); }}
        accessibilityLabel="Attach media"
        accessibilityRole="button"
      >
        <Icon name="add" size={isTablet ? 24 : 22} color={isDisabled ? colors.textTertiary : colors.accent} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}
        onDismiss={() => {
          const key = pendingPick.current;
          pendingPick.current = null;
          if (key) pick(key);
        }}>
        <Pressable style={[s.overlay, { backgroundColor: colors.overlay }]} onPress={() => setOpen(false)}>
          <Pressable onPress={() => {}}>
            <View
              style={[
                s.sheet,
                { backgroundColor: colors.surface1, borderColor: colors.hairline, paddingBottom: Math.max(insets.bottom, sp.xl) },
                isTablet && s.sheetTablet,
              ]}
            >
              <View style={[s.handle, { backgroundColor: colors.textTertiary }]} />
              <View style={[s.grid, isTablet && s.gridTablet]}>
                {OPTS.map((o) => (
                  <TouchableOpacity
                    key={o.key}
                    style={[s.optBtn, isTablet && s.optBtnTablet]}
                    activeOpacity={0.7}
                    onPress={() => {
                      if (Platform.OS === 'ios') {
                        pendingPick.current = o.key;
                        setOpen(false);
                      } else pick(o.key);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={o.label}
                  >
                    <View style={[s.optCircle, { backgroundColor: colors.accentTint, borderColor: colors.hairline }, isTablet && s.optCircleTablet]}>
                      <Icon name={o.icon} size={isTablet ? 26 : 22} color={colors.accent} />
                    </View>
                    <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}
                      style={[typography.micro, { color: colors.textSecondary }, isTablet && { fontSize: 13 }]}>
                      {o.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity
                style={[s.cancelBtn, { backgroundColor: colors.surface2 }]}
                activeOpacity={0.8}
                onPress={() => setOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={[typography.body, { color: colors.danger }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>



    </View>
  );
}

const s = StyleSheet.create({
  trigger: {
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: sp.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  triggerOff: { opacity: 0.4 },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingTop: sp.sm,
    paddingBottom: sp.xl,
    borderWidth: StyleSheet.hairlineWidth,
    ...shadows.lg,
  },
  sheetTablet: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 560,
    marginBottom: sp.lg,
    marginHorizontal: sp.lg,
    borderRadius: radius.xxl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: sp.lg,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    justifyContent: 'space-between',
    paddingHorizontal: sp.sm,
  },
  gridTablet: {
    paddingHorizontal: sp.lg,
    paddingVertical: sp.sm,
  },
  optBtn: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 2,
  },
  optBtnTablet: { maxWidth: 96 },
  optCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  optCircleTablet: {
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  cancelBtn: {
    marginTop: sp.lg,
    marginHorizontal: sp.lg,
    paddingVertical: 14,
    borderRadius: radius.lg,
    alignItems: 'center',
  },
  processingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  processingBox: {
    padding: sp.lg,
    borderRadius: radius.lg,
    alignItems: 'center',
    minWidth: 140,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
