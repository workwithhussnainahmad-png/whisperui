// Lookup only. No code bytes are passed into key derivation.
export function normalizeJoinCode(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  let text = value.trim();
  if (/^whisperchat:\/\/join\//i.test(text)) text = text.slice('whisperchat://join/'.length);
  const code = text.toUpperCase().replace(/[-\s]/g, '');
  return /^[0-9A-Z]{6}$/.test(code) ? code : null;
}
export function displayJoinCode(value) {
  const code = normalizeJoinCode(value);
  return code || '';
}
