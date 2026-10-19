// Direct HTTPS transport; this does not route traffic through Tor.
// Public groups remain disabled. One-to-one random chat uses libsignal and
// explicit unverified-peer notices and bilateral media consent.
export const ALLOW_UNVERIFIED_CHATS = false;
export function getServerUrl() {
  const value = process.env.EXPO_PUBLIC_SERVER_URL || 'https://mywhisperchat.duckdns.org';
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname !== '/' || parsed.hostname.endsWith('.onion')) {
    throw new Error('Chat transport requires an HTTPS server origin');
  }
  return parsed.origin;
}
