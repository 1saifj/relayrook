import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  defaultPermissionMode,
  isUngated,
  normalizePermissionMode,
  PERMISSION_MODES,
  resolvePermissionPosture,
} from '../src/permissions.mjs';
import { sessionKey } from '../src/util.mjs';

/**
 * Permission posture mapping.
 *
 * The contract is not "a mode exists" but "the mode is carried by something,
 * and RelayRook says which something". A caller deciding whether to let a
 * delegated agent write reads `enforcement`, so a wrong claim here is the one
 * that matters.
 */

test('every backend maps every mode to a named mechanism and honest enforcement', () => {
  for (const backend of ['devin', 'kiro', 'opencode', 'claude', 'codex']) {
    for (const mode of PERMISSION_MODES) {
      const posture = resolvePermissionPosture({ backend, mode });
      assert.equal(posture.mode, mode, `${backend}/${mode} keeps the requested mode`);
      assert.ok(posture.mechanism && posture.mechanism !== 'none', `${backend} names its mechanism`);
      assert.ok(
        ['backend-sandbox', 'parent-gated', 'prompt-only'].includes(posture.enforcement),
        `${backend}/${mode} reports a known enforcement`,
      );
      assert.ok(posture.note.length > 0, `${backend}/${mode} explains itself`);
    }
  }
});

test('full-auto never claims the parent still sees requests', () => {
  for (const backend of ['devin', 'kiro', 'opencode', 'claude', 'codex']) {
    const posture = resolvePermissionPosture({ backend, mode: 'full-auto' });
    assert.equal(posture.enforcement, 'prompt-only', `${backend} full-auto is unguarded`);
  }
});

test('read-only uses the backend lever where one exists', () => {
  assert.deepEqual(resolvePermissionPosture({ backend: 'devin', mode: 'read-only' }).args, [
    '--agent-type',
    'review',
  ]);
  assert.equal(resolvePermissionPosture({ backend: 'devin', mode: 'read-only' }).enforcement, 'backend-sandbox');
  assert.deepEqual(resolvePermissionPosture({ backend: 'codex', mode: 'read-only' }).codex, {
    sandbox: 'read-only',
    approvalPolicy: 'never',
  });
  assert.equal(resolvePermissionPosture({ backend: 'claude', mode: 'read-only' }).env.ACP_PERMISSION_MODE, 'plan');
  // Kiro has no read-only agent over ACP, so the honest claim is the parent gate.
  assert.equal(resolvePermissionPosture({ backend: 'kiro', mode: 'read-only' }).enforcement, 'parent-gated');
});

test('kiro reports auto-edits as unsupported instead of pretending', () => {
  const posture = resolvePermissionPosture({ backend: 'kiro', mode: 'auto-edits' });
  assert.equal(posture.requestedUnsupported, true);
  assert.equal(posture.enforcement, 'parent-gated');
  assert.deepEqual(posture.args, []);
});

test('opencode postures are written as a config file the CLI actually reads', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relayrook-perm-'));
  try {
    const posture = resolvePermissionPosture({ backend: 'opencode', mode: 'read-only', sessionDir: dir });
    assert.ok(posture.configFile, 'a config file is produced');
    assert.equal(posture.env.OPENCODE_CONFIG, posture.configFile.path);
    assert.equal(path.dirname(posture.configFile.path), dir);
    const parsed = JSON.parse(posture.configFile.contents);
    assert.deepEqual(parsed.permission, { edit: 'deny', bash: 'ask', webfetch: 'deny' });
    assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a caller pin on the Codex sandbox overrides the mapping and says so', () => {
  const posture = resolvePermissionPosture({
    backend: 'codex',
    mode: 'read-only',
    codexOverrides: { sandbox: 'workspace-write' },
  });
  assert.equal(posture.codex.sandbox, 'workspace-write');
  assert.equal(posture.enforcement, 'parent-gated');
  assert.match(posture.note, /caller pinned/);
});

test('review roles default to read-only and implementation to gated', () => {
  assert.equal(defaultPermissionMode({ role: 'code-review' }), 'read-only');
  assert.equal(defaultPermissionMode({ role: 'security-review' }), 'read-only');
  assert.equal(defaultPermissionMode({ role: 'implementation' }), 'gated');
  assert.equal(defaultPermissionMode({ profile: 'read-only' }), 'read-only');
  assert.equal(defaultPermissionMode({}), 'gated');
});

test('an unknown mode is a usage error, not a silent downgrade', () => {
  assert.throws(() => normalizePermissionMode('yolo'), (/** @type {any} */ err) => err.code === 'usage');
  assert.equal(normalizePermissionMode(undefined), null);
  assert.equal(isUngated('auto-edits'), true);
  assert.equal(isUngated('gated'), false);
});

test('posture is part of session identity so a warm worker is never widened', () => {
  const base = { backend: 'devin', workspace: process.cwd(), model: 'swe-2-max', profile: 'default' };
  assert.notEqual(
    sessionKey({ ...base, permissionMode: 'gated' }),
    sessionKey({ ...base, permissionMode: 'full-auto' }),
  );
});

test('an unknown backend is reported as unenforced rather than assumed safe', () => {
  const posture = resolvePermissionPosture({ backend: 'not-a-backend', mode: 'read-only' });
  assert.equal(posture.enforcement, 'prompt-only');
  assert.equal(posture.mechanism, 'none');
});

/**
 * The mapping is only worth anything if the flags and environment reach the
 * process. This starts a real worker against the stub and asks the stub what
 * it was launched with.
 */
test('the posture reaches the spawned backend', async (t) => {
  const { startSession, promptSession, waitSession, stopSession } = await import('../src/sessions.mjs');
  const { fileURLToPath } = await import('node:url');
  const stub = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'relayrook-perm-e2e-'));
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'relayrook-perm-ws-'));
  process.env.RELAYROOK_BACKEND_CMD_DEVIN = JSON.stringify([process.execPath, stub]);
  process.env.FAKE_ACP_MODEL = 'swe-2-max';
  t.after(async () => {
    delete process.env.RELAYROOK_BACKEND_CMD_DEVIN;
    delete process.env.FAKE_ACP_MODEL;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const started = await startSession({
    stateDir,
    backend: 'devin',
    workspace,
    role: 'code-review',
    startTimeoutMs: 60000,
  });
  assert.equal(started.meta.permissions.mode, 'read-only');
  assert.equal(started.meta.permissions.enforcement, 'backend-sandbox');

  await promptSession({ stateDir, key: started.key, text: 'LAUNCH_REPORT', timeoutMs: 30000 });
  const finished = await waitSession({ stateDir, key: started.key, timeoutMs: 30000, stopOnStall: false });
  const report = JSON.parse(finished.answer.trim());
  assert.ok(
    report.argv.join(' ').includes('--agent-type review'),
    `read-only launches the review agent, got: ${report.argv.join(' ')}`,
  );
  assert.equal(report.env.DEVIN_PERMISSION_MODE, 'auto');
  await stopSession({ stateDir, key: started.key });
});

test('a review role cannot be started ungated', async () => {
  const { startSession } = await import('../src/sessions.mjs');
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'relayrook-perm-guard-'));
  try {
    await assert.rejects(
      () =>
        startSession({
          stateDir,
          backend: 'devin',
          workspace: stateDir,
          role: 'code-review',
          permissionMode: 'full-auto',
        }),
      (/** @type {any} */ err) => err.code === 'role_posture_mismatch',
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
