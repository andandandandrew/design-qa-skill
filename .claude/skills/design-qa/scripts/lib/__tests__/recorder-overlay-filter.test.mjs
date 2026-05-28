/**
 * Unit tests for the overlay-event filter in lib/recorder.mjs.
 *
 * Background: clicks INSIDE our `__design_qa_host` overlay (Mark-start chip,
 * Recording popover, comment composer, panel buttons) are retargeted by the
 * closed shadow root to the host element. Without filtering, the Playwright
 * recorder captures them as real interactions and pollutes the persisted
 * spec — the engineer's replay would re-click our UI instead of the actual
 * app. Same for any stray Playwright in-page UI clicks (x-pw-*).
 *
 * The filter lives at the recorder-adapter boundary so dropped events never
 * touch `events[]`, the redactor, or the caller's sinks. These tests pin the
 * shape so a future regex change can't quietly let overlay actions through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOverlayAction } from '../recorder.mjs';

test('drops clicks whose selector references our overlay host id', () => {
  assert.equal(isOverlayAction({ action: { selector: 'internal:role=button >> #__design_qa_host' } }), true);
  assert.equal(isOverlayAction({ action: { selector: '#__design_qa_host' } }), true);
  assert.equal(isOverlayAction({ action: { selector: 'div[id="__design_qa_host"]' } }), true);
});

test('drops events targeting Playwright in-page UI (x-pw-*)', () => {
  assert.equal(isOverlayAction({ action: { selector: 'x-pw-glass' } }), true);
  assert.equal(isOverlayAction({ action: { selector: 'x-pw-tool-overlay > .pw-action-point' } }), true);
  // Case-insensitive — the recorder may upper-case or lower-case tag names
  // depending on selector engine.
  assert.equal(isOverlayAction({ action: { selector: 'X-PW-HIGHLIGHT' } }), true);
});

test('keeps real-app interactions (semantic locators) untouched', () => {
  assert.equal(isOverlayAction({ action: { selector: 'internal:role=button[name="Save"]' } }), false);
  assert.equal(isOverlayAction({ action: { selector: 'internal:label="Password"' } }), false);
  assert.equal(isOverlayAction({ action: { selector: '#email' } }), false);
  // A real selector that contains "host" but not our specific id is fine.
  assert.equal(isOverlayAction({ action: { selector: '.dashboard-host > button' } }), false);
});

test('defaults to KEEP on missing / malformed input (defensive)', () => {
  // Losing real data because of a regex glitch would be worse than letting one
  // overlay click through — the assertion direction matters.
  assert.equal(isOverlayAction(null), false);
  assert.equal(isOverlayAction({}), false);
  assert.equal(isOverlayAction({ action: {} }), false);
  assert.equal(isOverlayAction({ action: { selector: '' } }), false);
  assert.equal(isOverlayAction({ action: { selector: null } }), false);
});
