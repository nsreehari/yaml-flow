#!/usr/bin/env node

/**
 * seed-cpm.cjs — Create and seed the CPM compliance database.
 *
 * Usage:
 *   node seed-cpm.cjs [--db <path>]
 *
 * Default db path: sqlite-handler/.retain/compliance.db.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const dbArgIdx = args.indexOf('--db');
const dbPath = dbArgIdx !== -1 && args[dbArgIdx + 1]
  ? path.resolve(args[dbArgIdx + 1])
  : path.resolve(__dirname, '.retain', 'compliance.db');

// Ensure parent directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// Remove existing DB to start fresh
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = new Database(dbPath);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE agents (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL UNIQUE,
    platform       TEXT,
    owner          TEXT,
    priority       TEXT DEFAULT 'Unassessed' CHECK(priority IN ('Immediate','Normal','Monitor','Unassessed')),
    risk_score     INTEGER DEFAULT 0,
    last_eval      TEXT,
    model_version  TEXT,
    description    TEXT
  );

  CREATE TABLE eval_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL,
    evals      TEXT,
    mode       TEXT,
    regulation TEXT
  );

  CREATE TABLE eval_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name  TEXT NOT NULL,
    category    TEXT NOT NULL,
    result      TEXT NOT NULL CHECK(result IN ('PASS','FAIL','PENDING')),
    run_date    TEXT,
    details     TEXT,
    FOREIGN KEY (agent_name) REFERENCES agents(name)
  );

  CREATE TABLE remediation_tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name   TEXT NOT NULL,
    owner        TEXT,
    category     TEXT,
    action       TEXT,
    status       TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','closed')),
    created_date TEXT,
    regulation   TEXT,
    FOREIGN KEY (agent_name) REFERENCES agents(name)
  );
`);

// ---------------------------------------------------------------------------
// Seed: Agents
// ---------------------------------------------------------------------------
const insertAgent = db.prepare(`
  INSERT INTO agents (name, platform, owner, priority, risk_score, last_eval, model_version, description)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const agents = [
  ['HR Benefits Agent',       'Copilot Studio', 'HR Team',        'Immediate',  92, '2026-04-27', 'gpt-4o-2026-03',   'Answers employee benefits questions, PTO policy, enrollment guidance.'],
  ['IT Helpdesk Copilot',     'M365 Copilot',   'IT Operations',  'Immediate',  87, '2026-04-27', 'gpt-4o-2026-03',   'Handles IT support tickets, password resets, device troubleshooting.'],
  ['Sales Forecaster',        'Foundry',        'Sales Analytics', 'Immediate',  78, '2026-04-26', 'gpt-4o-2026-01',   'Generates quarterly sales projections from CRM pipeline data.'],
  ['Legal Contract Reviewer', 'Copilot Studio', 'Legal Ops',      'Immediate',  95, '2026-04-27', 'gpt-4o-2026-03',   'Reviews vendor contracts for risk clauses, compliance terms, SLA gaps.'],
  ['Customer Support Bot',    'Foundry',        'CX Team',        'Normal',     45, '2026-04-25', 'gpt-4o-mini-2026', 'First-line customer support for product FAQs and order status.'],
  ['Marketing Copy Generator','M365 Copilot',   'Marketing',      'Normal',     38, '2026-04-24', 'gpt-4o-mini-2026', 'Generates ad copy, social media posts, email campaigns.'],
  ['Finance Reconciler',      'Foundry',        'Finance Ops',    'Monitor',    22, '2026-04-20', 'gpt-4o-2026-01',   'Reconciles invoice data against purchase orders and GL entries.'],
  ['Onboarding Assistant',    'Copilot Studio', 'People Team',    'Unassessed',  0, null,          'gpt-4o-mini-2026', 'Guides new hires through onboarding checklists and policy docs.'],
];
for (const a of agents) insertAgent.run(...a);

// ---------------------------------------------------------------------------
// Seed: Eval Categories (V1 Baseline Pack)
// ---------------------------------------------------------------------------
const insertCategory = db.prepare(`
  INSERT INTO eval_categories (category, evals, mode, regulation)
  VALUES (?, ?, ?, ?)
`);

const categories = [
  ['Scope',              'Scope refusal',                                                              'Generator-Verifier',         'Art 14 (Human oversight)'],
  ['Adherence',          'JSON-validity, schema-validity, required field presence, malformed output',   'Deterministic',              'Art 15 (Accuracy, robustness)'],
  ['Determinism',        'BLEU, ROUGE-L',                                                              'Deterministic',              'Art 15 (Accuracy, performance)'],
  ['Groundedness',       'Groundedness, citation',                                                     'LLM + Deterministic',        'Art 13 (Transparency), Art 15 (Accuracy)'],
  ['Regression & Drift', 'Regression / drift evaluator after model change',                            'Deterministic',              'Art 9 (Risk mgmt), Art 15 (Robustness)'],
  ['Safety / Red-Teaming','Prompt injection, jailbreak (library driven)',                               'Generator-Verifier',         'Art 15 (Robustness against misuse)'],
  ['Content Safety',     'Profanity detection, slur detection, harmful content filtering',              'LLM + Deterministic',        'Art 15 (Harm mitigation), Art 5'],
  ['Security',           'Credential leakage',                                                         'Generator-Verifier',         'Art 15 (System security)'],
  ['RAG',                'Tool call presence, tool call error rate, risky tool',                        'Deterministic + Behavioral', 'Art 9, Art 13, Art 15'],
];
for (const c of categories) insertCategory.run(...c);

// ---------------------------------------------------------------------------
// Seed: Eval Results (latest run for high-priority agents)
// ---------------------------------------------------------------------------
const insertResult = db.prepare(`
  INSERT INTO eval_results (agent_name, category, result, run_date, details)
  VALUES (?, ?, ?, ?, ?)
`);

const runDate = '2026-04-27';
const results = [
  // Legal Contract Reviewer — worst offender: 3 failures
  ['Legal Contract Reviewer', 'Scope',              'PASS', runDate, null],
  ['Legal Contract Reviewer', 'Adherence',          'PASS', runDate, null],
  ['Legal Contract Reviewer', 'Determinism',        'FAIL', runDate, 'BLEU score dropped from 0.82 to 0.61 after model update to gpt-4o-2026-03. Output variance exceeds threshold.'],
  ['Legal Contract Reviewer', 'Groundedness',       'PASS', runDate, null],
  ['Legal Contract Reviewer', 'Regression & Drift', 'FAIL', runDate, 'Model changed from gpt-4o-2026-01 to gpt-4o-2026-03 on 2026-04-25. Response pattern shifted significantly vs. baseline.'],
  ['Legal Contract Reviewer', 'Safety / Red-Teaming','PASS', runDate, null],
  ['Legal Contract Reviewer', 'Content Safety',     'PASS', runDate, null],
  ['Legal Contract Reviewer', 'Security',           'FAIL', runDate, 'Credential leakage: agent included internal API key fragment in 2 of 50 sampled responses.'],
  ['Legal Contract Reviewer', 'RAG',                'PASS', runDate, null],

  // HR Benefits Agent — groundedness failure + pending RAG
  ['HR Benefits Agent', 'Scope',              'PASS', runDate, null],
  ['HR Benefits Agent', 'Adherence',          'PASS', runDate, null],
  ['HR Benefits Agent', 'Determinism',        'PASS', runDate, null],
  ['HR Benefits Agent', 'Groundedness',       'FAIL', runDate, 'Citations missing in 23% of responses. Agent fabricated policy details not in source documents.'],
  ['HR Benefits Agent', 'Regression & Drift', 'PASS', runDate, null],
  ['HR Benefits Agent', 'Safety / Red-Teaming','PASS', runDate, null],
  ['HR Benefits Agent', 'Content Safety',     'PASS', runDate, null],
  ['HR Benefits Agent', 'Security',           'PASS', runDate, null],
  ['HR Benefits Agent', 'RAG',                'PENDING', runDate, 'Tool call evaluation pending — PICS SDK integration in progress.'],

  // IT Helpdesk Copilot — safety failure (jailbreak)
  ['IT Helpdesk Copilot', 'Scope',              'PASS', runDate, null],
  ['IT Helpdesk Copilot', 'Adherence',          'PASS', runDate, null],
  ['IT Helpdesk Copilot', 'Determinism',        'PASS', runDate, null],
  ['IT Helpdesk Copilot', 'Groundedness',       'PASS', runDate, null],
  ['IT Helpdesk Copilot', 'Regression & Drift', 'PASS', runDate, null],
  ['IT Helpdesk Copilot', 'Safety / Red-Teaming','FAIL', runDate, 'Jailbreak succeeded in 3 of 20 adversarial probes. Agent disclosed internal IT topology when prompted with social engineering pattern.'],
  ['IT Helpdesk Copilot', 'Content Safety',     'PASS', runDate, null],
  ['IT Helpdesk Copilot', 'Security',           'PASS', runDate, null],
  ['IT Helpdesk Copilot', 'RAG',                'PASS', runDate, null],

  // Sales Forecaster — clean except pending drift (model not yet updated)
  ['Sales Forecaster', 'Scope',              'PASS', runDate, null],
  ['Sales Forecaster', 'Adherence',          'PASS', runDate, null],
  ['Sales Forecaster', 'Determinism',        'PASS', runDate, null],
  ['Sales Forecaster', 'Groundedness',       'PASS', runDate, null],
  ['Sales Forecaster', 'Regression & Drift', 'PENDING', runDate, 'Drift evaluation pending — baseline not yet established for Foundry deployment.'],
  ['Sales Forecaster', 'Safety / Red-Teaming','PASS', runDate, null],
  ['Sales Forecaster', 'Content Safety',     'PASS', runDate, null],
  ['Sales Forecaster', 'Security',           'PASS', runDate, null],
  ['Sales Forecaster', 'RAG',                'PASS', runDate, null],
];
for (const r of results) insertResult.run(...r);

// ---------------------------------------------------------------------------
// Seed: Remediation Tasks
// ---------------------------------------------------------------------------
const insertTask = db.prepare(`
  INSERT INTO remediation_tasks (agent_name, owner, category, action, status, created_date, regulation)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const tasks = [
  ['Legal Contract Reviewer', 'Legal Ops',     'Security',           'Immediate security review — credential leakage detected in sampled traces. Rotate exposed keys and patch system prompt to suppress internal identifiers.', 'open',        '2026-04-27', 'Art 15 (System security)'],
  ['Legal Contract Reviewer', 'Legal Ops',     'Regression & Drift', 'Model updated from gpt-4o-2026-01 to gpt-4o-2026-03 without re-certification. Schedule re-evaluation against approved baseline.', 'open',        '2026-04-27', 'Art 9 (Risk mgmt)'],
  ['Legal Contract Reviewer', 'Legal Ops',     'Determinism',        'BLEU score regression after model change. Review prompt template and few-shot examples for deterministic output stability.', 'in_progress', '2026-04-27', 'Art 15 (Accuracy)'],
  ['HR Benefits Agent',       'HR Team',       'Groundedness',       'Citations missing in 23% of responses. Review grounding configuration — ensure RAG pipeline returns source document references.', 'open',        '2026-04-27', 'Art 13 (Transparency)'],
  ['IT Helpdesk Copilot',     'IT Operations', 'Safety / Red-Teaming','Jailbreak vulnerability: agent disclosed internal IT topology under social engineering. Harden system prompt with explicit refusal boundaries.', 'open',        '2026-04-27', 'Art 15 (Robustness)'],
];
for (const t of tasks) insertTask.run(...t);

db.close();
console.log(`[seed-cpm] Database seeded: ${dbPath}`);
console.log(`  agents:             ${agents.length}`);
console.log(`  eval_categories:    ${categories.length}`);
console.log(`  eval_results:       ${results.length}`);
console.log(`  remediation_tasks:  ${tasks.length}`);
