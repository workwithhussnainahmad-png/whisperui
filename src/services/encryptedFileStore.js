import nacl from 'tweetnacl';

// Ephemeral, append-only cache. Keys and the authenticated record index exist
// only in memory. No recovery after process death is intended. This is a cache
// format built on NaCl secretbox, not a messaging protocol or secure deletion.
export const CACHE_CHUNK_BYTES = 98304;
const OVERHEAD = 24 + 16 + 8;

export function createEncryptedFileStore({ createFile, removeFile, randomBytes, requireStorage, maxBytes }) {
  const entries = new Map();
  function entryFor(uri) {
    const entry = entries.get(uri);
    if (!entry) throw new Error('Attachment is no longer available');
    return entry;
  }
  function forget(uri) {
    const entry = entries.get(uri);
    if (!entry) return;
    entries.delete(uri);
    entry.key.fill(0);
    for (const close of [...entry.handles]) close();
    entry.records.length = 0;
  }
  function open(uri) {
    const entry = entryFor(uri);
    const raw = entry.file.open();
    let offset = 0;
    let closed = false;
    const check = () => {
      if (closed || entries.get(uri) !== entry) throw new Error('Attachment handle is closed');
      if (entry.file.size !== entry.diskSize) throw new Error('Encrypted attachment size changed');
    };
    const close = () => {
      if (closed) return;
      closed = true;
      entry.handles.delete(close);
      raw.close();
    };
    entry.handles.add(close);
    return {
      get offset() { return offset; },
      set offset(value) {
        check();
        if (!Number.isSafeInteger(value) || value < 0 || value > entry.size) throw new Error('Invalid attachment offset');
        offset = value;
      },
      writeBytes(bytes) {
        check();
        if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > CACHE_CHUNK_BYTES ||
            offset !== entry.size || entry.size + bytes.length > maxBytes || entry.sealed) {
          throw new Error('Invalid encrypted attachment write');
        }
        requireStorage(bytes.length + OVERHEAD);
        const nonce = randomBytes(24);
        const input = new Uint8Array(8 + bytes.length);
        const view = new DataView(input.buffer);
        view.setUint32(0, entry.records.length);
        view.setUint32(4, bytes.length);
        input.set(bytes, 8);
        let cipher;
        try {
          cipher = nacl.secretbox(input, nonce, entry.key);
          raw.offset = entry.diskSize;
          raw.writeBytes(nonce);
          raw.writeBytes(cipher);
          entry.records.push({ at: entry.diskSize, start: entry.size, size: bytes.length });
          entry.diskSize += nonce.length + cipher.length;
          entry.size += bytes.length;
          offset = entry.size;
        } catch (error) {
          forget(uri);
          removeFile(uri);
          throw error;
        } finally { nonce.fill(0); input.fill(0); cipher?.fill(0); }
      },
      readBytes(length) {
        check();
        if (!entry.sealed || !Number.isSafeInteger(length) || length < 0 || length > CACHE_CHUNK_BYTES) {
          throw new Error('Invalid encrypted attachment read');
        }
        const output = new Uint8Array(Math.min(length, entry.size - offset));
        let written = 0;
        try {
          while (written < output.length) {
            const index = entry.records.findIndex((record) => offset >= record.start && offset < record.start + record.size);
            const record = entry.records[index];
            if (!record) throw new Error('Invalid encrypted attachment index');
            raw.offset = record.at;
            const nonce = raw.readBytes(24);
            const cipher = raw.readBytes(record.size + 24);
            let plain;
            try {
              if (nonce.length !== 24 || cipher.length !== record.size + 24) throw new Error('Truncated attachment');
              plain = nacl.secretbox.open(cipher, nonce, entry.key);
              if (!plain || plain.length !== record.size + 8) throw new Error('Attachment authentication failed');
              const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
              if (view.getUint32(0) !== index || view.getUint32(4) !== record.size) throw new Error('Attachment record was replaced');
              const within = offset - record.start;
              const take = Math.min(record.size - within, output.length - written);
              output.set(plain.subarray(8 + within, 8 + within + take), written);
              offset += take;
              written += take;
            } finally { nonce.fill(0); cipher.fill(0); plain?.fill(0); }
          }
          return output;
        } catch (error) { output.fill(0); throw error; }
      },
      close,
    };
  }
  function fileFor(uri) {
    return { uri, get size() { return entryFor(uri).size; }, open: () => open(uri) };
  }
  return {
    has: (uri) => entries.has(uri),
    get: fileFor,
    create() {
      const key = randomBytes(32);
      let file;
      try { file = createFile(); }
      catch (error) { key.fill(0); throw error; }
      entries.set(file.uri, { file, key, size: 0, diskSize: 0, sealed: false, records: [], handles: new Set() });
      return fileFor(file.uri);
    },
    seal(uri) {
      const entry = entryFor(uri);
      if (entry.size < 1 || entry.file.size !== entry.diskSize) throw new Error('Incomplete encrypted attachment');
      entry.sealed = true;
      return { fileUri: uri, fileSize: entry.size };
    },
    forget,
    clear() { for (const uri of [...entries.keys()]) { forget(uri); removeFile(uri); } },
  };
}
