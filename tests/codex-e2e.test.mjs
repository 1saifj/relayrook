import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  answerPermission,
  cancelSession,
  promptSession,
  reviewSession,
  startSession,
  statusSession,
  steerSession,
  stopSession,
  waitSession,
} from '../src/sessions.mjs';
import { SessionStore } from '../src/state.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

/**
 * Full Codex app-server lifecycle against a deterministic stub.
 *
 * The stub speaks the real `codex app-server --stdio` wire protocol, so
 * thread/start, turn/start, turn/steer, turn/interrupt, review/start,
 * approvals, model/effort readback and thread/resume are all exercised end to
 * end without a paid model call.
 */

const stubPath = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const STUB_ARGV = JSON.stringify([process.execPath, stubPath]);
const BIN = fileURLToPath(new URL('../bin/relayrook.js', import.meta.url));
const execFileP = promisify(execFile);

/** @type {{stateDir: string, workspace: string, key: string|null}} */
const ctx = { stateDir: '', workspace: '', key: null };

test.before(() => {
  ctx.stateDir = mkdtempSync(path.join(os.tmpdir(), 'relayrook-codex-state-'));
  ctx.workspace = mkdtempSync(path.join(os.tmpdir(), 'relayrook-codex-ws-'));
  process.env.RELAYROOK_BACKEND_CMD_CODEX = STUB_ARGV;
  process.env.FAKE_CODEX_MODEL = 'fake-codex-1';
  process.env.FAKE_CODEX_EFFORT = 'high';
  process.env.FAKE_CODEX_STORE = path.join(ctx.stateDir, 'fake-codex-threads.json');
});

test.after(async () => {
  if (ctx.key) {
    try {
      await stopSession({ stateDir: ctx.stateDir, key: ctx.key });
    } catch {
      // Already stopped.
    }
  }
  delete process.env.RELAYROOK_BACKEND_CMD_CODEX;
  delete process.env.FAKE_CODEX_MODEL;
  delete process.env.FAKE_CODEX_EFFORT;
  delete process.env.FAKE_CODEX_LEGACY;
  delete process.env.FAKE_CODEX_REJECT_MODEL;
  delete process.env.FAKE_CODEX_STORE;
  rmSync(ctx.stateDir, { recursive: true, force: true });
  rmSync(ctx.workspace, { recursive: true, force: true });
});

test('start launches a codex app-server thread and reads model and effort back', async () => {
  const started = await startSession({
    stateDir: ctx.stateDir,
    backend: 'codex',
    workspace: ctx.workspace,
    model: 'fake-codex-1',
    effort: 'high',
    startTimeoutMs: 60000,
  });
  ctx.key = started.key;

  assert.equal(started.reused, false);
  assert.equal(started.meta.status, 'ready');
  assert.equal(started.meta.backend, 'codex');
  assert.equal(started.meta.sessionId, 'thr-1');
  assert.deepEqual(started.meta.model, {
    requested: 'fake-codex-1',
    observed: 'fake-codex-1',
    source: 'pin',
    verified: true,
  });
  assert.equal(started.meta.effort.requested, 'high');
  assert.equal(started.meta.effort.support, 'turn-parameter');
  // Codex sandbox/approval policy is recorded in the session metadata.
  assert.equal(started.meta.codex.sandbox, 'workspace-write');
  assert.equal(started.meta.codex.approvalPolicy, 'on-request');
});

test('a prompt runs to a completed turn with the protocol stop reason', async () => {
  const submitted = await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'say hello' });
  assert.equal(submitted.state, 'running');
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'completed');
  assert.equal(finished.turn.stopReason, 'end_turn');
  assert.match(finished.answer, /ROUTER_READY/);
  // The fake's thread/tokenUsage/updated lands as a normalized record:
  // canonical fields mapped, raw preserved, caller-known fields filled.
  const usage = finished.turn.usage;
  assert.equal(usage.backend, 'codex');
  assert.equal(usage.totalTokens, 10);
  assert.equal(usage.uncachedInputTokens, 8);
  assert.equal(usage.outputTokens, 2);
  assert.equal(usage.cachedInputTokens, null);
  assert.equal(usage.eventCount, 1);
  assert.equal(typeof usage.latencyMs, 'number');
  assert.deepEqual(usage.raw.total, { totalTokens: 10, inputTokens: 8, outputTokens: 2 });
});

test('turn/steer queues input while turn/start is in flight', async () => {
  const submitted = await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'LATE_START STEER_ME' });
  assert.equal(submitted.state, 'running');
  const steered = await steerSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'steered-now' });
  assert.equal(steered.ok, true);
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'completed');
  assert.match(finished.answer, /STEERED:steered-now/);
});

test('a queued steer rejects when turn/start returns no turn id', async () => {
  const submitted = await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'LATE_START NO_TURN_ID' });
  assert.equal(submitted.state, 'running');
  await assert.rejects(
    steerSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'cannot-land' }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.protocol_error,
  );
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'failed');
});

test('turn/interrupt reports an interrupted turn, not a failure', async () => {
  const submitted = await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'SLOW work' });
  assert.equal(submitted.state, 'running');
  const cancelled = await cancelSession({ stateDir: ctx.stateDir, key: ctx.key, turnId: submitted.turnId });
  assert.equal(cancelled.ok, true);
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'cancelled');
  assert.equal(finished.turn.stopReason, 'cancelled');
});

test('a cancel issued while turn/start is in flight still interrupts', async () => {
  // SLOW_START holds the turn/start reply ~400ms; cancel lands in that window,
  // before the adapter knows the native turn id. The interrupt must fire the
  // moment the id arrives rather than being dropped.
  const submitted = await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'SLOW_START work' });
  assert.equal(submitted.state, 'running');
  const cancelled = await cancelSession({ stateDir: ctx.stateDir, key: ctx.key, turnId: submitted.turnId });
  assert.equal(cancelled.ok, true);
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'cancelled');
  assert.equal(finished.turn.stopReason, 'cancelled');
});

test('prompt --role on a writable codex session is refused as a posture mismatch', async () => {
  // The session from the first test runs workspace-write: a review role must
  // not prompt into it — the reviewer could edit without a permission request
  // ever reaching the parent.
  await assert.rejects(
    execFileP(process.execPath, [
      BIN, 'prompt', '--session', ctx.key, '--role', 'code-review',
      '--task', 'review the workspace', '--state-dir', ctx.stateDir,
    ], { env: process.env }),
    (/** @type {any} */ err) => {
      const out = JSON.parse(err.stderr);
      return err.code === 1 && out.ok === false && out.error.code === ERROR_CODES.role_posture_mismatch;
    },
  );
});

test('prompt --role is accepted on a session with read-only posture', async () => {
  const started = await startSession({
    stateDir: ctx.stateDir,
    backend: 'codex',
    workspace: ctx.workspace,
    profile: 'read-only',
    startTimeoutMs: 60000,
  });
  assert.equal(started.meta.codex.sandbox, 'read-only');
  const key = started.key;
  try {
    const { stdout } = await execFileP(process.execPath, [
      BIN, 'prompt', '--session', key, '--role', 'code-review',
      '--task', 'list findings only', '--state-dir', ctx.stateDir,
    ], { env: process.env });
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.state, 'running');
    const finished = await waitSession({ stateDir: ctx.stateDir, key, timeoutMs: 20000 });
    assert.equal(finished.turn.state, 'completed');
  } finally {
    await stopSession({ stateDir: ctx.stateDir, key }).catch(() => {});
  }
});

test('a codex approval pauses the turn until the parent answers', async () => {
  await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'NEED_APPROVAL' });
  const paused = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(paused.waitOutcome, 'awaiting-permission');
  const request = paused.pendingPermissions[0];
  assert.ok(request.options.some((o) => o.optionId === 'accept'));
  await answerPermission({ stateDir: ctx.stateDir, key: ctx.key, requestId: request.requestId, optionId: 'accept' });
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'completed');
  assert.match(finished.answer, /APPROVAL:accept/);
});

test('review/start refuses a writable session', async () => {
  await assert.rejects(
    reviewSession({ stateDir: ctx.stateDir, key: ctx.key, target: { type: 'uncommittedChanges' } }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.role_posture_mismatch,
  );
});

test('review/start runs a native review turn on a read-only session', async () => {
  const started = await startSession({
    stateDir: ctx.stateDir,
    backend: 'codex',
    workspace: ctx.workspace,
    profile: 'read-only',
    startTimeoutMs: 60000,
  });
  try {
    const submitted = await reviewSession({
      stateDir: ctx.stateDir,
      key: started.key,
      target: { type: 'uncommittedChanges' },
      delivery: 'inline',
    });
    assert.equal(submitted.state, 'running');
    const finished = await waitSession({ stateDir: ctx.stateDir, key: started.key, timeoutMs: 20000 });
    assert.equal(finished.turn.state, 'completed');
    assert.match(finished.answer, /REVIEW_OK:uncommittedChanges/);
    assert.equal(finished.turn.mechanism, 'review/start');
  } finally {
    await stopSession({ stateDir: ctx.stateDir, key: started.key }).catch(() => {});
  }
});

test('a failed codex turn reports the protocol failure, not a crash', async () => {
  await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'FAIL_TURN' });
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'failed');
  assert.equal(finished.turn.stopReason, 'failed');
});

test('steering with no active turn is a typed error', async () => {
  await assert.rejects(
    steerSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'now' }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.no_active_turn,
  );
});

test('a model Codex substitutes without confirmation fails the start', async () => {
  process.env.FAKE_CODEX_REJECT_MODEL = '1';
  try {
    await assert.rejects(
      startSession({
        stateDir: ctx.stateDir,
        backend: 'codex',
        workspace: ctx.workspace,
        model: 'fake-codex-1',
        profile: 'model-mismatch-test',
        startTimeoutMs: 30000,
      }),
      (/** @type {any} */ err) => err.code === ERROR_CODES.worker_start_failed,
    );
  } finally {
    delete process.env.FAKE_CODEX_REJECT_MODEL;
  }
});

test('a codex that predates the turn API is an unsupported-version error', async () => {
  process.env.FAKE_CODEX_LEGACY = '1';
  let key = null;
  try {
    const started = await startSession({
      stateDir: ctx.stateDir,
      backend: 'codex',
      workspace: ctx.workspace,
      profile: 'legacy-codex-test',
      startTimeoutMs: 30000,
    });
    key = started.key;
    await promptSession({ stateDir: ctx.stateDir, key, text: 'anything' });
    const finished = await waitSession({ stateDir: ctx.stateDir, key, timeoutMs: 20000 });
    assert.equal(finished.turn.state, 'failed');
    assert.equal(finished.turn.error.code, ERROR_CODES.unsupported_backend_version);
  } finally {
    if (key) await stopSession({ stateDir: ctx.stateDir, key }).catch(() => {});
    delete process.env.FAKE_CODEX_LEGACY;
  }
});

test('thread/resume recovers a session after the worker dies', async () => {
  const store = new SessionStore(ctx.stateDir, ctx.key);
  const meta = store.readMeta();
  const threadId = meta.sessionId;
  assert.equal(threadId, 'thr-1');

  // Kill the worker without a graceful stop: the backend child is orphaned and
  // the control socket goes silent, so a restart must resume the same thread.
  process.kill(meta.pid, 'SIGKILL');
  for (let i = 0; i < 50; i++) {
    const s = await statusSession({ stateDir: ctx.stateDir, key: ctx.key }).catch(() => null);
    if (!s || s.offline === true) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const restarted = await startSession({
    stateDir: ctx.stateDir,
    backend: 'codex',
    workspace: ctx.workspace,
    model: 'fake-codex-1',
    effort: 'high',
    resume: 'required',
    startTimeoutMs: 60000,
  });
  assert.equal(restarted.reused, false);
  assert.equal(restarted.meta.sessionId, threadId);
  assert.equal(restarted.meta.recovered, true);
  assert.equal(restarted.meta.resume.supported, true);
  ctx.key = restarted.key;

  const submitted = await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'still here' });
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, turnId: submitted.turnId, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'completed');
});

test('resume:required fails typed when the thread is gone', async () => {
  const store = new SessionStore(ctx.stateDir, ctx.key);
  const meta = store.readMeta();
  // Point the recorded session at a thread the stub never created.
  meta.sessionId = 'thr-nonexistent';
  store.writeMeta(meta);
  process.kill(meta.pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(
    startSession({
      stateDir: ctx.stateDir,
      backend: 'codex',
      workspace: ctx.workspace,
      model: 'fake-codex-1',
      effort: 'high',
      resume: 'required',
      startTimeoutMs: 60000,
    }),
    (/** @type {any} */ err) =>
      err.code === ERROR_CODES.worker_start_failed &&
      (err.details?.cause?.code === ERROR_CODES.session_not_resumable || /resum/i.test(err.message)),
  );
  ctx.key = null;
});
