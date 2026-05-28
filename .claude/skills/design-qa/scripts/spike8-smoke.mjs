#!/usr/bin/env node
/**
 * Headless smoke test for spike8-poc.mjs: verifies that
 *   (a) context._enableRecorder import path works on the installed Playwright
 *   (b) recorderMode:'api' does NOT pop an Inspector window
 *   (c) the eventSink receives actionAdded with structured `data` + `.ts` `code`
 * Synthesized actions are driven by Playwright itself (not a human), then
 * outputs are dumped to ./spike8-smoke-out/.
 */
import { chromium } from 'playwright';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'spike8-smoke-out');

const events = [];
let pages = 0;

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  const profile = path.join(OUT, '.profile');
  await fsp.mkdir(profile, { recursive: true });

  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  ctx.on('page', () => { pages += 1; });

  await ctx._enableRecorder(
    {
      language: 'playwright-test',
      launchOptions: { headless: true },
      contextOptions: {},
      mode: 'recording',
      recorderMode: 'api',
      testIdAttributeName: 'data-testid',
      handleSIGINT: false,
    },
    {
      actionAdded(page, data, code) { events.push({ kind: 'actionAdded', data, code }); },
      actionUpdated(page, data, code) { events.push({ kind: 'actionUpdated', data, code }); },
      signalAdded(page, data) { events.push({ kind: 'signalAdded', data, code: '' }); },
    },
  );

  // Drive a tiny interaction. Recorder watches DOM events the browser dispatches,
  // so we use page.evaluate'd CustomEvent + native dispatchEvent for click/input,
  // because page.click() is a Playwright API call (won't be recorded as a human
  // action). Using mouse/keyboard directly DOES dispatch the right events.
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.setContent(`
    <!doctype html><html><body>
      <h1>spike8 smoke</h1>
      <button id="b">Click me</button>
      <input id="t" placeholder="type here">
      <a id="n" href="data:text/html,<title>second</title><h1>second</h1>">Go second</a>
    </body></html>
  `);
  // Mouse + keyboard (real input events; recorder treats them as user actions).
  const btn = await page.$('#b');
  const btnBox = await btn.boundingBox();
  await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
  await page.waitForTimeout(200);

  const inp = await page.$('#t');
  const inBox = await inp.boundingBox();
  await page.mouse.click(inBox.x + inBox.width / 2, inBox.y + inBox.height / 2);
  await page.keyboard.type('hello');
  await page.waitForTimeout(200);

  const nav = await page.$('#n');
  const navBox = await nav.boundingBox();
  await page.mouse.click(navBox.x + navBox.width / 2, navBox.y + navBox.height / 2);
  await page.waitForTimeout(500);

  await fsp.writeFile(
    path.join(OUT, 'events.json'),
    JSON.stringify({ pageCount: pages, eventCount: events.length, events }, null, 2),
    'utf8',
  );
  console.log(`pages=${pages} events=${events.length}`);
  for (const e of events) {
    const action = e.data?.action;
    console.log(`  ${e.kind.padEnd(14)} name=${action?.name || '-'}  selector=${truncate(action?.selector, 60)}  code=${truncate(e.code, 60)}`);
  }

  await ctx.close();
}
function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 3) + '...' : s; }

main().catch((err) => { console.error(err); process.exit(1); });
