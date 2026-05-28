/**
 * Unit tests for lib/emit-spec.mjs (Spike 8, phase 9d). Pure-function tests —
 * no Playwright, no disk, no SessionStore. Inputs are small hand-rolled v4 docs.
 *
 * The tests cover the load-bearing emit invariants:
 *   - Precondition + recorded blocks both materialize, in that order.
 *   - View dividers appear between view.steps[] groups.
 *   - Omitted steps don't reach the emitted text.
 *   - Implicit `page.goto(firstAction.pageUrl)` lands when the first recorded
 *     step isn't a navigation (POC finding from §POC results).
 *   - DESIGN_QA_FIELD_* references in step.code surface in `envVars`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitRecordingSpec } from '../emit-spec.mjs';

function makeDoc(overrides = {}) {
  return {
    version: 4,
    id: 'sess_x',
    name: 'demo session',
    sessionDir: '/tmp/x',
    createdAt: '2026-05-28T00:00:00Z',
    recordingStartAt: 1000,
    preconditionSteps: [],
    views: [],
    ...overrides,
  };
}

test('emits a self-contained test() body with both blocks', () => {
  const { text } = emitRecordingSpec(makeDoc({
    preconditionSteps: [{ id: 's1', kind: 'click', code: "await page.click('#login');", t: 1 }],
    views: [{
      id: 'v1', name: 'home', url: 'https://x/home',
      steps: [{ id: 's2', kind: 'openPage', code: "await page.goto('https://x/home');", t: 2, pageUrl: 'https://x/home' }],
    }],
  }));
  assert.match(text, /import \{ test, expect \} from '@playwright\/test'/);
  assert.match(text, /test\('Reproduce: demo session'/);
  assert.match(text, /=== PRECONDITION/);
  assert.match(text, /\/\/ await page\.click\('#login'\);/); // precondition commented out
  assert.match(text, /=== RECORDED PATH/);
  assert.match(text, /--- view: home ---/);
  assert.match(text, /await page\.goto\('https:\/\/x\/home'\);/);
});

test('skips omitted steps in both blocks', () => {
  const { text } = emitRecordingSpec(makeDoc({
    preconditionSteps: [
      { id: 'a', kind: 'click', code: "await page.click('#KEEP_PRE');", t: 1 },
      { id: 'b', kind: 'click', code: "await page.click('#DROP_PRE');", t: 2, omitted: true },
    ],
    views: [{
      id: 'v1', name: 'v', url: 'u',
      steps: [
        { id: 'c', kind: 'click', code: "await page.click('#KEEP_REC');", t: 3, pageUrl: 'u' },
        { id: 'd', kind: 'click', code: "await page.click('#DROP_REC');", t: 4, pageUrl: 'u', omitted: true },
      ],
    }],
  }));
  assert.ok(text.includes('KEEP_PRE'));
  assert.ok(text.includes('KEEP_REC'));
  assert.ok(!text.includes('DROP_PRE'), 'omitted precondition step leaked');
  assert.ok(!text.includes('DROP_REC'), 'omitted recorded step leaked');
});

test('prepends implicit page.goto when first recorded step is not a navigation', () => {
  const { text } = emitRecordingSpec(makeDoc({
    views: [{
      id: 'v1', name: 'detail', url: 'https://x/detail',
      steps: [{
        id: 's', kind: 'click',
        code: "await page.getByRole('button', { name: 'Edit' }).click();",
        t: 1, pageUrl: 'https://x/detail',
      }],
    }],
  }));
  assert.match(text, /Implicit goto/);
  assert.match(text, /await page\.goto\("https:\/\/x\/detail"\);/);
});

test('no implicit goto when first recorded step is already a navigation', () => {
  const { text } = emitRecordingSpec(makeDoc({
    views: [{
      id: 'v1', name: 'home', url: 'u',
      steps: [{ id: 's', kind: 'openPage', code: "await page.goto('https://x/home');", t: 1, pageUrl: 'https://x/home' }],
    }],
  }));
  assert.ok(!text.includes('Implicit goto'),
    `expected no implicit goto comment, got:\n${text}`);
});

test('multiple view segments get separator comments in order', () => {
  const { text } = emitRecordingSpec(makeDoc({
    views: [
      { id: 'v1', name: 'first', url: 'u1', steps: [
        { id: 'a', kind: 'click', code: "await page.click('#A');", t: 1, pageUrl: 'u1' },
      ] },
      { id: 'v2', name: 'second', url: 'u2', steps: [
        { id: 'b', kind: 'click', code: "await page.click('#B');", t: 2, pageUrl: 'u2' },
      ] },
    ],
  }));
  const iFirst = text.indexOf('--- view: first ---');
  const iA = text.indexOf("await page.click('#A')");
  const iSecond = text.indexOf('--- view: second ---');
  const iB = text.indexOf("await page.click('#B')");
  assert.ok(iFirst > 0 && iA > iFirst, 'first segment header missing or after its step');
  assert.ok(iSecond > iA, 'second segment header should follow first segment');
  assert.ok(iB > iSecond, 'second step should follow its segment header');
});

test('envVars surfaces every distinct DESIGN_QA_FIELD_* in the emitted text', () => {
  const { text, envVars } = emitRecordingSpec(makeDoc({
    views: [{
      id: 'v1', name: 'login', url: 'u',
      steps: [
        { id: 's1', kind: 'fill',
          code: "await page.getByLabel('Password').fill(process.env.DESIGN_QA_FIELD_PASSWORD ?? '');",
          t: 1, pageUrl: 'u' },
        { id: 's2', kind: 'fill',
          code: "await page.getByLabel('Token').fill(process.env.DESIGN_QA_FIELD_TOKEN ?? '');",
          t: 2, pageUrl: 'u' },
        { id: 's3', kind: 'fill', // a duplicate reference shouldn't double-count
          code: "await page.getByLabel('Password').fill(process.env.DESIGN_QA_FIELD_PASSWORD ?? '');",
          t: 3, pageUrl: 'u' },
      ],
    }],
  }));
  assert.deepEqual(envVars, ['DESIGN_QA_FIELD_PASSWORD', 'DESIGN_QA_FIELD_TOKEN']);
  // And the text actually contains both references.
  assert.ok(text.includes('DESIGN_QA_FIELD_PASSWORD'));
  assert.ok(text.includes('DESIGN_QA_FIELD_TOKEN'));
});

test('empty session emits a placeholder note in both blocks', () => {
  const { text, envVars } = emitRecordingSpec(makeDoc());
  assert.match(text, /no precondition steps were recorded/);
  assert.match(text, /no recorded steps/);
  assert.deepEqual(envVars, []);
});

// ---- 9g: per-screen cumulative checkpoints --------------------------------

test('emits one test() per annotated screen, each cumulative to that screen', () => {
  const { text } = emitRecordingSpec(makeDoc({
    views: [
      { id: 'v1', name: 'Login', url: 'u1', pins: [{ id: 'p1' }], steps: [
        { id: 'a', kind: 'openPage', code: "await page.goto('u1');", t: 1, pageUrl: 'u1' },
      ] },
      { id: 'v2', name: 'Dashboard', url: 'u2', pins: [{ id: 'p2' }], steps: [
        { id: 'b', kind: 'click', code: "await page.click('#widget');", t: 2, pageUrl: 'u2' },
      ] },
    ],
  }));
  const iLogin = text.indexOf("test('Reach feedback on: Login'");
  const iDash = text.indexOf("test('Reach feedback on: Dashboard'");
  assert.ok(iLogin >= 0, 'expected a Login checkpoint test');
  assert.ok(iDash > iLogin, 'expected a Dashboard checkpoint test after Login');
  // Login checkpoint is truncated: Login steps only, NOT Dashboard steps.
  const loginBlock = text.slice(iLogin, iDash);
  assert.ok(loginBlock.includes("await page.goto('u1')"), 'Login block missing its own step');
  assert.ok(!loginBlock.includes('#widget'), 'Login checkpoint leaked Dashboard steps');
  // Dashboard checkpoint is cumulative: includes Login + Dashboard steps.
  const dashBlock = text.slice(iDash);
  assert.ok(dashBlock.includes("await page.goto('u1')"), 'Dashboard checkpoint is not cumulative');
  assert.ok(dashBlock.includes('#widget'), 'Dashboard checkpoint missing its own step');
});

test('pass-through (pinless) screens are intermediate steps, not their own test', () => {
  const { text } = emitRecordingSpec(makeDoc({
    views: [
      { id: 'v1', name: 'Login', url: 'u1', pins: [{ id: 'p' }], steps: [
        { id: 'a', kind: 'openPage', code: "await page.goto('u1');", t: 1, pageUrl: 'u1' },
      ] },
      { id: 'v2', name: 'Interstitial', url: 'u2', pins: [], steps: [
        { id: 'b', kind: 'click', code: "await page.click('#mid');", t: 2, pageUrl: 'u2' },
      ] },
      { id: 'v3', name: 'Settings', url: 'u3', pins: [{ id: 'p3' }], steps: [
        { id: 'c', kind: 'click', code: "await page.click('#set');", t: 3, pageUrl: 'u3' },
      ] },
    ],
  }));
  assert.ok(text.includes("test('Reach feedback on: Login'"));
  assert.ok(text.includes("test('Reach feedback on: Settings'"));
  assert.ok(!text.includes("Reach feedback on: Interstitial"),
    'pass-through screen must not get its own test');
  // The Settings checkpoint (cumulative) still includes the interstitial steps.
  const settingsBlock = text.slice(text.indexOf("test('Reach feedback on: Settings'"));
  assert.ok(settingsBlock.includes('--- view: Interstitial ---'),
    'cumulative path should include the pass-through divider');
  assert.ok(settingsBlock.includes('#mid') && settingsBlock.includes('#set'),
    'cumulative path should include both interstitial and settings steps');
});

test('viewId option scopes to a single screen checkpoint test', () => {
  const doc = makeDoc({
    views: [
      { id: 'v1', name: 'Login', url: 'u1', pins: [{ id: 'p1' }], steps: [
        { id: 'a', kind: 'openPage', code: "await page.goto('u1');", t: 1, pageUrl: 'u1' },
      ] },
      { id: 'v2', name: 'Dashboard', url: 'u2', pins: [{ id: 'p2' }], steps: [
        { id: 'b', kind: 'click', code: "await page.click('#widget');", t: 2, pageUrl: 'u2' },
      ] },
    ],
  });
  const { text } = emitRecordingSpec(doc, { viewId: 'v1' });
  assert.ok(text.includes("test('Reach feedback on: Login'"));
  assert.ok(!text.includes("Reach feedback on: Dashboard"),
    'scoped preview should emit only the requested screen');
  assert.ok(!text.includes('#widget'), 'scoped Login preview leaked Dashboard steps');
});

test('no annotated screens → single fallback Reproduce test over the whole path', () => {
  const { text } = emitRecordingSpec(makeDoc({
    views: [
      { id: 'v1', name: 'a', url: 'u1', pins: [], steps: [
        { id: 's1', kind: 'openPage', code: "await page.goto('u1');", t: 1, pageUrl: 'u1' },
      ] },
      { id: 'v2', name: 'b', url: 'u2', pins: [], steps: [
        { id: 's2', kind: 'click', code: "await page.click('#z');", t: 2, pageUrl: 'u2' },
      ] },
    ],
  }));
  assert.match(text, /test\('Reproduce: demo session'/);
  assert.ok(!text.includes('Reach feedback on:'), 'no checkpoints expected without pins');
  // Exactly one test() call (match `test('` to avoid the doc-comment mention).
  assert.equal((text.match(/test\('/g) || []).length, 1);
  assert.ok(text.includes("await page.goto('u1')") && text.includes('#z'));
});
