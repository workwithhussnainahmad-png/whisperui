import { disconnectSocket } from './socket';
import { clearExternalShareFiles } from './vaultExport';
import { wipePrivateVault } from './privateVault';

// Whisper has anonymous sessions, not user accounts. The visible Reset Whisper
// action is its logout/account-reset boundary. Ordinary chat leave is not reset.
export async function resetWhisper() {
  try { disconnectSocket(); }
  finally { try { await wipePrivateVault(); } finally { await clearExternalShareFiles(); } }
}
