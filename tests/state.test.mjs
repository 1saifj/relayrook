import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventLog, SessionStore, resolveStateDir, listSessionKeys, writeTurnRecord, LIMITS } from '../src/state.mjs';
import { JsonLineReader } from '../src/jsonline.mjs';
import { writeJsonAtomic, sessionKey, redactPath, truncateText } from '../src/util.mjs';
import { ERROR_CODES } from '../src/errors.mjs';
import { IS_WINDOWS } from '../src/platform.mjs';

/** @returns {string} */
function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'relayrook-state-'));
}

test('the state directory defaults outside any repository', () => {
  const explicit = resolveStateDir('/tmp/explicit', {});
  assert.equal(explicit, path.resolve('/tmp/explicit'));

  const fromEnv = resolveStateDir(null, { RELAYROOK_STATE_DIR: '/tmp/from-env' });
  assert.equal(fromEnv, path.resolve('/tmp/from-env'));

  const platformBase = path.resolve('/tmp/platform-state');
  const platformEnv = IS_WINDOWS ? { LOCALAPPDATA: platformBase } : { XDG_STATE_HOME: platformBase };
  assert.equal(resolveStateDir(null, platformEnv), path.join(platformBase, 'relayrook'));

  const fallback = resolveStateDir(null, {});
  const fallbackParts = IS_WINDOWS ? ['AppData', 'Local', 'relayrook'] : ['.local', 'state', 'relayrook'];
  assert.equal(fallback, path.join(os.homedir(), ...fallbackParts));
  assert.ok(path.isAbsolute(fallback));
});

test('session keys are stable and separate distinct models, efforts and profiles', () => {
  const a = sessionKey({ backend: 'devin', workspace: '/w', model: 'swe-2-max' });
  const b = sessionKey({ backend: 'devin', workspace: '/w', model: 'swe-2-max' });
  const c = sessionKey({ backend: 'devin', workspace: '/w', model: 'other' });
  const d = sessionKey({ backend: 'devin', workspace: '/w', model: 'swe-2-max', profile: 'review' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test('metadata writes are atomic and leave no temp file behind', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'nested', 'meta.json');
    writeJsonAtomic(file, { status: 'ready' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { status: 'ready' });
    writeJsonAtomic(file, { status: 'stopped' });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'stopped');
    assert.ok(existsSync(file));
    const leftovers = readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'the temp file must be renamed away, never left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reading missing session metadata is a typed error', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore(dir, 'nope');
    assert.throws(
      () => store.readMeta(),
      (/** @type {any} */ err) => err.code === ERROR_CODES.session_not_found,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('event cursors are monotonic and pageable', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore(dir, 'key1').ensure();
    const log = new EventLog(store);
    for (let i = 0; i < 10; i += 1) log.append({ kind: 'text', text: `chunk-${i}`, turnId: 't1' });

    const first = log.read({ cursor: 0, limit: 4 });
    assert.equal(first.events.length, 4);
    assert.equal(first.events[0].cursor, 1);
    assert.equal(first.nextCursor, 4);
    assert.equal(first.hasMore, true);
    assert.equal(first.cursorGap, false);

    const second = log.read({ cursor: first.nextCursor, limit: 100 });
    assert.equal(second.events[0].cursor, 5);
    assert.equal(second.hasMore, false);
    assert.equal(second.latestCursor, 10);

    const none = log.read({ cursor: 10 });
    assert.equal(none.events.length, 0);
    assert.equal(none.nextCursor, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('events can be filtered to one turn', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore(dir, 'key-turns').ensure();
    const log = new EventLog(store);
    log.append({ kind: 'text', text: 'a', turnId: 't1' });
    log.append({ kind: 'text', text: 'b', turnId: 't2' });
    log.append({ kind: 'text', text: 'c', turnId: 't1' });
    const page = log.read({ cursor: 0, turnId: 't1' });
    assert.deepEqual(page.events.map((e) => e.text), ['a', 'c']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bounded retention reports a cursor gap instead of silently dropping events', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore(dir, 'key2').ensure();
    const log = new EventLog(store, { maxRetainedEvents: 5 });
    for (let i = 0; i < 12; i += 1) log.append({ kind: 'text', text: `e${i}` });

    assert.equal(log.retainedFrom, 8);
    assert.equal(log.droppedCount, 7);

    const stale = log.read({ cursor: 2 });
    assert.equal(stale.cursorGap, true, 'a cursor older than the retained window must report a gap');

    const fresh = log.read({ cursor: 8 });
    assert.equal(fresh.cursorGap, false);
    assert.equal(fresh.events[0].cursor, 9);

    // The on-disk log matches the retained window exactly.
    const lines = readFileSync(store.eventsFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('oversized event text is truncated with the original length recorded', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore(dir, 'key3').ensure();
    const log = new EventLog(store);
    const big = 'X'.repeat(LIMITS.maxEventTextChars + 5000);
    const stored = log.append({ kind: 'text', text: big });
    assert.equal(stored.text.length, LIMITS.maxEventTextChars);
    assert.equal(stored.truncated, true);
    assert.equal(stored.originalLength, big.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an event log reloads its cursors after a restart', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore(dir, 'key4').ensure();
    const first = new EventLog(store);
    first.append({ kind: 'a' });
    first.append({ kind: 'b' });

    const reloaded = new EventLog(store).load();
    assert.equal(reloaded.nextCursor, 3);
    assert.equal(reloaded.read({ cursor: 0 }).events.length, 2);
    const next = reloaded.append({ kind: 'c' });
    assert.equal(next.cursor, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a torn final line in the event log is dropped without breaking cursors', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore(dir, 'key5').ensure();
    const log = new EventLog(store);
    log.append({ kind: 'a' });
    log.append({ kind: 'b' });
    // Simulate a crash part-way through appending a third event.
    appendFileSync(store.eventsFile, '{"cursor":3,"kind":"c"');

    const reloaded = new EventLog(store).load();
    assert.equal(reloaded.read({ cursor: 0 }).events.length, 2);
    assert.equal(reloaded.nextCursor, 3);
    assert.equal(reloaded.append({ kind: 'd' }).cursor, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('full per-turn records are written outside the bounded log', () => {
  const dir = tmpDir();
  try {
    const store = new SessionStore(dir, 'key6').ensure();
    const turnDir = writeTurnRecord(store, 'turn-1', {
      prompt: 'do the thing',
      answer: 'done',
      events: [{ cursor: 1, kind: 'text' }],
      result: { state: 'completed', stopReason: 'end_turn' },
    });
    assert.equal(readFileSync(path.join(turnDir, 'prompt.txt'), 'utf8'), 'do the thing');
    assert.equal(readFileSync(path.join(turnDir, 'answer.txt'), 'utf8'), 'done');
    assert.equal(JSON.parse(readFileSync(path.join(turnDir, 'result.json'), 'utf8')).stopReason, 'end_turn');
    assert.equal(readFileSync(path.join(turnDir, 'events.jsonl'), 'utf8').trim().split('\n').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session keys are listed from the state directory', () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(listSessionKeys(dir), []);
    new SessionStore(dir, 'aaa').ensure();
    new SessionStore(dir, 'bbb').ensure();
    assert.deepEqual(listSessionKeys(dir), ['aaa', 'bbb']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('home directories are redacted from any path we report', () => {
  const home = os.homedir();
  assert.equal(redactPath(path.join(home, 'secret', 'place')), path.join('~', 'secret', 'place'));
  assert.equal(redactPath('/opt/elsewhere'), '/opt/elsewhere');
  assert.equal(redactPath(null), null);
});

test('truncateText reports the original length', () => {
  assert.deepEqual(truncateText('abc', 10), { text: 'abc', truncated: false, originalLength: 3 });
  const long = truncateText('abcdef', 3);
  assert.deepEqual(long, { text: 'abc', truncated: true, originalLength: 6 });
});

test('a protocol line above the ceiling is dropped with a typed error, and the stream resynchronises', () => {
  /** @type {any[]} */
  const messages = [];
  /** @type {any[]} */
  const errors = [];
  const reader = new JsonLineReader({
    maxLineBytes: 1024,
    onMessage: (m) => messages.push(m),
    onError: (e) => errors.push(e),
  });

  reader.push(`${JSON.stringify({ id: 1 })}\n`);
  reader.push(`${JSON.stringify({ id: 2, payload: 'Y'.repeat(4000) })}\n`);
  reader.push(`${JSON.stringify({ id: 3 })}\n`);

  assert.deepEqual(messages.map((m) => m.id), [1, 3]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, ERROR_CODES.line_overflow);
  assert.equal(reader.droppedLines, 1);
});

test('an oversized line arriving in chunks is dropped before the buffer grows unbounded', () => {
  /** @type {any[]} */
  const messages = [];
  /** @type {any[]} */
  const errors = [];
  const reader = new JsonLineReader({
    maxLineBytes: 512,
    onMessage: (m) => messages.push(m),
    onError: (e) => errors.push(e),
  });
  for (let i = 0; i < 10; i += 1) reader.push('Z'.repeat(200));
  assert.equal(errors.length, 1);
  assert.ok(reader.buffer.length <= 512);
  reader.push(`tail-of-dropped-line\n${JSON.stringify({ id: 9 })}\n`);
  assert.deepEqual(messages.map((m) => m.id), [9]);
});

test('an unparseable line is reported without killing the stream', () => {
  /** @type {any[]} */
  const messages = [];
  /** @type {any[]} */
  const errors = [];
  const reader = new JsonLineReader({ onMessage: (m) => messages.push(m), onError: (e) => errors.push(e) });
  reader.push('{not json}\n');
  reader.push(`${JSON.stringify({ id: 5 })}\n`);
  assert.equal(errors[0].code, ERROR_CODES.protocol_error);
  assert.deepEqual(messages.map((m) => m.id), [5]);
});
