import assert from 'node:assert/strict';
import test from 'node:test';

import { route, ROLES, loadRouteTable, resolveEffortSupport, assertRole } from '../src/routing.mjs';
import { getBackend } from '../src/backends.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

/** @param {string[]} installed */
function inventory(installed) {
  return ['devin', 'kiro', 'opencode', 'claude', 'codex'].map((id) => ({
    id,
    evidence: { installed: installed.includes(id) },
  }));
}

const noCaller = { depth: 0, ancestry: [] };

test('every role has a configured candidate list', () => {
  const table = loadRouteTable();
  for (const role of ROLES) {
    assert.ok(Array.isArray(table.roles[role].candidates));
    assert.ok(table.roles[role].candidates.length > 0);
  }
  assert.equal(table.roles['code-review'].readOnly, true);
  assert.equal(table.roles['security-review'].readOnly, true);
  assert.equal(table.roles.implementation.readOnly, false);
  assert.equal(table.evidenceBasis, 'configured-preference');
});

test('unknown roles are rejected', () => {
  assert.throws(
    () => assertRole('refactor'),
    (/** @type {any} */ err) => err.code === ERROR_CODES.unknown_role,
  );
});

test('implementation prefers the pinned Devin route when Devin is installed', () => {
  const result = route({ role: 'implementation', inventory: inventory(['devin', 'kiro']), callerState: noCaller });
  assert.equal(result.selected.backend, 'devin');
  assert.equal(result.selected.model, 'swe-2-max');
  assert.equal(result.readOnly, false);
  assert.match(result.reason, /swe-2-max/);
});

test('uninstalled backends are rejected with a reason, not silently skipped', () => {
  const result = route({ role: 'implementation', inventory: inventory(['kiro']), callerState: noCaller });
  assert.equal(result.selected.backend, 'kiro');
  const devin = result.rejected.find((r) => r.backend === 'devin');
  assert.equal(devin.reason, 'not-installed');
});

test('Codex is rejected for session roles because its session control is unimplemented', () => {
  const result = route({
    role: 'code-review',
    inventory: inventory(['codex', 'kiro']),
    callerState: noCaller,
  });
  assert.notEqual(result.selected.backend, 'codex');
  const rejection = result.rejected.find((r) => r.backend === 'codex');
  // Codex is not in the code-review table at all, so the rejection only appears
  // when it is explicitly pinned; that case is covered below.
  assert.ok(rejection === undefined || rejection.reason === 'session-control-not-implemented');

  assert.throws(
    () =>
      route({
        role: 'code-review',
        pins: { agent: 'codex' },
        inventory: inventory(['codex']),
        callerState: noCaller,
      }),
    (/** @type {any} */ err) =>
      err.code === ERROR_CODES.pin_unsatisfiable &&
      err.details.rejected.some((r) => r.reason === 'session-control-not-implemented'),
  );
});

test('an agent pin narrows the field to exactly that backend', () => {
  const result = route({
    role: 'implementation',
    pins: { agent: 'opencode' },
    inventory: inventory(['devin', 'opencode']),
    callerState: noCaller,
  });
  assert.equal(result.selected.backend, 'opencode');
  assert.equal(result.pins.agent, 'opencode');
});

test('a model pin is carried through and never substituted', () => {
  const result = route({
    role: 'implementation',
    pins: { agent: 'opencode', model: 'opencode-go/qwen3.8-max' },
    inventory: inventory(['opencode']),
    callerState: noCaller,
  });
  assert.equal(result.selected.model, 'opencode-go/qwen3.8-max');
  assert.equal(result.selected.modelSource, 'pin');
});

test('an unsatisfiable pin is an error rather than a substitution', () => {
  assert.throws(
    () =>
      route({
        role: 'implementation',
        pins: { agent: 'devin' },
        inventory: inventory(['kiro']),
        callerState: noCaller,
      }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.pin_unsatisfiable,
  );
});

test('no installed backend produces no_eligible_route', () => {
  assert.throws(
    () => route({ role: 'security-review', inventory: inventory([]), callerState: noCaller }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.no_eligible_route,
  );
});

test('a backend in the delegation ancestry is filtered out by the recursion guard', () => {
  const result = route({
    role: 'code-review',
    inventory: inventory(['devin', 'kiro']),
    callerState: { depth: 1, ancestry: ['kiro'] },
  });
  assert.equal(result.selected.backend, 'devin');
  const kiro = result.rejected.find((r) => r.backend === 'kiro');
  assert.equal(kiro.reason, 'recursion-guard');
});

test('exceeding the delegation depth fails the whole route, not one candidate', () => {
  assert.throws(
    () =>
      route({
        role: 'implementation',
        inventory: inventory(['devin', 'kiro']),
        callerState: { depth: 3, ancestry: [] },
        policy: { maxDepth: 3 },
      }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.recursion_depth_exceeded,
  );
});

test('provider allow-lists and avoid-lists are honoured', () => {
  const allowed = route({
    role: 'implementation',
    inventory: inventory(['devin', 'opencode']),
    callerState: noCaller,
    policy: { allowedProviders: ['opencode'] },
  });
  assert.equal(allowed.selected.backend, 'opencode');
  assert.equal(allowed.rejected.find((r) => r.backend === 'devin').reason, 'provider-not-allowed');

  const avoided = route({
    role: 'implementation',
    inventory: inventory(['devin', 'kiro']),
    callerState: noCaller,
    policy: { avoidBackends: ['devin'] },
  });
  assert.equal(avoided.selected.backend, 'kiro');
  assert.equal(avoided.rejected.find((r) => r.backend === 'devin').reason, 'explicitly-avoided');
});

test('the billing route and provider travel with the selection', () => {
  const result = route({ role: 'implementation', inventory: inventory(['devin']), callerState: noCaller });
  assert.equal(result.selected.provider, 'devin');
  assert.equal(result.selected.billingRoute, 'devin-subscription');
});

test('effort support is reported honestly per backend', () => {
  assert.deepEqual(resolveEffortSupport(getBackend('kiro'), 'max'), {
    state: 'requested-verifiable',
    mechanism: 'launch-flag',
    verifiable: true,
  });
  assert.deepEqual(resolveEffortSupport(getBackend('opencode'), 'high'), {
    state: 'requested-if-advertised',
    mechanism: 'set_config_option',
    verifiable: true,
  });
  assert.deepEqual(resolveEffortSupport(getBackend('devin'), 'max'), {
    state: 'unsupported',
    mechanism: null,
    verifiable: false,
  });
  assert.equal(resolveEffortSupport(getBackend('devin'), null).state, 'not-requested');
});

test('a security review prefers an independent family over the implementation route', () => {
  const result = route({
    role: 'security-review',
    inventory: inventory(['devin', 'kiro']),
    callerState: { depth: 1, ancestry: ['devin'] },
  });
  assert.equal(result.selected.backend, 'kiro');
  assert.equal(result.readOnly, true);
});

test('runners-up are reported as lower-score rejections with their scores', () => {
  const result = route({ role: 'implementation', inventory: inventory(['devin', 'kiro']), callerState: noCaller });
  const kiro = result.rejected.find((r) => r.backend === 'kiro');
  assert.equal(kiro.reason, 'lower-score');
  assert.equal(typeof kiro.detail.score, 'number');
});
