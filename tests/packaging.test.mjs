import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(repoRoot, 'src');
const skillDir = path.join(repoRoot, 'skills', 'relayrook');
const libDir = path.join(skillDir, 'scripts', 'lib');

/** @param {string} dir @param {string} [prefix] @returns {string[]} */
function listFiles(dir, prefix = '') {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
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

/** @param {string} command @param {string[]} args @param {{cwd?: string, env?: any, timeout?: number}} [options] */
function run(command, args, options = {}) {
  // Delegation metadata from the invoking environment must not leak into a
  // spawned CLI: it is signed against this machine's own state dir, so an
  // inherited copy is correctly rejected as foreign. Tests get a clean slate.
  const env = options.env ?? process.env;
  const clean = { ...env };
  delete clean.RELAYROOK_ROUTE;
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, env: clean, timeout: options.timeout ?? 60000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

test('the packaged skill carries a current copy of the runtime', () => {
  const sources = listFiles(srcDir);
  assert.ok(sources.length > 0);

  for (const rel of sources) {
    const copied = path.join(libDir, rel);
    assert.ok(existsSync(copied), `skills/relayrook/scripts/lib/${rel} is missing — run npm run build`);
    assert.equal(hashFile(copied), hashFile(path.join(srcDir, rel)), `${rel} has drifted — run npm run build`);
  }

  const copies = listFiles(libDir);
  assert.deepEqual(copies, sources, 'the skill copy must match src/ exactly');

  const manifest = JSON.parse(readFileSync(path.join(skillDir, 'scripts', 'lib.manifest.json'), 'utf8'));
  assert.equal(manifest.fileCount, sources.length);
  for (const rel of sources) {
    assert.equal(manifest.files[rel], hashFile(path.join(srcDir, rel)), `manifest entry for ${rel} is stale`);
  }
});

test('the skill subtree has no imports that reach outside itself', () => {
  for (const rel of listFiles(skillDir)) {
    if (!rel.endsWith('.mjs')) continue;
    const text = readFileSync(path.join(skillDir, rel), 'utf8');
    const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      assert.ok(
        !specifier.startsWith('../..') && !specifier.includes('/src/'),
        `${rel} imports ${specifier}, which escapes the skill directory`,
      );
    }
  }
});

test('the skill subtree contains no machine-specific or sensitive values', () => {
  const forbidden = [
    { name: 'absolute home path', re: /\/(?:Users|home)\/[A-Za-z0-9._-]+\// },
    { name: 'e-mail address', re: /[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
    { name: 'token', re: /\b(?:sk|pk|ghp|gho|github_pat)_[A-Za-z0-9]{16,}/ },
    { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  ];
  for (const rel of listFiles(skillDir)) {
    if (statSync(path.join(skillDir, rel)).size > 1024 * 1024) continue;
    const text = readFileSync(path.join(skillDir, rel), 'utf8');
    for (const rule of forbidden) {
      assert.ok(!rule.re.test(text), `${rel} contains a ${rule.name}`);
    }
  }
});

test('SKILL.md carries the frontmatter a host needs to discover it', () => {
  const text = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.ok(text.startsWith('---\n'), 'SKILL.md must open with YAML frontmatter');
  const frontmatter = text.slice(4, text.indexOf('\n---', 4));
  assert.match(frontmatter, /^name: relayrook$/m);
  assert.match(frontmatter, /^description: .{40,}/m);
  // Discovery guidance: when to use it and when not to.
  assert.match(text, /Do not use/);
  assert.match(text, /Codex/);
  // The entrypoint path is relative to SKILL.md itself — no $SKILL_DIR env var.
  assert.doesNotMatch(text, /\$SKILL_DIR/);
  assert.match(text, /scripts\/relayrook\.mjs/);
});

test('a copied skill directory runs its entrypoint with no repository checkout', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'relayrook-pkg-'));
  try {
    const installed = path.join(tmp, 'Relay Rook Skills', 'relayrook');
    cpSync(skillDir, installed, { recursive: true });

    // Nothing from the development checkout is reachable from the copy.
    assert.ok(!existsSync(path.join(tmp, 'src')));
    assert.ok(!existsSync(path.join(tmp, 'package.json')));
    assert.ok(!existsSync(path.join(tmp, 'node_modules')));

    const entry = path.join(installed, 'scripts', 'relayrook.mjs');
    const stateDir = path.join(tmp, 'state');

    const version = await run(process.execPath, [entry, 'version']);
    assert.equal(version.code, 0, version.stderr);
    // Compared with package.json, not a literal: a release bump should not
    // have to touch a test that is about the copy being runnable.
    const declared = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
    assert.equal(JSON.parse(version.stdout).version, declared);

    const doctor = await run(process.execPath, [entry, 'doctor', '--caller', 'codex', '--state-dir', stateDir]);
    assert.equal(doctor.code, 0, doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.caller.immediateParent, 'codex');
    assert.equal(report.backends.length, 5);

    const routed = await run(process.execPath, [
      entry,
      'prompt-preview',
      '--role',
      'security-review',
      '--task',
      'Review the auth module',
      '--workspace',
      tmp,
    ]);
    assert.equal(routed.code, 0, routed.stderr);
    assert.match(JSON.parse(routed.stdout).prompt, /safeVerification/);

    const workspace = path.join(tmp, 'workspace');
    mkdirSync(workspace);
    const fixture = path.join(repoRoot, 'tests', 'fixtures', 'fake-acp-agent.mjs');
    const env = {
      ...process.env,
      RELAYROOK_BACKEND_CMD_DEVIN: JSON.stringify([process.execPath, fixture]),
      FAKE_ACP_METADATA: 'configOptions',
      FAKE_ACP_MODEL: 'swe-2-max',
    };
    const started = await run(process.execPath, [
      entry, 'start', '--backend', 'devin', '--caller', 'codex', '--workspace', workspace,
      '--state-dir', stateDir, '--start-timeout', '10000',
    ], { env });
    assert.equal(started.code, 0, started.stderr);
    const session = JSON.parse(started.stdout).session;
    const prompted = await run(process.execPath, [
      entry, 'prompt', '--session', session, '--text', 'PACKAGED_SPACE_PATH', '--state-dir', stateDir,
    ], { env });
    assert.equal(prompted.code, 0, prompted.stderr);
    const waited = await run(process.execPath, [
      entry, 'wait', '--session', session, '--timeout', '10000', '--state-dir', stateDir,
    ], { env });
    assert.equal(waited.code, 0, waited.stderr);
    assert.equal(JSON.parse(waited.stdout).turn.state, 'completed');
    const stopped = await run(process.execPath, [entry, 'stop', '--session', session, '--state-dir', stateDir], { env });
    assert.equal(stopped.code, 0, stopped.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the development bin and the packaged entrypoint agree', async () => {
  const viaBin = await run(process.execPath, [path.join(repoRoot, 'bin', 'relayrook.js'), 'version']);
  const viaSkill = await run(process.execPath, [path.join(skillDir, 'scripts', 'relayrook.mjs'), 'version']);
  assert.equal(viaBin.code, 0, viaBin.stderr);
  assert.equal(viaSkill.code, 0, viaSkill.stderr);
  assert.deepEqual(JSON.parse(viaBin.stdout), JSON.parse(viaSkill.stdout));
});

test('the runtime declares no production dependencies', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {});
  assert.equal(pkg.type, 'module');
  assert.match(pkg.engines.node, /22\.13/);
});

test('an unknown command fails with a typed error and a non-zero exit code', async () => {
  const result = await run(process.execPath, [path.join(repoRoot, 'bin', 'relayrook.js'), 'teleport']);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'unknown_command');
  assert.ok(parsed.error.details.known.includes('doctor'));
});

test('a missing command also fails with the JSON error contract', async () => {
  const result = await run(process.execPath, [path.join(repoRoot, 'bin', 'relayrook.js')]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.error.code, 'usage');
});
