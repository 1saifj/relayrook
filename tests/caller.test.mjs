import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveCaller,
  assertNoRecursion,
  childRouteEnvelope,
  routeEnvelopeEnv,
  parseRouteEnvelope,
  collectEnvEvidence,
  normalizeCallerId,
  signEnvelopePayload,
  CALLER_CONFIDENCE,
  ROUTE_ENV_VAR,
} from '../src/caller.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

const TEST_KEY = Buffer.alloc(32, 7);

test('explicit --caller wins over conflicting environment evidence', () => {
  const state = resolveCaller({
    explicitCaller: 'claude-code',
    env: { CODEX_THREAD_ID: 'thread-1', CODEX_SESSION_ID: 'session-1' },
    parentProcess: { pid: 42, command: 'codex' },
  });
  assert.equal(state.immediateParent, 'claude-code');
  assert.equal(state.confidence, CALLER_CONFIDENCE.explicit);
  assert.ok(state.conflicts.some((c) => c.kind === 'environment-disagrees' && c.host === 'codex'));
});

test('router-owned delegation metadata outranks environment inference', () => {
  const envelope = {
    rootCaller: 'claude-code',
    parent: 'relayrook',
    routeId: 'route-9',
    depth: 2,
    ancestry: ['devin'],
  };
  envelope.integrity = signEnvelopePayload(envelope, TEST_KEY);
  const env = { CODEX_THREAD_ID: 'thread-1', [ROUTE_ENV_VAR]: JSON.stringify(envelope) };
  const state = resolveCaller({ env, parentProcess: null, routeKey: TEST_KEY });
  assert.equal(state.confidence, CALLER_CONFIDENCE.delegated);
  assert.equal(state.rootCaller, 'claude-code');
  assert.equal(state.immediateParent, 'relayrook');
  assert.equal(state.depth, 2);
  assert.deepEqual(state.ancestry, ['devin']);
});

test('an unsigned or forged route envelope is refused, not trusted', () => {
  const unsigned = {
    [ROUTE_ENV_VAR]: JSON.stringify({ rootCaller: 'x', parent: 'relayrook', routeId: 'r', depth: 1, ancestry: [] }),
  };
  assert.throws(
    () => resolveCaller({ env: unsigned, parentProcess: null, routeKey: TEST_KEY }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.route_envelope_invalid,
  );

  const forged = {
    rootCaller: 'x', parent: 'relayrook', routeId: 'r', depth: 1, ancestry: [],
    integrity: signEnvelopePayload(
      { rootCaller: 'x', parent: 'relayrook', routeId: 'r', depth: 1, ancestry: [] },
      Buffer.alloc(32, 1),
    ),
  };
  assert.throws(
    () => resolveCaller({ env: { [ROUTE_ENV_VAR]: JSON.stringify(forged) }, parentProcess: null, routeKey: TEST_KEY }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.route_envelope_invalid,
  );

  // An envelope minted without a key stays untrusted: parsing reports it and
  // resolution refuses it when the resolver has a key to check against.
  const parsed = parseRouteEnvelope(unsigned, TEST_KEY);
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.trusted, false);
  assert.equal(parsed.unsigned, true);
});

test('arbitrary normalized host ids are accepted; malformed ids are not', () => {
  assert.equal(normalizeCallerId('My_Custom-Host'), 'my_custom-host');
  assert.equal(normalizeCallerId('harness_9'), 'harness_9');
  assert.equal(normalizeCallerId('has.dot'), null);
  assert.equal(normalizeCallerId('bad id!'), null);
  assert.equal(normalizeCallerId(''), null);
  assert.equal(normalizeCallerId(42), null);
  const state = resolveCaller({ explicitCaller: 'Future-Harness_9', env: {}, parentProcess: null });
  assert.equal(state.immediateParent, 'future-harness_9');
  assert.equal(state.knownHost, false);
  assert.equal(state.confidence, CALLER_CONFIDENCE.explicit);
  assert.throws(
    () => resolveCaller({ explicitCaller: 'bad id!', env: {}, parentProcess: null }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.usage,
  );
});

test('a single host signal is inferred, not asserted', () => {
  const state = resolveCaller({ env: { OPENCODE_SESSION_ID: 'x' }, parentProcess: null });
  assert.equal(state.confidence, CALLER_CONFIDENCE.inferred);
  assert.equal(state.immediateParent, 'opencode');
  assert.match(state.reason, /inherited/);
});

test('conflicting host signals are reported as ambiguous with candidates', () => {
  const state = resolveCaller({
    env: { CODEX_THREAD_ID: 'a', CLAUDECODE: '1' },
    parentProcess: null,
  });
  assert.equal(state.ambiguous, true);
  assert.equal(state.immediateParent, null);
  assert.deepEqual(state.candidates, ['claude-code', 'codex']);
  assert.match(state.reason, /--caller/);
});

test('no evidence resolves to unknown with a reason', () => {
  const state = resolveCaller({ env: {}, parentProcess: null });
  assert.equal(state.confidence, CALLER_CONFIDENCE.none);
  assert.equal(state.rootCaller, null);
  assert.equal(state.ambiguous, false);
});

test('the parent process name is only inference-grade evidence', () => {
  const state = resolveCaller({ env: {}, parentProcess: { pid: 7, command: '/opt/homebrew/bin/codex' } });
  assert.equal(state.confidence, CALLER_CONFIDENCE.inferred);
  assert.equal(state.immediateParent, 'codex');
});

test('environment evidence records variable names only, never values', () => {
  const evidence = collectEnvEvidence({ CODEX_THREAD_ID: 'secret-thread-value' });
  assert.deepEqual(evidence, [{ host: 'codex', variables: ['CODEX_THREAD_ID'] }]);
  assert.ok(!JSON.stringify(evidence).includes('secret-thread-value'));
});

test('a malformed route envelope is rejected instead of resetting ancestry', () => {
  const parsed = parseRouteEnvelope({ [ROUTE_ENV_VAR]: '{not json' });
  assert.equal(parsed.malformed, true);
  assert.throws(
    () => resolveCaller({ env: { [ROUTE_ENV_VAR]: '{not json' }, parentProcess: null }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.route_envelope_invalid,
  );
});

test('delegation depth is bounded', () => {
  assert.throws(
    () => assertNoRecursion({ callerState: { depth: 3, ancestry: [] }, backend: 'devin', maxDepth: 3 }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.recursion_depth_exceeded,
  );
  assert.doesNotThrow(() => assertNoRecursion({ callerState: { depth: 2, ancestry: [] }, backend: 'devin', maxDepth: 3 }));
});

test('a backend already in the ancestry is refused unless explicitly allowed', () => {
  const callerState = { depth: 1, ancestry: ['devin'] };
  assert.throws(
    () => assertNoRecursion({ callerState, backend: 'devin' }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.recursive_backend,
  );
  assert.doesNotThrow(() => assertNoRecursion({ callerState, backend: 'devin', allowRepeatBackend: true }));
  assert.doesNotThrow(() => assertNoRecursion({ callerState, backend: 'kiro' }));
});

test('the child envelope records root caller, parent, depth, ancestry and a signature', () => {
  const callerState = { rootCaller: 'codex', immediateParent: 'codex', depth: 0, ancestry: [] };
  const envelope = childRouteEnvelope({ callerState, backend: 'devin', routeId: 'r1', routeKey: TEST_KEY });
  assert.equal(envelope.rootCaller, 'codex');
  assert.equal(envelope.parent, 'relayrook');
  assert.equal(envelope.routeId, 'r1');
  assert.equal(envelope.depth, 1);
  assert.deepEqual(envelope.ancestry, ['devin']);
  assert.match(envelope.integrity, /^v1\.[0-9a-f]{64}$/);
  const env = routeEnvelopeEnv(envelope);
  const parsed = parseRouteEnvelope(env, TEST_KEY);
  assert.deepEqual(parsed.ancestry, ['devin']);
  assert.equal(parsed.trusted, true);
});

test('depth and ancestry accumulate across hops', () => {
  let state = resolveCaller({ explicitCaller: 'codex', env: {}, parentProcess: null });
  let env = routeEnvelopeEnv(childRouteEnvelope({ callerState: state, backend: 'devin', routeId: 'r1', routeKey: TEST_KEY }));
  state = resolveCaller({ env, parentProcess: null, routeKey: TEST_KEY });
  assert.equal(state.depth, 1);

  env = routeEnvelopeEnv(childRouteEnvelope({ callerState: state, backend: 'kiro', routeId: 'r2', routeKey: TEST_KEY }));
  state = resolveCaller({ env, parentProcess: null, routeKey: TEST_KEY });
  assert.equal(state.depth, 2);
  assert.deepEqual(state.ancestry, ['devin', 'kiro']);
  assert.equal(state.rootCaller, 'codex');
});
