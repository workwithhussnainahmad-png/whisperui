import React, { useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, Alert, AppState, StyleSheet, ActivityIndicator, Switch, TextInput, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from '../components/Icon';
import AttachmentViewer from '../components/AttachmentViewer';
import { listSavedFiles, deleteSavedFile, vaultError, beginVaultSession, subscribeVaultLock, getVaultLockState, configureVaultLock, disableVaultLock, lockSavedFiles } from '../services/privateVault';
import { resetWhisper } from '../services/accountReset';
import { ensureCaptureProtection } from '../services/captureProtection';
import { useTheme } from '../hooks/useTheme';

export default function SavedFilesScreen({ navigation }) {
  const { colors } = useTheme();
  const [items, setItems] = useState([]), [error, setError] = useState('');
  const [busy, setBusy] = useState(true), [viewing, setViewing] = useState(null);
  const [lockState, setLockState] = useState(getVaultLockState());
  const [destructive, setDestructive] = useState(false), [confirmation, setConfirmation] = useState('');
  const confirmWipe = useRef(null);
  const session = useRef(null);
  const mounted = useRef(true), working = useRef(false);
  async function reload() {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try {
      await ensureCaptureProtection();
      session.current?.(); session.current = await beginVaultSession();
      if (!mounted.current) { session.current(); session.current = null; return; }
      const result = await listSavedFiles();
      if (mounted.current && !getVaultLockState().locked) setItems(result);
    } catch (e) { if (mounted.current) { setItems([]); setError(vaultError(e)); } }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true; reload();
    const unsubscribe = subscribeVaultLock(state => {
      setLockState(state);
      if (state.locked) { setItems([]); setViewing(null); session.current?.(); session.current = null; }
    });
    const sub = AppState.addEventListener('change', (state) => { if (state !== 'active') setViewing(null); });
    return () => { confirmWipe.current?.(false); mounted.current = false; sub.remove(); unsubscribe(); session.current?.(); };
  }, []);
  async function changeLock(enabled, timeout) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await configureVaultLock(enabled, timeout); }
    catch (e) { setError(vaultError(e)); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  async function disableLock() {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try {
      const wiped = await disableVaultLock(() => new Promise(resolve => {
        confirmWipe.current = resolve; setConfirmation(''); setDestructive(true);
      }));
      if (wiped && mounted.current) setItems([]);
    } catch (error) { if (mounted.current) setError(vaultError(error)); }
    finally {
      confirmWipe.current = null; working.current = false;
      if (mounted.current) { setDestructive(false); setBusy(false); }
    }
  }
  function toggleLock(enabled) {
    if (!enabled) { disableLock(); return; }
    Alert.alert(enabled ? 'Lock Saved Files?' : 'Turn off Saved Files lock?', enabled
      ? 'Your device will require authentication to read or save vault files. Removing your device PIN/passcode or losing its protected key can make saved files permanently inaccessible. There is no bypass; Reset Whisper erases them.'
      : 'All saved files will be permanently deleted. This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        { text: enabled ? 'Enable lock' : 'Disable lock', onPress: () => changeLock(enabled, lockState.timeout) },
      ]);
  }
  function remove(item) {
    Alert.alert('Delete saved file?', `Delete “${item.name}” from private Saved Files?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        if (working.current) return;
        working.current = true; setBusy(true); setViewing(null);
        try { await deleteSavedFile(item.id); }
        catch (e) { Alert.alert('Could not delete saved file', vaultError(e)); }
        finally { working.current = false; if (mounted.current) reload(); }
      } },
    ]);
  }
  function reset() {
    Alert.alert('Reset Whisper?', 'This ends your anonymous session and permanently removes all files saved privately in Whisper and their encryption key.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset Whisper', style: 'destructive', onPress: async () => {
        if (working.current) return;
        working.current = true; setBusy(true); setViewing(null);
        try {
          await resetWhisper();
          if (mounted.current) navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
        } catch (e) { if (mounted.current) { setItems([]); setError(vaultError(e)); } }
        finally { working.current = false; if (mounted.current) setBusy(false); }
      } },
    ]);
  }
  const action = (label, onPress, disabled = false) => <TouchableOpacity accessibilityRole="button" disabled={disabled}
    onPress={onPress} style={[s.button, { backgroundColor: colors.surface2, borderRadius: 14, margin: 4 }]}><Text style={{ color: disabled ? colors.textTertiary : colors.accent }}>{label}</Text></TouchableOpacity>;
  return <SafeAreaView style={[s.screen, { backgroundColor: colors.background || colors.surface }]}>
    <View style={s.header}><TouchableOpacity accessibilityLabel="Go back" onPress={() => navigation.goBack()} style={s.button}><Icon name="arrow-back" /></TouchableOpacity><View style={{ flex: 1 }}><Text style={[s.title, { color: colors.text }]}>Saved Files</Text><Text style={{ color: colors.textSecondary, fontSize: 12 }}>YOUR PRIVATE COLLECTION</Text></View><Icon name="shield-checkmark-outline" color={colors.accent} size={26} /></View>
    <FlatList style={{ flex: 1 }} data={items} keyExtractor={(item) => item.id} contentContainerStyle={s.list}
      ListHeaderComponent={<>
    <View style={[s.card, { backgroundColor: colors.accentTint, marginTop: 8 }]}><Icon name="lock-closed-outline" color={colors.accent} size={28} /><View style={{ flex: 1 }}><Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>Only in Whisper</Text><Text style={{ color: colors.textSecondary, marginTop: 5, lineHeight: 20 }}>Encrypted and private. Your files stay here after the chat ends.</Text></View></View>
    <View style={[s.card, { backgroundColor: colors.surface1 }]}><Icon name="finger-print-outline" color={colors.accent} size={26} /><Text style={{ flex: 1, color: colors.text, fontWeight: '600' }}>Lock Saved Files</Text>
      <Switch accessibilityLabel="Lock Saved Files" value={lockState.enabled} disabled={busy} onValueChange={toggleLock} /></View>
    {lockState.enabled && <View>
      <Text style={[s.note, { color: colors.textSecondary }]}>Always locks in background. Foreground unlock session:</Text>
      <View style={s.row}>{[[0, 'Immediate'], [60, '1 min'], [300, '5 min']].map(([seconds, label]) =>
        <View key={seconds}>{action(`${lockState.timeout === seconds ? 'Selected: ' : ''}${label}`, () => changeLock(true, seconds), busy)}</View>)}</View>
      {lockState.timeout === 0 && <Text style={[s.note, { color: colors.textSecondary }]}>Immediate locks when you close the last vault screen or finish its current operation.</Text>}
      {!lockState.locked && action('Lock now', lockSavedFiles, busy)}
    </View>}
    {lockState.locked && !busy && <View>
      <Text style={[s.note, { color: colors.text }]}>{lockState.recovery
        ? 'Vault cannot be unlocked. Device security changed or the key is unavailable. Retry, or Reset Whisper to erase the inaccessible vault. There is no bypass.'
        : 'Saved Files is locked. Authenticate to view, save or send files.'}</Text>
      {action(lockState.recovery ? 'Retry unlock' : 'Unlock Saved Files', reload)}
    </View>}
    {busy && <ActivityIndicator accessibilityLabel="Loading private files" color={colors.accent} />}
    {!!error && <View><Text accessibilityRole="alert" style={[s.note, { color: colors.danger }]}>{error}</Text>{action('Retry', reload, busy)}</View>}
      </>}
      ListEmptyComponent={!busy && !error && !lockState.locked ? <View style={{ alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 }}><Icon name="folder-open-outline" size={52} color={colors.accent} /><Text style={{ color: colors.text, fontSize: 20, fontWeight: '600', marginTop: 20 }}>Your private collection starts here</Text><Text style={{ color: colors.textSecondary, textAlign: 'center', lineHeight: 22, marginTop: 10 }}>Tap Save on an attachment in chat to keep it here.</Text></View> : null}
      renderItem={({ item }) => <View style={[s.card, { backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.hairline }]}>
        <View style={{ backgroundColor: colors.accentTint, padding: 12, borderRadius: 14 }}><Icon name={item.mime.startsWith('image/') ? 'image-outline' : item.mime.startsWith('video/') ? 'videocam-outline' : 'document-text-outline'} color={colors.accent} size={24} /></View>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={`View ${item.name}`} disabled={busy}
          style={s.item} onPress={() => setViewing({ vaultId: item.id, messageId: item.id, fileName: item.name,
            mimeType: item.mime, fileSize: item.size, isSent: true, allowSaving: false })}>
          <Text style={{ color: colors.text, fontWeight: '600', fontSize: 15 }} numberOfLines={2}>{item.name}</Text>
          <Text style={{ color: colors.textSecondary }}>{item.mime.split('/')[1]?.toUpperCase()} · {item.size >= 1048576 ? (item.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(item.size / 1024)) + ' KB'}</Text>
          <Text style={{ color: colors.textSecondary }}>{new Date(item.savedAt).toLocaleDateString()}</Text>
        </TouchableOpacity><TouchableOpacity accessibilityLabel={`Delete ${item.name}`} disabled={busy} onPress={() => remove(item)} style={{ padding: 12 }}><Icon name="trash-outline" size={20} color={colors.textSecondary} /></TouchableOpacity>
      </View>} />
    {action('Reset Whisper', reset, busy)}
    {destructive && <SafeAreaView style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}>
      <Text style={[s.note, { color: colors.text }]}>All saved files will be permanently deleted. This cannot be undone.</Text>
      <TextInput accessibilityLabel="Type DELETE to erase Saved Files" placeholder="Type DELETE" autoCapitalize="characters"
        value={confirmation} onChangeText={setConfirmation} style={[s.note, { color: colors.text, borderWidth: 1, borderColor: colors.hairline }]} />
      {action('Cancel', () => confirmWipe.current?.(false))}
      {action('Permanently delete and disable lock', () => confirmWipe.current?.(true), confirmation !== 'DELETE')}
    </ScrollView></KeyboardAvoidingView></SafeAreaView>}
    {viewing && <AttachmentViewer message={viewing} onClose={() => setViewing(null)} />}
  </SafeAreaView>;
}
const s = StyleSheet.create({ screen: { flex: 1 }, header: { flexDirection: 'row', alignItems: 'center', paddingRight: 24, paddingVertical: 12 },
  title: { fontSize: 22, fontWeight: '600' }, note: { padding: 16 }, list: { paddingHorizontal: 16 },
  row: { flexWrap: 'wrap', flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingVertical: 12 },
  card: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 20, gap: 12, marginBottom: 12 },
  item: { flex: 1, paddingVertical: 8 }, button: { padding: 16, minHeight: 48, justifyContent: 'center' } });
