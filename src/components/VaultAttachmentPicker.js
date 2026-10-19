import React, { useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { listSavedFiles, vaultError, beginVaultSession, subscribeVaultLock, getVaultLockState } from '../services/privateVault';
import { useTheme } from '../hooks/useTheme';

export default function VaultAttachmentPicker({ onSelect, onClose }) {
  const { colors } = useTheme();
  const [items, setItems] = useState([]), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const selected = useRef(false);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [onClose]);
  useEffect(() => {
    let active = true, release; setLoading(true); setError('');
    const unsubscribe = subscribeVaultLock(state => { if (state.locked && active) { setItems([]); setError('Saved Files is locked. Retry to authenticate, or open Saved Files to Reset Whisper if the key is unavailable.'); release?.(); release = null; } });
    beginVaultSession().then(end => { release = end; if (!active) { end(); return []; } return listSavedFiles(); }).then((files) => { if (active && !getVaultLockState().locked) { setItems(files); setError(''); } })
      .catch((e) => { if (active) setError(vaultError(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; unsubscribe(); release?.(); };
  }, [attempt]);
  return <SafeAreaView style={[s.cover, { backgroundColor: colors.surface }]}>
    <View style={s.header}><Text style={[s.title, { color: colors.text }]}>Send from Saved Files</Text>
      <TouchableOpacity accessibilityRole="button" onPress={onClose} style={s.button}><Text style={{ color: colors.accent }}>Cancel</Text></TouchableOpacity></View>
    {loading && <ActivityIndicator color={colors.accent} />}
    {!!error && <View><Text accessibilityRole="alert" style={[s.note, { color: colors.danger }]}>{error}</Text>
      <TouchableOpacity accessibilityRole="button" style={s.button} onPress={() => setAttempt((n) => n + 1)}><Text style={{ color: colors.accent }}>Retry</Text></TouchableOpacity></View>}
    <FlatList data={items} keyExtractor={(item) => item.id}
      ListEmptyComponent={!loading && !error ? <Text style={[s.note, { color: colors.textSecondary }]}>No saved files yet. Save a received attachment privately in Whisper first.</Text> : null}
      renderItem={({ item }) => <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Send ${item.name}`} disabled={loading}
        style={[s.item, { borderColor: colors.hairline }]} onPress={() => { if (!selected.current) { selected.current = true; onSelect(item); } }}>
        <Text style={{ color: colors.text }}>{item.name}</Text>
        <Text style={{ color: colors.textSecondary }}>{item.mime} · {item.size.toLocaleString()} bytes</Text>
        <Text style={{ color: colors.textSecondary }}>{new Date(item.savedAt).toLocaleString()}</Text>
      </TouchableOpacity>} />
  </SafeAreaView>;
}
const s = StyleSheet.create({ cover: { ...StyleSheet.absoluteFill, zIndex: 100 }, header: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16 },
  title: { flex: 1, fontSize: 20, fontWeight: '600' }, button: { padding: 16, minHeight: 48 }, note: { padding: 16 }, item: { padding: 18, borderBottomWidth: 1 } });
