import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  answerPermission,
  cancelSession,
  extendSession,
  promptSession,
  startSession,
  statusSession,
  stopSession,
  waitSession,
} from '../src/sessions.mjs';
import { sleep } from '../src/util.mjs';

/**
 * Turn watchdog behaviour against the deterministic ACP stub.
 *
 * The contract under test: a turn is judged by whether the backend is still
 * saying anything, never by how long the work has taken. A busy turn survives
 * indefinitely; a silent one is reported to the parent, which decides.
 */

const stubPath = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const STUB_ENV_KEY = 'RELAYROOK_BACKEND_CMD_DEVIN';

/** @type {{stateDir: string, workspace: string, key: string|null}} */
const ctx = { stateDir: '', workspace: '', key: null };

test.before(async () => {
  ctx.stateDir = mkdtempSync(path.join(os.tmpdir(), 'relayrook-watchdog-state-'));
  ctx.workspace = mkdtempSync(path.join(os.tmpdir(), 'relayrook-watchdog-ws-'));
  process.env[STUB_ENV_KEY] = JSON.stringify([process.execPath, stubPath]);
  process.env.FAKE_ACP_MODEL = 'swe-2-max';
  process.env.FAKE_ACP_HEARTBEAT_MS = '40';
  const started = await startSession({
    stateDir: ctx.stateDir,
    backend: 'devin',
    workspace: ctx.workspace,
    startTimeoutMs: 60000,
  });
  ctx.key = started.key;
});

test.after(async () => {
  try {
    await stopSession({ stateDir: ctx.stateDir, key: ctx.key });
  } catch {
    // Already stopped.
  }
  delete process.env[STUB_ENV_KEY];
  delete process.env.FAKE_ACP_MODEL;
  delete process.env.FAKE_ACP_HEARTBEAT_MS;
  rmSync(ctx.stateDir, { recursive: true, force: true });
  rmSync(ctx.workspace, { recursive: true, force: true });
});

/** Cancel whatever is in flight so each test starts from an idle session. */
async function settle() {
  try {
    await cancelSession({ stateDir: ctx.stateDir, key: ctx.key });
  } catch {
    // No active turn.
  }
  await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 10000, stopOnStall: false });
}

test('a silent turn is reported, not killed', async () => {
  const submitted = await promptSession({
    stateDir: ctx.stateDir,
    key: ctx.key,
    text: 'SLOW',
    stallTimeoutMs: 300,
    timeoutMs: 0,
  });

  const stalled = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 10000 });
  assert.equal(stalled.waitOutcome, 'stalled');
  // The turn is still alive: reporting a stall is a question to the parent.
  assert.equal(stalled.turn.state, 'running');
  assert.equal(stalled.turn.watchdog.stalled, true);
  assert.ok(stalled.turn.watchdog.stallCount >= 1);
  assert.ok(stalled.turn.watchdog.silentMs >= 250);
  assert.equal(stalled.turn.watchdog.deadlineMs, 0, 'a 0 deadline stays disabled');

  const stallEvent = stalled.events.find((e) => e.kind === 'turn_stalled' && e.turnId === submitted.turnId);
  assert.ok(stallEvent, 'a turn_stalled event is recorded');
  assert.equal(stallEvent.action, 'report');

  await settle();
});

test('a busy turn outlives many inactivity windows', async () => {
  await promptSession({
    stateDir: ctx.stateDir,
    key: ctx.key,
    text: 'HEARTBEAT',
    stallTimeoutMs: 1000,
    timeoutMs: 0,
  });

  // Well past the window, with a heartbeat every 40ms. The margin is wide on
  // purpose: a busy CI runner pausing for a moment is not a stalled backend.
  await sleep(1500);
  const snapshot = await statusSession({ stateDir: ctx.stateDir, key: ctx.key });
  assert.equal(snapshot.turn.state, 'running');
  assert.equal(snapshot.turn.watchdog.stalled, false);
  assert.equal(snapshot.turn.watchdog.stallCount, 0);
  assert.ok(snapshot.turn.watchdog.silentMs < 1000);

  await settle();
});

test('stall-action cancel restores kill-on-silence for hosts that cannot poll', async () => {
  const submitted = await promptSession({
    stateDir: ctx.stateDir,
    key: ctx.key,
    text: 'SLOW',
    stallTimeoutMs: 250,
    stallAction: 'cancel',
    timeoutMs: 0,
  });

  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 10000 });
  assert.equal(finished.waitOutcome, 'terminal');
  assert.equal(finished.turn.state, 'timed-out');
  assert.equal(finished.turn.stopReason, 'relayrook_timeout');
  assert.equal(finished.turn.watchdog.timeoutKind, 'stall');
  const timeoutEvent = finished.events.find((e) => e.kind === 'turn_timeout' && e.turnId === submitted.turnId);
  assert.equal(timeoutEvent.reason, 'stall');
});

test('the wall-clock backstop still stops a turn that never stops talking', async () => {
  const submitted = await promptSession({
    stateDir: ctx.stateDir,
    key: ctx.key,
    text: 'HEARTBEAT',
    stallTimeoutMs: 0,
    timeoutMs: 400,
  });

  const finished = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 10000 });
  assert.equal(finished.turn.state, 'timed-out');
  assert.equal(finished.turn.watchdog.timeoutKind, 'deadline');
  const timeoutEvent = finished.events.find((e) => e.kind === 'turn_timeout' && e.turnId === submitted.turnId);
  assert.equal(timeoutEvent.reason, 'deadline');
});

test('extend gives an in-flight turn a new budget', async () => {
  await promptSession({
    stateDir: ctx.stateDir,
    key: ctx.key,
    text: 'HEARTBEAT',
    stallTimeoutMs: 0,
    timeoutMs: 2000,
  });

  const extended = await extendSession({
    stateDir: ctx.stateDir,
    key: ctx.key,
    timeoutMs: 60000,
    resetDeadline: true,
  });
  assert.equal(extended.ok, true);
  assert.equal(extended.watchdog.deadlineMs, 60000);

  // Well past the original deadline.
  await sleep(2400);
  const snapshot = await statusSession({ stateDir: ctx.stateDir, key: ctx.key });
  assert.equal(snapshot.turn.state, 'running');
  assert.ok(snapshot.turn.watchdog.remainingMs > 1000);

  await settle();
});

test('waiting on a permission is not silence', async () => {
  const submitted = await promptSession({
    stateDir: ctx.stateDir,
    key: ctx.key,
    text: 'PERMISSION_WAIT_FOR_RESPONSE',
    stallTimeoutMs: 300,
    timeoutMs: 0,
  });

  const paused = await waitSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 10000 });
  assert.equal(paused.waitOutcome, 'awaiting-permission');

  // Several stall windows pass while the parent thinks about the request. The
  // pause suspends the inactivity clock outright, so no stall is ever counted
  // — that holds however slow the machine is.
  await sleep(1200);
  const stillPaused = await statusSession({ stateDir: ctx.stateDir, key: ctx.key });
  assert.equal(stillPaused.turn.state, 'awaiting-permission');
  assert.equal(stillPaused.turn.watchdog.stalled, false);
  assert.equal(stillPaused.turn.watchdog.stallCount, 0);

  const request = stillPaused.pendingPermissions[0];
  await answerPermission({
    stateDir: ctx.stateDir,
    key: ctx.key,
    requestId: request.requestId,
    optionId: 'allow_once',
  });
  const finished = await waitSession({
    stateDir: ctx.stateDir,
    key: ctx.key,
    turnId: submitted.turnId,
    timeoutMs: 10000,
    stopOnStall: false,
  });
  assert.equal(finished.turn.state, 'completed');
});

test('extend refuses when no turn is active', async () => {
  await assert.rejects(
    () => extendSession({ stateDir: ctx.stateDir, key: ctx.key, timeoutMs: 1000 }),
    (/** @type {any} */ err) => err.code === 'no_active_turn',
  );
});
