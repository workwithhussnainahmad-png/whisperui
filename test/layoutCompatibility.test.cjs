const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('UI uses supported React Native overlay positioning', () => {
  const api = fs.readFileSync(require.resolve('react-native/Libraries/StyleSheet/StyleSheetExports'), 'utf8');
  assert.match(api, /\babsoluteFill,/);
  function check(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) check(name);
    else if (name.endsWith('.js')) assert.doesNotMatch(fs.readFileSync(name, 'utf8'), /StyleSheet\.absoluteFillObject/, name);
  }}
  check(path.join(__dirname, '../src'));
});
