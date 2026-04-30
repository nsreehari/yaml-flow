/**
 * fs-adapter — all Node.js filesystem operations used by board-live-cards in one place.
 *
 * Every call to fs.*, path.*, os.tmpdir() across all board-live-cards-* files
 * is expressed here as a named function. No other board-live-cards file should
 * import fs/path/os directly — they should import from here instead.
 *
 * This is the ONLY file that needs swapping when the storage backend changes
 * (e.g. Azure Blob, CosmosDB, browser localStorage, Python pycli).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

// ============================================================================
// Path utilities
// ============================================================================

export function joinPath(...parts: string[]): string {
  return path.join(...parts);
}

export function resolvePath(...parts: string[]): string {
  return path.resolve(...parts);
}

export function dirName(p: string): string {
  return path.dirname(p);
}

export function baseName(p: string): string {
  return path.basename(p);
}

export function relativePath(from: string, to: string): string {
  return path.relative(from, to);
}

export function tmpPath(prefix: string, ext = '.json'): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}${ext}`);
}

export function tmpPathUnique(prefix: string, ext = '.json'): string {
  return path.join(os.tmpdir(), `${prefix}-${randomUUID()}${ext}`);
}

// ============================================================================
// Existence / directory
// ============================================================================

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

// ============================================================================
// Read
// ============================================================================

export function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export function readJsonFile<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

export function readJsonFileOrNull<T = unknown>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T; }
  catch { return null; }
}

export function readTextFileOrNull(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

// ============================================================================
// Write
// ============================================================================

export function writeTextFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function writeJsonFile(filePath: string, payload: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

export function writeJsonAtomic(filePath: string, payload: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp.' + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

export function appendTextFile(filePath: string, content: string): void {
  fs.appendFileSync(filePath, content, 'utf-8');
}

// ============================================================================
// Delete / move
// ============================================================================

export function deleteFile(filePath: string): void {
  fs.unlinkSync(filePath);
}

export function deleteFileSilent(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
}

export function moveFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
}

// ============================================================================
// Glob / directory listing
// ============================================================================

export function listJsonFilesRecursive(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const results: string[] = [];
  function walk(d: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) results.push(full);
    }
  }
  walk(dirPath);
  return results.sort();
}
