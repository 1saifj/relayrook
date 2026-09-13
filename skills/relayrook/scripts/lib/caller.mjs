import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail, ERROR_CODES } from './errors.mjs';
import { isPlainObject } from './util.mjs';

/**
 * Caller identification.
 *
 * Host environment variables such as CODEX_THREAD_ID are inherited by child
 * processes, so their presence proves an ancestor, never the immediate parent.
 * Explicit `--caller` from the host-facing skill is the only authoritative
 * source; everything else is lower-confidence evidence.
 *
 * Host ids are not restricted to the five primary backends: any normalized id
 * is accepted so a harness this build does not know about can still delegate
 * with an honest identity. Normalization is lowercase ASCII alphanumerics plus
 * `-`/`_`, 1–64 characters, starting with an alphanumeric.
 */

export const CALLER_CONFIDENCE = Object.freeze({
  explicit: 'explicit',
  delegated: 'delegated',
  inferred: 'inferred',
  none: 'none',
});

export const KNOWN_HOSTS = Object.freeze(['codex', 'claude-code', 'kiro-cli', 'opencode', 'devin']);

/** Environment markers, grouped by host. Presence is evidence, not proof. */
export const HOST_ENV_SIGNALS = Object.freeze({
  codex: ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_HOME'],
  'claude-code': ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_SESSION_ID'],
  'kiro-cli': ['KIRO_SESSION_ID', 'KIRO_AGENT', 'KIRO_CLI_SESSION'],
  opencode: ['OPENCODE_SESSION_ID', 'OPENCODE_SERVER', 'OPENCODE'],
  devin: ['DEVIN_SESSION_ID', 'DEVIN_ACP_SESSION'],
});

export const ROUTE_ENV_VAR = 'RELAYROOK_ROUTE';
export const DEFAULT_MAX_DEPTH = 3;
export const CALLER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INTEGRITY_PREFIX = 'v1.';

/**
 * Normalize a caller-supplied host id. Returns the normalized id, or null when
 * the input cannot be represented in the allowed alphabet.
 * @param {unknown} raw
 */
export function normalizeCallerId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  return CALLER_ID_PATTERN.test(id) ? id : null;
}

/**
 * @param {unknown} raw caller id from --caller; throws a usage error when it
 * cannot be normalized.
 */
export function requireCallerId(raw) {
  const id = normalizeCallerId(raw);
  if (!id) {
    throw fail(ERROR_CODES.usage, `Invalid caller id ${JSON.stringify(raw)}; use ${CALLER_ID_PATTERN.source}`, {
      caller: raw,
    });
  }
  return id;
}

/**
 * HMAC-SHA256 over the canonical envelope payload. The key lives at
 * `<stateDir>/route-integrity.key` (created on demand, mode 0600), so a
 * signature can only be produced by a process that can read this machine's
 * RelayRook state directory — i.e. RelayRook itself or the invoking user.
 *
 * Trust boundary: the envelope attests ancestry only within one state
 * directory. A delegated agent can always *omit* the variable (env is mutable
 * by the executing agent); it cannot *forge* RelayRook's attestation. Depth
 * remains the hard bound regardless of what the envelope claims.
 * @param {object} payload
 * @param {Buffer|string|null} key
 */
export function signEnvelopePayload(payload, key) {
  if (!key) return null;
  const canonical = JSON.stringify({
    ancestry: payload.ancestry,
    depth: payload.depth,
    parent: payload.parent,
    rootCaller: payload.rootCaller,
    routeId: payload.routeId,
  });
  return INTEGRITY_PREFIX + createHmac('sha256', key).update(canonical).digest('hex');
}

/**
 * @param {object} envelope
 * @param {Buffer|string|null} key
 */
export function verifyEnvelopeIntegrity(envelope, key) {
  const signature = typeof envelope?.integrity === 'string' ? envelope.integrity : null;
  const expected = signEnvelopePayload(envelope, key);
  if (!signature || !expected) return false;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Parse router-owned delegation metadata that RelayRook itself injected into a
 * child session. Trusted above environment inference because RelayRook signed
 * it, below an explicit `--caller`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {Buffer|string|null} [key] route-integrity key; when absent the
 *   envelope is parsed but reported as untrusted.
 * @returns {{malformed: boolean, reason?: string, trusted: boolean,
 *   unsigned?: boolean, rootCaller: string|null, parent: string|null,
 *   routeId: string|null, depth: number, ancestry: string[]}|null}
 */
export function parseRouteEnvelope(env, key = null) {
  const raw = env[ROUTE_ENV_VAR];
  if (!raw) return null;
  const empty = { malformed: true, trusted: false, rootCaller: null, parent: null, routeId: null, depth: 0, ancestry: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...empty, reason: 'not-json' };
  }
  if (!isPlainObject(parsed)) return { ...empty, reason: 'not-object' };
  const ancestry = Array.isArray(parsed.ancestry) ? parsed.ancestry.filter((x) => typeof x === 'string') : [];
  const trusted = verifyEnvelopeIntegrity(parsed, key);
  return {
    malformed: false,
    trusted,
    unsigned: typeof parsed.integrity !== 'string',
    rootCaller: typeof parsed.rootCaller === 'string' ? parsed.rootCaller : null,
    parent: typeof parsed.parent === 'string' ? parsed.parent : null,
    routeId: typeof parsed.routeId === 'string' ? parsed.routeId : null,
    depth: Number.isInteger(parsed.depth) && parsed.depth >= 0 ? parsed.depth : 0,
    ancestry,
  };
}

/**
 * Collect host environment evidence without reading any variable's value.
 * Only variable names and a present/absent flag are recorded, so a token or an
 * account identifier can never leak into router state or JSON output.
 * @param {NodeJS.ProcessEnv} env
 */
export function collectEnvEvidence(env) {
  /** @type {{host: string, variables: string[]}[]} */
  const evidence = [];
  for (const [host, names] of Object.entries(HOST_ENV_SIGNALS)) {
    const present = names.filter((name) => typeof env[name] === 'string' && env[name] !== '');
    if (present.length > 0) evidence.push({ host, variables: present });
  }
  return evidence;
}

/**
 * Resolve the caller.
 *
 * @param {{
 *   explicitCaller?: string|null,
 *   env?: NodeJS.ProcessEnv,
 *   parentProcess?: {pid: number|null, command: string|null}|null,
 *   routeKey?: Buffer|string|null,
 * }} input
 */
export function resolveCaller(input = {}) {
  const env = input.env ?? process.env;
  const envEvidence = collectEnvEvidence(env);
  const envelope = parseRouteEnvelope(env, input.routeKey ?? null);
  if (envelope?.malformed) {
    throw fail(ERROR_CODES.route_envelope_invalid, `Malformed ${ROUTE_ENV_VAR}; refusing to reset delegation ancestry`, {
      variable: ROUTE_ENV_VAR,
      reason: envelope.reason,
    });
  }
  if (envelope && !envelope.trusted) {
    throw fail(
      ERROR_CODES.route_envelope_invalid,
      `Unsigned or forged ${ROUTE_ENV_VAR}; delegation ancestry must be minted by RelayRook`,
      { variable: ROUTE_ENV_VAR, unsigned: envelope.unsigned },
    );
  }
  const parentProcess = input.parentProcess ?? null;
  const explicitCaller = input.explicitCaller ? normalizeCallerId(input.explicitCaller) : null;
  if (input.explicitCaller && !explicitCaller) {
    throw fail(ERROR_CODES.usage, `Invalid caller id ${JSON.stringify(input.explicitCaller)}`, {
      caller: input.explicitCaller,
    });
  }

  const evidence = {
    explicit: explicitCaller,
    routeEnvelope: envelope,
    environment: envEvidence,
    parentProcess: parentProcess ? { command: parentProcess.command, pid: parentProcess.pid } : null,
  };

  const inferredHosts = new Set(envEvidence.map((e) => e.host));
  if (parentProcess?.command) {
    const guess = guessHostFromCommand(parentProcess.command);
    if (guess) inferredHosts.add(guess);
  }
  const inferredList = [...inferredHosts].sort();

  const conflicts = [];

  if (explicitCaller) {
    for (const host of inferredList) {
      if (host !== explicitCaller) conflicts.push({ kind: 'environment-disagrees', host });
    }
    if (envelope && !envelope.malformed && envelope.parent && envelope.parent !== explicitCaller) {
      conflicts.push({ kind: 'route-envelope-disagrees', host: envelope.parent });
    }
    return {
      rootCaller: envelope?.rootCaller ?? explicitCaller,
      immediateParent: explicitCaller,
      knownHost: KNOWN_HOSTS.includes(explicitCaller),
      confidence: CALLER_CONFIDENCE.explicit,
      ambiguous: false,
      depth: envelope && !envelope.malformed ? envelope.depth : 0,
      ancestry: envelope && !envelope.malformed ? envelope.ancestry : [],
      routeId: envelope?.routeId ?? null,
      conflicts,
      evidence,
      reason: 'Explicit --caller is authoritative',
    };
  }

  if (envelope && !envelope.malformed && envelope.parent) {
    return {
      rootCaller: envelope.rootCaller ?? envelope.parent,
      immediateParent: envelope.parent,
      knownHost: KNOWN_HOSTS.includes(envelope.parent),
      confidence: CALLER_CONFIDENCE.delegated,
      ambiguous: false,
      depth: envelope.depth,
      ancestry: envelope.ancestry,
      routeId: envelope.routeId,
      conflicts,
      evidence,
      reason: 'Router-signed delegation metadata carried into this process',
    };
  }

  if (inferredList.length === 1) {
    return {
      rootCaller: inferredList[0],
      immediateParent: inferredList[0],
      knownHost: true,
      confidence: CALLER_CONFIDENCE.inferred,
      ambiguous: false,
      depth: 0,
      ancestry: [],
      routeId: null,
      conflicts,
      evidence,
      reason: 'Single host environment signal; inherited variables cannot prove the immediate parent',
    };
  }

  if (inferredList.length > 1) {
    return {
      rootCaller: null,
      immediateParent: null,
      knownHost: false,
      confidence: CALLER_CONFIDENCE.none,
      ambiguous: true,
      candidates: inferredList,
      depth: 0,
      ancestry: [],
      routeId: null,
      conflicts,
      evidence,
      reason: `Conflicting host signals (${inferredList.join(', ')}); pass --caller to resolve`,
    };
  }

  return {
    rootCaller: null,
    immediateParent: null,
    knownHost: false,
    confidence: CALLER_CONFIDENCE.none,
    ambiguous: false,
    depth: 0,
    ancestry: [],
    routeId: null,
    conflicts,
    evidence,
    reason: 'No caller evidence available',
  };
}

/** @param {string} command */
export function guessHostFromCommand(command) {
  const base = String(command).split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base.startsWith('codex')) return 'codex';
  if (base.startsWith('claude')) return 'claude-code';
  if (base.startsWith('kiro')) return 'kiro-cli';
  if (base.startsWith('opencode')) return 'opencode';
  if (base.startsWith('devin')) return 'devin';
  return null;
}

/**
 * Recursion guard. Bounded depth plus recorded ancestry, so an agent cannot
 * delegate to itself through an unbounded chain. Reusing the same backend is
 * blocked by default but can be allowed intentionally.
 *
 * @param {{callerState: any, backend: string, maxDepth?: number, allowRepeatBackend?: boolean}} input
 */
export function assertNoRecursion(input) {
  const { callerState, backend } = input;
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DEPTH;
  const depth = callerState?.depth ?? 0;
  const ancestry = callerState?.ancestry ?? [];

  if (depth >= maxDepth) {
    throw fail(
      ERROR_CODES.recursion_depth_exceeded,
      `Delegation depth ${depth} has reached the limit of ${maxDepth}`,
      { depth, maxDepth, ancestry },
    );
  }
  if (!input.allowRepeatBackend && ancestry.includes(backend)) {
    throw fail(
      ERROR_CODES.recursive_backend,
      `Backend ${backend} already appears in the delegation ancestry`,
      { backend, ancestry },
    );
  }
  return { depth, maxDepth, ancestry };
}

/**
 * Build the signed envelope handed to a child session so the next hop knows
 * its root caller, immediate parent and depth without guessing.
 * @param {{callerState: any, backend: string, routeId: string, routeKey?: Buffer|string|null}} input
 */
export function childRouteEnvelope(input) {
  const { callerState, backend, routeId } = input;
  const envelope = {
    rootCaller: callerState?.rootCaller ?? callerState?.immediateParent ?? 'unknown',
    parent: 'relayrook',
    routeId,
    depth: (callerState?.depth ?? 0) + 1,
    ancestry: [...(callerState?.ancestry ?? []), backend],
  };
  const integrity = signEnvelopePayload(envelope, input.routeKey ?? null);
  if (integrity) envelope.integrity = integrity;
  return envelope;
}

/**
 * Serialise the envelope for the child process environment.
 * @param {ReturnType<typeof childRouteEnvelope>} envelope
 */
export function routeEnvelopeEnv(envelope) {
  return { [ROUTE_ENV_VAR]: JSON.stringify(envelope) };
}
