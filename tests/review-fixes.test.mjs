import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { cleanupSessions, resolveLaunchCommand, startSession } from '../src/sessions.mjs';
import { assertPrivateSocketDir, SessionStore } from '../src/state.mjs';
import { checkTransport } from '../src/preflight.mjs';
import { pidAlive, IS_WINDOWS, processIdentity } from '../src/platform.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

/**
 * Regressions from the independent read-only review. Each test names the
 * defect it pins down so a future refactor cannot quietly reintroduce it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'relayrook.js');
const EVALS = path.join(ROOT, 'evals', 'run.mjs');
const execFileP = promisify(execFile);

const ctx = { stateDir: '', workspace: '' };
test.before(() => {
  ctx.stateDir = mkdtempSync(path.join(os.tmpdir(), 'relayrook-rf-state-'));
  ctx.workspace = mkdtempSync(path.join(os.tmpdir(), 'relayrook-rf-ws-'));
});
test.after(() => {
  rmSync(ctx.stateDir, { recursive: true, force: true });
  rmSync(ctx.workspace, { recursive: true, force: true });
});

/** A pid that is guaranteed dead: a child that already exited. */
function deadPid() {
  const res = spawnSync(process.execPath, ['-e', '0']);
  return res.pid;
}

// F1 — `start` must await preflight: a missing backend surfaces as the typed
// preflight blocker, not a worker_start_failed from spawning the void.
test('start rejects with the preflight blocker when the backend is missing', async () => {
  const missing = JSON.stringify([path.join(ctx.stateDir, 'no-such-codex-bin')]);
  process.env.RELAYROOK_BACKEND_CMD_CODEX = missing;
  try {
    await assert.rejects(
      startSession({
        stateDir: ctx.stateDir,
        backend: 'codex',
        workspace: ctx.workspace,
        startTimeoutMs: 15000,
      }),
      (/** @type {any} */ err) => err.code === ERROR_CODES.backend_not_installed && err.details?.check === 'backend',
    );
  } finally {
    delete process.env.RELAYROOK_BACKEND_CMD_CODEX;
  }
});

// F2 — launch commands resolve through PATH so the spawned argv carries the
// real executable path (on Windows that is what lets spawnCommand route .cmd
// through cmd.exe).
test('resolveLaunchCommand returns the resolved executable path', () => {
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'relayrook-rf-bin-'));
  try {
    const exe = path.join(binDir, IS_WINDOWS ? 'relayrook-fake.cmd' : 'relayrook-fake');
    writeFileSync(exe, IS_WINDOWS ? '@echo off\r\n' : '#!/bin/sh\n');
    chmodSync(exe, 0o755);
    const launch = resolveLaunchCommand(
      { id: 'fake', command: 'relayrook-fake', adapter: null },
      ctx.stateDir,
      null,
      { PATH: binDir, PATHEXT: '.CMD;.BAT;.EXE' },
    );
    assert.equal(launch.command, exe);
    assert.ok(path.isAbsolute(launch.command));
    assert.deepEqual(launch.extraArgs, []);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

// F3 — `preflight` is a report, not a verdict: top-level `ok` means the report
// was produced, `passed` carries the capability verdict, exit code stays 0.
test('preflight exits 0 with ok:true and passed:false when a backend is missing', async () => {
  const missing = JSON.stringify([path.join(ctx.stateDir, 'no-such-codex-bin')]);
  const { stdout } = await execFileP(
    process.execPath,
    [BIN, 'preflight', '--backend', 'codex', '--state-dir', ctx.stateDir],
    { env: { ...process.env, RELAYROOK_BACKEND_CMD_CODEX: missing } },
  );
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.command, 'preflight');
  assert.equal(out.passed, false);
  assert.ok(out.blockers.some((b) => b.code === ERROR_CODES.backend_not_installed));
});

test('preflight reports passed:true when every check succeeds', async () => {
  const stub = path.join(ROOT, 'tests', 'fixtures', 'fake-codex-app-server.mjs');
  const { stdout } = await execFileP(
    process.execPath,
    [BIN, 'preflight', '--backend', 'codex', '--state-dir', ctx.stateDir],
    { env: { ...process.env, RELAYROOK_BACKEND_CMD_CODEX: JSON.stringify([process.execPath, stub]) } },
  );
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.passed, true);
  assert.deepEqual(out.blockers, []);
});

// F6 — cleanup must not SIGKILL a live pid it cannot prove is the recorded
// backend; only a pid still carrying the backend's command name is reaped.
test('cleanup leaves a pid-reused process alone and reports it unverified', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
  await new Promise((r) => child.once('spawn', r));
  const key = 'rf-unverified';
  const store = new SessionStore(ctx.stateDir, key).ensure();
  store.writeMeta({
    schemaVersion: 2,
    key,
    backend: 'codex',
    status: 'ready',
    pid: deadPid(),
    backendPid: child.pid,
    backendCommand: '/opt/relayrook/some-other-binary',
  });
  try {
    const result = await cleanupSessions({ stateDir: ctx.stateDir });
    const entry = result.reaped.find((r) => r.key === key);
    assert.equal(entry.orphanBackendUnverified, true);
    assert.equal(entry.orphanBackendKilled, false);
    assert.equal(pidAlive(child.pid), true);
  } finally {
    child.kill('SIGKILL');
  }
});

test('cleanup kills an orphaned backend only when command and start marker match', async (t) => {
  if (IS_WINDOWS) return t.skip('process command identity check is exercised on CI windows');
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
  await new Promise((r) => child.once('spawn', r));
  const key = 'rf-verified';
  const store = new SessionStore(ctx.stateDir, key).ensure();
  const identity = await processIdentity(child.pid);
  assert.ok(identity);
  store.writeMeta({
    schemaVersion: 2,
    key,
    backend: 'codex',
    status: 'ready',
    pid: deadPid(),
    backendPid: child.pid,
    backendCommand: identity.command,
    backendProcessStartedAt: identity.startedAt,
  });
  const result = await cleanupSessions({ stateDir: ctx.stateDir });
  const entry = result.reaped.find((r) => r.key === key);
  assert.equal(entry.orphanBackendKilled, true);
  assert.equal(entry.orphanBackendUnverified, false);
  for (let i = 0; i < 20 && pidAlive(child.pid); i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(pidAlive(child.pid), false);
});

// F7 — eval defaults must use backend registry ids; an unknown id fails fast.
test('evals reject an unknown backend id instead of silently skipping', async () => {
  await assert.rejects(
    execFileP(process.execPath, [EVALS, '--backend', 'kiro-cli'], { env: process.env }),
    (/** @type {any} */ err) => err.code === 2 && /unknown backend id.*kiro-cli/.test(err.stderr),
  );
});

// F10 — the predictable shared-temp socket dir fails closed: a path that is
// not a private user-owned 0700 directory is a typed error, never trusted.
test('assertPrivateSocketDir rejects anything that is not a private directory', { skip: IS_WINDOWS }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relayrook-rf-priv-'));
  try {
    chmodSync(dir, 0o700);
    assert.doesNotThrow(() => assertPrivateSocketDir(dir));

    const file = path.join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    assert.throws(() => assertPrivateSocketDir(file), (/** @type {any} */ err) => err.code === ERROR_CODES.state_error);

    if (!IS_WINDOWS) {
      chmodSync(dir, 0o755);
      assert.throws(() => assertPrivateSocketDir(dir), (/** @type {any} */ err) => err.code === ERROR_CODES.state_error);
      chmodSync(dir, 0o700);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transport preflight repairs and accepts a same-user shared-temp fallback', async (t) => {
  if (IS_WINDOWS) return t.skip('unix-socket fallback does not apply on Windows');
  // Drop the shared dir to 0755 first: the probe must chmod it back to a
  // private mode and pass, not fail closed on same-user permissive leftovers.
  const shared = path.join(os.tmpdir(), `relayrook-${process.getuid()}`);
  if (existsSync(shared)) chmodSync(shared, 0o755);
  else mkdirSync(shared, { mode: 0o755, recursive: true });
  try {
    const deep = path.join(ctx.stateDir, 'nested', 'x'.repeat(120));
    mkdirSync(deep, { recursive: true });
    const result = await checkTransport(deep);
    assert.equal(result.ok, true);
    assert.equal(result.mechanism, 'unix-socket');
  } finally {
    chmodSync(shared, 0o700);
  }
});
