import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { callControl, pingControl } from './control.mjs';
import { EventLog, SessionStore, listSessionKeys } from './state.mjs';
import { fail, ERROR_CODES } from './errors.mjs';
import { getBackend } from './backends.mjs';
import { sessionKey, sleep, redactPath } from './util.mjs';
import { resolveClaudeAdapter } from './discovery.mjs';

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
 * Create or reuse a persistent session.
 *
 * Reuse is keyed on backend, workspace, model, effort and security profile, and
 * confirmed by an actual ping — a leftover socket file is not proof of a live
 * worker.
 *
 * @param {{
 *   stateDir: string,
 *   backend: string,
 *   workspace: string,
 *   model?: string|null,
 *   effort?: string|null,
 *   profile?: string,
 *   caller?: any,
 *   route?: any,
 *   env?: Record<string, string>,
 *   reuse?: boolean,
 *   idleTimeoutMs?: number,
 *   startTimeoutMs?: number,
 *   maxLineBytes?: number,
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
  const lockFd = await acquireStartLock(store, startTimeoutMs);

  try {
    if (existsSync(store.socketPath)) {
      const ping = await pingControl(store.socketPath);
      if (spec.reuse !== false && ping.alive && ping.result?.status === 'ready') {
        return { key, reused: true, meta: ping.result.meta, dir: redactPath(store.dir) };
      }
      if (ping.alive) {
        throw fail(ERROR_CODES.active_turn, 'A live session already owns this key', { key });
      }
      unlinkSync(store.socketPath);
    }

    const override = backendCommandOverride(spec.backend, process.env);
    const launch = resolveLaunchCommand(backend, spec.stateDir, override);

    const request = {
    backend: spec.backend,
    workspace,
    model: spec.model ?? null,
    effort: spec.effort ?? null,
    profile: spec.profile ?? 'default',
    caller: spec.caller ?? null,
    route: spec.route ?? null,
    env: spec.env ?? {},
    idleTimeoutMs: spec.idleTimeoutMs,
    maxLineBytes: spec.maxLineBytes,
    commandOverride: launch.command,
    argsOverride: launch.extraArgs,
    createdAt: new Date().toISOString(),
    };
    store.writeRequest(request);
    store.writeMeta({ key, backend: spec.backend, workspace, status: 'starting', startedAt: new Date().toISOString() });

    const workerEntry = fileURLToPath(new URL('./worker-entry.mjs', import.meta.url));
    const logFd = openSync(store.logFile, 'a');
    const child = spawn(process.execPath, [workerEntry, '--session-dir', store.dir], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ...(spec.env ?? {}) },
    });
    closeSync(logFd);
    child.unref();

    const meta = await waitForReady(store, startTimeoutMs);
    return { key, reused: false, meta, dir: redactPath(store.dir) };
  } finally {
    closeSync(lockFd);
    try { unlinkSync(store.startLockFile); } catch {}
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
        try { unlinkSync(store.startLockFile); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw fail(
          ERROR_CODES.worker_start_failed,
          `Timed out waiting for session start lock after ${timeoutMs}ms`,
          { key: store.key },
        );
      }
      await sleep(100);
    }
  }
}

/**
 * Resolve the executable to launch, including the Claude adapter's
 * bootstrapped location, and report a typed error when it is not there.
 * @param {any} backend
 * @param {string} stateDir
 * @param {{command: string, args: string[]}|null} override
 */
export function resolveLaunchCommand(backend, stateDir, override) {
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
  return { command: undefined, extraArgs: undefined };
}

/**
 * @param {SessionStore} store
 * @param {number} timeoutMs
 */
async function waitForReady(store, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastMeta = null;
  while (Date.now() < deadline) {
    if (existsSync(store.socketPath)) {
      const ping = await pingControl(store.socketPath, 3000);
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
    { timeoutMs: 30000 },
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
      { timeoutMs: 15000 },
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
        try { answer = readFileSync(path.join(dir, 'answer.txt'), 'utf8'); } catch {}
        try { persistedResult = JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')); } catch {}
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
  return callControl(store.socketPath, 'cancel', { turnId: input.turnId }, { timeoutMs: 15000 });
}

/** @param {{stateDir: string, key: string, requestId?: string, optionId?: string, cancel?: boolean}} input */
export function answerPermission(input) {
  const store = storeFor(input.stateDir, input.key);
  return callControl(
    store.socketPath,
    'permission',
    { requestId: input.requestId, optionId: input.optionId, cancel: input.cancel },
    { timeoutMs: 15000 },
  );
}

/** @param {{stateDir: string, key: string}} input */
export async function stopSession(input) {
  const store = storeFor(input.stateDir, input.key);
  try {
    const result = await callControl(store.socketPath, 'stop', {}, { timeoutMs: 15000 });
    return { ...result, key: input.key };
  } catch (err) {
    if (err && typeof err === 'object' && err.code === ERROR_CODES.session_not_running) {
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
    const ping = existsSync(store.socketPath) ? await pingControl(store.socketPath, 1000) : { alive: false };
    sessions.push({
      key,
      backend: meta.backend ?? null,
      workspace: redactPath(meta.workspace ?? null),
      status: meta.status ?? 'unknown',
      alive: ping.alive === true,
      model: meta.model ?? null,
      effort: meta.effort ?? null,
      turn: meta.turn ?? null,
      updatedAt: meta.updatedAt ?? null,
    });
  }
  return sessions;
}
