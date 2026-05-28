/**
 * Unit tests for lib/redact.mjs.
 *
 * No Playwright, no browser. Synthesized event shapes mirror what the recorder
 * adapter passes through in production: `{ kind, data: { action, ariaSnapshot,
 * … }, code }`. The shape only needs `code` + `data` for scrubbing to apply;
 * we exercise both.
 *
 * Run: `node --test scripts/lib/__tests__/redact.test.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, REDACT_DEFAULTS } from '../redact.mjs';

/** Build a synthetic `actionAdded`-shaped event. */
function fillEvent({ selector, text, ariaSnapshot = '' }) {
  return {
    kind: 'action',
    data: {
      action: { name: 'fill', selector, text },
      ariaSnapshot,
    },
    code: `await page.locator(${JSON.stringify(selector)}).fill('${text}');`,
  };
}

function clickEvent({ selector, ariaSnapshot = '' }) {
  return {
    kind: 'action',
    data: {
      action: { name: 'click', selector },
      ariaSnapshot,
    },
    code: `await page.locator(${JSON.stringify(selector)}).click();`,
  };
}

test('non-secret field passes through unchanged', () => {
  const r = createRedactor();
  const ev = fillEvent({
    selector: 'internal:role=textbox[name="Email address"][type="email"]',
    text: 'andrew@example.com',
  });
  const registered = r.maybeRegisterFromAction(ev.data.action);
  assert.equal(registered, false);
  r.scrubEvent(ev);
  assert.match(ev.code, /andrew@example\.com/);
  assert.equal(r.count, 0);
});

test('secret field registers and substitutes in code + bare text', () => {
  const r = createRedactor();
  const password = 'SECRET_PWD_xyz';
  const ev = fillEvent({
    selector: 'internal:role=textbox[name="Password"][type="password"]',
    text: password,
    ariaSnapshot: `- textbox "Password": ${password}`,
  });
  const registered = r.maybeRegisterFromAction(ev.data.action);
  assert.equal(registered, true);
  r.scrubEvent(ev);
  // Code: quoted form → process.env.
  assert.ok(ev.code.includes("process.env.DESIGN_QA_FIELD_PASSWORD ?? ''"),
    `code missing env-var substitution: ${ev.code}`);
  // action.text: bare → [REDACTED …].
  assert.equal(ev.data.action.text, '[REDACTED DESIGN_QA_FIELD_PASSWORD]');
  // ariaSnapshot: bare → [REDACTED …].
  assert.ok(ev.data.ariaSnapshot.includes('[REDACTED DESIGN_QA_FIELD_PASSWORD]'));
  // Password value gone from the whole event JSON.
  assert.equal(JSON.stringify(ev).split(password).length - 1, 0);
});

test('retroactive scrub: prior event with secret in ariaSnapshot gets cleaned', () => {
  // Order matters: a click whose ariaSnapshot already contains the
  // (about-to-be-typed) password fires BEFORE the password fill in some flows
  // (e.g. focus-then-paste). When we later register the secret we must scrub
  // the already-stored click too — the ariaSnapshot leak vector.
  const r = createRedactor();
  const password = 'TOP_SECRET_pw_12345';

  const click = clickEvent({
    selector: 'internal:role=button[name="Sign in"]',
    ariaSnapshot: `- textbox "Password": ${password}\n- button "Sign in"`,
  });
  const fill = fillEvent({
    selector: 'internal:role=textbox[name="Password"]',
    text: password,
  });
  const events = [click, fill];

  // First event arrives — not a fill, nothing registered.
  assert.equal(r.maybeRegisterFromAction(click.data.action), false);
  r.scrubEvent(click);
  // No registration yet → password still present in click.
  assert.ok(click.data.ariaSnapshot.includes(password));

  // Fill arrives — secret registered; retroactive scrub.
  assert.equal(r.maybeRegisterFromAction(fill.data.action), true);
  r.scrubEvents(events);

  // Both events should now be password-free.
  const dump = JSON.stringify(events);
  assert.equal(dump.split(password).length - 1, 0,
    'password value leaked after retroactive scrub');
});

test('prefix-collapse: progressive actionUpdated values converge on the full one', () => {
  // Recorder fires actionUpdated as the user types: "S" → "SE" → "SEC" → final.
  // Each call registers the new value; collapse drops shorter prefixes.
  const r = createRedactor();
  const sel = 'internal:role=textbox[name="Password"]';
  const progression = ['SECR', 'SECRE', 'SECRET', 'SECRET_'];
  for (const text of progression) {
    r.maybeRegisterFromAction({ name: 'fill', selector: sel, text });
  }
  // Final state: exactly one entry, the longest value.
  assert.equal(r.count, 1);
  assert.deepEqual(r.getEnvVars(), ['DESIGN_QA_FIELD_PASSWORD']);
  // Scrubbing the final form removes only the longest — shorter prefixes are
  // not standalone registered values so they pass through.
  const sample = 'SECRET_token_x';
  const scrubbed = r.scrubValue(sample);
  assert.ok(!scrubbed.includes('SECRET_'),
    `expected longest registered prefix to be redacted, got: ${scrubbed}`);
});

test('min-length filter: short fills (< 4 chars) do NOT register', () => {
  const r = createRedactor();
  const sel = 'internal:role=textbox[name="Password"]';
  for (const text of ['', 'a', 'ab', 'abc']) {
    assert.equal(
      r.maybeRegisterFromAction({ name: 'fill', selector: sel, text }),
      false,
      `text=${JSON.stringify(text)} should not register`,
    );
  }
  assert.equal(r.count, 0);
  // 4-char fills DO register.
  assert.equal(
    r.maybeRegisterFromAction({ name: 'fill', selector: sel, text: 'abcd' }),
    true,
  );
  assert.equal(r.count, 1);
});

test('non-fill actions never register (clicks, presses, etc.)', () => {
  const r = createRedactor();
  for (const name of ['click', 'press', 'check', 'navigate', 'openPage', 'select']) {
    assert.equal(
      r.maybeRegisterFromAction({
        name,
        selector: 'internal:role=textbox[name="Password"]',
        text: 'this should not register',
      }),
      false,
      `${name} should not register`,
    );
  }
  assert.equal(r.count, 0);
});

test('extraPatterns: additive custom regex matches', () => {
  // Project has a field labeled "Memorable phrase" that's effectively a secret.
  const r = createRedactor({ extraPatterns: [/memorable/i] });
  const ev = fillEvent({
    selector: 'internal:role=textbox[name="Memorable phrase"]',
    text: 'correct horse battery staple',
  });
  assert.equal(r.maybeRegisterFromAction(ev.data.action), true);
  r.scrubEvent(ev);
  assert.ok(ev.code.includes('process.env.DESIGN_QA_FIELD_MEMORABLE_PHRASE'));
});

test('env-var collision: same field name with two distinct values → _2 suffix', () => {
  const r = createRedactor();
  const sel = 'internal:role=textbox[name="API key"]';
  // Two fills of distinct values into selectors with the same `name`. (In
  // practice this happens when a session has two API-key fields, or the user
  // pastes two different secrets one after another.)
  r.maybeRegisterFromAction({ name: 'fill', selector: sel, text: 'key_A_value_1234' });
  r.maybeRegisterFromAction({ name: 'fill', selector: sel, text: 'key_B_value_5678' });
  assert.equal(r.count, 2);
  const vars = r.getEnvVars();
  assert.ok(vars.includes('DESIGN_QA_FIELD_API_KEY'));
  assert.ok(vars.includes('DESIGN_QA_FIELD_API_KEY_2'));
});

test('scrubValue is deep + handles arrays/objects/null', () => {
  const r = createRedactor();
  r.maybeRegisterFromAction({
    name: 'fill',
    selector: 'internal:role=textbox[name="Secret"]',
    text: 'abcde-1234',
  });
  const scrubbed = r.scrubValue({
    a: 'plain text abcde-1234',
    b: ["'abcde-1234'", '"abcde-1234"', 'abcde-1234 trailing'],
    c: null,
    d: { e: 42, f: 'abcde-1234' },
  });
  // Bare → [REDACTED …]
  assert.equal(scrubbed.a, 'plain text [REDACTED DESIGN_QA_FIELD_SECRET]');
  // Single-quoted → process.env
  assert.equal(scrubbed.b[0], "process.env.DESIGN_QA_FIELD_SECRET ?? ''");
  // Double-quoted → process.env
  assert.equal(scrubbed.b[1], "process.env.DESIGN_QA_FIELD_SECRET ?? ''");
  // Bare in array element
  assert.equal(scrubbed.b[2], '[REDACTED DESIGN_QA_FIELD_SECRET] trailing');
  // null passthrough
  assert.equal(scrubbed.c, null);
  // Non-string in object preserved
  assert.equal(scrubbed.d.e, 42);
  assert.equal(scrubbed.d.f, '[REDACTED DESIGN_QA_FIELD_SECRET]');
});

test('count + getEnvVars track distinct secrets', () => {
  const r = createRedactor();
  assert.equal(r.count, 0);
  assert.deepEqual(r.getEnvVars(), []);
  r.maybeRegisterFromAction({
    name: 'fill',
    selector: 'internal:role=textbox[name="Password"]',
    text: 'pw_value_one',
  });
  r.maybeRegisterFromAction({
    name: 'fill',
    selector: 'internal:role=textbox[name="OTP"]',
    text: '123456',
  });
  assert.equal(r.count, 2);
  const vars = r.getEnvVars();
  assert.ok(vars.includes('DESIGN_QA_FIELD_PASSWORD'));
  assert.ok(vars.includes('DESIGN_QA_FIELD_OTP'));
});

test('REDACT_DEFAULTS exports the pattern and min-length for inspection', () => {
  assert.ok(REDACT_DEFAULTS.pattern instanceof RegExp);
  assert.equal(REDACT_DEFAULTS.minSecretLen, 4);
  // Sanity: the default pattern matches the documented keywords.
  for (const word of ['password', 'pwd', 'secret', 'token', 'api key', 'api_key',
                       'otp', '2fa', 'cvv', 'ssn', 'credit card']) {
    assert.ok(REDACT_DEFAULTS.pattern.test(word), `expected default pattern to match ${word}`);
  }
});
