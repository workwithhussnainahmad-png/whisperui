import React, { useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, Alert, AppState, StyleSheet, ActivityIndicator, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AttachmentViewer from '../components/AttachmentViewer';
import { listSavedFiles, deleteSavedFile, vaultError, beginVaultSession, subscribeVaultLock, getVaultLockState, configureVaultLock, lockSavedFiles } from '../services/privateVault';
import { resetWhisper } from '../services/accountReset';
import { ensureCaptureProtection } from '../services/captureProtection';
import { useTheme } from '../hooks/useTheme';

export default function SavedFilesScreen({ navigation }) {
  const { colors } = useTheme();
  const [items, setItems] = useState([]), [error, setError] = useState('');
  const [busy, setBusy] = useState(true), [viewing, setViewing] = useState(null);
  const [lockState, setLockState] = useState(getVaultLockState());
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
    return () => { mounted.current = false; sub.remove(); unsubscribe(); session.current?.(); };
  }, []);
  async function changeLock(enabled, timeout) {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await configureVaultLock(enabled, timeout); }
    catch (e) { setError(vaultError(e)); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  function toggleLock(enabled) {
    Alert.alert(enabled ? 'Lock Saved Files?' : 'Turn off Saved Files lock?', enabled
      ? 'Your device will require authentication to read or save vault files. Removing your device PIN/passcode or losing its protected key can make saved files permanently inaccessible. There is no bypass; Reset Whisper erases them.'
      : 'Saved Files will no longer require device authentication. Confirm with your device credential to continue.', [
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
    onPress={onPress} style={s.button}><Text style={{ color: disabled ? colors.textTertiary : colors.accent }}>{label}</Text></TouchableOpacity>;
  return <SafeAreaView style={[s.screen, { backgroundColor: colors.background || colors.surface }]}>
    <View style={s.header}>{action('Back', () => navigation.goBack())}<Text style={[s.title, { color: colors.text }]}>Saved Files</Text></View>
    <FlatList style={{ flex: 1 }} data={items} keyExtractor={(item) => item.id} contentContainerStyle={s.list}
      ListHeaderComponent={<>
    <Text style={[s.note, { color: colors.textSecondary }]}>Saved privately in Whisper. Files remain here after a chat ends or the app restarts.</Text>
    <View style={s.row}><Text style={[s.note, { color: colors.text }]}>Lock Saved Files</Text>
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
      ListEmptyComponent={!busy && !error && !lockState.locked ? <Text style={[s.note, { color: colors.textSecondary }]}>No saved files yet. Tap Save on a received attachment to keep it privately in Whisper.</Text> : null}
      renderItem={({ item }) => <View style={[s.row, { borderColor: colors.hairline }]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={`View ${item.name}`} disabled={busy}
          style={s.item} onPress={() => setViewing({ vaultId: item.id, messageId: item.id, fileName: item.name,
            mimeType: item.mime, fileSize: item.size, isSent: true, allowSaving: false })}>
          <Text style={{ color: colors.text }} numberOfLines={2}>{item.name}</Text>
          <Text style={{ color: colors.textSecondary }}>{item.mime} · {item.size.toLocaleString()} bytes</Text>
          <Text style={{ color: colors.textSecondary }}>{new Date(item.savedAt).toLocaleString()}</Text>
        </TouchableOpacity>{action('Delete', () => remove(item), busy)}
      </View>} />
    {action('Reset Whisper', reset, busy)}
    {viewing && <AttachmentViewer message={viewing} onClose={() => setViewing(null)} />}
  </SafeAreaView>;
}
const s = StyleSheet.create({ screen: { flex: 1 }, header: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, fontSize: 22, fontWeight: '600' }, note: { padding: 16 }, list: { paddingHorizontal: 16 },
  row: { flexWrap: 'wrap', flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingVertical: 12 },
  item: { flex: 1, paddingVertical: 8 }, button: { padding: 16, minHeight: 48, justifyContent: 'center' } });
