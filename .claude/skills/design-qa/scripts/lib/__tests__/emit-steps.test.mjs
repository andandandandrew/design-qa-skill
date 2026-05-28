/**
 * Unit tests for lib/emit-steps.mjs (Spike 8, phase 9e). Pure-function tests —
 * no Playwright, no disk, no SessionStore. Mirror of emit-spec.test.mjs.
 *
 * Covers the load-bearing emit invariants for `recording-steps.md`:
 *   - Precondition + recorded sections both materialize, in that order.
 *   - Per-view `### <name>` headings appear for each step group, in order.
 *   - Omitted steps are skipped silently (no struck-through residue).
 *   - The human label honours `step.humanText`, else describeAction().
 *   - DESIGN_QA_FIELD_* references surface in a credentials note.
 *   - Empty session still emits both sections with placeholders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitRecordingSteps } from '../emit-steps.mjs';

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

test('emits a markdown doc with both sections in order', () => {
  const text = emitRecordingSteps(makeDoc({
    preconditionSteps: [{
      id: 's1', kind: 'click',
      selector: 'internal:role=button[name="Log in"]',
      code: "await page.getByRole('button', { name: 'Log in' }).click();", t: 1,
    }],
    views: [{
      id: 'v1', name: 'home', url: 'https://x/home',
      steps: [{
        id: 's2', kind: 'navigate', url: 'https://x/home',
        code: "await page.goto('https://x/home');", t: 2, pageUrl: 'https://x/home',
      }],
    }],
  }));
  assert.match(text, /^# Recording — demo session/m);
  assert.match(text, /session created 2026-05-28/);
  const iPre = text.indexOf('## Precondition');
  const iRec = text.indexOf('## Recorded path');
  assert.ok(iPre > 0 && iRec > iPre, 'precondition section should precede recorded path');
  assert.match(text, /1\. Click the \*\*Log in\*\* button/);
  assert.match(text, /### home/);
  assert.match(text, /1\. Go to `https:\/\/x\/home`/);
});

test('skips omitted steps silently in both sections', () => {
  const text = emitRecordingSteps(makeDoc({
    preconditionSteps: [
      { id: 'a', kind: 'click', humanText: 'KEEP_PRE', code: "await page.click('#a');", t: 1 },
      { id: 'b', kind: 'click', humanText: 'DROP_PRE', code: "await page.click('#b');", t: 2, omitted: true },
    ],
    views: [{
      id: 'v1', name: 'v', url: 'u',
      steps: [
        { id: 'c', kind: 'click', humanText: 'KEEP_REC', code: "await page.click('#c');", t: 3, pageUrl: 'u' },
        { id: 'd', kind: 'click', humanText: 'DROP_REC', code: "await page.click('#d');", t: 4, pageUrl: 'u', omitted: true },
      ],
    }],
  }));
  assert.ok(text.includes('KEEP_PRE'));
  assert.ok(text.includes('KEEP_REC'));
  assert.ok(!text.includes('DROP_PRE'), 'omitted precondition step leaked');
  assert.ok(!text.includes('DROP_REC'), 'omitted recorded step leaked');
});

test('humanText override wins over describeAction', () => {
  const text = emitRecordingSteps(makeDoc({
    views: [{
      id: 'v1', name: 'v', url: 'u',
      steps: [{
        id: 's', kind: 'click', humanText: 'Tap the secret gizmo',
        selector: 'internal:role=button[name="Save"]', code: "await page.click('x');", t: 1, pageUrl: 'u',
      }],
    }],
  }));
  assert.ok(text.includes('Tap the secret gizmo'));
  assert.ok(!text.includes('Save'), 'fell back to describeAction despite humanText');
});

test('multiple views get their own heading in order', () => {
  const text = emitRecordingSteps(makeDoc({
    views: [
      { id: 'v1', name: 'first', url: 'u1', steps: [
        { id: 'a', kind: 'click', humanText: 'A', code: "await page.click('#A');", t: 1, pageUrl: 'u1' },
      ] },
      { id: 'v2', name: 'second', url: 'u2', steps: [
        { id: 'b', kind: 'click', humanText: 'B', code: "await page.click('#B');", t: 2, pageUrl: 'u2' },
      ] },
    ],
  }));
  const iFirst = text.indexOf('### first');
  const iSecond = text.indexOf('### second');
  assert.ok(iFirst > 0 && iSecond > iFirst, 'view headings out of order');
});

test('surfaces a credentials note listing every distinct env var', () => {
  const text = emitRecordingSteps(makeDoc({
    views: [{
      id: 'v1', name: 'login', url: 'u',
      steps: [
        { id: 's1', kind: 'fill',
          code: "await page.getByLabel('Password').fill(process.env.DESIGN_QA_FIELD_PASSWORD ?? '');", t: 1, pageUrl: 'u' },
        { id: 's2', kind: 'fill',
          code: "await page.getByLabel('Token').fill(process.env.DESIGN_QA_FIELD_TOKEN ?? '');", t: 2, pageUrl: 'u' },
        { id: 's3', kind: 'fill',
          code: "await page.getByLabel('Password').fill(process.env.DESIGN_QA_FIELD_PASSWORD ?? '');", t: 3, pageUrl: 'u' },
      ],
    }],
  }));
  assert.match(text, /Credentials were redacted/);
  assert.match(text, /- `DESIGN_QA_FIELD_PASSWORD`/);
  assert.match(text, /- `DESIGN_QA_FIELD_TOKEN`/);
  // Sorted + de-duped: PASSWORD before TOKEN, each once.
  assert.equal((text.match(/DESIGN_QA_FIELD_PASSWORD/g) || []).length, 1);
});

test('no credentials note when nothing was redacted', () => {
  const text = emitRecordingSteps(makeDoc({
    views: [{ id: 'v1', name: 'v', url: 'u',
      steps: [{ id: 's', kind: 'click', humanText: 'X', code: "await page.click('x');", t: 1, pageUrl: 'u' }] }],
  }));
  assert.ok(!text.includes('Credentials were redacted'));
});

test('empty session emits placeholders in both sections', () => {
  const text = emitRecordingSteps(makeDoc());
  assert.match(text, /## Precondition/);
  assert.match(text, /_No precondition steps were recorded._/);
  assert.match(text, /## Recorded path/);
  assert.match(text, /_No recorded steps/);
});

test('annotated screens are flagged checkpoints; numbering is continuous', () => {
  const text = emitRecordingSteps(makeDoc({
    views: [
      { id: 'v1', name: 'Login', url: 'u1', pins: [{ id: 'p' }], steps: [
        { id: 'a', kind: 'click', humanText: 'Click login', code: "await page.click('#a');", t: 1, pageUrl: 'u1' },
      ] },
      { id: 'v2', name: 'Interstitial', url: 'u2', pins: [], steps: [
        { id: 'b', kind: 'click', humanText: 'Pass through', code: "await page.click('#b');", t: 2, pageUrl: 'u2' },
      ] },
    ],
  }));
  // Annotated screen → checkpoint heading + replay note.
  assert.match(text, /### 📍 Login — checkpoint/);
  assert.match(text, /Replaying steps 1–1 reaches the feedback/);
  // Pass-through screen → plain heading, no checkpoint marker.
  assert.match(text, /^### Interstitial$/m);
  assert.ok(!/### 📍 Interstitial/.test(text), 'pass-through screen wrongly marked a checkpoint');
  // Continuous numbering across screens.
  assert.match(text, /^1\. Click login/m);
  assert.match(text, /^2\. Pass through/m);
});
