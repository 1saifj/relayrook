import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  answerPermission,
  cancelSession,
  listSessions,
  promptSession,
  startSession,
  statusSession,
  stopSession,
  waitSession,
} from '../src/sessions.mjs';
import { SessionStore } from '../src/state.mjs';
import { ERROR_CODES } from '../src/errors.mjs';
import { sleep } from '../src/util.mjs';

/**
 * Full session lifecycle against a deterministic ACP stub.
 *
 * This exercises the real spawn/JSON-RPC/worker/control-socket path — only the
 * agent on the far end is a stub — so start, prompt, status cursors, wait,
 * permission pause, cancellation, overlap refusal and stop are all covered
 * without a paid model call.
 */

const stubPath = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const STUB_ENV_KEY = 'RELAYROOK_BACKEND_CMD_DEVIN';
const STUB_ARGV = JSON.stringify([process.execPath, stubPath]);

/** @type {{stateDir: string, workspace: string, key: string|null}} */
const ctx = { stateDir: '', workspace: '', key: null };

test.before(() => {
  ctx.stateDir = mkdtempSync(path.join(os.tmpdir(), 'relayrook-e2e-state-'));
  ctx.workspace = mkdtempSync(path.join(os.tmpdir(), 'relayrook-e2e-ws-'));
  process.env[STUB_ENV_KEY] = STUB_ARGV;
  process.env.FAKE_ACP_METADATA = 'configOptions';
  process.env.FAKE_ACP_MODEL = 'swe-2-max';
});

test.after(async () => {
  if (ctx.key) {
    try {
      await stopSession({ stateDir: ctx.stateDir, key: ctx.key });
    } catch {
      // Already stopped by the lifecycle test.
    }
  }
  delete process.env[STUB_ENV_KEY];
  delete process.env.FAKE_ACP_METADATA;
  delete process.env.FAKE_ACP_MODEL;
  rmSync(ctx.stateDir, { recursive: true, force: true });
  rmSync(ctx.workspace, { recursive: true, force: true });
});

test('start launches a worker and reads the model back from the backend', async () => {
  const started = await startSession({
    stateDir: ctx.stateDir,
    backend: 'devin',
    workspace: ctx.workspace,
    caller: { rootCaller: 'codex', immediateParent: 'codex', confidence: 'explicit', depth: 0, ancestry: [] },
    route: { routeId: 'route-e2e', role: 'implementation' },
    env: {
      RELAYROOK_ROUTE: JSON.stringify({
        rootCaller: 'codex',
        parent: 'relayrook',
        routeId: 'route-e2e',
        depth: 1,
        ancestry: ['devin'],
      }),
    },
    startTimeoutMs: 60000,
  });
  ctx.key = started.key;

  assert.equal(started.reused, false);
  assert.equal(started.meta.status, 'ready');
  assert.equal(started.meta.backend, 'devin');
  assert.equal(started.meta.sessionId, 'stub-session-1');
  // Devin's pin is applied at launch and confirmed by the session readback.
  assert.deepEqual(started.meta.model, {
    requested: 'swe-2-max',
    observed: 'swe-2-max',
    source: 'backend-default',
    verified: true,
  });
  // Nothing machine-specific leaks into reported paths.
  assert.ok(!started.dir.startsWith(os.homedir()));
});

test('a second start with the same key reuses the warm worker', async () => {
  const again = await startSession({
    stateDir: ctx.stateDir,
    backend: 'devin',
    workspace: ctx.workspace,
  });
  assert.equal(again.reused, true);
  assert.equal(again.key, ctx.key);
  assert.equal(again.meta.status, 'ready');
});

test('concurrent cold starts serialize to one worker', async () => {
  const spec = {
    stateDir: ctx.stateDir,
    backend: 'devin',
    workspace: ctx.workspace,
    profile: 'concurrent-start-test',
    startTimeoutMs: 10000,
  };
  const [first, second] = await Promise.all([startSession(spec), startSession(spec)]);
  assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
  assert.equal(first.key, second.key);
  await stopSession({ stateDir: ctx.stateDir, key: first.key });
});

test('the control socket and session directory are private', { skip: process.platform === 'win32' }, () => {
  const store = new SessionStore(ctx.stateDir, ctx.key);
  assert.equal(statSync(store.dir).mode & 0o777, 0o700);
  assert.equal(statSync(store.socketPath).mode & 0o777, 0o600);
});

test('every control call must carry the per-session token', async () => {
  const store = new SessionStore(ctx.stateDir, ctx.key);
  const { callControl } = await import('../src/control.mjs');
  await assert.rejects(
    callControl(store.socketPath, 'status', {}, { timeoutMs: 3000 }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.control_unauthorized,
  );
  await assert.rejects(
    callControl(store.socketPath, 'status', {}, { timeoutMs: 3000, token: 'forged-token' }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.control_unauthorized,
  );
  const authed = await callControl(store.socketPath, 'status', {}, { timeoutMs: 3000, token: store.readControlToken() });
  assert.equal(authed.status, 'ready');
});

test('a prompt runs to a completed turn with a protocol stop reason', async () => {
  const submitted = await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'say hello' });
  assert.equal(submitted.state, 'running');
  assert.ok(submitted.turnId);

  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.waitOutcome, 'terminal');
  assert.equal(finished.turn.state, 'completed');
  assert.equal(finished.turn.stopReason, 'end_turn');
  assert.equal(finished.answer, 'ROUTER_READY');
  assert.equal(finished.cursorGap, false);

  const kinds = finished.events.map((e) => e.kind);
  assert.ok(kinds.includes('turn_started'));
  assert.ok(kinds.includes('text'));
  assert.ok(kinds.includes('turn_finished'));
});

test('status pages events incrementally from a cursor', async () => {
  const first = await statusSession({ stateDir: ctx.stateDir, key: ctx.key, cursor: 0, limit: 2 });
  assert.equal(first.events.length, 2);
  assert.equal(first.hasMore, true);

  const second = await statusSession({ stateDir: ctx.stateDir, key: ctx.key, cursor: first.nextCursor, limit: 500 });
  assert.ok(second.events.every((e) => e.cursor > first.nextCursor));

  const caughtUp = await statusSession({ stateDir: ctx.stateDir, key: ctx.key, cursor: second.nextCursor });
  assert.equal(caughtUp.events.length, 0);
  assert.equal(caughtUp.nextCursor, second.nextCursor);
});

test('the full per-turn record is written outside the bounded event log', async () => {
  const store = new SessionStore(ctx.stateDir, ctx.key);
  const meta = store.readMeta();
  const turnDir = path.join(store.turnsDir, meta.turn.id);
  assert.equal(readFileSync(path.join(turnDir, 'prompt.txt'), 'utf8'), 'say hello');
  assert.equal(readFileSync(path.join(turnDir, 'answer.txt'), 'utf8'), 'ROUTER_READY');
  const result = JSON.parse(readFileSync(path.join(turnDir, 'result.json'), 'utf8'));
  assert.equal(result.state, 'completed');
  assert.equal(result.stopReason, 'end_turn');
});

test('submitting while a turn is active is refused instead of interleaved', async () => {
  const running = await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'SLOW work' });
  assert.equal(running.state, 'running');

  await assert.rejects(
    promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'second prompt' }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.active_turn,
  );

  const cancelled = await cancelSession({ stateDir: ctx.stateDir, key: ctx.key, turnId: running.turnId });
  assert.equal(cancelled.ok, true);

  const settled = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(settled.turn.state, 'cancelled');
  assert.equal(settled.turn.stopReason, 'cancelled');
});

test('a turn can be submitted again after a cancellation', async () => {
  const submitted = await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'follow up' });
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, turnId: submitted.turnId, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'completed');
  assert.equal(finished.answer, 'ROUTER_READY');
});

test('a permission request pauses the turn and waits for the parent', async () => {
  await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'NEED_PERMISSION please' });

  const paused = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(paused.waitOutcome, 'awaiting-permission');
  assert.equal(paused.turn.state, 'awaiting-permission');
  assert.equal(paused.pendingPermissions.length, 1);

  const request = paused.pendingPermissions[0];
  assert.deepEqual(request.options.map((o) => o.optionId), ['allow_once', 'reject_once']);

  // An option the agent never advertised is refused, not coerced.
  await assert.rejects(
    answerPermission({ stateDir: ctx.stateDir, key: ctx.key, requestId: request.requestId, optionId: 'allow_always' }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.permission_option_invalid && err.details.allowed.includes('allow_once'),
  );
  // A wrong request id is refused too.
  await assert.rejects(
    answerPermission({ stateDir: ctx.stateDir, key: ctx.key, requestId: 'no-such-request', optionId: 'allow_once' }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.permission_not_pending,
  );

  const answered = await answerPermission({
    stateDir: ctx.stateDir,
    key: ctx.key,
    requestId: request.requestId,
    optionId: 'allow_once',
  });
  assert.equal(answered.outcome, 'selected');

  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'completed');
  assert.match(finished.answer, /PERMISSION:selected:allow_once/);

  const resolved = finished.events.find((e) => e.kind === 'permission_resolved');
  assert.equal(resolved.option, 'allow_once');
});

test('overlapping permissions remain paused until every request is answered', async () => {
  await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'DOUBLE_PERMISSION' });
  let paused = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(paused.pendingPermissions.length, 2);
  await answerPermission({
    stateDir: ctx.stateDir, key: ctx.key,
    requestId: paused.pendingPermissions[0].requestId, optionId: 'allow_once',
  });
  paused = await statusSession({ stateDir: ctx.stateDir, key: ctx.key });
  assert.equal(paused.turn.state, 'awaiting-permission');
  assert.equal(paused.pendingPermissions.length, 1);
  await answerPermission({
    stateDir: ctx.stateDir, key: ctx.key,
    requestId: paused.pendingPermissions[0].requestId, optionId: 'allow_once',
  });
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'completed');
});

test('a permission-blocked turn releases the request when it times out', async () => {
  await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'PERMISSION_WAIT_FOR_RESPONSE', timeoutMs: 500 });
  await sleep(700);
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000, pollMs: 50 });
  assert.equal(finished.turn.state, 'timed-out');
  assert.equal(finished.pendingPermissions.length, 0);
  assert.ok(readFileSync(path.join(new SessionStore(ctx.stateDir, ctx.key).turnDir(finished.turn.id), 'result.json'), 'utf8'));
});

test('a backend reply with no stop reason is a failure, not a success', async () => {
  await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'NO_STOP_REASON' });
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'failed');
  assert.equal(finished.turn.error.message, 'Backend returned no stopReason');
});

test('a refusal is reported as its own stop reason', async () => {
  await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'REFUSE this' });
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'completed');
  assert.equal(finished.turn.stopReason, 'refusal');
});

test('an oversized agent message is truncated in the event log but kept in full in the turn record', async () => {
  const submitted = await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'BIG payload' });
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.state, 'completed');

  const textEvent = finished.events.find((e) => e.kind === 'text' && e.truncated);
  assert.ok(textEvent, 'the oversized chunk must be marked truncated');
  assert.equal(textEvent.text.length, 8192);
  assert.equal(textEvent.originalLength, 200000);

  const store = new SessionStore(ctx.stateDir, ctx.key);
  const answer = readFileSync(path.join(store.turnsDir, submitted.turnId, 'answer.txt'), 'utf8');
  assert.equal(answer.length, 200000);
});

test('answers over the memory cap remain complete on disk and keep their final result block online', async () => {
  const submitted = await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'BIG_2MB' });
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000 });
  assert.equal(finished.turn.answerTruncated, true);
  assert.match(finished.answer, /relayrook-result/);
  const store = new SessionStore(ctx.stateDir, ctx.key);
  const answer = readFileSync(path.join(store.turnsDir, submitted.turnId, 'answer.txt'), 'utf8');
  assert.ok(answer.length > 2 * 1024 * 1024);
  assert.match(answer, /complete-no-findings/);
});

test('a turn timeout is reported as timed-out, not as a completion', async () => {
  await promptSession({ stateDir: ctx.stateDir, key: ctx.key, text: 'SLOW forever', timeoutMs: 600 });
  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 20000, pollMs: 100 });
  assert.equal(finished.turn.state, 'timed-out');
  assert.equal(finished.turn.stopReason, 'relayrook_timeout');
  const turnDir = new SessionStore(ctx.stateDir, ctx.key).turnDir(finished.turn.id);
  const persisted = JSON.parse(readFileSync(path.join(turnDir, 'result.json'), 'utf8'));
  assert.equal(persisted.state, 'timed-out');
  assert.equal(persisted.finishedAt, finished.turn.finishedAt);
});

test('cancel with no active turn is a typed error', async () => {
  await assert.rejects(
    cancelSession({ stateDir: ctx.stateDir, key: ctx.key }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.no_active_turn,
  );
});

test('sessions lists the live worker', async () => {
  const sessions = await listSessions(ctx.stateDir);
  const entry = sessions.find((s) => s.key === ctx.key);
  assert.equal(entry.backend, 'devin');
  assert.equal(entry.alive, true);
  assert.equal(entry.status, 'ready');
});

test('stop shuts the worker down and state stays readable afterwards', async () => {
  const stopped = await stopSession({ stateDir: ctx.stateDir, key: ctx.key });
  assert.equal(stopped.ok, true);

  assert.equal(stopped.stopped, true);

  const offline = await statusSession({ stateDir: ctx.stateDir, key: ctx.key, cursor: 0, limit: 5 });
  assert.equal(offline.offline, true);
  assert.equal(offline.meta.status, 'stopped');
  assert.ok(offline.events.length > 0, 'the on-disk event log survives the worker');

  const again = await stopSession({ stateDir: ctx.stateDir, key: ctx.key });
  assert.equal(again.alreadyStopped, true);
  ctx.key = null;
});

test('an unknown backend is refused before any session state is written', async () => {
  await assert.rejects(
    startSession({ stateDir: ctx.stateDir, backend: 'no-such-backend', workspace: ctx.workspace }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.unknown_backend,
  );
});

test('a model the backend will not confirm fails the start instead of running on the wrong model', async () => {
  process.env.FAKE_ACP_REJECT_MODEL = '1';
  process.env[`RELAYROOK_BACKEND_CMD_OPENCODE`] = STUB_ARGV;
  try {
    await assert.rejects(
      startSession({
        stateDir: ctx.stateDir,
        backend: 'opencode',
        workspace: ctx.workspace,
        model: 'opencode-go/kimi-k2.7-code',
        startTimeoutMs: 30000,
      }),
      (/** @type {any} */ err) => err.code === ERROR_CODES.worker_start_failed && /did not confirm model/.test(err.message),
    );
  } finally {
    delete process.env.FAKE_ACP_REJECT_MODEL;
    delete process.env.RELAYROOK_BACKEND_CMD_OPENCODE;
  }
});

test('legacy Kiro model metadata is honoured end to end', async () => {
  process.env.RELAYROOK_BACKEND_CMD_KIRO = STUB_ARGV;
  process.env.FAKE_ACP_METADATA = 'models';
  process.env.FAKE_ACP_MODEL = 'claude-opus-5';
  process.env.FAKE_KIRO_NOTIFY_EFFORT = 'max';
  let key = null;
  try {
    const started = await startSession({
      stateDir: ctx.stateDir,
      backend: 'kiro',
      workspace: ctx.workspace,
      model: 'claude-opus-5',
      effort: 'max',
      startTimeoutMs: 60000,
    });
    key = started.key;
    assert.equal(started.meta.metadataStyle, 'models');
    assert.deepEqual(started.meta.model, {
      requested: 'claude-opus-5',
      observed: 'claude-opus-5',
      source: 'pin',
      verified: true,
    });
    // Kiro takes --effort at launch but reports no effort value back.
    assert.equal(started.meta.effort.requested, 'max');
    assert.equal(started.meta.effort.verified, false);
    assert.equal(started.meta.effort.support, 'launch-flag-not-read-back');
    await promptSession({ stateDir: ctx.stateDir, key, text: 'EFFORT_METADATA' });
    const finished = await waitSession({ stateDir: ctx.stateDir, key, timeoutMs: 10000 });
    assert.deepEqual(finished.meta.effort, {
      requested: 'max', observed: 'max', verified: true, support: 'agent-notification',
    });
  } finally {
    if (key) await stopSession({ stateDir: ctx.stateDir, key }).catch(() => {});
    delete process.env.RELAYROOK_BACKEND_CMD_KIRO;
    delete process.env.FAKE_KIRO_NOTIFY_EFFORT;
    process.env.FAKE_ACP_METADATA = 'configOptions';
    process.env.FAKE_ACP_MODEL = 'swe-2-max';
  }
});
