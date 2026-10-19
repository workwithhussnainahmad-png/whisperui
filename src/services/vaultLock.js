// Platform authentication is enforced by io.unlock/native key access, not this UI state.
export function createVaultLock(io) {
  let policy = null, ready, pending, timer, epoch = 0, uses = 0, foreground = true;
  let state = { enabled: false, timeout: 60, locked: true, authenticating: false, recovery: false };
  const listeners = new Set();
  const emit = () => { for (const listener of listeners) listener({ ...state }); };
  const clearTimer = () => { if (timer) io.clearTimer(timer); timer = null; };
  function lock(cancel = true) {
    epoch++; clearTimer(); state.locked = true;
    io.lock(); io.cleanup();
    if (cancel) io.cancelAuth();
    emit();
  }
  async function initialize() {
    const token = epoch;
    if (!ready) ready = Promise.resolve().then(() => io.policy()).then(value => {
      if (token !== epoch) throw new Error('Saved Files locked. Initialization cancelled.');
      if (![0, 60, 300].includes(value.timeout) || typeof value.enabled !== 'boolean') throw new Error('Vault key unavailable. Retry or Reset Whisper.');
      policy = value; state = { ...state, ...value, locked: value.enabled };
      if (value.enabled) io.lock();
      emit();
    }).catch(error => { if (token === epoch) { ready = null; state.recovery = /key unavailable|key is missing|invalidated/i.test(String(error?.message)); emit(); } throw error; });
    return ready;
  }
  async function acquire() {
    await initialize();
    if (!foreground && !state.authenticating) throw new Error('Saved Files is locked. Return to Whisper to unlock.');
    if (state.locked) {
      if (!pending) {
        const token = epoch;
        state.authenticating = true; emit();
        pending = (async () => {
          try {
            await io.unlock(() => epoch === token && foreground);
            if (epoch !== token || !foreground) throw new Error('Saved Files locked. Unlock was cancelled.');
            state.locked = false; state.recovery = false;
            if (state.enabled && state.timeout > 0) timer = io.setTimer(() => lock(), state.timeout * 1000);
          } catch (error) {
            io.lock(); state.locked = true;
            state.recovery = /key unavailable|key is missing|invalidated/i.test(String(error?.message));
            throw error;
          } finally { pending = null; state.authenticating = false; emit(); }
        })();
      }
      await pending;
    }
    if (state.locked) throw new Error('Saved Files is locked. Unlock to continue.');
    const token = epoch; uses++;
    let released = false;
    return () => {
      if (released) return; released = true; uses--;
      if (token === epoch && state.enabled && state.timeout === 0 && uses === 0) lock();
    };
  }
  return {
    initialize, acquire,
    fail(error) {
      if (/key unavailable|key is missing|invalidated/i.test(String(error?.message))) {
        state.recovery = true; lock();
      }
    },
    getState: () => ({ ...state }),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    lock: () => lock(),
    background: active => {
      foreground = active;
      if (!active && state.enabled && !state.authenticating) lock();
    },
    async disable(confirm) {
      await initialize();
      if (!state.enabled) return false;
      lock(); // Force a new OS key authentication even if a screen was already open.
      const release = await acquire();
      const token = epoch;
      try {
        if (!await confirm()) { lock(); return false; }
        if (epoch !== token || !foreground || state.locked) throw new Error('Saved Files locked. Retry disabling.');
        lock(); await io.wipe(); policy = null; ready = null;
        state = { enabled: false, timeout: 60, locked: false, authenticating: false, recovery: false }; emit();
        return true;
      } finally { release(); }
    },
    async configure(enabled, timeout) {
      if (!enabled) throw new Error('Disabling lock requires confirmation and erases all saved files.');
      await initialize();
      if (pending) throw new Error('Vault authentication is already in progress.');
      // Ensure a new empty vault has a master before migration, then erase JS keys.
      const release = await acquire();
      try { await io.prepare(); } finally { release(); }
      lock(); state.authenticating = true; emit();
      const token = epoch;
      pending = (async () => {
        try {
          const committed = await io.configure(enabled, timeout);
          if (token !== epoch) throw new Error('Saved Files locked. Lock change was cancelled.');
          policy = committed; state = { ...state, ...policy, locked: true, recovery: false };
        } catch (error) {
          if (token === epoch) {
            state.recovery = /key unavailable|key is missing|invalidated/i.test(String(error?.message));
            try { policy = await io.policy(); state = { ...state, ...policy }; } catch { state.recovery = true; }
          }
          throw error;
        } finally { pending = null; state.authenticating = false; emit(); }
      })();
      await pending;
    },
    async reset() {
      lock(); await io.wipe(); policy = null; ready = null;
      state = { enabled: false, timeout: 60, locked: true, authenticating: false, recovery: false }; emit();
    },
  };
}
