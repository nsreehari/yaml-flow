#!/usr/bin/env node
/**
 * seed-cards.mjs — Upload card YAML/JSON files to Firestore seed-cards collection.
 *
 * Usage:
 *   node scripts/seed-cards.mjs <cards-dir> [--board <boardId>] [--project <firebaseProject>]
 *
 * Example:
 *   node scripts/seed-cards.mjs ../../demo-src/example-board/cards --board default
 *
 * This reads all .json/.yaml/.yml files from the given directory and writes
 * them to Firestore at: boards/{boardId}/seed-cards/{cardId}
 *
 * Requires: firebase-admin (installed via package.json)
 * Auth: Uses Application Default Credentials (run `gcloud auth application-default login`
 *        or set GOOGLE_APPLICATION_CREDENTIALS env var)
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

// Parse args
const args = process.argv.slice(2);
let cardsDir = null;
let boardId = 'default';
let projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--board' && args[i + 1]) { boardId = args[++i]; continue; }
  if (args[i] === '--project' && args[i + 1]) { projectId = args[++i]; continue; }
  if (!cardsDir) cardsDir = args[i];
}

if (!cardsDir) {
  console.error('Usage: node scripts/seed-cards.mjs <cards-dir> [--board <boardId>]');
  process.exit(1);
}

// Init Firebase
const app = initializeApp(projectId ? { projectId } : undefined);
const db = getFirestore(app);

const collectionPath = `boards/${boardId}/seed-cards`;
console.log(`Seeding cards from ${cardsDir} → Firestore ${collectionPath}`);

// Read card files
const files = readdirSync(cardsDir).filter(f => {
  const ext = extname(f).toLowerCase();
  return ['.json', '.yaml', '.yml'].includes(ext) && statSync(join(cardsDir, f)).isFile();
});

if (files.length === 0) {
  console.warn('No card files found in', cardsDir);
  process.exit(0);
}

let count = 0;
for (const file of files) {
  const filePath = join(cardsDir, file);
  const ext = extname(file).toLowerCase();
  let card;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    if (ext === '.json') {
      card = JSON.parse(raw);
    } else {
      // For YAML, try dynamic import of js-yaml
      try {
        const yaml = await import('js-yaml');
        card = yaml.load(raw);
      } catch {
        console.warn(`  Skipping ${file} — js-yaml not installed. Run: npm install js-yaml`);
        continue;
      }
    }
  } catch (err) {
    console.warn(`  Skipping ${file} — parse error:`, err.message);
    continue;
  }

  if (!card || typeof card !== 'object') {
    console.warn(`  Skipping ${file} — not an object`);
    continue;
  }

  const cardId = card.id || file.replace(/\.(json|ya?ml)$/i, '');
  card.id = cardId;

  await db.collection(collectionPath).doc(cardId).set(card);
  console.log(`  ✓ ${cardId}`);
  count++;
}

console.log(`\nSeeded ${count} card(s) to ${collectionPath}`);
process.exit(0);
