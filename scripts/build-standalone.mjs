#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'standalone');
const shouldMinifyJs = !process.argv.includes('--no-minify-js');

// ─── Layout ───────────────────────────────────────────────────────────────────
//
//   core/pylib/      ← pycli/pylib/          (pure engine library)
//   core/cli/        ← pycli/main/            (CLI entrypoints)
//   core/adapters/   ← pycli/sub/             (platform adapters)
//   core/server/     ← pycli/py-server-runtime/
//   browser/         ← demo-src html + svg
//   examples/pyboard/        ← Python demo board (self-contained)
//     server/               ← py-demo-server.py + standalone demo-server-config.json
//     server/handlers/      ← demo-task-executor.py, demo-chat-handler.py,
//                               source_def_flows.json, source-def-flows/, source-def-handlers/
//     server/handlers/source-def-handlers/scripts/ ← copilot_wrapper.bat + .ps1
//     data/cards/           ← card definitions
//     data/gandalf-cards/   ← gandalf board cards
//   examples/portfolio-tracker/ ← portfolio-tracker example (Python only)
//   requirements.txt ← pycli/requirements.txt
//
// ─────────────────────────────────────────────────────────────────────────────

// Entries: [srcRel, dstRel] — relative to repo root / standalone root
const copyMap = [
  // core library
  ['pycli/pylib',             'core/pylib'],
  ['pycli/main',              'core/cli'],
  ['pycli/sub',               'core/adapters'],
  ['pycli/py-server-runtime', 'core/server'],
  // requirements at root
  ['pycli/requirements.txt',  'requirements.txt'],
  // browser assets (JS bundles + favicon) — referenced as ../../browser/ from example HTML shells
  ['browser/live-cards.js',                    'browser/live-cards.js'],
  ['browser/board-livecards-client.js',        'browser/board-livecards-client.js'],
  ['browser/board-livecards-localstorage.js',  'browser/board-livecards-localstorage.js'],
  ['browser/compute-jsonata.js',               'browser/compute-jsonata.js'],
  ['demo-src/example-board/favicon.svg',       'browser/favicon.svg'],
  // HTML shells — placed in their example directories (../../browser/ resolves to standalone/browser/)
  ['demo-src/example-board/demo-shell-with-server.html', 'examples/pyboard/demo-shell-with-server.html'],
  ['demo-src/example-board/demo-shell-localstorage.html','examples/pyboard-local/demo-shell-localstorage.html'],
  // demo-shell.html intentionally excluded from standalone
  // pyboard — server
  ['demo-src/example-board/py-demo-server.py', 'examples/pyboard/server/py-demo-server.py'],
  // pyboard — handlers (note: demo-server-config.json is written fresh by writeStandaloneServerConfig)
  ['demo-src/example-board/demo-task-executor.py',  'examples/pyboard/server/handlers/demo-task-executor.py'],
  ['demo-src/example-board/demo-chat-handler.py',   'examples/pyboard/server/handlers/demo-chat-handler.py'],
  ['demo-src/example-board/source_def_flows.json',  'examples/pyboard/server/handlers/source_def_flows.json'],
  ['demo-src/example-board/source-def-flows',       'examples/pyboard/server/handlers/source-def-flows'],
  // pyboard — source-def Python handlers (JS handlers excluded from standalone)
  ['demo-src/example-board/source-def-handlers/http-source-handler.py',    'examples/pyboard/server/handlers/source-def-handlers/http-source-handler.py'],
  ['demo-src/example-board/source-def-handlers/copilot-source-handler.py', 'examples/pyboard/server/handlers/source-def-handlers/copilot-source-handler.py'],
  // pyboard — copilot scripts land inside source-def-handlers/ where they belong
  ['demo-src/example-board/scripts/copilot_wrapper.bat',        'examples/pyboard/server/handlers/source-def-handlers/scripts/copilot_wrapper.bat'],
  ['demo-src/example-board/scripts/copilot_wrapper_helper.ps1', 'examples/pyboard/server/handlers/source-def-handlers/scripts/copilot_wrapper_helper.ps1'],
  // pyboard — data
  ['demo-src/example-board/cards',         'examples/pyboard/data/cards'],
  ['demo-src/example-board/gandalf-cards', 'examples/pyboard/data/gandalf-cards'],
  // portfolio-tracker example — only the main script and its fetch-prices handler
  ['examples/browser/boards/portfolio-tracker/portfolio-tracker.py',             'examples/portfolio-tracker/portfolio-tracker.py'],
  ['examples/browser/boards/portfolio-tracker/portfolio-tracker-fetch-prices.py','examples/portfolio-tracker/portfolio-tracker-fetch-prices.py'],
];

// Python path patches: [dstRel, [[oldStr, newStr], ...]]
// Applied to the copied file in standalone after all copies are done.
const pythonPathPatches = [
  // ── py-demo-server.py ──────────────────────────────────────────────────────
  // server/ is at examples/pyboard/server/ → core is 3 levels up (../../..)
  ['examples/pyboard/server/py-demo-server.py', [
    ['os.path.normpath(os.path.join(__file_dir, "..", "..", "pycli"))',
     'os.path.normpath(os.path.join(__file_dir, "..", "..", "..", "core"))'],
    ['os.path.join(_PYCLI_ROOT, "py-server-runtime")',
     'os.path.join(_PYCLI_ROOT, "server")'],
    ['os.path.join(_PYCLI_ROOT, "sub")',
     'os.path.join(_PYCLI_ROOT, "adapters")'],
    ['os.path.join(_PYCLI_ROOT, "main", "board_live_cards_pycli.py")',
     'os.path.join(_PYCLI_ROOT, "cli", "board_live_cards_pycli.py")'],
  ]],
  // ── demo-task-executor.py ──────────────────────────────────────────────────
  // handlers/ is at examples/pyboard/server/handlers/ → core is 4 levels up (../../../..)
  ['examples/pyboard/server/handlers/demo-task-executor.py', [
    ['os.path.normpath(os.path.join(_HERE, "..", "..", "pycli"))',
     'os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", "core"))'],
    // scripts/ moved into source-def-handlers/scripts/ in standalone
    ['os.path.join(_HERE, "scripts", "copilot_wrapper.bat")',
     'os.path.join(_HERE, "source-def-handlers", "scripts", "copilot_wrapper.bat")'],
  ]],
  // ── copilot-source-handler.py ──────────────────────────────────────────────
  // executor_dir is passed in as _HERE of demo-task-executor (handlers/)
  // scripts/ is at handlers/source-def-handlers/scripts/
  ['examples/pyboard/server/handlers/source-def-handlers/copilot-source-handler.py', [
    ['os.path.join(executor_dir, "scripts")',
     'os.path.join(executor_dir, "source-def-handlers", "scripts")'],
  ]],
  // ── HTML shells: fix favicon path (favicon lives in browser/, not alongside HTML) ──
  ['examples/pyboard/demo-shell-with-server.html', [
    ['href="favicon.svg"', 'href="../../browser/favicon.svg"'],
  ]],
  ['examples/pyboard-local/demo-shell-localstorage.html', [
    ['href="favicon.svg"', 'href="../../browser/favicon.svg"'],
  ]],
  // ── flow JSONs: replace JS handler refs with Python equivalents ────────────
  ['examples/pyboard/server/handlers/source-def-flows/url.flow.json', [
    ['./source-def-handlers/http-source-handler.js', './source-def-handlers/http-source-handler.py'],
  ]],
  ['examples/pyboard/server/handlers/source-def-flows/url-list.flow.json', [
    ['./source-def-handlers/http-source-handler.js', './source-def-handlers/http-source-handler.py'],
  ]],
  ['examples/pyboard/server/handlers/source-def-flows/copilot.flow.json', [
    ['./source-def-handlers/copilot-source-handler.js', './source-def-handlers/copilot-source-handler.py'],
  ]],
];

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyAs(srcRel, dstRel) {
  const src = path.join(root, srcRel);
  const dst = path.join(outDir, dstRel);
  if (!(await exists(src))) {
    console.warn(`  [skip] not found: ${srcRel}`);
    return;
  }
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.cp(src, dst, { recursive: true });
}

async function applyPythonPatches() {
  for (const [dstRel, replacements] of pythonPathPatches) {
    const filePath = path.join(outDir, dstRel);
    if (!(await exists(filePath))) {
      console.warn(`  [patch-skip] not found: ${dstRel}`);
      continue;
    }
    let content = await fs.readFile(filePath, 'utf-8');
    for (const [oldStr, newStr] of replacements) {
      if (!content.includes(oldStr)) {
        console.warn(`  [patch-warn] string not found in ${dstRel}: ${oldStr}`);
        continue;
      }
      content = content.replaceAll(oldStr, newStr);
    }
    await fs.writeFile(filePath, content, 'utf-8');
  }
}

async function writeStandaloneServerConfig() {
  // Written fresh so all paths are correct for the standalone layout.
  // All paths are relative to server/ (where py-demo-server.py lives).
  const config = {
    port: 7799,
    serverMetaStoreRef: 'b64:eyJraW5kIjoiZnMtcGF0aCIsInZhbHVlIjoiLi8uc2VydmVyLW1ldGEifQ',
    cardsDir: '../data/cards',
    gandalfCardsDir: '../data/gandalf-cards',
    taskExecutorPath: './handlers/demo-task-executor.py',
    chatHandlerPath: './handlers/demo-chat-handler.py',
    chatSessionsDir: '',
    gandalfTaskExecutorPath: './handlers/demo-task-executor.py',
    gandalfChatHandlerPath: './handlers/demo-chat-handler.py',
  };
  const dst = path.join(outDir, 'examples/pyboard/server/demo-server-config.json');
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.writeFile(dst, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

async function writeReadme() {
  const readme = [
    '# yaml-flow standalone',
    '',
    'Standalone Python distribution generated by `npm run standalone`.',
    '',
    '## Layout',
    '',
    '```',
    'core/pylib/        — pure engine library (step-machine, event-graph, etc.)',
    'core/cli/          — CLI entrypoints (board_live_cards_pycli, step_machine_pycli, ...)',
    'core/adapters/     — platform adapters (FS, HTTP, native bridge)',
    'core/server/       — platform-free board server runtime',
    'browser/           — HTML shells for the live-cards board UI',
    'examples/pyboard/         — Python demo board (self-contained)',
    '  server/              — py-demo-server.py + demo-server-config.json',
    '  server/handlers/     — task-executor, chat-handler, flows, source-def-handlers',
    '  data/                — card definitions (cards/ + gandalf-cards/)',
    '',
    '  (deprecated: examples/demo-board/ renamed to examples/pyboard/)',
    '',
    'examples/portfolio-tracker/ — step-machine portfolio-tracker example',
    'requirements.txt   — Python dependencies',
    '```',
    '',
    '## Requirements',
    '',
    '- **Python 3.9+**',
    '',
    '## Setup',
    '',
    '1. Create and activate a virtual environment:',
    '   ```',
    '   python -m venv .venv',
    '   .venv\\Scripts\\activate              # Windows',
    '   source .venv/bin/activate           # macOS/Linux',
    '   ```',
    '2. Install dependencies:',
    '   ```',
    '   python -m pip install -r requirements.txt',
    '   ```',
    '',
    '## Usage',
    '',
    'Run from this directory root:',
    '',
    '- `python core/cli/board_live_cards_pycli.py --help`',
    '- `python core/cli/step_machine_pycli.py --help`',
    '',
    '### Examples',
    '',
    '- Python demo board server:',
    '  `python examples/pyboard/server/py-demo-server.py`',
    '- Portfolio tracker:',
    '  `python examples/portfolio-tracker/portfolio-tracker.py`',
  ].join('\n');

  await fs.writeFile(path.join(outDir, 'README-STANDALONE.md'), readme, 'utf-8');
}

async function walkFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkFiles(p);
      out.push(...nested);
    } else {
      out.push(p);
    }
  }
  return out;
}

async function minifyStandaloneJs() {
  const staticTargets = [];

  const distRoot = path.join(outDir, 'dist');
  const distFiles = (await exists(distRoot)) ? await walkFiles(distRoot) : [];
  const distTargets = distFiles.filter(p => p.endsWith('.js') || p.endsWith('.cjs'));
  const mapFiles = distFiles.filter(p => p.endsWith('.map'));

  const allTargets = [...staticTargets, ...distTargets];

  for (const filePath of allTargets) {
    if (!(await exists(filePath))) continue;
    const source = await fs.readFile(filePath, 'utf-8');
    const lines = source.split('\n');
    const shebang = lines[0].startsWith('#!') ? lines[0] : '';
    const body = shebang ? lines.slice(1).join('\n') : source;

    const result = await transform(body, {
      loader: 'js',
      minify: true,
      legalComments: 'none',
      target: 'es2022',
    });

    const output = shebang ? `${shebang}\n${result.code}` : result.code;
    await fs.writeFile(filePath, output, 'utf-8');
  }

  for (const mapFile of mapFiles) {
    await fs.rm(mapFile, { force: true });
  }
}

async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  for (const [srcRel, dstRel] of copyMap) {
    await copyAs(srcRel, dstRel);
  }

  await writeStandaloneServerConfig();
  await applyPythonPatches();

  if (shouldMinifyJs) {
    await minifyStandaloneJs();
  }

  await writeReadme();

  console.log(`standalone generated at: ${outDir}${shouldMinifyJs ? ' (js minified)' : ''}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
