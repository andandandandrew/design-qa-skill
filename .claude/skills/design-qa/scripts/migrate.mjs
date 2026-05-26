#!/usr/bin/env node
/**
 * One-time batch upgrade of session.json files to schema v2 (%-at-rest +
 * author/status/source). Additive and idempotent — px coords are kept, so it's
 * safe to re-run and safe on already-shipped sessions. (The daemon also
 * lazy-migrates on load; this is for upgrading a whole sessions dir at once.)
 *
 * Usage: node migrate.mjs <sessions-dir> [--dry-run]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readSession, writeSession, migrateDoc } from './lib/session.mjs';

const dir = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!dir) { console.error('usage: node migrate.mjs <sessions-dir> [--dry-run]'); process.exit(2); }

const entries = await fs.readdir(dir, { withFileTypes: true });
let migrated = 0, skipped = 0;
for (const ent of entries) {
  if (!ent.isDirectory()) continue;
  const sessionDir = path.join(dir, ent.name);
  let doc;
  try { doc = await readSession(sessionDir); } catch { continue; }
  const changed = await migrateDoc(sessionDir, doc);
  if (changed) {
    if (!dryRun) await writeSession(sessionDir, doc);
    migrated++;
    console.log(`${dryRun ? '[dry] ' : ''}migrated ${ent.name}`);
  } else {
    skipped++;
  }
}
console.log(`done: ${migrated} migrated, ${skipped} already current${dryRun ? ' (dry run, no writes)' : ''}`);
