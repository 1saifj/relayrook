import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { fail, ERROR_CODES } from './errors.mjs';
import { getBackend, hasBackend } from './backends.mjs';
import { assertNoRecursion, DEFAULT_MAX_DEPTH } from './caller.mjs';
import { RelayRookError } from './errors.mjs';

export const ROLES = Object.freeze(['implementation', 'code-review', 'security-review']);

let cachedTable = null;

/** Route table, loaded from runtime data so model inventory can change without touching code. */
export function loadRouteTable() {
  if (cachedTable) return cachedTable;
  const file = new URL('./data/routes.json', import.meta.url);
  cachedTable = JSON.parse(readFileSync(file, 'utf8'));
  return cachedTable;
}

/** Test seam: drop the cached table. */
export function resetRouteTableCache() {
  cachedTable = null;
}

/**
 * Load measured route evidence produced by `evals/run.mjs`. Lives in the
 * state directory so the installed skill can pick it up at runtime; absent or
 * malformed means every route is a configured preference, exactly as labelled.
 * @param {string} stateDir
 */
export function loadRouteEvidence(stateDir) {
  const file = path.join(stateDir, 'route-evidence.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.routes || typeof parsed.routes !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Evidence key for one route candidate: role + backend + model + effort.
 * @param {string} role @param {string} backend @param {string|null} model @param {string|null} effort
 */
export function routeEvidenceKey(role, backend, model, effort) {
  return [role, backend, model ?? '', effort ?? ''].join('|');
}

/**
 * A candidate counts as measured once it has at least two completed
 * evaluation runs — a single run is an anecdote, not a measurement.
 * @param {any} evidence
 */
export function isMeasured(evidence) {
  return Boolean(evidence) && Number.isFinite(evidence.runs) && evidence.runs >= 2;
}

/** @param {string} role */
export function assertRole(role) {
  if (!ROLES.includes(role)) {
    throw fail(ERROR_CODES.unknown_role, `Unknown role: ${role}`, { known: ROLES });
  }
  return role;
}

/**
 * Choose a backend/model/effort for a role.
 *
 * Eligibility filters run before any scoring, and every rejected candidate is
 * returned with its reason so the caller can see what was ruled out and why.
 * An explicit pin is never substituted: an unsatisfiable pin is an error.
 *
 * @param {{
 *   role: string,
 *   pins?: {agent?: string|null, model?: string|null, effort?: string|null},
 *   inventory: any[],
 *   callerState?: any,
 *   routeEvidence?: {routes?: Record<string, any>}|null,
 *   policy?: {
 *     maxDepth?: number,
 *     allowRepeatBackend?: boolean,
 *     allowedProviders?: string[]|null,
 *     preferredProviders?: string[],
 *     allowUnimplementedSession?: boolean,
 *     avoidBackends?: string[],
 *   },
 * }} input
 */
export function route(input) {
  const role = assertRole(input.role);
  const table = loadRouteTable();
  const roleConfig = table.roles[role];
  const pins = input.pins ?? {};
  const policy = input.policy ?? {};
  const callerState = input.callerState ?? { depth: 0, ancestry: [] };
  const inventoryById = new Map((input.inventory ?? []).map((entry) => [entry.id, entry]));
  const measured = input.routeEvidence?.routes ?? {};

  /** @type {{backend: string, model: string|null, reason: string, detail?: any}[]} */
  const rejected = [];

  if (pins.agent && !hasBackend(pins.agent)) {
    throw fail(ERROR_CODES.unknown_backend, `Unknown pinned agent: ${pins.agent}`);
  }

  /** @type {any[]} */
  let candidates = roleConfig.candidates.map((c) => ({ ...c }));

  // An explicit agent pin narrows the field to exactly that backend. If the
  // role table has no entry for it we still build one so the pin is honoured.
  if (pins.agent) {
    const pinned = candidates.find((c) => c.backend === pins.agent);
    candidates = [
      pinned ?? {
        backend: pins.agent,
        model: null,
        effort: null,
        weight: 50,
        verifiedTurn: false,
        basis: 'Explicit agent pin; no configured role entry for this backend.',
      },
    ];
  }

  // An explicit model pin overrides the configured model for every candidate.
  if (pins.model) {
    candidates = candidates.map((c) => ({ ...c, model: pins.model, modelSource: 'pin' }));
  }
  if (pins.effort) {
    candidates = candidates.map((c) => ({ ...c, effort: pins.effort, effortSource: 'pin' }));
  }

  const eligible = [];
  for (const candidate of candidates) {
    const backend = getBackend(candidate.backend);
    const record = inventoryById.get(candidate.backend);

    if (!record || record.evidence?.installed !== true) {
      rejected.push({ backend: candidate.backend, model: candidate.model, reason: 'not-installed' });
      continue;
    }
    if (backend.sessionSupport !== 'implemented' && !policy.allowUnimplementedSession) {
      rejected.push({
        backend: candidate.backend,
        model: candidate.model,
        reason: 'session-control-not-implemented',
        detail: backend.sessionSupportReason ?? null,
      });
      continue;
    }
    if (policy.allowedProviders && !policy.allowedProviders.includes(backend.provider)) {
      rejected.push({ backend: candidate.backend, model: candidate.model, reason: 'provider-not-allowed' });
      continue;
    }
    if (policy.avoidBackends?.includes(candidate.backend)) {
      rejected.push({ backend: candidate.backend, model: candidate.model, reason: 'explicitly-avoided' });
      continue;
    }
    try {
      assertNoRecursion({
        callerState,
        backend: candidate.backend,
        maxDepth: policy.maxDepth ?? DEFAULT_MAX_DEPTH,
        allowRepeatBackend: policy.allowRepeatBackend === true,
      });
    } catch (err) {
      if (err instanceof RelayRookError && err.code === ERROR_CODES.recursion_depth_exceeded) throw err;
      rejected.push({
        backend: candidate.backend,
        model: candidate.model,
        reason: 'recursion-guard',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Devin's fixed default is preserved unless the caller pinned a model.
    const model = candidate.model ?? backend.defaultModel ?? null;
    const modelSource = candidate.modelSource ?? (candidate.model ? 'route-table' : model ? 'backend-default' : 'unset');

    const effortSupport = resolveEffortSupport(backend, candidate.effort);
    const evidence = measured[routeEvidenceKey(role, candidate.backend, model, candidate.effort ?? null)] ?? null;
    eligible.push({
      backend: candidate.backend,
      provider: backend.provider,
      family: candidate.family ?? backend.modelFamily ?? backend.provider,
      billingRoute: backend.billingRoute,
      model,
      modelSource,
      effort: candidate.effort ?? null,
      effortSource: candidate.effortSource ?? (candidate.effort ? 'route-table' : 'unset'),
      effortSupport,
      verifiedTurn: candidate.verifiedTurn === true,
      basis: candidate.basis,
      evidenceBasis: isMeasured(evidence) ? 'measured-evaluation' : 'configured-preference',
      measured: isMeasured(evidence) ? evidence : null,
      score: scoreCandidate(candidate, backend, table, policy, callerState, evidence),
    });
  }

  if (eligible.length === 0) {
    if (pins.agent || pins.model) {
      throw fail(ERROR_CODES.pin_unsatisfiable, 'No eligible route satisfies the requested pins', {
        role,
        pins,
        rejected,
      });
    }
    throw fail(ERROR_CODES.no_eligible_route, `No eligible backend for role ${role}`, { role, rejected });
  }

  eligible.sort((a, b) => b.score - a.score || a.backend.localeCompare(b.backend));
  const [selected, ...runnersUp] = eligible;
  for (const other of runnersUp) {
    rejected.push({ backend: other.backend, model: other.model, reason: 'lower-score', detail: { score: other.score } });
  }

  const anyMeasured = eligible.some((c) => c.evidenceBasis === 'measured-evaluation');
  return {
    role,
    readOnly: roleConfig.readOnly === true,
    evidenceBasis: anyMeasured ? 'measured+configured' : table.evidenceBasis,
    selected,
    rejected,
    pins: { agent: pins.agent ?? null, model: pins.model ?? null, effort: pins.effort ?? null },
    delegation: { depth: callerState.depth ?? 0, ancestry: callerState.ancestry ?? [] },
    reason: buildReason(selected, pins, role),
  };
}

/**
 * Effort is an independent quality control. When a backend cannot read it back
 * we say so rather than implying the request was honoured.
 * @param {any} backend
 * @param {string|null|undefined} effort
 */
export function resolveEffortSupport(backend, effort) {
  if (!effort) return { state: 'not-requested', verifiable: Boolean(backend.effortReadback) };
  if (backend.effortMechanism === 'turn-parameter') {
    return { state: 'requested-verifiable', mechanism: 'turn-parameter', verifiable: true };
  }
  if (backend.effortFlag) {
    return {
      state: backend.effortReadback ? 'requested-verifiable' : 'requested-not-verifiable',
      mechanism: 'launch-flag',
      verifiable: Boolean(backend.effortReadback),
    };
  }
  if (backend.modelSelection === 'set_config_option') {
    return { state: 'requested-if-advertised', mechanism: 'set_config_option', verifiable: true };
  }
  return { state: 'unsupported', mechanism: null, verifiable: false };
}

/**
 * @param {any} candidate
 * @param {any} backend
 * @param {any} table
 * @param {any} policy
 * @param {any} callerState
 */
function scoreCandidate(candidate, backend, table, policy, callerState, evidence) {
  const scoring = table.scoring ?? {};
  let score = Number(candidate.weight ?? 0);
  if (candidate.verifiedTurn) score += Number(scoring.verifiedTurnBonus ?? 0);
  if (isMeasured(evidence)) {
    // Measured evidence outweighs configured weight: success/finding rates
    // scale a bounded bonus rather than replacing the table.
    const success = Number(evidence.successRate ?? 0);
    const precision = Number(evidence.precision ?? success);
    score += Math.round((Number(scoring.measuredBonus ?? 30) * (success * 0.6 + precision * 0.4)) * 100) / 100;
  }
  if (policy.preferredProviders?.includes(backend.provider)) score += Number(scoring.preferredProviderBonus ?? 0);
  const candidateFamily = candidate.family ?? backend.modelFamily ?? backend.provider;
  const usedFamilies = new Set((callerState.ancestry ?? []).map((id) => {
    try {
      const used = getBackend(id);
      return used.modelFamily ?? used.provider;
    } catch {
      return id;
    }
  }));
  if (!usedFamilies.has(candidateFamily)) {
    score += Number(scoring.independentFamilyBonus ?? 0);
  }
  return score;
}

/**
 * @param {any} selected
 * @param {any} pins
 * @param {string} role
 */
function buildReason(selected, pins, role) {
  const parts = [`role=${role}`, `backend=${selected.backend}`];
  parts.push(`model=${selected.model ?? 'backend-default'} (${selected.modelSource})`);
  if (selected.effort) parts.push(`effort=${selected.effort} (${selected.effortSupport.state})`);
  if (pins.agent) parts.push('agent pinned by caller');
  if (pins.model) parts.push('model pinned by caller');
  parts.push(selected.verifiedTurn ? 'route has a completed turn on record' : 'route is advertised, not turn-verified');
  return parts.join('; ');
}
