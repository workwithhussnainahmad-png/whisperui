import nacl from 'tweetnacl';

// New records use format 2 (index, length, final marker); format 1 remains readable.
// Index publication is the commit point; all disk names are opaque identifiers.
export const VAULT_CHUNK = 98304;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_INDEX = 2 * 1024 * 1024;
const ID = /^[0-9a-f-]{36}$/;
const enc = (s) => new TextEncoder().encode(s);
const b64 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 16384) s += String.fromCharCode(...b.subarray(i, i + 16384)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const invalid = () => new Error('Saved file or vault index is corrupted. Nothing was opened.');

export function createPrivateVaultStore(io) {
  let master = null, entries = null, queue = Promise.resolve(), generation = 0;
  const leases = new Map(), activeKeys = new Set();
  let blocked = false;
  const track = key => { activeKeys.add(key); return key; };
  const erase = key => { key.fill(0); activeKeys.delete(key); };
  function lock() {
    generation++; blocked = true;
    master?.fill(0); master = null; entries = null;
    for (const key of activeKeys) key.fill(0);
    activeKeys.clear();
    for (const closes of [...leases.values()]) for (const close of [...closes]) {
      try { close(); } catch { io.onCleanupFailure?.(); }
    }
  }
  function chunkReader(e, key, check) {
    const file = io.file(`${e.id}.box`), header = e.format === 2 ? 9 : 8;
    const count = Math.ceil(e.size / VAULT_CHUNK), diskSize = e.size + count * (header + 40);
    let reader = file.open(), next = 0, total = 0;
    return {
      readChunk(index) {
        check();
        if (!reader || index !== next || index >= count || file.size !== diskSize) throw invalid();
        const n = Math.min(VAULT_CHUNK, e.size - total), packed = reader.readBytes(n + header + 40);
        if (packed.length !== n + header + 40) throw invalid();
        const plain = open(packed, key);
        try {
          const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
          if (plain.length !== n + header || view.getUint32(0) !== index || view.getUint32(4) !== n ||
              (e.format === 2 && plain[8] !== (index === count - 1 ? 1 : 0))) throw invalid();
          total += n; next++;
          if (next === count && (total !== e.size || file.size !== diskSize)) throw invalid();
          return plain.slice(header);
        } finally { plain.fill(0); }
      },
      close() { reader?.close(); reader = null; },
    };
  }
  function seal(bytes, key) {
    const nonce = io.randomBytes(24);
    const cipher = nacl.secretbox(bytes, nonce, key);
    const packed = new Uint8Array(24 + cipher.length);
    packed.set(nonce); packed.set(cipher, 24); return packed;
  }
  function open(bytes, key) {
    if (bytes.length < 40) throw invalid();
    const result = nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), key);
    if (!result) throw invalid();
    return result;
  }
  function readAll(file, max) {
    if (file.size > max) throw invalid();
    const out = new Uint8Array(file.size), handle = file.open();
    try {
      for (let at = 0; at < out.length;) {
        const block = handle.readBytes(Math.min(VAULT_CHUNK, out.length - at));
        if (!block.length) throw invalid();
        out.set(block, at); at += block.length;
      }
      return out;
    } finally { handle.close(); }
  }
  function publish(next) {
    const plain = enc(JSON.stringify({ v: 1, entries: next }));
    if (plain.length > MAX_INDEX - 40) { plain.fill(0); throw new Error('Saved Files is full. Delete some files first.'); }
    const cipher = seal(plain, master); plain.fill(0);
    io.requireStorage(cipher.length);
    const name = `${io.uuid()}.tmp`;
    let handle;
    try {
      handle = io.create(name).open();
      for (let at = 0; at < cipher.length; at += VAULT_CHUNK) handle.writeBytes(cipher.subarray(at, at + VAULT_CHUNK));
      handle.close(); handle = null;
      io.commit(name, 'index.v1');
      entries = next;
    } finally { handle?.close(); io.remove(name); }
  }
  function validate(value) {
    if (value?.v !== 1 || !Array.isArray(value.entries) || value.entries.length > 2000) throw invalid();
    const ids = new Set();
    for (const e of value.entries) {
      if (!e || !ID.test(e.id) || ids.has(e.id) || typeof e.name !== 'string' || e.name.length > 255 ||
          ![undefined, 1, 2].includes(e.format) || typeof e.mime !== 'string' || e.mime.length > 128 || !Number.isSafeInteger(e.size) || e.size < 1 || e.size > MAX_FILE ||
          !Number.isSafeInteger(e.savedAt) || e.savedAt < 0 || e.savedAt > 8640000000000000 || typeof e.wrappedKey !== 'string' || e.wrappedKey.length !== 96) throw invalid();
      ids.add(e.id);
    }
    return value.entries;
  }
  async function initialize(check = () => {}) {
    if (entries) return;
    const names = io.list();
    const candidate = await io.masterKey(!names.some((n) => n === 'index.v1' || n.endsWith('.box')));
    try { check(); } catch (error) { candidate?.fill(0); throw error; }
    master = candidate;
    if (!(master instanceof Uint8Array) || master.length !== 32) throw new Error('The private vault key is missing. Reset Whisper to erase the inaccessible vault.');
    try {
      if (names.includes('index.v1')) {
        const plain = open(readAll(io.file('index.v1'), MAX_INDEX), master);
        try { entries = validate(JSON.parse(new TextDecoder().decode(plain))); } finally { plain.fill(0); }
      } else {
        if (names.some((n) => n.endsWith('.box'))) throw invalid();
        publish([]);
      }
      const live = new Set(entries.map((e) => `${e.id}.box`));
      for (const name of io.list()) {
        if (/^[0-9a-f-]{36}\.(tmp|box)$/.test(name) && !live.has(name)) io.remove(name);
      }
    } catch (error) { master?.fill(0); master = null; entries = null; throw error; }
  }
  function run(work) {
    const epoch = generation;
    const check = () => { if (epoch !== generation) throw new Error('Whisper was reset or Saved Files locked. The operation was cancelled.'); };
    const result = queue.then(async () => { check(); if (blocked) throw new Error('Saved Files is locked. Unlock to continue.'); await initialize(check); check(); return work(check); });
    queue = result.catch(() => {}); return result;
  }
  const publicEntry = ({ wrappedKey, ...e }) => ({ ...e });
  return {
    lock,
    inspectState: () => ({ locked: blocked, masterPresent: master !== null, perFileKeys: activeKeys.size, entriesPresent: entries !== null, leases: [...leases.values()].reduce((n, set) => n + set.size, 0) }),
    unlock: (active = () => true) => {
      const epoch = generation;
      const check = () => { if (epoch !== generation || !active()) throw new Error('Saved Files locked. Unlock was cancelled.'); };
      const result = queue.then(async () => { check(); await initialize(check); check(); blocked = false; });
      queue = result.catch(() => {}); return result;
    },
    openForSend: (id, active = () => true) => run(async (check) => {
      const e = entries.find((item) => item.id === id);
      if (!e) throw new Error('This saved file is no longer available.');
      const key = track(open(unb64(e.wrappedKey), master));
      const ensureActive = () => { check(); if (!active()) throw new Error('Send cancelled or chat ended.'); };
      let reader, closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try { reader?.close(); } finally { erase(key); leases.get(id)?.delete(close); if (!leases.get(id)?.size) leases.delete(id); }
      };
      try {
        // Authenticate the entire file before allowing the first network chunk.
        // Re-authenticate every chunk during transmission to detect later changes.
        reader = chunkReader(e, key, ensureActive);
        for (let i = 0; i < Math.ceil(e.size / VAULT_CHUNK); i++) {
          reader.readChunk(i).fill(0);
          if (i % 8 === 7) await io.yield();
        }
        reader.close(); ensureActive(); reader = chunkReader(e, key, ensureActive);
        if (!leases.has(id)) leases.set(id, new Set());
        leases.get(id).add(close);
        return { entry: publicEntry(e), size: e.size, readChunk: (i) => { if (closed) throw new Error('Send cancelled or chat ended.'); return reader.readChunk(i); }, close };
      } catch (error) { close(); throw error; }
    }),
    list: () => run(() => entries.map(publicEntry).sort((a, b) => b.savedAt - a.savedAt)),
    save: (source, metadata, active = () => true) => run(async (check) => {
      const size = source.size;
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE) throw new Error('Saved files must be between 1 byte and 64 MiB.');
      if (entries.length >= 2000) throw new Error('Saved Files is full. Delete some files first.');
      const ensureActive = () => { check(); if (!active()) throw new Error('Chat ended before the file was saved.'); };
      ensureActive();
      io.requireStorage(size + Math.ceil(size / VAULT_CHUNK) * 49 + MAX_INDEX);
      const id = io.uuid(), temp = `${id}.tmp`, final = `${id}.box`, key = track(io.randomBytes(32));
      let reader, writer, committed = false;
      try {
        reader = source.open(); writer = io.create(temp).open();
        for (let at = 0, index = 0; at < size; index++) {
          ensureActive();
          const n = Math.min(VAULT_CHUNK, size - at), block = reader.readBytes(n);
          const plain = new Uint8Array(9 + n), view = new DataView(plain.buffer);
          try {
            if (block.length !== n) throw new Error('The attachment changed while saving.');
            view.setUint32(0, index); view.setUint32(4, n); plain[8] = at + n === size ? 1 : 0; plain.set(block, 9);
            writer.writeBytes(seal(plain, key));
          } finally { block.fill(0); plain.fill(0); }
          at += n;
          if (index % 8 === 7) await io.yield();
        }
        reader.close(); reader = null; writer.close(); writer = null;
        ensureActive();
        if (source.size !== size) throw new Error('The attachment changed while saving.');
        io.commit(temp, final);
        const entry = { id, format: 2, name: String(metadata.name || 'Attachment').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255),
          mime: String(metadata.mime || 'application/octet-stream').slice(0, 128), size, savedAt: Date.now(), wrappedKey: b64(seal(key, master)) };
        publish([...entries, entry]); committed = true;
        return publicEntry(entry);
      } finally {
        erase(key); reader?.close(); writer?.close();
        io.remove(temp); if (!committed) io.remove(final);
      }
    }),
    read: (id, consume, active = () => true) => run(async (check) => {
      const e = entries.find((item) => item.id === id);
      if (!e) throw new Error('This saved file is no longer available.');
      const key = track(open(unb64(e.wrappedKey), master));
      let reader;
      try {
        if (key.length !== 32) throw invalid();
        const file = io.file(`${e.id}.box`);
        const header = e.format === 2 ? 9 : 8, overhead = header + 40;
        let total = 0;
        if (file.size !== e.size + Math.ceil(e.size / VAULT_CHUNK) * overhead) throw invalid();
        reader = file.open();
        for (let at = 0, index = 0; at < e.size; index++) {
          check(); if (!active()) throw new Error('Preview was closed.');
          const n = Math.min(VAULT_CHUNK, e.size - at), packed = reader.readBytes(n + overhead);
          if (packed.length !== n + overhead) throw invalid();
          const plain = open(packed, key);
          try {
            const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
            if (plain.length !== n + header || view.getUint32(0) !== index || view.getUint32(4) !== n) throw invalid();
            if (e.format === 2 && plain[8] !== (at + n === e.size ? 1 : 0)) throw invalid();
            consume(plain.subarray(header)); total += n;
          } finally { plain.fill(0); }
          at += n;
          if (index % 8 === 7) await io.yield();
        }
        if (total !== e.size || file.size !== e.size + Math.ceil(e.size / VAULT_CHUNK) * overhead) throw invalid();
        check(); if (!active()) throw new Error('Preview was closed.');
      } finally { erase(key); reader?.close(); }
    }),
    delete: (id) => run(() => {
      if (leases.get(id)?.size) throw new Error('This saved file is being sent. Cancel or finish the send before deleting it.');
      const e = entries.find((item) => item.id === id);
      if (!e) throw new Error('This saved file is no longer available.');
      publish(entries.filter((item) => item.id !== id));
      io.remove(`${id}.box`);
    }),
    wipe: () => {
      lock();
      const result = queue.then(async () => {
        let cleanupError;
        for (const closes of [...leases.values()]) for (const close of [...closes]) {
          try { close(); } catch (error) { cleanupError = error; }
        }
        master?.fill(0); master = null; entries = null;
        await io.wipe(); blocked = false;
        if (cleanupError) throw cleanupError;
      });
      queue = result.catch(() => {}); return result;
    },
  };
}
