// Keep the receiver's bounded reorder window: never send more than `width`
// chunks ahead of the first unacknowledged chunk, even if later ACKs arrive first.
export function runTransferWindow(count, width, send) {
  return new Promise((resolve, reject) => {
    const acknowledged = new Set();
    let base = 0, next = 0, pending = 0, failure;
    function pump() {
      if (failure) { if (!pending) reject(failure); return; }
      if (base === count) { resolve(); return; }
      while (next < count && next < base + width) {
        const index = next++;
        pending++;
        Promise.resolve().then(() => send(index)).then(() => {
          acknowledged.add(index);
          while (acknowledged.delete(base)) base++;
        }, error => { failure ||= error; }).finally(() => { pending--; pump(); });
      }
    }
    pump();
  });
}
