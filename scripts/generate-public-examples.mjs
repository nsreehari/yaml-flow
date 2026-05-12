import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function collectHtmlFiles(dir) {
  const entries = await readdir(dir);
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      files.push(...(await collectHtmlFiles(fullPath)));
      continue;
    }
    if (entry.toLowerCase().endsWith('.html')) {
      files.push(fullPath);
    }
  }

  return files;
}

function rewriteBrowserScriptsToJsDelivr(html, packageName, packageVersion) {
  const cdnBase = `https://cdn.jsdelivr.net/npm/${packageName}@${packageVersion}/browser/`;
  const browserScriptPattern = /(src\s*=\s*["'])\.\.\/\.\.\/browser\/([^"']+\.js)(["'])/g;
  return html.replace(browserScriptPattern, (_m, before, fileName, after) => `${before}${cdnBase}${fileName}${after}`);
}

async function main() {
  const repoRoot = process.cwd();
  const srcDir = path.join(repoRoot, 'public-examples');
  const outDir = path.join(repoRoot, 'examples');
  const packageJsonPath = path.join(repoRoot, 'package.json');

  const pkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const packageName = pkg.name;
  const packageVersion = pkg.version;

  await mkdir(outDir, { recursive: true });

  const sourceEntries = await readdir(srcDir);
  const generatedRoots = [];
  for (const entry of sourceEntries) {
    const srcEntryPath = path.join(srcDir, entry);
    const outEntryPath = path.join(outDir, entry);
    await rm(outEntryPath, { recursive: true, force: true });
    await cp(srcEntryPath, outEntryPath, { recursive: true, force: true });
    generatedRoots.push(outEntryPath);
  }

  const htmlFiles = [];
  for (const root of generatedRoots) {
    htmlFiles.push(...(await collectHtmlFiles(root)));
  }
  let rewrittenCount = 0;

  for (const htmlPath of htmlFiles) {
    const original = await readFile(htmlPath, 'utf8');
    const rewritten = rewriteBrowserScriptsToJsDelivr(original, packageName, packageVersion);
    if (rewritten !== original) {
      await writeFile(htmlPath, rewritten, 'utf8');
      rewrittenCount += 1;
    }
  }

  console.log(`Generated public examples from public-examples to examples`);
  console.log(`Rewrote browser script URLs in ${rewrittenCount}/${htmlFiles.length} HTML files to jsDelivr @${packageVersion}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
