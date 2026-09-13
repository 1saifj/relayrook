import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveCaller,
  assertNoRecursion,
  childRouteEnvelope,
  routeEnvelopeEnv,
  parseRouteEnvelope,
  collectEnvEvidence,
  CALLER_CONFIDENCE,
  ROUTE_ENV_VAR,
} from '../src/caller.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

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
  const env = {
    CODEX_THREAD_ID: 'thread-1',
    [ROUTE_ENV_VAR]: JSON.stringify({
      rootCaller: 'claude-code',
      parent: 'relayrook',
      routeId: 'route-9',
      depth: 2,
      ancestry: ['devin'],
    }),
  };
  const state = resolveCaller({ env, parentProcess: null });
  assert.equal(state.confidence, CALLER_CONFIDENCE.delegated);
  assert.equal(state.rootCaller, 'claude-code');
  assert.equal(state.immediateParent, 'relayrook');
  assert.equal(state.depth, 2);
  assert.deepEqual(state.ancestry, ['devin']);
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

test('the child envelope records root caller, parent, depth and ancestry', () => {
  const callerState = { rootCaller: 'codex', immediateParent: 'codex', depth: 0, ancestry: [] };
  const envelope = childRouteEnvelope({ callerState, backend: 'devin', routeId: 'r1' });
  assert.deepEqual(envelope, {
    rootCaller: 'codex',
    parent: 'relayrook',
    routeId: 'r1',
    depth: 1,
    ancestry: ['devin'],
  });
  const env = routeEnvelopeEnv(envelope);
  assert.deepEqual(parseRouteEnvelope(env).ancestry, ['devin']);
});

test('depth and ancestry accumulate across hops', () => {
  let state = resolveCaller({ explicitCaller: 'codex', env: {}, parentProcess: null });
  let env = routeEnvelopeEnv(childRouteEnvelope({ callerState: state, backend: 'devin', routeId: 'r1' }));
  state = resolveCaller({ env, parentProcess: null });
  assert.equal(state.depth, 1);

  env = routeEnvelopeEnv(childRouteEnvelope({ callerState: state, backend: 'kiro', routeId: 'r2' }));
  state = resolveCaller({ env, parentProcess: null });
  assert.equal(state.depth, 2);
  assert.deepEqual(state.ancestry, ['devin', 'kiro']);
  assert.equal(state.rootCaller, 'codex');
});
