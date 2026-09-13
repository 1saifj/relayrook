import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';

import { allBackends, getBackend } from './backends.mjs';
import { discoverAll, ProbeCache } from './discovery.mjs';
import { probeCodex } from './adapters/codex.mjs';
import { probeAcp } from './adapters/acp-probe.mjs';
import { resolveCaller } from './caller.mjs';
import { loadRouteTable, ROLES } from './routing.mjs';
import { listSessions } from './sessions.mjs';
import { runPreflight } from './preflight.mjs';
import { resolveRouteKey } from './state.mjs';
import { redactPath } from './util.mjs';

/**
 * Read the nearest parent process's executable name.
 *
 * This is low-confidence evidence: it names an ancestor, not necessarily the
 * agent that invoked RelayRook. Failure is normal and never fatal.
 */
export function parentProcessInfo(ppid = process.ppid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32' || !Number.isInteger(ppid) || ppid <= 0) {
      resolve({ pid: ppid ?? null, command: null });
      return;
    }
    execFile('ps', ['-o', 'comm=', '-p', String(ppid)], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        resolve({ pid: ppid, command: null });
        return;
      }
      const command = String(stdout).trim().split('\n')[0]?.trim() || null;
      resolve({ pid: ppid, command });
    });
  });
}

/**
 * Full environment report: who is calling, what can run, how certain we are,
 * and which routes are configured — with no credential values anywhere.
 *
 * @param {{
 *   stateDir: string,
 *   explicitCaller?: string|null,
 *   probe?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   version?: string,
 * }} input
 */
export async function runDoctor(input) {
  const env = input.env ?? process.env;
  const parent = await parentProcessInfo();
  const routeKey = resolveRouteKey(input.stateDir);
  // A malformed or forged route envelope hard-fails delegation commands, but
  // doctor's job is to report the environment as found — surface the error as
  // caller evidence instead of aborting the whole report.
  let caller;
  let callerError = null;
  try {
    caller = resolveCaller({ explicitCaller: input.explicitCaller ?? null, env, parentProcess: parent, routeKey });
  } catch (err) {
    callerError = { code: err?.code ?? 'internal_error', message: err?.message ?? String(err) };
    caller = {
      rootCaller: null, immediateParent: null, knownHost: false,
      confidence: 'invalid', ambiguous: false, candidates: [],
      depth: 0, ancestry: [], routeId: null, conflicts: [], reason: null,
      evidence: {
        explicit: input.explicitCaller ?? null,
        environment: [],
        routeEnvelope: { present: true },
        parentProcess: parent,
      },
    };
  }
  const inventory = await discoverAll({ stateDir: input.stateDir, env, timeoutMs: input.timeoutMs });
  const preflight = await runPreflight({ stateDir: input.stateDir, env });

  if (input.probe) {
    await applyProbes(inventory, input.stateDir, env);
  }

  const table = loadRouteTable();
  const routes = ROLES.map((role) => ({
    role,
    readOnly: table.roles[role].readOnly === true,
    candidates: table.roles[role].candidates.map((c) => ({
      backend: c.backend,
      model: c.model,
      effort: c.effort,
      verifiedTurn: c.verifiedTurn === true,
      installed: inventory.find((r) => r.id === c.backend)?.evidence?.installed === true,
    })),
  }));

  const sessions = await listSessions(input.stateDir);

  return {
    relayrook: { version: input.version ?? '0.2.0', node: process.version, platform: `${os.platform()}-${os.arch()}` },
    stateDir: redactPath(input.stateDir),
    stateDirExists: existsSync(input.stateDir),
    caller: callerError ? { ...summariseCaller(caller), error: callerError } : summariseCaller(caller),
    preflight,
    backends: inventory,
    routes,
    routeEvidenceBasis: table.evidenceBasis,
    routeEvidenceNote: table.evidenceNote,
    sessions,
    warnings: collectWarnings(inventory, caller, callerError),
  };
}

/**
 * Live protocol probes. Contained per backend: one failing CLI never fails the
 * whole inventory. ACP backends get an initialize-only handshake — enough to
 * prove protocol readiness and read advertised capabilities (including
 * `loadSession`) without creating a session.
 * @param {any[]} inventory
 * @param {string} stateDir
 * @param {NodeJS.ProcessEnv} env
 */
async function applyProbes(inventory, stateDir, env) {
  const cache = new ProbeCache(stateDir);
  for (const record of inventory) {
    if (record.evidence?.installed !== true) continue;
    const key = ProbeCache.key({ backend: record.id, executable: record.executable, version: record.version });
    if (record.id === 'codex') {
      let probe = cache.get(key);
      if (!probe) {
        probe = await probeCodex({ timeoutMs: 30000 });
        cache.set(key, probe);
      }
      record.evidence.protocolReady = probe.protocolReady === true;
      record.evidence.authenticated = probe.account?.present ?? null;
      record.evidence.modelAdvertised = Array.isArray(probe.models) && probe.models.length > 0;
      record.advertisedModels = probe.models ?? [];
      record.sessionControl = probe.sessionControl;
      record.capabilities = probe.capabilities ?? null;
      cache.set('codex-advertised-models', probe.models ?? []);
      if (probe.error) record.problems.push(`app-server probe failed: ${probe.error}`);
      continue;
    }
    // ACP backends: initialize handshake only. No session is created.
    let probe = cache.get(key);
    if (!probe) {
      try {
        probe = await probeAcp({ backend: getBackend(record.id), stateDir, env, timeoutMs: 30000 });
        cache.set(key, probe);
      } catch (err) {
        probe = { protocolReady: false, error: err instanceof Error ? err.message : String(err) };
        cache.set(key, probe);
      }
    }
    record.evidence.protocolReady = probe.protocolReady === true;
    record.agentInfo = probe.agentInfo ?? null;
    record.agentCapabilities = probe.agentCapabilities ?? null;
    record.evidence.modelAdvertised = null; // models arrive with session metadata
    if (probe.error) record.problems.push(`initialize probe failed: ${probe.error}`);
    if (probe.note) record.probeNote = probe.note;
  }
}

/** @param {any} caller */
function summariseCaller(caller) {
  return {
    rootCaller: caller.rootCaller,
    immediateParent: caller.immediateParent,
    knownHost: caller.knownHost === true,
    confidence: caller.confidence,
    ambiguous: caller.ambiguous === true,
    candidates: caller.candidates ?? [],
    delegationDepth: caller.depth,
    ancestry: caller.ancestry,
    routeId: caller.routeId,
    conflicts: caller.conflicts,
    reason: caller.reason,
    // Variable names only — values are never read, so nothing sensitive leaks.
    evidence: {
      explicit: caller.evidence.explicit,
      environmentVariablesPresent: caller.evidence.environment,
      routeEnvelope: caller.evidence.routeEnvelope
        ? {
            present: true,
            malformed: caller.evidence.routeEnvelope.malformed === true,
            trusted: caller.evidence.routeEnvelope.trusted === true,
            depth: caller.evidence.routeEnvelope.depth,
            ancestry: caller.evidence.routeEnvelope.ancestry,
          }
        : { present: false },
      parentProcess: caller.evidence.parentProcess,
    },
  };
}

/** @param {any[]} inventory @param {any} caller @param {any} [callerError] */
function collectWarnings(inventory, caller, callerError = null) {
  const warnings = [];
  if (callerError) {
    warnings.push(`Route envelope rejected: ${callerError.message} Delegation commands still fail closed on it.`);
  }
  if (caller.ambiguous) warnings.push(`Caller is ambiguous (${(caller.candidates ?? []).join(', ')}); pass --caller.`);
  if (caller.confidence === 'inferred') {
    warnings.push('Caller was inferred from inherited environment signals; pass --caller for an authoritative value.');
  }
  for (const conflict of caller.conflicts ?? []) {
    warnings.push(`Caller evidence conflict: ${conflict.kind} (${conflict.host}).`);
  }
  for (const backend of allBackends()) {
    const record = inventory.find((r) => r.id === backend.id);
    if (!record) continue;
    for (const problem of record.problems ?? []) warnings.push(`${backend.id}: ${problem}`);
    if (backend.sessionSupport !== 'implemented' && record.evidence?.installed) {
      warnings.push(`${backend.id}: ${backend.sessionSupportReason}`);
    }
  }
  return warnings;
}
