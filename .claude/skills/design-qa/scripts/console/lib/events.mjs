/**
 * Tiny synchronous pub/sub. The console's live-update boundary: components and
 * the store talk through this rather than calling each other directly, so the
 * Phase-4 HTTP/SSE transport can drive the same `emit` without the UI knowing.
 */
export function createEmitter() {
  const listeners = new Set();
  return {
    /** subscribe(fn) → unsubscribe(). */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(payload) {
      for (const fn of [...listeners]) {
        try { fn(payload); } catch (err) { console.error('listener error', err); }
      }
    },
  };
}
