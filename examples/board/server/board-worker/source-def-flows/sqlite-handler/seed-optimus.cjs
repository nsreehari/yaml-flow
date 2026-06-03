#!/usr/bin/env node

/**
 * seed-optimus.cjs — Create and seed the OPTIMUS threat hunting database.
 *
 * Usage:
 *   node seed-optimus.cjs [--db <path>]
 *
 * Default db path: sqlite-handler/.retain/optimus.db
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const dbArgIdx = args.indexOf('--db');
const dbPath = dbArgIdx !== -1 && args[dbArgIdx + 1]
  ? path.resolve(args[dbArgIdx + 1])
  : path.resolve(__dirname, '.retain', 'optimus.db');

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = new Database(dbPath);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE attack_planes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    plane        TEXT NOT NULL UNIQUE,
    data_source  TEXT NOT NULL,
    signal_type  TEXT,
    t_weight     REAL DEFAULT 0.0,
    description  TEXT
  );

  CREATE TABLE tapc_config (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    component   TEXT NOT NULL CHECK(component IN ('T','A','P','C','negative')),
    signal      TEXT NOT NULL,
    weight      REAL NOT NULL,
    description TEXT
  );

  CREATE TABLE agents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    role       TEXT NOT NULL,
    model      TEXT,
    tool_count INTEGER DEFAULT 0,
    status     TEXT DEFAULT 'idle' CHECK(status IN ('idle','scanning','graphing','validating','critiquing','complete','error')),
    last_run   TEXT,
    description TEXT
  );

  CREATE TABLE scan_candidates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    entity        TEXT NOT NULL,
    org_id        TEXT NOT NULL,
    plane         TEXT NOT NULL,
    pre_graph_ta  REAL DEFAULT 0.0,
    t_score       REAL DEFAULT 0.0,
    a_score       REAL DEFAULT 0.0,
    p_score       REAL,
    c_score       REAL,
    tapc_final    REAL,
    promoted      INTEGER DEFAULT 0,
    run_date      TEXT,
    details       TEXT,
    FOREIGN KEY (plane) REFERENCES attack_planes(plane)
  );

  CREATE TABLE findings (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    entity           TEXT NOT NULL,
    org_id           TEXT NOT NULL,
    tapc_score       REAL NOT NULL,
    admiralty_code   TEXT,
    mitre_technique  TEXT,
    kill_chain_stage TEXT,
    status           TEXT DEFAULT 'validated' CHECK(status IN ('validated','downgraded','fp_killed','escalated')),
    summary          TEXT,
    run_date         TEXT
  );

  CREATE TABLE fp_patterns (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_name     TEXT NOT NULL,
    plane            TEXT,
    suppression_rule TEXT,
    hits             INTEGER DEFAULT 0,
    added_date       TEXT,
    description      TEXT
  );

  CREATE TABLE scan_history (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date            TEXT NOT NULL,
    plane               TEXT NOT NULL,
    candidates_found    INTEGER DEFAULT 0,
    promoted            INTEGER DEFAULT 0,
    findings_validated  INTEGER DEFAULT 0,
    fp_killed           INTEGER DEFAULT 0,
    FOREIGN KEY (plane) REFERENCES attack_planes(plane)
  );

  CREATE TABLE mcp_tools (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server     TEXT NOT NULL,
    tool_name  TEXT NOT NULL,
    agent      TEXT,
    category   TEXT,
    description TEXT
  );
`);

// ---------------------------------------------------------------------------
// Seed: Attack Planes
// ---------------------------------------------------------------------------
const insertPlane = db.prepare(`
  INSERT INTO attack_planes (plane, data_source, signal_type, t_weight, description)
  VALUES (?, ?, ?, ?, ?)
`);

const planes = [
  ['Identity Auth',    'IdentityLogonEvents', 'Legacy auth protocols',         0.90, 'Authentication events — legacy auth, MFA bypass, protocol abuse'],
  ['Identity Control', 'CloudAppEvents',      'Role/permission changes',       0.75, 'Administrative actions — role assignments, conditional access changes, app registrations'],
  ['Identity Recon',   'IdentityQueryEvents', 'LDAP/SAM-R enumeration',        0.65, 'Reconnaissance — directory queries, group enumeration, user discovery'],
  ['Cloud / SaaS',     'CloudAppEvents',      'Inbox rules, OAuth grants',     0.85, 'Cloud post-compromise — inbox rule creation, OAuth consent, data exfiltration'],
  ['Endpoint',         'MtpAlertEvidence',    'Process/file anomalies',        0.70, 'Endpoint indicators — suspicious processes, file drops, persistence mechanisms'],
  ['Network',          'IdentityLogonEvents', 'Geo-impossible travel, VPN',    0.60, 'Network-layer signals — impossible travel, known bad IPs, TOR exit nodes'],
  ['Detection Gaps',   'MtpAlerts (inverse)', 'Absence-of-alerts signal',      0.80, 'Inverse detection — accounts with telemetry anomalies but ZERO existing alerts'],
];
for (const p of planes) insertPlane.run(...p);

// ---------------------------------------------------------------------------
// Seed: TAPC Configuration
// ---------------------------------------------------------------------------
const insertTapc = db.prepare(`
  INSERT INTO tapc_config (component, signal, weight, description)
  VALUES (?, ?, ?, ?)
`);

const tapcConfig = [
  // T — Threat Likeness (weight 0.4)
  ['T', 'autologon',       0.95, 'Autologon protocol — highest exploitation risk'],
  ['T', 'NTLMv1',          0.90, 'NTLMv1 authentication — trivially crackable'],
  ['T', 'WSTrust',         0.85, 'WS-Trust mixed endpoint — federation abuse vector'],
  ['T', 'deviceCode',      0.80, 'Device code flow — phishing-friendly OAuth grant'],
  ['T', 'WeakKerb',        0.75, 'Weak Kerberos encryption (RC4/DES)'],
  ['T', 'LegacyMail',      0.70, 'Legacy mail protocols (POP3/IMAP/SMTP AUTH)'],
  ['T', 'LDAPclear',       0.65, 'LDAP cleartext bind — credential exposure'],
  ['T', 'ADFS',            0.55, 'ADFS authentication — moderate federation risk'],
  // A — Anomaly (weight 0.2)
  ['A', 'volume_spike',    0.80, 'Volume exceeds 3-sigma above 30-day baseline'],
  ['A', 'new_ip',          0.70, 'IP address never seen for this entity in 30 days'],
  ['A', 'geo_impossible',  0.90, 'Geographically impossible travel between auth events'],
  ['A', 'off_hours',       0.50, 'Activity outside normal working hours pattern'],
  ['A', 'spray_structure', 0.85, 'Password spray: high fail + many users + legacy proto'],
  ['A', 'cross_plane',     0.15, 'Bonus: entity appears in >=2 attack planes'],
  // P — Progression (weight 0.3)
  ['P', 'credential',      0.10, 'P1: Initial credential access attempt'],
  ['P', 'token_exchange',  0.15, 'P2: Token exchange / elevation'],
  ['P', 'resource_access', 0.25, 'P3: Resource access (mail, files, APIs)'],
  ['P', 'persistence',     0.30, 'P4: Persistence mechanisms (inbox rules, app consent)'],
  ['P', 'lateral_movement',0.20, 'P5: Lateral movement to other accounts/systems'],
  // C — Context (weight 0.1)
  ['C', 'admin_privilege',  1.50, 'Admin account multiplier (1.5x)'],
  ['C', 'sso_misconfigured',0.70, 'SSO misconfiguration detected in tenant'],
  ['C', 'prior_alerts',     0.60, 'Entity has existing (potentially unrelated) alerts'],
  // Negative evidence
  ['negative', 'internal_inbox',   -0.40, 'Forwarding to internal inbox only — benign pattern'],
  ['negative', 'managed_device',   -0.20, 'Auth from corporate managed device'],
  ['negative', 'peer_prevalence',  -0.30, 'IP seen across many peer accounts (shared infra)'],
  ['negative', 'svc_account',      -0.20, 'Service account with expected legacy auth pattern'],
  ['negative', 'ip_100orgs',       -0.30, 'IP appears in 100+ orgs — shared infrastructure'],
];
for (const t of tapcConfig) insertTapc.run(...t);

// ---------------------------------------------------------------------------
// Seed: Agents
// ---------------------------------------------------------------------------
const insertAgent = db.prepare(`
  INSERT INTO agents (name, role, model, tool_count, status, last_run, description)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const agentData = [
  ['BEACON',      'TAPC Observable Scanner',     'Claude Opus 4.6',  10, 'complete', '2026-04-27', 'Sweeps all 7 attack planes with TAPC T-signal scoring. Generates anomaly candidates and promotes findings >= 0.35 PreGraphTA.'],
  ['WEAVER',      'Graph Pattern Operator',      'Claude Opus 4.6',   8, 'complete', '2026-04-27', 'Builds observable graphs from promoted candidates. Detects temporal attack motifs and cross-tenant campaign infrastructure.'],
  ['CRUCIBLE',    'Stress-Test Validator',        'Claude Opus 4.6',   5, 'complete', '2026-04-27', 'Assumes every finding is FP. Applies 7-check validation framework. Generates Admiralty/NATO confidence codes.'],
  ['RUBBER DUCK', 'Independent Critique Agent',   'Claude Sonnet 4.6', 0, 'complete', '2026-04-27', 'Provides adversarial feedback. Catches overclaims, logic errors, FP blind spots. Separate model for independent reasoning.'],
];
for (const a of agentData) insertAgent.run(...a);

// ---------------------------------------------------------------------------
// Seed: Scan Candidates (Cycle 3: 2026-04-27 — latest)
// ---------------------------------------------------------------------------
const insertCandidate = db.prepare(`
  INSERT INTO scan_candidates (entity, org_id, plane, pre_graph_ta, t_score, a_score, p_score, c_score, tapc_final, promoted, run_date, details)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const c3 = '2026-04-27';
const candidates = [
  // Promoted candidates (PreGraphTA >= 0.35)
  ['UserPII_a7f3e2d1',  'OrgPII_contoso',  'Identity Auth',    0.62, 0.90, 0.50, 0.25, 0.70, 0.68, 1, c3, 'WS-Trust mixed auth from new IP, volume 4.2-sigma above baseline, off-hours'],
  ['UserPII_b8c4f901',  'OrgPII_fabrikam',  'Identity Auth',    0.54, 0.85, 0.40, 0.15, 0.60, 0.57, 1, c3, 'Device code flow from residential IP, no MFA challenge, first-time protocol use'],
  ['UserPII_c9d5e012',  'OrgPII_contoso',  'Cloud / SaaS',     0.48, 0.85, 0.30, 0.30, 0.80, 0.62, 1, c3, 'New-InboxRule forwarding to external domain 2h after legacy auth'],
  ['UserPII_a7f3e2d1',  'OrgPII_contoso',  'Cloud / SaaS',     0.44, 0.70, 0.35, 0.25, 0.70, 0.55, 1, c3, 'OAuth consent grant for unknown app post-WSTrust auth (cross-plane)'],
  ['UserPII_d1e6f123',  'OrgPII_woodgrove', 'Identity Auth',    0.42, 0.75, 0.30, 0.10, 0.50, 0.47, 1, c3, 'Legacy SMTP AUTH from IP seen in only this org, 3.1-sigma spike'],
  ['UserPII_e2f7a234',  'OrgPII_contoso',  'Detection Gaps',   0.40, 0.80, 0.20, null,  null,  null, 1, c3, 'Admin account with 47 identity events, ZERO existing alerts'],
  ['UserPII_f3a8b345',  'OrgPII_fabrikam',  'Identity Recon',   0.38, 0.65, 0.30, null,  null,  null, 1, c3, 'LDAP enumeration of all global admin group members'],
  ['UserPII_a4b9c456',  'OrgPII_woodgrove', 'Endpoint',         0.36, 0.70, 0.20, null,  null,  null, 1, c3, 'Suspicious PowerShell execution post-auth from flagged IP'],
  // Not promoted (below threshold)
  ['UserPII_x1y2z301',  'OrgPII_contoso',  'Network',          0.28, 0.60, 0.10, null,  null,  null, 0, c3, 'VPN from new geo — but managed device, peer prevalence high'],
  ['UserPII_x2y3z402',  'OrgPII_fabrikam',  'Identity Auth',    0.24, 0.55, 0.05, null,  null,  null, 0, c3, 'ADFS auth from known corporate range — benign service account'],
  ['UserPII_x3y4z503',  'OrgPII_contoso',  'Identity Control', 0.22, 0.40, 0.15, null,  null,  null, 0, c3, 'Role assignment — but part of scheduled rotation'],
  ['UserPII_x4y5z604',  'OrgPII_woodgrove', 'Cloud / SaaS',     0.20, 0.35, 0.12, null,  null,  null, 0, c3, 'Inbox rule but internal-only forwarding (same domain)'],
  ['UserPII_x5y6z705',  'OrgPII_fabrikam',  'Identity Auth',    0.18, 0.45, 0.00, null,  null,  null, 0, c3, 'Legacy auth but high peer prevalence — shared VPN gateway'],
  ['UserPII_x6y7z806',  'OrgPII_contoso',  'Network',          0.14, 0.30, 0.05, null,  null,  null, 0, c3, 'Off-hours access but from home IP consistently used'],
  ['UserPII_x7y8z907',  'OrgPII_woodgrove', 'Identity Recon',   0.12, 0.25, 0.05, null,  null,  null, 0, c3, 'Single LDAP query — normal admin behavior'],
];
for (const c of candidates) insertCandidate.run(...c);

// ---------------------------------------------------------------------------
// Seed: Validated Findings (Cycle 3)
// ---------------------------------------------------------------------------
const insertFinding = db.prepare(`
  INSERT INTO findings (entity, org_id, tapc_score, admiralty_code, mitre_technique, kill_chain_stage, status, summary, run_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const findingsData = [
  ['UserPII_a7f3e2d1', 'OrgPII_contoso',  0.68, 'B1', 'T1078.004 + T1098.003', 'Credential → Persistence',   'validated',  'WS-Trust auth from new IP → OAuth consent grant for unknown app → 2 cross-plane signals. Admin account, no existing alerts. Kill chain: credential access via federation abuse followed by persistence through malicious OAuth app.', c3],
  ['UserPII_b8c4f901', 'OrgPII_fabrikam',  0.57, 'B2', 'T1528',                  'Credential → Token Theft',   'validated',  'Device code phishing pattern: residential IP, no prior auth history, token obtained without MFA. Corroborated across IdentityLogonEvents + CloudAppEvents. Same IP seen in 2 other DEX orgs.', c3],
  ['UserPII_c9d5e012', 'OrgPII_contoso',  0.62, 'B1', 'T1114.003 + T1078',      'Access → Exfil Staging',     'validated',  'Inbox rule forwarding to external domain created 2h after legacy SMTP auth. External domain registered 3 days prior. Classic BEC post-compromise pattern.', c3],
  ['UserPII_d1e6f123', 'OrgPII_woodgrove', 0.47, 'B2', 'T1110.003',              'Credential Spray',           'downgraded', 'Legacy SMTP spike corroborated but limited to single protocol. No post-compromise activity detected in 24h window. Downgraded from B1 to B2 by RUBBER DUCK — insufficient progression evidence.', c3],
  ['UserPII_e2f7a234', 'OrgPII_contoso',  0.40, 'B2', 'T1078 (suspected)',       'Detection Gap — No Actions', 'validated',  'Admin with 47 identity events and zero alerts. High T-signal (legacy auth protocols) but no confirmed post-compromise activity. Flagged as detection gap for monitoring — existing detection coverage insufficient.', c3],
];
for (const f of findingsData) insertFinding.run(...f);

// ---------------------------------------------------------------------------
// Seed: FP Pattern Library
// ---------------------------------------------------------------------------
const insertFP = db.prepare(`
  INSERT INTO fp_patterns (pattern_name, plane, suppression_rule, hits, added_date, description)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const fpPatterns = [
  ['same_domain_forward',   'Cloud / SaaS',     'inbox_rule.forward_to LIKE same_org_domain', 234, '2026-04-20', 'Inbox rule forwarding within same organization domain — benign delegation pattern'],
  ['managed_device_legacy',  'Identity Auth',    'device.compliant = true AND auth.legacy = true', 189, '2026-04-15', 'Legacy auth from managed device — often VPN client or legacy thick client'],
  ['shared_vpn_gateway',    'Identity Auth',    'ip.org_count >= 50',                              156, '2026-04-15', 'IP used by 50+ orgs — shared VPN/proxy infrastructure'],
  ['svc_account_pattern',   'Identity Auth',    'account.type = service AND auth.pattern = recurring', 98, '2026-04-18', 'Service account with predictable legacy auth pattern'],
  ['admin_role_rotation',   'Identity Control', 'role_change.scheduled = true',                     67, '2026-04-20', 'Planned admin role rotation per IT change management calendar'],
  ['geo_vpn_expected',      'Network',          'ip.geo_distance > 1000km AND ip.is_corp_vpn = true', 45, '2026-04-22', 'Impossible travel from known corporate VPN exit nodes'],
  ['monitoring_ldap',       'Identity Recon',   'query.source = monitoring_tool AND query.pattern = periodic', 34, '2026-04-25', 'LDAP queries from known monitoring tools (periodic health checks)'],
  ['stale_token_refresh',   'Cloud / SaaS',     'token.type = refresh AND token.age > 30d',          12, '2026-04-27', 'Stale refresh token usage — usually automated app re-auth, not attacker'],
];
for (const f of fpPatterns) insertFP.run(...f);

// ---------------------------------------------------------------------------
// Seed: Scan History (3 cycles)
// ---------------------------------------------------------------------------
const insertHistory = db.prepare(`
  INSERT INTO scan_history (run_date, plane, candidates_found, promoted, findings_validated, fp_killed)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const historyData = [
  // Cycle 1: 2026-04-13 — baseline, quiet period
  ['2026-04-13', 'Identity Auth',    8, 2, 0, 1],
  ['2026-04-13', 'Identity Control', 3, 0, 0, 0],
  ['2026-04-13', 'Identity Recon',   2, 0, 0, 0],
  ['2026-04-13', 'Cloud / SaaS',     5, 1, 0, 1],
  ['2026-04-13', 'Endpoint',         1, 0, 0, 0],
  ['2026-04-13', 'Network',          4, 1, 0, 0],
  ['2026-04-13', 'Detection Gaps',   2, 1, 0, 0],
  // Cycle 2: 2026-04-20 — first anomalies, FP discovery
  ['2026-04-20', 'Identity Auth',   14, 5, 1, 2],
  ['2026-04-20', 'Identity Control', 4, 1, 0, 1],
  ['2026-04-20', 'Identity Recon',   6, 2, 0, 1],
  ['2026-04-20', 'Cloud / SaaS',     9, 3, 1, 1],
  ['2026-04-20', 'Endpoint',         3, 1, 0, 0],
  ['2026-04-20', 'Network',          5, 1, 0, 1],
  ['2026-04-20', 'Detection Gaps',   4, 2, 1, 0],
  // Cycle 3: 2026-04-27 — campaign detected, multi-tenant
  ['2026-04-27', 'Identity Auth',   18, 8, 2, 3],
  ['2026-04-27', 'Identity Control', 5, 1, 0, 1],
  ['2026-04-27', 'Identity Recon',   7, 3, 0, 1],
  ['2026-04-27', 'Cloud / SaaS',    12, 4, 2, 2],
  ['2026-04-27', 'Endpoint',         4, 2, 0, 0],
  ['2026-04-27', 'Network',          6, 2, 0, 1],
  ['2026-04-27', 'Detection Gaps',   5, 3, 1, 0],
];
for (const h of historyData) insertHistory.run(...h);

// ---------------------------------------------------------------------------
// Seed: MCP Tools (representative subset)
// ---------------------------------------------------------------------------
const insertTool = db.prepare(`
  INSERT INTO mcp_tools (server, tool_name, agent, category, description)
  VALUES (?, ?, ?, ?, ?)
`);

const toolsData = [
  ['optimus', 'beacon_scan_all_planes',      'BEACON',   'scan',     'Parallel KQL sweep across all 7 attack planes'],
  ['optimus', 'beacon_scan_plane',           'BEACON',   'scan',     'Targeted single-plane anomaly scan'],
  ['optimus', 'beacon_fuse_results',         'BEACON',   'fusion',   'Cross-plane entity fusion and promotion'],
  ['optimus', 'beacon_hunt_password_spray',  'BEACON',   'hunt',     'Structural spray detection (post-promotion only)'],
  ['optimus', 'beacon_status',               'BEACON',   'status',   'Current BEACON agent state'],
  ['optimus', 'weaver_build_graph',          'WEAVER',   'graph',    'Kusto make-graph: user→IP→action edges'],
  ['optimus', 'weaver_find_motifs',          'WEAVER',   'graph',    'Temporal attack motif detection'],
  ['optimus', 'weaver_find_campaigns',       'WEAVER',   'graph',    'Cross-tenant campaign infrastructure (>=3 orgs)'],
  ['optimus', 'weaver_cross_plane',          'WEAVER',   'graph',    'Identity→Cloud plane traversal detection'],
  ['optimus', 'weaver_blast_radius',         'WEAVER',   'graph',    'Compromised account blast radius assessment'],
  ['optimus', 'weaver_enrich_pc',            'WEAVER',   'enrich',   'P/C score enrichment from graph context'],
  ['optimus', 'crucible_validate',           'CRUCIBLE', 'validate', '7-check validation framework'],
  ['optimus', 'crucible_investigate_deeper', 'CRUCIBLE', 'validate', 'Deep investigation KQL generation'],
  ['optimus', 'crucible_kill_fp',            'CRUCIBLE', 'validate', 'Add FP to negative evidence library'],
  ['optimus', 'optimus_run_cycle',           'MASTER',   'pipeline', 'Full TAPC-first pipeline: BEACON→WEAVER→CRUCIBLE'],
  ['optimus', 'optimus_get_tapc_config',     'MASTER',   'config',   'Full TAPC scoring configuration'],
  ['optimus', 'optimus_get_fp_patterns',     'MASTER',   'config',   'All known false positive patterns'],
  ['optimus', 'optimus_remember',            'MASTER',   'memory',   'Persist finding/pattern to knowledge store'],
  ['optimus', 'optimus_recall',              'MASTER',   'memory',   'Search persistent knowledge'],
  ['attack_intersectionality', 'lookup_technique',        null, 'mitre', 'MITRE technique lookup by ID or name'],
  ['attack_intersectionality', 'analyze_intersection',    null, 'mitre', 'Pairwise technique intersection analysis'],
  ['attack_intersectionality', 'match_attack_chain',      null, 'mitre', 'Match observed techniques to known attack chains'],
  ['attack_intersectionality', 'tapc_score',              null, 'tapc',  'TAPC model explanation and formula'],
  ['attack_intersectionality', 'validate_finding',        null, 'validate', '7-check self-critic validation engine'],
  ['attack_intersectionality', 'investigate',             null, 'pivot', 'Investigation pivot (IP/user/org)'],
  ['attack_intersectionality', 'scrub',                   null, 'ghost', 'SHA-1 PII hashing'],
  ['attack_intersectionality', 'unscrub',                 null, 'ghost', 'Rainbow table PII reversal'],
  ['kusto', 'kusto_query',                  null, 'kql',    'Execute KQL query against ADX cluster'],
];
for (const t of toolsData) insertTool.run(...t);

db.close();
console.log(`[seed-optimus] Database seeded: ${dbPath}`);
console.log(`  attack_planes:    ${planes.length}`);
console.log(`  tapc_config:      ${tapcConfig.length}`);
console.log(`  agents:           ${agentData.length}`);
console.log(`  scan_candidates:  ${candidates.length}`);
console.log(`  findings:         ${findingsData.length}`);
console.log(`  fp_patterns:      ${fpPatterns.length}`);
console.log(`  scan_history:     ${historyData.length}`);
console.log(`  mcp_tools:        ${toolsData.length}`);
