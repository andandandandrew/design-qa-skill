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
