import { loadHttpStore } from './http-store.mjs';
import { loadMemoryStore } from './memory-store.mjs';

/**
 * Pick the persistence seam at boot. When served by the session server,
 * /api/session responds and we use the live HttpStore. When opened standalone
 * (the Phase-2 _serve.mjs dev path), it 404s/errors and we fall back to the
 * in-memory fixture store. The UI never learns which it got.
 */
export async function createStore() {
  try {
    const res = await fetch('/api/session', { cache: 'no-store' });
    if (res.ok) return loadHttpStore(await res.json());
  } catch {
    // network error → not served by the session server; fall through to fixtures
  }
  return loadMemoryStore();
}
