import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';

import { allBackends } from './backends.mjs';
import { discoverAll, ProbeCache } from './discovery.mjs';
import { probeCodex } from './adapters/codex.mjs';
import { resolveCaller } from './caller.mjs';
import { loadRouteTable, ROLES } from './routing.mjs';
import { listSessions } from './sessions.mjs';
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
 * }} input
 */
export async function runDoctor(input) {
  const env = input.env ?? process.env;
  const parent = await parentProcessInfo();
  const caller = resolveCaller({ explicitCaller: input.explicitCaller ?? null, env, parentProcess: parent });
  const inventory = await discoverAll({ stateDir: input.stateDir, env, timeoutMs: input.timeoutMs });

  if (input.probe) {
    await applyProbes(inventory, input.stateDir);
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
    relayrook: { version: '0.1.0', node: process.version, platform: `${os.platform()}-${os.arch()}` },
    stateDir: redactPath(input.stateDir),
    stateDirExists: existsSync(input.stateDir),
    caller: summariseCaller(caller),
    backends: inventory,
    routes,
    routeEvidenceBasis: table.evidenceBasis,
    routeEvidenceNote: table.evidenceNote,
    sessions,
    warnings: collectWarnings(inventory, caller),
  };
}

/**
 * Live protocol probes. Contained per backend: one failing CLI never fails the
 * whole inventory.
 * @param {any[]} inventory
 * @param {string} stateDir
 */
async function applyProbes(inventory, stateDir) {
  const cache = new ProbeCache(stateDir);
  for (const record of inventory) {
    if (record.evidence?.installed !== true) continue;
    if (record.id !== 'codex') {
      // ACP protocol probes spawn a real agent session; v0.1 keeps `doctor`
      // side-effect free and leaves those states unknown until a session runs.
      record.evidence.protocolReady = null;
      record.probeNote = 'ACP handshake not probed by doctor; run `relayrook start` to establish protocol readiness.';
      continue;
    }
    const key = ProbeCache.key({ backend: record.id, executable: record.executable, version: record.version });
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
    if (probe.error) record.problems.push(`app-server probe failed: ${probe.error}`);
  }
}

/** @param {any} caller */
function summariseCaller(caller) {
  return {
    rootCaller: caller.rootCaller,
    immediateParent: caller.immediateParent,
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
            depth: caller.evidence.routeEnvelope.depth,
            ancestry: caller.evidence.routeEnvelope.ancestry,
          }
        : { present: false },
      parentProcess: caller.evidence.parentProcess,
    },
  };
}

/** @param {any[]} inventory @param {any} caller */
function collectWarnings(inventory, caller) {
  const warnings = [];
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
