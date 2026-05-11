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
//   examples/demo-board/   ← demo-src/example-board/ python files + cards + flows + Python handlers
//   examples/portfolio-tracker/ ← merged portfolio-tracker examples (Python only)
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
  // browser shells (demo-shell-browser.html excluded — JS/browser-only)
  ['demo-src/example-board/demo-shell-with-server.html', 'browser/demo-shell-with-server.html'],
  ['demo-src/example-board/demo-shell.html',             'browser/demo-shell.html'],
  ['demo-src/example-board/demo-shell-localstorage.html','browser/demo-shell-localstorage.html'],
  ['demo-src/example-board/favicon.svg',                 'browser/favicon.svg'],
  // demo-board example (python files + data)
  ['demo-src/example-board/cards',            'examples/demo-board/cards'],
  ['demo-src/example-board/gandalf-cards',    'examples/demo-board/gandalf-cards'],
  ['demo-src/example-board/source-def-flows', 'examples/demo-board/source-def-flows'],
  ['demo-src/example-board/scripts/copilot_wrapper.bat',           'examples/demo-board/scripts/copilot_wrapper.bat'],
  ['demo-src/example-board/scripts/copilot_wrapper_helper.ps1',    'examples/demo-board/scripts/copilot_wrapper_helper.ps1'],
  ['demo-src/example-board/source_def_flows.json',           'examples/demo-board/source_def_flows.json'],
  ['demo-src/example-board/demo-server-config.json',         'examples/demo-board/demo-server-config.json'],
  ['demo-src/example-board/demo-task-executor.py',           'examples/demo-board/demo-task-executor.py'],
  ['demo-src/example-board/demo-chat-handler.py',            'examples/demo-board/demo-chat-handler.py'],
  ['demo-src/example-board/py-demo-server.py',               'examples/demo-board/py-demo-server.py'],
  // source-def Python handlers (JS handlers excluded from standalone)
  ['demo-src/example-board/source-def-handlers/http-source-handler.py',    'examples/demo-board/source-def-handlers/http-source-handler.py'],
  ['demo-src/example-board/source-def-handlers/copilot-source-handler.py', 'examples/demo-board/source-def-handlers/copilot-source-handler.py'],
  // portfolio-tracker example — Python only (no JS handlers)
  ['examples/browser/boards/portfolio-tracker/portfolio-tracker.py',            'examples/portfolio-tracker/portfolio-tracker.py'],
  ['examples/browser/boards/portfolio-tracker/portfolio-tracker-fetch-prices.py','examples/portfolio-tracker/portfolio-tracker-fetch-prices.py'],
  ['examples/cli/step-machine-cli/portfolio-tracker/portfolio-tracker.flow.yaml',        'examples/portfolio-tracker/portfolio-tracker.flow.yaml'],
  ['examples/cli/step-machine-cli/portfolio-tracker/portfolio-tracker-pycli.flow.yaml',  'examples/portfolio-tracker/portfolio-tracker-pycli.flow.yaml'],
  ['examples/cli/step-machine-cli/portfolio-tracker/portfolio-tracker.input.json',       'examples/portfolio-tracker/portfolio-tracker.input.json'],
  ['examples/cli/step-machine-cli/portfolio-tracker/run-portfolio-tracker-pycli.py',     'examples/portfolio-tracker/run-portfolio-tracker-pycli.py'],
  ['examples/cli/step-machine-cli/portfolio-tracker/inline-python-demo.flow.yaml',       'examples/portfolio-tracker/inline-python-demo.flow.yaml'],
  ['examples/cli/step-machine-cli/portfolio-tracker/inline-python-handlers.py',          'examples/portfolio-tracker/inline-python-handlers.py'],
  ['examples/cli/step-machine-cli/portfolio-tracker/run-inline-python-demo-pycli.py',    'examples/portfolio-tracker/run-inline-python-demo-pycli.py'],
  ['examples/cli/step-machine-cli/portfolio-tracker/handlers-py',                        'examples/portfolio-tracker/handlers'],
];

// Python path patches: [dstRel, [[oldStr, newStr], ...]]
// Applied to the copied file in standalone after all copies are done.
const pythonPathPatches = [
  ['examples/demo-board/demo-task-executor.py', [
    // _PYCLI_ROOT bootstrap: was ../../../pycli from demo-src/example-board/, now ../../core from examples/demo-board/
    ['os.path.normpath(os.path.join(_HERE, "..", "..", "pycli"))',
     'os.path.normpath(os.path.join(_HERE, "..", "..", "core"))'],
  ]],
  ['examples/demo-board/py-demo-server.py', [
    // _PYCLI_ROOT bootstrap
    ['os.path.normpath(os.path.join(__file_dir, "..", "..", "pycli"))',
     'os.path.normpath(os.path.join(__file_dir, "..", "..", "core"))'],
    // py-server-runtime subdir
    ['os.path.join(_PYCLI_ROOT, "py-server-runtime")',
     'os.path.join(_PYCLI_ROOT, "server")'],
    // sub → adapters
    ['os.path.join(_PYCLI_ROOT, "sub")',
     'os.path.join(_PYCLI_ROOT, "adapters")'],
    // main → cli
    ['os.path.join(_PYCLI_ROOT, "main", "board_live_cards_pycli.py")',
     'os.path.join(_PYCLI_ROOT, "cli", "board_live_cards_pycli.py")'],
  ]],
  // Patch flow JSONs: replace JS handler refs with Python equivalents
  ['examples/demo-board/source-def-flows/url.flow.json', [
    ['./source-def-handlers/http-source-handler.js', './source-def-handlers/http-source-handler.py'],
  ]],
  ['examples/demo-board/source-def-flows/url-list.flow.json', [
    ['./source-def-handlers/http-source-handler.js', './source-def-handlers/http-source-handler.py'],
  ]],
  ['examples/demo-board/source-def-flows/copilot.flow.json', [
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
    'examples/demo-board/      — full Python demo board (server + task executor + cards)',
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
    '  `python examples/demo-board/py-demo-server.py`',
    '- Portfolio-tracker (pure Python handlers):',
    '  `python examples/portfolio-tracker/run-portfolio-tracker-pycli.py`',
    '- Portfolio-tracker inline-Python demo:',
    '  `python examples/portfolio-tracker/run-inline-python-demo-pycli.py`',
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
