import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { fail, ERROR_CODES } from './errors.mjs';
import { writeJsonAtomic, truncateText } from './util.mjs';
import { IS_WINDOWS, chmodPrivate, defaultStateBase, resolveControlEndpoint } from './platform.mjs';

/**
 * State lives outside the target repository by default so delegating work never
 * dirties the workspace being changed or reviewed.
 */
export const DEFAULT_STATE_DIR_ENV = 'RELAYROOK_STATE_DIR';

/**
 * Session metadata schema. Version 1 sessions (pre-0.2) carried no
 * `schemaVersion`; they are migrated on read. A metadata file written by a
 * newer RelayRook is rejected rather than misinterpreted.
 */
export const SESSION_SCHEMA_VERSION = 2;

export const LIMITS = Object.freeze({
  /** Events kept addressable in the rolling log; older cursors report a gap. */
  maxRetainedEvents: 2000,
  /** Per-event text kept in the rolling log. Full text stays in the turn log. */
  maxEventTextChars: 8192,
  /** Per-turn answer text kept in memory before it is flushed to disk. */
  maxAnswerChars: 1024 * 1024,
});

/**
 * Unix domain socket paths are capped by `sun_path` — 104 bytes on macOS, 108
 * on Linux. A deep state directory would otherwise fail with EINVAL at listen
 * time, so an over-long socket path falls back to a short name in the system
 * temp directory. Both the CLI and the worker derive it the same way from
 * (stateDir, key), so they always agree on where the socket is.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

/**
 * @param {string} preferred @param {string} key
 * @returns {string} the control endpoint: a filesystem socket path on Unix, a
 *   `\\.\pipe\` name on Windows.
 */
export function resolveSocketPath(preferred, key) {
  if (IS_WINDOWS) return resolveControlEndpoint(preferred, key);
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const privateDir = path.join(os.tmpdir(), `relayrook-${uid}`);
  const digest = createHash('sha256').update(preferred).digest('hex').slice(0, 12);
  return path.join(privateDir, `${key}-${digest}.sock`);
}

/**
 * Fail closed on the shared-temp socket directory. The tmpdir fallback is a
 * predictable path (`os.tmpdir()/relayrook-<uid>`) that any local user can
 * pre-create; a permissive or foreign-owned directory would let another user
 * unlink the control socket and bind an impostor at the known path. Require a
 * real directory, owned by this user, mode 0700 — anything else is
 * `state_error`, never a silent chmod failure.
 * @param {string} dir
 */
export function assertPrivateSocketDir(dir) {
  let st;
  try {
    st = lstatSync(dir);
  } catch (err) {
    throw fail(ERROR_CODES.state_error, `Socket directory ${dir} is not accessible: ${err.message}`);
  }
  const owned = typeof process.getuid !== 'function' || st.uid === process.getuid();
  if (!st.isDirectory() || !owned || (st.mode & 0o777) !== 0o700) {
    throw fail(
      ERROR_CODES.state_error,
      `Socket directory ${dir} must be a real directory owned by this user with mode 0700`,
      { dir, mode: st.isDirectory() ? (st.mode & 0o777).toString(8) : null, owned },
    );
  }
}

/** @param {string|undefined|null} explicit */
export function resolveStateDir(explicit, env = process.env) {
  if (explicit) return path.resolve(explicit);
  const fromEnv = env[DEFAULT_STATE_DIR_ENV];
  if (fromEnv) return path.resolve(fromEnv);
  return defaultStateBase(env);
}

/**
 * Load (or mint) the HMAC key that signs route envelopes. The file is created
 * mode 0600 on Unix; on Windows it relies on the per-user profile ACL, like
 * every other file in the state directory.
 * @param {string} stateDir
 * @returns {Buffer}
 */
export function resolveRouteKey(stateDir) {
  const keyFile = path.join(stateDir, 'route-integrity.key');
  try {
    const raw = readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  } catch {
    // fall through to mint
  }
  const key = randomBytes(32);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, `${key.toString('hex')}\n`, { mode: 0o600 });
  chmodPrivate(keyFile, 0o600);
  return key;
}

/**
 * Migrate persisted session metadata to the current schema version. Metadata
 * written by a newer RelayRook is a state error, not a guess.
 * @param {any} meta
 */
export function migrateSessionMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    throw fail(ERROR_CODES.state_error, 'Session metadata is not an object');
  }
  const version = Number.isInteger(meta.schemaVersion) ? meta.schemaVersion : 1;
  if (version > SESSION_SCHEMA_VERSION) {
    throw fail(
      ERROR_CODES.state_error,
      `Session ${meta.session ?? meta.key ?? '?'} was written by a newer RelayRook (schema v${version}); upgrade to read it`,
      { schemaVersion: version, supported: SESSION_SCHEMA_VERSION },
    );
  }
  const migrated = { ...meta, schemaVersion: SESSION_SCHEMA_VERSION };
  if (version < 2) {
    migrated.resume = meta.resume ?? { supported: null, mechanism: null, lastAttempt: null };
    migrated.previousSessions = Array.isArray(meta.previousSessions) ? meta.previousSessions : [];
    migrated.backendPid = meta.backendPid ?? null;
  }
  return migrated;
}

/**
 * Directory layout for one persistent worker session.
 *
 *   <stateDir>/sessions/<key>/
 *     meta.json          crash-safe session metadata (schemaVersion 2)
 *     request.json       the launch spec the worker was started with
 *     events.jsonl       rolling, bounded, cursor-addressable event log
 *     control.sock       worker control socket (Unix; named pipe on Windows)
 *     control.token      shared secret required on every control request
 *     worker.log         worker stderr/stdout diagnostics
 *     turns/<turnId>/    full per-turn record (prompt, events, answer, result)
 */
export class SessionStore {
  /** @param {string} stateDir @param {string} key */
  constructor(stateDir, key) {
    this.stateDir = stateDir;
    this.key = key;
    this.dir = path.join(stateDir, 'sessions', key);
    this.metaFile = path.join(this.dir, 'meta.json');
    this.requestFile = path.join(this.dir, 'request.json');
    this.startLockFile = path.join(this.dir, 'start.lock');
    this.eventsFile = path.join(this.dir, 'events.jsonl');
    this.socketPath = resolveSocketPath(path.join(this.dir, 'control.sock'), key);
    this.controlTokenFile = path.join(this.dir, 'control.token');
    this.logFile = path.join(this.dir, 'worker.log');
    this.turnsDir = path.join(this.dir, 'turns');
  }

  ensure() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodPrivate(this.dir, 0o700);
    mkdirSync(this.turnsDir, { recursive: true, mode: 0o700 });
    if (!IS_WINDOWS) {
      const socketDir = path.dirname(this.socketPath);
      mkdirSync(socketDir, { recursive: true, mode: 0o700 });
      chmodPrivate(socketDir, 0o700);
      // The shared-temp fallback path is predictable; verify it really is a
      // private directory rather than trusting a chmod that may have failed.
      if (socketDir !== this.dir) assertPrivateSocketDir(socketDir);
    }
    return this;
  }

  exists() {
    return existsSync(this.metaFile);
  }

  /**
   * Mint the control token for this session. The worker writes it before it
   * starts listening; every control request must echo it.
   * @returns {string}
   */
  mintControlToken() {
    const token = randomBytes(24).toString('hex');
    writeFileSync(this.controlTokenFile, `${token}\n`, { mode: 0o600 });
    chmodPrivate(this.controlTokenFile, 0o600);
    return token;
  }

  /** @returns {string|null} */
  readControlToken() {
    try {
      const token = readFileSync(this.controlTokenFile, 'utf8').trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  /** @returns {any} migrated to the current schema version */
  readMeta() {
    if (!existsSync(this.metaFile)) {
      throw fail(ERROR_CODES.session_not_found, `No session state at ${this.key}`, { key: this.key });
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.metaFile, 'utf8'));
    } catch (err) {
      throw fail(ERROR_CODES.state_error, `Corrupt session metadata: ${err instanceof Error ? err.message : err}`);
    }
    return migrateSessionMeta(parsed);
  }

  /** @param {any} meta */
  writeMeta(meta) {
    writeJsonAtomic(this.metaFile, meta);
  }

  /** @param {any} spec */
  writeRequest(spec) {
    writeJsonAtomic(this.requestFile, spec);
  }

  readRequest() {
    return JSON.parse(readFileSync(this.requestFile, 'utf8'));
  }

  /** @param {string} turnId */
  turnDir(turnId) {
    return path.join(this.turnsDir, turnId);
  }

  remove() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * Append-only event log with monotonic cursors and bounded retention.
 *
 * `status --cursor N` replays from N. Retention drops the oldest events once the
 * log exceeds `maxRetainedEvents`; a caller whose cursor predates the retained
 * window is told `cursorGap: true` instead of being handed a silently
 * incomplete stream.
 */
export class EventLog {
  /** @param {SessionStore} store @param {{maxRetainedEvents?: number}} [options] */
  constructor(store, options = {}) {
    this.store = store;
    this.maxRetainedEvents = options.maxRetainedEvents ?? LIMITS.maxRetainedEvents;
    /** @type {any[]} */
    this.events = [];
    this.nextCursor = 1;
    this.retainedFrom = 1;
    this.droppedCount = 0;
  }

  /** Rebuild in-memory state from an existing log (worker restart / CLI read). */
  load() {
    if (!existsSync(this.store.eventsFile)) return this;
    const lines = readFileSync(this.store.eventsFile, 'utf8').split('\n');
    /** @type {any[]} */
    const events = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // A partially written final line is dropped; cursors stay monotonic.
      }
    }
    this.events = events;
    this.nextCursor = events.length > 0 ? events[events.length - 1].cursor + 1 : 1;
    this.retainedFrom = events.length > 0 ? events[0].cursor : 1;
    return this;
  }

  /**
   * @param {{kind: string, turnId?: string|null, [k: string]: any}} event
   * @returns {any} the stored event, including its assigned cursor
   */
  append(event) {
    /** @type {any} */
    const stored = { cursor: this.nextCursor, ts: new Date().toISOString(), ...event };
    if (typeof stored.text === 'string') {
      const { text, truncated, originalLength } = truncateText(stored.text, LIMITS.maxEventTextChars);
      stored.text = text;
      if (truncated) {
        stored.truncated = true;
        stored.originalLength = originalLength;
      }
    }
    this.nextCursor += 1;
    this.events.push(stored);
    appendFileSync(this.store.eventsFile, `${JSON.stringify(stored)}\n`);
    this.#trim();
    return stored;
  }

  #trim() {
    if (this.events.length <= this.maxRetainedEvents) return;
    const overflow = this.events.length - this.maxRetainedEvents;
    this.events.splice(0, overflow);
    this.droppedCount += overflow;
    this.retainedFrom = this.events.length > 0 ? this.events[0].cursor : this.nextCursor;
    // Rewrite the log so the file matches the retained window exactly.
    writeFileSync(this.store.eventsFile, this.events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }

  /**
   * @param {{cursor?: number, limit?: number, turnId?: string|null}} [query]
   */
  read(query = {}) {
    const cursor = Number.isFinite(query.cursor) ? Number(query.cursor) : 0;
    const limit = Number.isFinite(query.limit) ? Number(query.limit) : 200;
    const cursorGap = cursor > 0 && cursor + 1 < this.retainedFrom;
    let selected = this.events.filter((e) => e.cursor > cursor);
    if (query.turnId) selected = selected.filter((e) => e.turnId === query.turnId);
    const page = selected.slice(0, Math.max(1, limit));
    return {
      events: page,
      nextCursor: page.length > 0 ? page[page.length - 1].cursor : cursor,
      hasMore: selected.length > page.length,
      cursorGap,
      retainedFrom: this.retainedFrom,
      droppedCount: this.droppedCount,
      latestCursor: this.nextCursor - 1,
    };
  }
}

/** @param {string} stateDir */
export function listSessionKeys(stateDir) {
  const dir = path.join(stateDir, 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Persist a complete per-turn record. The rolling event log is bounded; this is
 * not, so a caller can always recover the full transcript of one turn.
 * @param {SessionStore} store
 * @param {string} turnId
 * @param {{prompt?: string, answer?: string, result?: any, events?: any[]}} record
 */
export function writeTurnRecord(store, turnId, record) {
  const dir = store.turnDir(turnId);
  mkdirSync(dir, { recursive: true });
  if (record.prompt !== undefined) writeFileSync(path.join(dir, 'prompt.txt'), record.prompt);
  if (record.answer !== undefined) writeFileSync(path.join(dir, 'answer.txt'), record.answer);
  if (record.result !== undefined) writeJsonAtomic(path.join(dir, 'result.json'), record.result);
  if (record.events !== undefined) {
    writeFileSync(path.join(dir, 'events.jsonl'), record.events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
  return dir;
}

/** Append an answer chunk without retaining an unbounded transcript in memory. */
export function appendTurnAnswer(store, turnId, text) {
  const dir = store.turnDir(turnId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(path.join(dir, 'answer.txt'), text);
}
