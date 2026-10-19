const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { transformSync } = require('@babel/core');
const file = require('node:path').resolve('src/services/vaultLock.js');
const { code } = transformSync(fs.readFileSync(file, 'utf8'), { filename: file, configFile: false, babelrc: false, plugins: ['@babel/plugin-transform-modules-commonjs'] });
const m = { exports: {} }; new Function('module', 'exports', code)(m, m.exports);
const { createVaultLock } = m.exports;
function fixture(enabled = true, timeout = 60) {
  let policy = { enabled, timeout }, key = false, authError, hooks = {}, cleanup = 0, prompts = 0;
  const timers = new Set();
  const api = createVaultLock({
    policy: async () => ({ ...policy }),
    unlock: async () => { prompts++; if (authError) throw authError; await hooks.unlock?.(); key = true; },
    lock: () => { key = false; }, cleanup: () => { cleanup++; }, cancelAuth() {},
    prepare: async () => { key = true; },
    configure: async (enabled, timeout) => { if (authError) throw authError; await hooks.beforeCommit?.(); policy = { enabled, timeout }; await hooks.afterCommit?.(); return policy; },
    wipe: async () => { key = false; policy = { enabled: false, timeout: 60 }; },
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; }, clearTimer: timer => timers.delete(timer),
  });
  return { api, timers, hooks, get key() { return key; }, get policy() { return policy; }, get prompts() { return prompts; }, get cleanup() { return cleanup; }, fail: message => { authError = message ? new Error(message) : null; } };
}
test('lock starts closed; cancel/wrong auth never opens it; successful auth expires', async () => {
  const f = fixture(); await f.api.initialize(); assert.equal(f.key, false);
  for (const message of ['Vault authentication cancelled', 'Vault authentication unavailable']) {
    f.fail(message); await assert.rejects(f.api.acquire()); assert.equal(f.key, false); assert.equal(f.api.getState().locked, true);
  }
  f.fail(null); const release = await f.api.acquire(); assert.equal(f.key, true);
  const timer = [...f.timers][0]; assert.equal(timer.ms, 60000); timer.fn();
  assert.equal(f.key, false); assert.equal(f.api.getState().locked, true); release();
});
test('background/manual/immediate lock clean active content and close access', async () => {
  for (const mode of ['background', 'manual', 'immediate']) {
    const f = fixture(true, mode === 'immediate' ? 0 : 300); const release = await f.api.acquire();
    if (mode === 'background') f.api.background(false); else if (mode === 'manual') f.api.lock(); else release();
    assert.equal(f.key, false); assert.equal(f.api.getState().locked, true); assert.ok(f.cleanup); release();
  }
});
test('invalidated key shows recovery; reset works locked without another auth attempt', async () => {
  const f = fixture(); f.fail('Vault key unavailable. Device security changed');
  await assert.rejects(f.api.acquire()); assert.equal(f.api.getState().recovery, true);
  const prompts = f.prompts; await f.api.reset();
  assert.equal(f.prompts, prompts); assert.equal(f.key, false); assert.equal(f.policy.enabled, false);
});
test('background during authentication cannot retain a returned key', async () => {
  const f = fixture(); f.hooks.unlock = () => { f.api.background(false); };
  await assert.rejects(f.api.acquire(), /cancelled/); assert.equal(f.key, false);
});
for (const enabled of [true]) for (const point of ['beforeCommit', 'afterCommit']) {
  test(`migration ${enabled ? 'enable' : 'disable'} interrupted ${point} reconciles the committed policy and stays locked`, async () => {
    const f = fixture(!enabled); f.hooks[point] = () => { throw new Error('Simulated process interruption'); };
    await assert.rejects(f.api.configure(enabled, 300));
    assert.equal(f.policy.enabled, point === 'beforeCommit' ? !enabled : enabled);
    assert.equal(f.api.getState().enabled, f.policy.enabled); assert.equal(f.api.getState().locked, true); assert.equal(f.key, false);
    // A restarted controller uses the surviving policy; no data reset or bypass is offered.
    f.hooks[point] = null; const release = await f.api.acquire(); release();
  });
}
test('cancelled lock setting keeps previous protection; no silent downgrade', async () => {
  const f = fixture(); const release = await f.api.acquire(); release(); f.fail('Vault authentication cancelled');
  await assert.rejects(f.api.disable(async () => true)); assert.equal(f.policy.enabled, true); assert.equal(f.key, false);
});

test('disable authenticates before confirmation; cancelling either step preserves vault', async () => {
  const f = fixture(); let confirms = 0;
  f.fail('Vault authentication cancelled');
  await assert.rejects(f.api.disable(async () => { confirms++; return true; }));
  assert.equal(confirms, 0); assert.equal(f.policy.enabled, true);
  f.fail(null); await f.api.disable(async () => { confirms++; return false; });
  assert.equal(confirms, 1); assert.equal(f.policy.enabled, true);
});
test('confirmed disable wipes keys and allows a new unlocked vault', async () => {
  const f = fixture(); await f.api.disable(async () => true);
  assert.equal(f.policy.enabled, false); assert.equal(f.key, false);
  const release = await f.api.acquire(); assert.equal(f.api.getState().locked, false); release();
});
test('background or timeout during destructive confirmation prevents wipe', async () => {
  const f = fixture();
  await assert.rejects(f.api.disable(async () => { f.api.background(false); return true; }));
  assert.equal(f.policy.enabled, true);
});
