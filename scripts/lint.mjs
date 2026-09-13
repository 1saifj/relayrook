#!/usr/bin/env node
/**
 * Zero-dependency formatting and hygiene check.
 *
 * Formatting: LF endings, no trailing whitespace, no hard tabs, a final
 * newline, and a 130-column ceiling on source files. Prose and data files are
 * exempt from the column limit: Markdown reflows, and wrapping JSON string
 * values would change their content.
 *
 * Hygiene: no absolute home-directory paths, account identifiers, tokens or
 * private configuration anywhere in the distributable tree — the packaging
 * requirement that a published skill carry nothing machine-specific.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_LINE = 130;

const SKIP_DIRS = new Set(['node_modules', '.git', 'assets', '.relayrook', 'coverage', 'tmp', '.claude']);
const TEXT_EXTENSIONS = new Set(['.mjs', '.js', '.json', '.md', '.yaml', '.yml', '.ts']);
const LINE_LIMIT_EXTENSIONS = new Set(['.mjs', '.js', '.ts']);

/** Secret-shaped patterns that must never appear in a distributable file. */
const FORBIDDEN = [
  { name: 'absolute home path', re: /\/(?:Users|home)\/[A-Za-z0-9._-]+\// },
  { name: 'bearer token', re: /\b(?:sk|pk|ghp|gho|github_pat)_[A-Za-z0-9]{16,}/ },
  { name: 'authorization header', re: /authorization\s*:\s*["']?bearer\s+\S/i },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
];

/** Files exempt from the e-mail rule because they are research records, not distributables. */
const ALLOW_EMAIL_IN = new Set(['docs/research.md', 'docs/compatibility.md', 'docs/inventory.json']);

/** @param {string} dir @param {string[]} [acc] */
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.gitignore') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name)) || entry.name === '.gitignore') acc.push(full);
  }
  return acc;
}

const problems = [];
const files = walk(repoRoot).sort();

for (const file of files) {
  const rel = path.relative(repoRoot, file);
  if (statSync(file).size > 2 * 1024 * 1024) continue;
  const raw = readFileSync(file, 'utf8');
  const enforceLineLimit = LINE_LIMIT_EXTENSIONS.has(path.extname(file));

  if (raw.includes('\r\n')) problems.push(`${rel}: CRLF line endings`);
  if (raw.length > 0 && !raw.endsWith('\n')) problems.push(`${rel}: missing final newline`);

  const lines = raw.split('\n');
  lines.forEach((line, index) => {
    const n = index + 1;
    if (/[ \t]+$/.test(line)) problems.push(`${rel}:${n}: trailing whitespace`);
    if (line.includes('\t')) problems.push(`${rel}:${n}: hard tab`);
    if (enforceLineLimit && line.length > MAX_LINE) {
      problems.push(`${rel}:${n}: line is ${line.length} chars (max ${MAX_LINE})`);
    }
    for (const rule of FORBIDDEN) {
      if (rule.re.test(line)) problems.push(`${rel}:${n}: forbidden content (${rule.name})`);
    }
    if (!ALLOW_EMAIL_IN.has(rel) && /[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(line)) {
      problems.push(`${rel}:${n}: e-mail address in a distributable file`);
    }
  });
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n\n${problems.length} problem(s)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`lint: ${files.length} files clean\n`);
}
