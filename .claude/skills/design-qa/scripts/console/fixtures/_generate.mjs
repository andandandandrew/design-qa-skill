#!/usr/bin/env node
/**
 * Phase-2 fixture generator (dev-only, not shipped in the runtime path).
 *
 * Reads a real captured session + its screenshots and emits a %-at-rest
 * fixture under console/fixtures/, enriched so the standalone editor exercises
 * every state: categories, authors, resolved/unresolved. This is throwaway
 * scaffolding — Phase 3 moves the real px→% conversion into the store.
 *
 * Usage: node _generate.mjs <source-session-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagePxToPct, pngDimensions } from '../lib/coords.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = process.argv[2];
if (!srcDir) {
  console.error('usage: node _generate.mjs <source-session-dir>');
  process.exit(2);
}

const CATEGORIES = ['visual', 'copy', 'spec', 'question', 'bug'];
const AUTHORS = ['Andrew Frank', 'Jordan Lee'];
const SAMPLE_NOTES = [
  'Heading uses 28px but the design spec calls for 32px / 600 weight.',
  'This control should use the primary accent token, not the hard-coded blue.',
  'Inconsistent padding — 12px here vs 16px on the sibling card.',
  'Hover state is missing; spec shows a 1px accent border on hover.',
  'Label and input are misaligned by ~4px on the baseline.',
  'Copy says "Sign in" but the design says "Log in".',
];

const session = JSON.parse(fs.readFileSync(path.join(srcDir, 'session.json'), 'utf8'));

const outDir = here;
const outShotsDir = path.join(outDir, 'screenshots');
fs.mkdirSync(outShotsDir, { recursive: true });

let pinCounter = 0;
const views = session.views.map((view) => {
  const vp = view.viewport || { width: 1440, height: 900 };
  let shotWidth = vp.width;
  let shotHeight = vp.height;
  let screenshotRel = null;

  if (view.screenshot) {
    const absShot = path.join(srcDir, view.screenshot);
    try {
      const buf = fs.readFileSync(absShot);
      ({ width: shotWidth, height: shotHeight } = pngDimensions(buf));
      const base = path.basename(view.screenshot);
      fs.copyFileSync(absShot, path.join(outShotsDir, base));
      screenshotRel = `screenshots/${base}`;
    } catch (err) {
      console.warn(`skip screenshot for ${view.id}: ${err.message}`);
    }
  }

  const pins = view.pins.map((p) => {
    const { xPct, yPct } = pagePxToPct({
      x: p.x, y: p.y, viewportWidth: vp.width, shotWidth, shotHeight,
    });
    const i = pinCounter++;
    return {
      id: p.id,
      viewId: view.id,
      xPct,
      yPct,
      note: p.note && p.note.trim() && !/^test/i.test(p.note)
        ? p.note
        : SAMPLE_NOTES[i % SAMPLE_NOTES.length],
      category: CATEGORIES[i % CATEGORIES.length],
      author: AUTHORS[i % AUTHORS.length],
      status: i % 3 === 0 ? 'resolved' : 'open',
      resolvedNote: i % 3 === 0 ? 'Fixed in PR #482.' : null,
      createdAt: p.createdAt,
    };
  });

  return {
    id: view.id,
    source: 'browser',
    url: view.url,
    title: view.title,
    name: view.name,
    viewport: vp,
    screenshot: screenshotRel,
    createdAt: view.createdAt,
    sealedAt: view.sealedAt,
    pins,
  };
});

const fixture = {
  version: 2,
  id: 'sess_fixture',
  name: 'Fixture — console editor demo',
  createdAt: session.createdAt,
  endedAt: session.endedAt,
  views,
};

fs.writeFileSync(path.join(outDir, 'session.json'), JSON.stringify(fixture, null, 2) + '\n');
console.log(`wrote fixture: ${views.length} views, ${pinCounter} pins`);
