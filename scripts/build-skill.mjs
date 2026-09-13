#!/usr/bin/env node
/**
 * Copy the runtime into the distributable skill subtree.
 *
 * `skills/relayrook/scripts/lib/` is a byte-for-byte copy of `src/`, so an
 * installed skill directory runs without the development checkout, and
 * `tests/packaging.test.mjs` fails the build if the copy drifts.
 *
 * Usage:
 *   node scripts/build-skill.mjs          # write the copy
 *   node scripts/build-skill.mjs --check  # verify the copy is current
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(repoRoot, 'src');
const outDir = path.join(repoRoot, 'skills', 'relayrook', 'scripts', 'lib');
const manifestFile = path.join(repoRoot, 'skills', 'relayrook', 'scripts', 'lib.manifest.json');

/** @param {string} dir @param {string} [prefix] @returns {string[]} */
function listFiles(dir, prefix = '') {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), rel));
    else files.push(rel);
  }
  return files;
}

/** @param {string} file */
function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function buildManifest() {
  const files = listFiles(srcDir);
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const rel of files) hashes[rel] = hashFile(path.join(srcDir, rel));
  return { generatedFrom: 'src/', fileCount: files.length, files: hashes };
}

const check = process.argv.includes('--check');
const manifest = buildManifest();

if (check) {
  const problems = [];
  if (!existsSync(manifestFile)) problems.push('skills/relayrook/scripts/lib.manifest.json is missing');
  else {
    const stored = JSON.parse(readFileSync(manifestFile, 'utf8'));
    for (const [rel, hash] of Object.entries(manifest.files)) {
      if (stored.files?.[rel] !== hash) problems.push(`stale copy: ${rel}`);
    }
    for (const rel of Object.keys(stored.files ?? {})) {
      if (!Object.hasOwn(manifest.files, rel)) problems.push(`removed from src but still listed: ${rel}`);
    }
  }
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const copied = path.join(outDir, rel);
    if (!existsSync(copied)) problems.push(`missing in skill copy: ${rel}`);
    else if (hashFile(copied) !== hash) problems.push(`content differs in skill copy: ${rel}`);
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\nRun: npm run build\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`skill copy is current (${manifest.fileCount} files)\n`);
  }
} else {
  rmSync(outDir, { recursive: true, force: true });
  for (const rel of Object.keys(manifest.files)) {
    const from = path.join(srcDir, rel);
    const to = path.join(outDir, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
  }
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const bytes = Object.keys(manifest.files).reduce((sum, rel) => sum + statSync(path.join(outDir, rel)).size, 0);
  process.stdout.write(`copied ${manifest.fileCount} files (${bytes} bytes) into skills/relayrook/scripts/lib\n`);
}
