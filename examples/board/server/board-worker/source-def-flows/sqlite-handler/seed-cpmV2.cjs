#!/usr/bin/env node

/**
 * seed-cpmV2.cjs — Extend compliance.db with V2 historical data.
 *
 * Adds historical eval_results rows for earlier run dates so the drift-trend
 * card has multiple data points to chart. Run AFTER seed-cpm.cjs.
 *
 * Usage:
 *   node seed-cpmV2.cjs [--db <name>]
 *
 * Default db: compliance.db (resolved via sqlite-handler/.retain directory).
 */

const Database = require('better-sqlite3');
const path = require('path');

const args = process.argv.slice(2);
const dbArgIdx = args.indexOf('--db');
const dbName = dbArgIdx !== -1 && args[dbArgIdx + 1]
  ? args[dbArgIdx + 1]
  : 'compliance.db';
const dbPath = path.isAbsolute(dbName) || dbName.includes(path.sep) || dbName.includes('/')
  ? path.resolve(dbName)
  : path.join(__dirname, '.retain', dbName);

const db = new Database(dbPath);

// ---------------------------------------------------------------------------
// Add historical eval runs (3 prior dates) for Immediate agents
// ---------------------------------------------------------------------------
const insertResult = db.prepare(`
  INSERT INTO eval_results (agent_name, category, result, run_date, details)
  VALUES (?, ?, ?, ?, ?)
`);

const historicalRuns = [
  // ---- Run: 2026-04-13 (2 weeks ago) — most things passing, seeds of drift ----
  ['Legal Contract Reviewer', 'Scope',              'PASS', '2026-04-13', null],
  ['Legal Contract Reviewer', 'Adherence',          'PASS', '2026-04-13', null],
  ['Legal Contract Reviewer', 'Determinism',        'PASS', '2026-04-13', 'BLEU 0.82 — within threshold on gpt-4o-2026-01.'],
  ['Legal Contract Reviewer', 'Groundedness',       'PASS', '2026-04-13', null],
  ['Legal Contract Reviewer', 'Regression & Drift', 'PASS', '2026-04-13', null],
  ['Legal Contract Reviewer', 'Safety / Red-Teaming','PASS', '2026-04-13', null],
  ['Legal Contract Reviewer', 'Content Safety',     'PASS', '2026-04-13', null],
  ['Legal Contract Reviewer', 'Security',           'PASS', '2026-04-13', null],
  ['Legal Contract Reviewer', 'RAG',                'PASS', '2026-04-13', null],

  ['HR Benefits Agent', 'Scope',              'PASS', '2026-04-13', null],
  ['HR Benefits Agent', 'Adherence',          'PASS', '2026-04-13', null],
  ['HR Benefits Agent', 'Determinism',        'PASS', '2026-04-13', null],
  ['HR Benefits Agent', 'Groundedness',       'PASS', '2026-04-13', 'Citations present in 91% of responses.'],
  ['HR Benefits Agent', 'Regression & Drift', 'PASS', '2026-04-13', null],
  ['HR Benefits Agent', 'Safety / Red-Teaming','PASS', '2026-04-13', null],
  ['HR Benefits Agent', 'Content Safety',     'PASS', '2026-04-13', null],
  ['HR Benefits Agent', 'Security',           'PASS', '2026-04-13', null],
  ['HR Benefits Agent', 'RAG',                'PASS', '2026-04-13', null],

  ['IT Helpdesk Copilot', 'Scope',              'PASS', '2026-04-13', null],
  ['IT Helpdesk Copilot', 'Adherence',          'PASS', '2026-04-13', null],
  ['IT Helpdesk Copilot', 'Determinism',        'PASS', '2026-04-13', null],
  ['IT Helpdesk Copilot', 'Groundedness',       'PASS', '2026-04-13', null],
  ['IT Helpdesk Copilot', 'Regression & Drift', 'PASS', '2026-04-13', null],
  ['IT Helpdesk Copilot', 'Safety / Red-Teaming','PASS', '2026-04-13', null],
  ['IT Helpdesk Copilot', 'Content Safety',     'PASS', '2026-04-13', null],
  ['IT Helpdesk Copilot', 'Security',           'PASS', '2026-04-13', null],
  ['IT Helpdesk Copilot', 'RAG',                'PASS', '2026-04-13', null],

  ['Sales Forecaster', 'Scope',              'PASS', '2026-04-13', null],
  ['Sales Forecaster', 'Adherence',          'PASS', '2026-04-13', null],
  ['Sales Forecaster', 'Determinism',        'PASS', '2026-04-13', null],
  ['Sales Forecaster', 'Groundedness',       'PASS', '2026-04-13', null],
  ['Sales Forecaster', 'Regression & Drift', 'PASS', '2026-04-13', null],
  ['Sales Forecaster', 'Safety / Red-Teaming','PASS', '2026-04-13', null],
  ['Sales Forecaster', 'Content Safety',     'PASS', '2026-04-13', null],
  ['Sales Forecaster', 'Security',           'PASS', '2026-04-13', null],
  ['Sales Forecaster', 'RAG',                'PASS', '2026-04-13', null],

  // ---- Run: 2026-04-20 (1 week ago) — drift beginning to show ----
  ['Legal Contract Reviewer', 'Scope',              'PASS', '2026-04-20', null],
  ['Legal Contract Reviewer', 'Adherence',          'PASS', '2026-04-20', null],
  ['Legal Contract Reviewer', 'Determinism',        'PASS', '2026-04-20', 'BLEU 0.78 — slight decline after model update started rolling out.'],
  ['Legal Contract Reviewer', 'Groundedness',       'PASS', '2026-04-20', null],
  ['Legal Contract Reviewer', 'Regression & Drift', 'PASS', '2026-04-20', null],
  ['Legal Contract Reviewer', 'Safety / Red-Teaming','PASS', '2026-04-20', null],
  ['Legal Contract Reviewer', 'Content Safety',     'PASS', '2026-04-20', null],
  ['Legal Contract Reviewer', 'Security',           'PASS', '2026-04-20', 'No credential leakage in sampled responses.'],
  ['Legal Contract Reviewer', 'RAG',                'PASS', '2026-04-20', null],

  ['HR Benefits Agent', 'Scope',              'PASS', '2026-04-20', null],
  ['HR Benefits Agent', 'Adherence',          'PASS', '2026-04-20', null],
  ['HR Benefits Agent', 'Determinism',        'PASS', '2026-04-20', null],
  ['HR Benefits Agent', 'Groundedness',       'FAIL', '2026-04-20', 'Citations dropped to 81% — grounding config may need review.'],
  ['HR Benefits Agent', 'Regression & Drift', 'PASS', '2026-04-20', null],
  ['HR Benefits Agent', 'Safety / Red-Teaming','PASS', '2026-04-20', null],
  ['HR Benefits Agent', 'Content Safety',     'PASS', '2026-04-20', null],
  ['HR Benefits Agent', 'Security',           'PASS', '2026-04-20', null],
  ['HR Benefits Agent', 'RAG',                'PENDING', '2026-04-20', 'PICS SDK not yet available.'],

  ['IT Helpdesk Copilot', 'Scope',              'PASS', '2026-04-20', null],
  ['IT Helpdesk Copilot', 'Adherence',          'PASS', '2026-04-20', null],
  ['IT Helpdesk Copilot', 'Determinism',        'PASS', '2026-04-20', null],
  ['IT Helpdesk Copilot', 'Groundedness',       'PASS', '2026-04-20', null],
  ['IT Helpdesk Copilot', 'Regression & Drift', 'PASS', '2026-04-20', null],
  ['IT Helpdesk Copilot', 'Safety / Red-Teaming','FAIL', '2026-04-20', 'Jailbreak succeeded in 1 of 20 probes — first detection.'],
  ['IT Helpdesk Copilot', 'Content Safety',     'PASS', '2026-04-20', null],
  ['IT Helpdesk Copilot', 'Security',           'PASS', '2026-04-20', null],
  ['IT Helpdesk Copilot', 'RAG',                'PASS', '2026-04-20', null],

  ['Sales Forecaster', 'Scope',              'PASS', '2026-04-20', null],
  ['Sales Forecaster', 'Adherence',          'PASS', '2026-04-20', null],
  ['Sales Forecaster', 'Determinism',        'PASS', '2026-04-20', null],
  ['Sales Forecaster', 'Groundedness',       'PASS', '2026-04-20', null],
  ['Sales Forecaster', 'Regression & Drift', 'PENDING', '2026-04-20', 'Baseline not yet established.'],
  ['Sales Forecaster', 'Safety / Red-Teaming','PASS', '2026-04-20', null],
  ['Sales Forecaster', 'Content Safety',     'PASS', '2026-04-20', null],
  ['Sales Forecaster', 'Security',           'PASS', '2026-04-20', null],
  ['Sales Forecaster', 'RAG',                'PASS', '2026-04-20', null],
];

const tx = db.transaction(() => {
  for (const r of historicalRuns) insertResult.run(...r);
});
tx();

db.close();
console.log(`[seed-cpmV2] Added ${historicalRuns.length} historical eval results to: ${dbPath}`);
console.log('  Run dates added: 2026-04-13, 2026-04-20 (existing: 2026-04-27)');
