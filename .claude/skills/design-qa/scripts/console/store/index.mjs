import { loadHttpStore } from './http-store.mjs';
import { loadMemoryStore } from './memory-store.mjs';
import { loadLookbackStore } from './lookback-store.mjs';

/**
 * Pick the persistence seam at boot:
 *
 *   1. `?session=<basename>` in the URL → LookbackStore (Phase 6 read-only
 *      view of an archived sibling session, served by the current server's
 *      `/api/session?id=` + `/sessions/<base>/screenshots/` routes).
 *   2. `/api/session` responds → HttpStore (the normal live console path,
 *      one server per session, sole writer).
 *   3. Neither — fall back to the in-memory fixture (the Phase-2 `_serve.mjs`
 *      dev path; no live server present).
 *
 * The UI is unaware which it got: every store exposes the same interface.
 */
export async function createStore() {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const lookbackId = params.get('session');
  if (lookbackId) return loadLookbackStore(lookbackId);

  try {
    const res = await fetch('/api/session', { cache: 'no-store' });
    if (res.ok) return loadHttpStore(await res.json());
  } catch {
    // network error → not served by the session server; fall through to fixtures
  }
  return loadMemoryStore();
}
