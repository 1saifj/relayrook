import { fail, ERROR_CODES } from './errors.mjs';
import { isPlainObject } from './util.mjs';

/**
 * Caller identification.
 *
 * docs/research.md §4 sets the precedence, and the reason it matters: host
 * environment variables such as CODEX_THREAD_ID are inherited by child
 * processes, so their presence proves an ancestor, never the immediate parent.
 * Explicit `--caller` from the host-facing skill is the only authoritative
 * source; everything else is lower-confidence evidence.
 */

export const CALLER_CONFIDENCE = Object.freeze({
  explicit: 'explicit',
  delegated: 'delegated',
  inferred: 'inferred',
  none: 'none',
});

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

/**
 * Parse router-owned delegation metadata that RelayRook itself injected into a
 * child session. This is trusted above environment inference because RelayRook
 * wrote it, but below an explicit `--caller`.
 * @param {NodeJS.ProcessEnv} env
 */
export function parseRouteEnvelope(env) {
  const raw = env[ROUTE_ENV_VAR];
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { malformed: true, rootCaller: null, parent: null, routeId: null, depth: 0, ancestry: [] };
  }
  if (!isPlainObject(parsed)) return { malformed: true, rootCaller: null, parent: null, routeId: null, depth: 0, ancestry: [] };
  const ancestry = Array.isArray(parsed.ancestry) ? parsed.ancestry.filter((x) => typeof x === 'string') : [];
  return {
    malformed: false,
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
 * }} input
 */
export function resolveCaller(input = {}) {
  const env = input.env ?? process.env;
  const envEvidence = collectEnvEvidence(env);
  const envelope = parseRouteEnvelope(env);
  if (envelope?.malformed) {
    throw fail(ERROR_CODES.route_envelope_invalid, `Malformed ${ROUTE_ENV_VAR}; refusing to reset delegation ancestry`, {
      variable: ROUTE_ENV_VAR,
    });
  }
  const parentProcess = input.parentProcess ?? null;

  const evidence = {
    explicit: input.explicitCaller ?? null,
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

  if (input.explicitCaller) {
    for (const host of inferredList) {
      if (host !== input.explicitCaller) conflicts.push({ kind: 'environment-disagrees', host });
    }
    if (envelope && !envelope.malformed && envelope.parent && envelope.parent !== input.explicitCaller) {
      conflicts.push({ kind: 'route-envelope-disagrees', host: envelope.parent });
    }
    return {
      rootCaller: envelope?.rootCaller ?? input.explicitCaller,
      immediateParent: input.explicitCaller,
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
      confidence: CALLER_CONFIDENCE.delegated,
      ambiguous: false,
      depth: envelope.depth,
      ancestry: envelope.ancestry,
      routeId: envelope.routeId,
      conflicts,
      evidence,
      reason: 'Router-owned delegation metadata carried into this process',
    };
  }

  if (inferredList.length === 1) {
    return {
      rootCaller: inferredList[0],
      immediateParent: inferredList[0],
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
  const base = String(command).split('/').pop()?.toLowerCase() ?? '';
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
 * Build the envelope handed to a child session so the next hop knows its root
 * caller, immediate parent and depth without guessing.
 * @param {{callerState: any, backend: string, routeId: string}} input
 */
export function childRouteEnvelope(input) {
  const { callerState, backend, routeId } = input;
  return {
    rootCaller: callerState?.rootCaller ?? callerState?.immediateParent ?? 'unknown',
    parent: 'relayrook',
    routeId,
    depth: (callerState?.depth ?? 0) + 1,
    ancestry: [...(callerState?.ancestry ?? []), backend],
  };
}

/**
 * Serialise the envelope for the child process environment.
 * @param {ReturnType<typeof childRouteEnvelope>} envelope
 */
export function routeEnvelopeEnv(envelope) {
  return { [ROUTE_ENV_VAR]: JSON.stringify(envelope) };
}
