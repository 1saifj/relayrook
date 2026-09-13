import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EventLog,
  SessionStore,
  migrateSessionMeta,
  resolveRouteKey,
  resolveSocketPath,
  SESSION_SCHEMA_VERSION,
} from '../src/state.mjs';
import { checkLocalExecution, checkNode, checkTransport, runPreflight, MIN_NODE_VERSION } from '../src/preflight.mjs';
import { cleanupSessions } from '../src/sessions.mjs';
import { loadRouteEvidence } from '../src/routing.mjs';
import { pidAlive } from '../src/platform.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'relayrook-state-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('schema v1 metadata migrates on read and a newer schema is refused', () => {
  const migrated = migrateSessionMeta({ key: 'k', backend: 'devin', status: 'stopped' });
  assert.equal(migrated.schemaVersion, SESSION_SCHEMA_VERSION);
  assert.deepEqual(migrated.resume, { supported: null, mechanism: null, lastAttempt: null });
  assert.deepEqual(migrated.previousSessions, []);

  assert.throws(
    () => migrateSessionMeta({ schemaVersion: SESSION_SCHEMA_VERSION + 1 }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.state_error && err.details.schemaVersion === SESSION_SCHEMA_VERSION + 1,
  );
  assert.throws(
    () => migrateSessionMeta('nope'),
    (/** @type {any} */ err) => err.code === ERROR_CODES.state_error,
  );

  // Through the store: a v1 file on disk reads back migrated.
  const store = new SessionStore(tmp, 'legacy-key').ensure();
  writeFileSync(store.metaFile, JSON.stringify({ key: 'legacy-key', backend: 'devin', status: 'stopped' }));
  const read = store.readMeta();
  assert.equal(read.schemaVersion, SESSION_SCHEMA_VERSION);
  assert.equal(read.status, 'stopped');
});

test('the route-integrity key is minted once, persisted, and private', () => {
  const dir = path.join(tmp, 'routekey');
  const key = resolveRouteKey(dir);
  assert.equal(key.length, 32);
  const again = resolveRouteKey(dir);
  assert.deepEqual(again, key);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path.join(dir, 'route-integrity.key')).mode & 0o777, 0o600);
  }
});

test('a control token is minted and readable per session', () => {
  const store = new SessionStore(tmp, 'token-key').ensure();
  const token = store.mintControlToken();
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(store.readControlToken(), token);
  if (process.platform !== 'win32') {
    assert.equal(statSync(store.controlTokenFile).mode & 0o777, 0o600);
  }
});

test('over-long unix socket paths fall back to a short hashed endpoint', { skip: process.platform === 'win32' }, () => {
  const deep = path.join(tmp, 'a'.repeat(120), 'control.sock');
  const resolved = resolveSocketPath(deep, 'session-key');
  assert.ok(Buffer.byteLength(resolved) <= 100);
  assert.notEqual(resolved, deep);
  // Within the limit, the preferred path is used verbatim.
  const shallow = path.join(tmp, 'control.sock');
  assert.equal(resolveSocketPath(shallow, 'k'), shallow);
});

const SKIP_WINDOWS = { skip: process.platform === 'win32' };

test('transport preflight survives a state dir deeper than the socket limit', SKIP_WINDOWS, async () => {
  // The probe socket must resolve through the same hashed fallback sessions
  // use; a listen straight on the deep path fails EINVAL where the kernel's
  // sun_path is short (and would leave a socket inside the state dir where it
  // is longer).
  const deep = path.join(tmp, 'd'.repeat(90));
  mkdirSync(deep, { recursive: true });
  const probe = path.join(deep, '.transport-probe-x.sock');
  assert.ok(Buffer.byteLength(probe) > 100, 'fixture must exceed the socket path cap');
  const check = await checkTransport(deep);
  assert.equal(check.ok, true);
  assert.equal(check.mechanism, 'unix-socket');
  // The endpoint landed in the temp-dir fallback and was cleaned up — nothing
  // socket-shaped remains inside the deep state dir.
  assert.equal(readdirSync(deep).filter((f) => f.endsWith('.sock')).length, 0);
});

test('node, local-execution, state-dir and transport preflights pass here', async () => {
  assert.equal(checkNode().ok, true);
  const [major, minor, patch] = MIN_NODE_VERSION;
  assert.ok(major >= 22 && minor >= 13 && patch >= 0);
  assert.equal((await checkLocalExecution()).ok, true);
  const dir = path.join(tmp, 'preflight');
  mkdirSync(dir, { recursive: true });
  assert.equal((await checkTransport(dir)).ok, true);
  const report = await runPreflight({ stateDir: dir });
  assert.equal(report.ok, true);
  assert.deepEqual(report.blockers, []);
});

test('preflight reports a missing backend with a typed code, not a spawn error', async () => {
  const report = await runPreflight({
    stateDir: path.join(tmp, 'preflight-missing'),
    backend: 'kiro',
    env: { PATH: '/nonexistent-only' },
  });
  assert.equal(report.ok, false);
  const blocker = report.blockers.find((b) => b.check === 'backend');
  assert.equal(blocker.code, ERROR_CODES.backend_not_installed);
});

test('route evidence is absent, malformed, or a parsed routes map', () => {
  const dir = path.join(tmp, 'evidence');
  assert.equal(loadRouteEvidence(dir), null);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'route-evidence.json'), '{not json');
  assert.equal(loadRouteEvidence(dir), null);
  writeFileSync(path.join(dir, 'route-evidence.json'), JSON.stringify({ nope: true }));
  assert.equal(loadRouteEvidence(dir), null);
  const good = { routes: { 'implementation|devin|swe-2-max|': { runs: 3, successRate: 1 } } };
  writeFileSync(path.join(dir, 'route-evidence.json'), JSON.stringify(good));
  assert.deepEqual(loadRouteEvidence(dir), good);
});

test('cleanup marks a dead worker as orphaned and reaps its stale endpoint', async () => {
  const store = new SessionStore(tmp, 'orphan-key').ensure();
  store.writeMeta({
    schemaVersion: SESSION_SCHEMA_VERSION,
    key: 'orphan-key',
    backend: 'devin',
    workspace: tmp,
    status: 'ready',
    pid: 999999999, // not a live pid
    backendPid: null,
    sessionId: 's-1',
  });
  if (process.platform !== 'win32') {
    writeFileSync(store.socketPath, '');
  }
  const result = await cleanupSessions({ stateDir: tmp });
  const reaped = result.reaped.find((r) => r.key === 'orphan-key');
  assert.ok(reaped, 'the orphaned session must be reaped');
  const meta = store.readMeta();
  assert.equal(meta.status, 'orphaned');
  if (process.platform !== 'win32') {
    assert.equal(existsSync(store.socketPath), false);
  }
});

test('pidAlive distinguishes live and dead processes', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(999999999), false);
  assert.equal(pidAlive(null), false);
});

test('a worker-written meta round-trips with the current schema version', () => {
  const store = new SessionStore(tmp, 'schema-key').ensure();
  store.writeMeta({ schemaVersion: SESSION_SCHEMA_VERSION, key: 'schema-key', status: 'ready' });
  const read = JSON.parse(readFileSync(store.metaFile, 'utf8'));
  assert.equal(read.schemaVersion, SESSION_SCHEMA_VERSION);
  assert.equal(store.readMeta().key, 'schema-key');
  const log = new EventLog(store).load();
  assert.equal(log.nextCursor, 1);
});
