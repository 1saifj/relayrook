import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { callControl, pingControl } from './control.mjs';
import { EventLog, SessionStore, listSessionKeys } from './state.mjs';
import { fail, ERROR_CODES } from './errors.mjs';
import { getBackend } from './backends.mjs';
import { sessionKey, sleep, redactPath } from './util.mjs';
import { resolveClaudeAdapter, whichSync } from './discovery.mjs';
import { runSessionPreflight } from './preflight.mjs';
import { IS_WINDOWS, controlEndpointExists, pidAlive, processIdentity, terminateWindowsProcessTree } from './platform.mjs';

/**
 * Per-backend launch override, used by tests and by anyone pointing RelayRook at
 * a wrapper script. Value is a JSON array of argv, e.g.
 * `RELAYROOK_BACKEND_CMD_DEVIN='["node","/path/to/wrapper.mjs"]'`.
 */
export const BACKEND_CMD_ENV_PREFIX = 'RELAYROOK_BACKEND_CMD_';

/** @param {string} backendId @param {NodeJS.ProcessEnv} [env] */
export function backendCommandOverride(backendId, env = process.env) {
  const raw = env[`${BACKEND_CMD_ENV_PREFIX}${backendId.toUpperCase()}`];
  if (!raw) return null;
  try {
    const argv = JSON.parse(raw);
    if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string') return null;
    return { command: argv[0], args: argv.slice(1).map(String) };
  } catch {
    return null;
  }
}

/**
 * @param {SessionStore} store
 * @returns {string|null} the control token the current worker generation requires
 */
function controlToken(store) {
  return store.readControlToken();
}

/**
 * Reap the leftovers of a dead worker: unlink a stale socket endpoint and kill
 * an orphaned backend child if one survived its worker and still carries the
 * recorded backend's command name. A live pid whose identity cannot be
 * confirmed is left alone and reported as unverified — pid reuse must never
 * become someone else's SIGKILL.
 * @param {SessionStore} store
 * @param {any} meta
 * @returns {Promise<{orphanBackendKilled: boolean, orphanBackendUnverified: boolean}>}
 */
async function reapDeadWorker(store, meta) {
  let orphanBackendKilled = false;
  let orphanBackendUnverified = false;
  if (Number.isInteger(meta?.backendPid) && pidAlive(meta.backendPid) && !pidAlive(meta?.pid)) {
    // A pid is only an existence check — the OS may have reassigned it to an
    // unrelated process after the worker died. Kill only when the live
    // process still carries the recorded backend's command name; anything
    // else is reported as unverified rather than signalled blindly.
    const expected = meta?.backendCommand ? String(meta.backendCommand) : null;
    const expectedStartedAt = typeof meta?.backendProcessStartedAt === 'string' ? meta.backendProcessStartedAt : null;
    const observed = expected && expectedStartedAt ? await processIdentity(meta.backendPid) : null;
    const matches =
      expected !== null &&
      expectedStartedAt !== null &&
      observed !== null &&
      commandNamesMatch(observed.command, expected) &&
      observed.startedAt === expectedStartedAt;
    if (matches) {
      try {
        if (IS_WINDOWS) orphanBackendKilled = await terminateWindowsProcessTree(meta.backendPid);
        else {
          process.kill(meta.backendPid, 'SIGKILL');
          orphanBackendKilled = true;
        }
      } catch {
        // The process may have exited between the check and the signal.
      }
    } else {
      orphanBackendUnverified = true;
    }
  }
  if (controlEndpointExists(store.socketPath)) {
    try {
      unlinkSync(store.socketPath);
    } catch {
      // Another starter may be racing; the lock serialises us anyway.
    }
  }
  return { orphanBackendKilled, orphanBackendUnverified };
}

/**
 * Compare a live process's command name with the recorded backend command.
 * Both values come from the same identity probe. Require an exact command
 * match; a shared prefix or basename is not evidence of process identity.
 * @param {string} observed @param {string} expected
 */
function commandNamesMatch(observed, expected) {
  const a = observed.trim();
  const b = expected.trim();
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Create or reuse a persistent session.
 *
 * Reuse is keyed on backend, workspace, model, effort and security profile, and
 * confirmed by an actual ping — a leftover socket file is not proof of a live
 * worker.
 *
 * When a previous worker for the same key is dead, the new worker attempts to
 * resume the persisted backend-native session (`session/load` for ACP agents
 * that advertise it, `thread/resume` for Codex). `resume: 'required'` fails
 * with `session_not_resumable` instead of starting a fresh native session;
 * the default reports `recovered: false` honestly.
 *
 * @param {{
 *   stateDir: string,
 *   backend: string,
 *   workspace: string,
 *   model?: string|null,
 *   effort?: string|null,
 *   profile?: string,
 *   codex?: {sandbox?: string, approvalPolicy?: string},
 *   caller?: any,
 *   route?: any,
 *   env?: Record<string, string>,
 *   reuse?: boolean,
 *   resume?: 'auto'|'required'|'never',
 *   idleTimeoutMs?: number,
 *   startTimeoutMs?: number,
 *   maxLineBytes?: number,
 *   env_overrides?: Record<string, string>,
 * }} spec
 */
export async function startSession(spec) {
  const backend = getBackend(spec.backend);
  if (backend.sessionSupport !== 'implemented') {
    throw fail(
      ERROR_CODES.session_control_not_implemented,
      backend.sessionSupportReason ?? `Session control is not implemented for ${backend.id}`,
      { backend: backend.id },
    );
  }

  const workspace = path.resolve(spec.workspace);
  const key = sessionKey({
    backend: spec.backend,
    workspace,
    model: spec.model ?? backend.defaultModel ?? null,
    effort: spec.effort ?? null,
    profile: spec.profile ?? 'default',
  });
  const store = new SessionStore(spec.stateDir, key).ensure();
  const startTimeoutMs = spec.startTimeoutMs ?? 120000;

  // Capability preflight before any state is written for the new generation.
  // A blocker throws a typed error here, before the start lock and before
  // request/meta files exist — the caller gets the JSON error contract, never
  // an unhandled rejection from a discarded promise.
  await runSessionPreflight({
    backend,
    stateDir: spec.stateDir,
    store,
    env: { ...process.env, ...(spec.env ?? {}) },
  });

  const lockFd = await acquireStartLock(store, startTimeoutMs);

  try {
    if (controlEndpointExists(store.socketPath) || IS_WINDOWS) {
      const ping = await pingControl(store.socketPath, { timeoutMs: 3000, token: controlToken(store) });
      if (spec.reuse !== false && ping.alive && ping.result?.status === 'ready') {
        return { key, reused: true, recovered: true, meta: ping.result.meta, dir: redactPath(store.dir) };
      }
      if (ping.alive) {
        throw fail(ERROR_CODES.active_turn, 'A live session already owns this key', { key });
      }
      if (!IS_WINDOWS) {
        try {
          unlinkSync(store.socketPath);
        } catch {}
      }
    }

    // Dead-worker recovery: decide whether the previous native session can be
    // resumed before the new worker is even spawned.
    let previousMeta = null;
    try {
      previousMeta = store.exists() ? store.readMeta() : null;
    } catch {
      previousMeta = null;
    }
    const previousSessionId = previousMeta?.sessionId ?? null;
    const previousSessions = Array.isArray(previousMeta?.previousSessions) ? [...previousMeta.previousSessions] : [];
    if (previousSessionId) previousSessions.push(previousSessionId);
    const reaped = previousMeta
      ? await reapDeadWorker(store, previousMeta)
      : { orphanBackendKilled: false, orphanBackendUnverified: false };

    const resumePolicy = spec.resume ?? 'auto';
    const resume =
      resumePolicy !== 'never' && previousSessionId
        ? { nativeSessionId: previousSessionId, policy: resumePolicy }
        : null;

    const override = backendCommandOverride(spec.backend, process.env);
    const launch = resolveLaunchCommand(backend, spec.stateDir, override, {
      ...process.env,
      ...(spec.env ?? {}),
    });

    const request = {
      schemaVersion: 2,
      backend: spec.backend,
      workspace,
      model: spec.model ?? null,
      effort: spec.effort ?? null,
      profile: spec.profile ?? 'default',
      codex: spec.codex ?? null,
      caller: spec.caller ?? null,
      route: spec.route ?? null,
      env: spec.env ?? {},
      resume,
      previousSessions,
      idleTimeoutMs: spec.idleTimeoutMs,
      maxLineBytes: spec.maxLineBytes,
      commandOverride: launch.command,
      argsOverride: launch.extraArgs,
      createdAt: new Date().toISOString(),
    };
    store.writeRequest(request);
    store.writeMeta({
      schemaVersion: 2,
      key,
      backend: spec.backend,
      workspace,
      status: 'starting',
      startedAt: new Date().toISOString(),
      previousSessions,
      resume: { supported: null, mechanism: null, lastAttempt: resume ? { requested: resume.nativeSessionId } : null },
    });

    const workerEntry = fileURLToPath(new URL('./worker-entry.mjs', import.meta.url));
    const logFd = openSync(store.logFile, 'a');
    const child = spawn(process.execPath, [workerEntry, '--session-dir', store.dir], {
      // Each CLI command exits while the worker keeps serving later commands.
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ...(spec.env ?? {}) },
    });
    closeSync(logFd);
    child.unref();

    const meta = await waitForReady(store, startTimeoutMs);
    return {
      key,
      reused: false,
      recovered: meta.recovered === true,
      resume: {
        attempted: Boolean(resume),
        requested: resume?.nativeSessionId ?? null,
        supported: meta.resume?.supported ?? null,
        mechanism: meta.resume?.mechanism ?? null,
        policy: resumePolicy,
      },
      previousSessionId,
      orphanBackendKilled: reaped.orphanBackendKilled,
      orphanBackendUnverified: reaped.orphanBackendUnverified === true,
      meta,
      dir: redactPath(store.dir),
    };
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(store.startLockFile);
    } catch {}
  }
}

async function acquireStartLock(store, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(store.startLockFile, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return fd;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      let ownerAlive = false;
      try {
        const owner = JSON.parse(readFileSync(store.startLockFile, 'utf8'));
        if (Number.isInteger(owner.pid)) {
          process.kill(owner.pid, 0);
          ownerAlive = true;
        }
      } catch {}
      if (!ownerAlive) {
        try {
          unlinkSync(store.startLockFile);
        } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw fail(ERROR_CODES.worker_start_failed, `Timed out waiting for session start lock after ${timeoutMs}ms`, {
          key: store.key,
        });
      }
      await sleep(100);
    }
  }
}

/**
 * Resolve the executable to launch, including the Claude adapter's
 * bootstrapped location, and report a typed error when it is not there.
 *
 * Native backends resolve to the PATH-absolute binary. That matters on
 * Windows: npm installs ship `.cmd` shims, and `spawn` cannot PATHEXT-resolve
 * a bare command name — but `spawnCommand` can route a resolved `.cmd` path
 * through `cmd.exe` because it can inspect the extension.
 * @param {any} backend
 * @param {string} stateDir
 * @param {{command: string, args: string[]}|null} override
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveLaunchCommand(backend, stateDir, override, env = process.env) {
  if (override) return { command: override.command, extraArgs: override.args };
  if (backend.adapter === 'npm-package') {
    const adapter = resolveClaudeAdapter(stateDir);
    if (!adapter.path) {
      throw fail(
        ERROR_CODES.adapter_not_ready,
        `${backend.adapterPackage}@${backend.adapterVersion} is not installed. Run: relayrook bootstrap --backend ${backend.id}`,
        { backend: backend.id, package: backend.adapterPackage, pinnedVersion: backend.adapterVersion },
      );
    }
    return { command: adapter.path, extraArgs: [] };
  }
  const executable = whichSync(backend.command, env);
  if (!executable) {
    throw fail(ERROR_CODES.backend_not_installed, `${backend.command} not found on PATH`, {
      backend: backend.id,
      command: backend.command,
    });
  }
  return { command: executable, extraArgs: [] };
}

/**
 * @param {SessionStore} store
 * @param {number} timeoutMs
 */
async function waitForReady(store, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastMeta = null;
  while (Date.now() < deadline) {
    const token = controlToken(store);
    if (controlEndpointExists(store.socketPath) || IS_WINDOWS) {
      const ping = await pingControl(store.socketPath, { timeoutMs: 3000, token });
      if (ping.alive) {
        if (ping.result?.status === 'ready') return ping.result.meta;
        lastMeta = ping.result?.meta ?? lastMeta;
      }
    }
    if (store.exists()) {
      const meta = store.readMeta();
      lastMeta = meta;
      if (meta.status === 'failed' || meta.status === 'stopped') {
        // Carry the worker's own typed code into the message so the caller sees
        // why the session never became ready, not just that it did not.
        const detail = meta.lastError
          ? `${meta.lastError.code}: ${meta.lastError.message}`
          : `Worker ${meta.status} during startup`;
        throw fail(ERROR_CODES.worker_start_failed, detail, {
          cause: meta.lastError ?? null,
          meta,
          workerLog: redactPath(store.logFile),
        });
      }
    }
    await sleep(150);
  }
  throw fail(ERROR_CODES.worker_start_failed, `Session did not become ready within ${timeoutMs}ms`, {
    meta: lastMeta,
    workerLog: redactPath(store.logFile),
  });
}

/** @param {string} stateDir @param {string} key */
export function storeFor(stateDir, key) {
  const store = new SessionStore(stateDir, key);
  if (!store.exists()) {
    throw fail(ERROR_CODES.session_not_found, `No session with key ${key}`, { key });
  }
  return store;
}

/**
 * @param {{stateDir: string, key: string, text: string, timeoutMs?: number, metadata?: any}} input
 */
export function promptSession(input) {
  const store = storeFor(input.stateDir, input.key);
  return callControl(
    store.socketPath,
    'prompt',
    { text: input.text, timeoutMs: input.timeoutMs, metadata: input.metadata },
    { timeoutMs: 30000, token: controlToken(store) },
  );
}

/**
 * Steer the active turn with additional input (Codex `turn/steer`).
 * @param {{stateDir: string, key: string, text: string}} input
 */
export function steerSession(input) {
  const store = storeFor(input.stateDir, input.key);
  return callControl(store.socketPath, 'steer', { text: input.text }, { timeoutMs: 30000, token: controlToken(store) });
}

/**
 * Start a native review turn (Codex `review/start`).
 * @param {{stateDir: string, key: string, target?: any, delivery?: string, timeoutMs?: number}} input
 */
export function reviewSession(input) {
  const store = storeFor(input.stateDir, input.key);
  return callControl(
    store.socketPath,
    'review',
    { target: input.target, delivery: input.delivery, timeoutMs: input.timeoutMs },
    { timeoutMs: 30000, token: controlToken(store) },
  );
}

/**
 * @param {{stateDir: string, key: string, cursor?: number, limit?: number, turnId?: string|null}} input
 */
export async function statusSession(input) {
  const store = storeFor(input.stateDir, input.key);
  try {
    return await callControl(
      store.socketPath,
      'status',
      { cursor: input.cursor ?? 0, limit: input.limit ?? 200, turnId: input.turnId ?? null },
      { timeoutMs: 15000, token: controlToken(store) },
    );
  } catch (err) {
    // A stopped worker still has readable state on disk; report that rather
    // than failing the whole command.
    if (err && typeof err === 'object' && err.code === ERROR_CODES.session_not_running) {
      const meta = store.readMeta();
      const log = new EventLog(store).load();
      const page = log.read({ cursor: input.cursor ?? 0, limit: input.limit ?? 200, turnId: input.turnId ?? null });
      const turn = meta.turn ?? null;
      let answer = '';
      let persistedResult = null;
      if (turn?.id) {
        const dir = store.turnDir(turn.id);
        try {
          answer = readFileSync(path.join(dir, 'answer.txt'), 'utf8');
        } catch {}
        try {
          persistedResult = JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8'));
        } catch {}
      }
      return { status: meta.status ?? 'stopped', meta, turn, answer, persistedResult, offline: true, ...page };
    }
    throw err;
  }
}

/**
 * Poll a session until its active turn reaches a terminal state.
 *
 * A terminal state is one the backend reported (`completed`, `cancelled`,
 * `failed`) or one RelayRook imposed (`timed-out`). `awaiting-permission` is
 * terminal for the purposes of waiting, because only the parent can unblock it.
 *
 * @param {{stateDir: string, key: string, cursor?: number, timeoutMs?: number, pollMs?: number, turnId?: string|null}} input
 */
export async function waitSession(input) {
  const deadline = Date.now() + (input.timeoutMs ?? 15 * 60 * 1000);
  const pollMs = input.pollMs ?? 250;
  let cursor = input.cursor ?? 0;
  /** @type {any[]} */
  const collected = [];
  let cursorGap = false;
  let last = null;

  for (;;) {
    const snapshot = await statusSession({ stateDir: input.stateDir, key: input.key, cursor, limit: 500, turnId: input.turnId });
    last = snapshot;
    if (snapshot.cursorGap) cursorGap = true;
    if (snapshot.events?.length) {
      collected.push(...snapshot.events);
      cursor = snapshot.nextCursor;
    }
    const turn = snapshot.turn;
    const state = turn?.state ?? 'idle';
    if (turn && input.turnId && turn.id !== input.turnId) {
      return { ...snapshot, events: collected, nextCursor: cursor, cursorGap, waitOutcome: 'turn-replaced' };
    }
    if (state === 'awaiting-permission') {
      return { ...snapshot, events: collected, nextCursor: cursor, cursorGap, waitOutcome: 'awaiting-permission' };
    }
    if (['completed', 'cancelled', 'failed', 'timed-out'].includes(state)) {
      return { ...snapshot, events: collected, nextCursor: cursor, cursorGap, waitOutcome: 'terminal' };
    }
    if (snapshot.offline) {
      return { ...snapshot, events: collected, nextCursor: cursor, cursorGap, waitOutcome: 'worker-offline' };
    }
    if (Date.now() >= deadline) {
      return { ...snapshot, events: collected, nextCursor: cursor, cursorGap, waitOutcome: 'wait-timeout' };
    }
    await sleep(pollMs);
  }
}

/** @param {{stateDir: string, key: string, turnId?: string}} input */
export function cancelSession(input) {
  const store = storeFor(input.stateDir, input.key);
  return callControl(store.socketPath, 'cancel', { turnId: input.turnId }, { timeoutMs: 15000, token: controlToken(store) });
}

/** @param {{stateDir: string, key: string, requestId?: string, optionId?: string, cancel?: boolean}} input */
export function answerPermission(input) {
  const store = storeFor(input.stateDir, input.key);
  return callControl(
    store.socketPath,
    'permission',
    { requestId: input.requestId, optionId: input.optionId, cancel: input.cancel },
    { timeoutMs: 15000, token: controlToken(store) },
  );
}

/** @param {{stateDir: string, key: string}} input */
export async function stopSession(input) {
  const store = storeFor(input.stateDir, input.key);
  const workerPid = store.readMeta()?.pid;
  const waitStopped = async () => {
    const deadline = Date.now() + 15000;
    while (pidAlive(workerPid)) {
      if (Date.now() >= deadline) throw fail(ERROR_CODES.state_error, 'Worker shutdown did not finish within 15 seconds');
      await sleep(25);
    }
  };
  try {
    const result = await callControl(store.socketPath, 'stop', {}, { timeoutMs: 15000, token: controlToken(store) });
    await waitStopped();
    return { ...result, stopping: false, stopped: true, key: input.key };
  } catch (err) {
    if (err && typeof err === 'object' && err.code === ERROR_CODES.session_not_running) {
      await waitStopped();
      return { ok: true, stopping: false, alreadyStopped: true, key: input.key };
    }
    throw err;
  }
}

/** @param {string} stateDir */
export async function listSessions(stateDir) {
  const keys = listSessionKeys(stateDir);
  const sessions = [];
  for (const key of keys) {
    const store = new SessionStore(stateDir, key);
    if (!store.exists()) continue;
    let meta;
    try {
      meta = store.readMeta();
    } catch {
      sessions.push({ key, status: 'unreadable' });
      continue;
    }
    const token = controlToken(store);
    const ping =
      controlEndpointExists(store.socketPath) || IS_WINDOWS
        ? await pingControl(store.socketPath, { timeoutMs: 1000, token })
        : { alive: false };
    // A worker that claims to be live but neither answers its socket nor has a
    // live pid is orphaned: the directory remains, the process is gone.
    const orphaned = !ping.alive && ['ready', 'starting'].includes(meta.status ?? '') && !pidAlive(meta.pid);
    sessions.push({
      key,
      backend: meta.backend ?? null,
      workspace: redactPath(meta.workspace ?? null),
      status: meta.status ?? 'unknown',
      alive: ping.alive === true,
      orphaned,
      sessionId: meta.sessionId ?? null,
      resumable: meta.resume?.supported ?? null,
      model: meta.model ?? null,
      effort: meta.effort ?? null,
      turn: meta.turn ?? null,
      updatedAt: meta.updatedAt ?? null,
    });
  }
  return sessions;
}

/**
 * Sweep session directories whose workers are dead: reap stale endpoints and
 * orphaned backend processes, and mark the metadata so `sessions` reports the
 * truth instead of a phantom live session.
 * @param {{stateDir: string}} input
 */
export async function cleanupSessions(input) {
  const keys = listSessionKeys(input.stateDir);
  const reaped = [];
  for (const key of keys) {
    const store = new SessionStore(input.stateDir, key);
    if (!store.exists()) continue;
    let meta;
    try {
      meta = store.readMeta();
    } catch {
      continue;
    }
    const token = controlToken(store);
    const ping =
      controlEndpointExists(store.socketPath) || IS_WINDOWS
        ? await pingControl(store.socketPath, { timeoutMs: 1000, token })
        : { alive: false };
    if (ping.alive) continue;
    if (!['ready', 'starting'].includes(meta.status ?? '')) continue;
    const result = await reapDeadWorker(store, meta);
    meta.status = 'orphaned';
    meta.lastError = { code: 'worker_orphaned', message: 'Worker process is gone; session state preserved on disk' };
    meta.updatedAt = new Date().toISOString();
    store.writeMeta(meta);
    reaped.push({ key, backend: meta.backend ?? null, sessionId: meta.sessionId ?? null, ...result });
  }
  return { reaped };
}
