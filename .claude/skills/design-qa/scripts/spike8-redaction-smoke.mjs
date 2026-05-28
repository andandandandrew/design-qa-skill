#!/usr/bin/env node
/**
 * Regression smoke for spike8-poc.mjs redaction.
 * Drives a fake login form with a fake password ('SECRET_PWD_xyz_DO_NOT_LEAK')
 * and asserts the value does NOT appear in the captured events.
 */
import { chromium } from 'playwright';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'spike8-smoke-out');
const FAKE_PASSWORD = 'SECRET_PWD_xyz_DO_NOT_LEAK';

// Replicate the redaction surface from spike8-poc.mjs (kept in sync by hand
// for this throwaway smoke; the production version would share a module).
const SECRET_NAME_RE = /password|pwd|secret|token|api[ _-]?key|otp|2fa|cvv|ssn|credit[ _-]?card/i;
const redactionMap = new Map();

function nameFromSelector(s) { const m = /\[name="((?:[^"\\]|\\.)*)"/i.exec(s || ''); return m ? m[1] : ''; }
function envVarFor(n) {
  const slug = String(n || 'FIELD').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'FIELD';
  return `DESIGN_QA_FIELD_${slug}`;
}
function scrubValue(v) {
  if (v == null) return v;
  if (typeof v === 'string') {
    let out = v;
    for (const [raw, envVar] of redactionMap) {
      if (!raw) continue;
      out = out.split(`'${raw}'`).join(`process.env.${envVar} ?? ''`);
      out = out.split(`"${raw}"`).join(`process.env.${envVar} ?? ''`);
      out = out.split(raw).join(`[REDACTED ${envVar}]`);
    }
    return out;
  }
  if (Array.isArray(v)) return v.map(scrubValue);
  if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = scrubValue(v[k]); return o; }
  return v;
}
const MIN_SECRET_LEN = 4;
function maybeRegisterSecret(action) {
  if (!action || action.name !== 'fill') return false;
  const fieldName = nameFromSelector(action.selector);
  if (!fieldName || !SECRET_NAME_RE.test(fieldName)) return false;
  const raw = action.text ?? action.value ?? '';
  if (!raw || raw.length < MIN_SECRET_LEN || redactionMap.has(raw)) return false;
  for (const existing of [...redactionMap.keys()]) {
    if (raw.startsWith(existing) || existing.startsWith(raw)) redactionMap.delete(existing);
  }
  redactionMap.set(raw, envVarFor(fieldName));
  return true;
}
function scrubAllEvents(events) { for (const e of events) { e.code = scrubValue(e.code); e.data = scrubValue(e.data); } }

const events = [];

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  const profile = path.join(OUT, '.redact-profile');
  await fsp.rm(profile, { recursive: true, force: true });
  await fsp.mkdir(profile, { recursive: true });

  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  await ctx._enableRecorder(
    { language: 'playwright-test', launchOptions: { headless: true }, contextOptions: {},
      mode: 'recording', recorderMode: 'api', testIdAttributeName: 'data-testid', handleSIGINT: false },
    {
      actionAdded(page, data, code) {
        const added = maybeRegisterSecret(data?.action);
        const ev = { kind: 'action', data, code };
        events.push(ev);
        if (added) scrubAllEvents(events);
        else { ev.code = scrubValue(ev.code); ev.data = scrubValue(ev.data); }
      },
      actionUpdated(page, data, code) {
        const added = maybeRegisterSecret(data?.action);
        const ev = { kind: 'action', data, code };
        for (let i = events.length - 1; i >= 0; i--) { if (events[i].kind === 'action') { events[i] = ev; break; } }
        if (added) scrubAllEvents(events);
        else { ev.code = scrubValue(ev.code); ev.data = scrubValue(ev.data); }
      },
      signalAdded(page, data) { events.push({ kind: 'signal', data: scrubValue(data), code: '' }); },
    },
  );

  const page = ctx.pages()[0] || await ctx.newPage();
  await page.setContent(`
    <!doctype html><html><body>
      <h1>Login</h1>
      <label>Email <input id="e" aria-label="Email address" type="email"></label>
      <label>Password <input id="p" aria-label="Password" type="password"></label>
      <button id="s">Sign In</button>
      <p>Other field: <input id="o" aria-label="Search query"></p>
    </body></html>
  `);

  // Fill email (NOT a secret — should remain in clear)
  const e = await page.$('#e'); const eb = await e.boundingBox();
  await page.mouse.click(eb.x + eb.width / 2, eb.y + eb.height / 2);
  await page.keyboard.type('andrew@example.com');
  await page.waitForTimeout(150);

  // Fill password (IS a secret — should be redacted)
  const p = await page.$('#p'); const pb = await p.boundingBox();
  await page.mouse.click(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.keyboard.type(FAKE_PASSWORD);
  await page.waitForTimeout(150);

  // Fill a normal field with a search term that happens to contain the password
  // substring — verifies retroactive scrub covers any subsequent action that
  // would otherwise leak the value via ariaSnapshot of the password field.
  const o = await page.$('#o'); const ob = await o.boundingBox();
  await page.mouse.click(ob.x + ob.width / 2, ob.y + ob.height / 2);
  await page.keyboard.type('benign search text');
  await page.waitForTimeout(150);

  // Click sign-in (its ariaSnapshot will include the password field's value
  // pre-scrub; this is the canary action that exposed the bug originally).
  const s = await page.$('#s'); const sb = await s.boundingBox();
  await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.waitForTimeout(300);

  await ctx.close();

  // Assertions
  const dump = JSON.stringify(events);
  const leaks = dump.split(FAKE_PASSWORD).length - 1;
  await fsp.writeFile(path.join(OUT, 'redaction-events.json'), JSON.stringify(events, null, 2), 'utf8');

  console.log(`events captured: ${events.length}`);
  console.log(`redactionMap size: ${redactionMap.size}`);
  console.log(`leak count for "${FAKE_PASSWORD}" in scrubbed JSON: ${leaks}`);
  if (leaks > 0) {
    console.error(`FAIL — password value leaked ${leaks} time(s)`);
    process.exit(1);
  }
  console.log('PASS — password value did not appear in any scrubbed event');
}

main().catch((err) => { console.error(err); process.exit(1); });
