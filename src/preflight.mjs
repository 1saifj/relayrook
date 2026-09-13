import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { fail, ERROR_CODES } from './errors.mjs';
import { whichSync, resolveClaudeAdapter } from './discovery.mjs';
import { getBackend, hasBackend } from './backends.mjs';
import { chmodPrivate, IS_WINDOWS } from './platform.mjs';
import { assertPrivateSocketDir, resolveSocketPath } from './state.mjs';
import { newId } from './util.mjs';
import { existsSync } from 'node:fs';

export const MIN_NODE_VERSION = [22, 13, 0];

/**
 * Capability preflight. Each check produces a named result; the first failure
 * throws that check's typed error so callers never see a bare ENOENT where a
 * capability statement belongs.
 *
 * Checks, in order:
 *   node            this runtime satisfies engines (>= 22.13)
 *   localExecution  a child process can actually be spawned
 *   stateDir        the state directory can be created and written
 *   transport       the control transport endpoint can actually be bound
 *   backend         the backend executable resolves on PATH (or its adapter)
 *   adapter         a pinned adapter exists and matches the pinned version
 *   model/effort    advertised capability when the backend probe ran
 *
 * `runPreflight` returns the report; `runSessionPreflight` throws the first
 * blocker and is what `start` uses.
 */

/**
 * @param {{stateDir: string, env?: NodeJS.ProcessEnv, backend?: string|null, probeCache?: any}} input
 * @returns {Promise<{ok: boolean, checks: Record<string, any>, blockers: any[]}>}
 */
export async function runPreflight(input) {
  const env = input.env ?? process.env;
  /** @type {Record<string, any>} */
  const checks = {};
  /** @type {any[]} */
  const blockers = [];

  checks.node = checkNode();
  checks.localExecution = await checkLocalExecution();
  checks.stateDir = checkStateDir(input.stateDir);
  checks.transport = await checkTransport(input.stateDir);
  for (const name of ['node', 'localExecution', 'stateDir', 'transport']) {
    if (checks[name] && checks[name].ok === false) blockers.push({ check: name, ...checks[name] });
  }
  if (input.backend) {
    checks.backend = checkBackend(input.backend, env, input.stateDir);
    if (checks.backend.adapter && checks.backend.adapter.ok === false) {
      blockers.push({ check: 'adapter', ...checks.backend.adapter });
    } else if (!checks.backend.ok) {
      blockers.push({ check: 'backend', ...stripAdapter(checks.backend) });
    }
    checks.model = modelCheck(input.backend, input.probeCache);
  }
  return { ok: blockers.length === 0, checks, blockers };
}

/**
 * Runs every check and throws the first blocker as a typed error.
 * @param {{stateDir: string, env?: NodeJS.ProcessEnv, backend?: any, store?: any}} input
 */
export async function runSessionPreflight(input) {
  const backendId = typeof input.backend === 'string' ? input.backend : input.backend?.id;
  const report = await runPreflight({ stateDir: input.stateDir, env: input.env, backend: backendId });
  if (!report.ok) {
    const first = report.blockers[0];
    throw fail(first.code ?? ERROR_CODES.local_execution_unavailable, first.message, first);
  }
  return report;
}

/** @returns {{ok: boolean, code?: string, message?: string, version: string}} */
export function checkNode() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const [reqMajor, reqMinor, reqPatch] = MIN_NODE_VERSION;
  const ok =
    major > reqMajor || (major === reqMajor && (minor > reqMinor || (minor === reqMinor && patch >= reqPatch)));
  if (!ok) {
    return {
      ok: false,
      code: ERROR_CODES.node_version_unsupported,
      message: `Node ${process.versions.node} is below the required ${MIN_NODE_VERSION.join('.')}`,
      version: process.versions.node,
    };
  }
  return { ok: true, version: process.versions.node };
}

/**
 * Prove a child process can be spawned. A harness without process execution
 * gets `local_execution_unavailable` here rather than an ambiguous EACCES from
 * inside a worker.
 * @param {number} [timeoutMs]
 */
export function checkLocalExecution(timeoutMs = 10000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      resolve({
        ok: false,
        code: ERROR_CODES.local_execution_unavailable,
        message: `Cannot spawn a local process: ${err instanceof Error ? err.message : err}`,
      });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve({
        ok: false,
        code: ERROR_CODES.local_execution_unavailable,
        message: 'Spawned probe process did not exit',
      });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: ERROR_CODES.local_execution_unavailable,
        message: `Cannot spawn a local process: ${err.message}`,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? { ok: true }
          : { ok: false, code: ERROR_CODES.local_execution_unavailable, message: `Probe process exited ${code}` },
      );
    });
  });
}

/**
 * Bind a throwaway control endpoint to prove the transport works here:
 * a unix socket inside the state dir, or a named pipe on Windows. The probe
 * resolves through the same path sessions use — a state dir deeper than the
 * `sun_path` limit falls back to a short hashed name under the temp dir.
 * @param {string} stateDir
 */
export function checkTransport(stateDir) {
  return new Promise((resolve) => {
    const preferred = path.join(stateDir, `.transport-probe-${newId()}.sock`);
    const endpoint = resolveSocketPath(preferred, 'probe');
    if (!IS_WINDOWS) {
      try {
        const dir = path.dirname(endpoint);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodPrivate(dir, 0o700);
        // A probe that fell back to the predictable tmpdir name fails closed
        // on foreign or permissive ownership, same as a real session socket.
        if (dir !== path.dirname(preferred)) assertPrivateSocketDir(dir);
      } catch (err) {
        resolve({
          ok: false,
          code: err?.code === ERROR_CODES.state_error ? err.code : ERROR_CODES.transport_unavailable,
          mechanism: 'unix-socket',
          message: `Control transport directory cannot be trusted: ${err.message}`,
        });
        return;
      }
    }
    const server = net.createServer();
    const done = (result) => {
      try {
        server.close();
      } catch {}
      if (!IS_WINDOWS) {
        try {
          unlinkSync(endpoint);
        } catch {}
      }
      resolve(result);
    };
    server.once('error', (err) => {
      done({
        ok: false,
        code: ERROR_CODES.transport_unavailable,
        mechanism: IS_WINDOWS ? 'named-pipe' : 'unix-socket',
        message: `Control transport cannot listen: ${err.message}`,
      });
    });
    server.listen(endpoint, () => {
      done({ ok: true, mechanism: IS_WINDOWS ? 'named-pipe' : 'unix-socket' });
    });
  });
}

/** @param {string} stateDir */
function checkStateDir(stateDir) {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const probe = path.join(stateDir, `.write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      code: ERROR_CODES.local_execution_unavailable,
      message: `State directory is not writable: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/**
 * Executable + adapter readiness for one backend.
 * @param {any} backend backend registry entry or id
 * @param {NodeJS.ProcessEnv} env
 * @param {string} stateDir
 */
function checkBackend(backend, env, stateDir) {
  const entry = typeof backend === 'string' ? (hasBackend(backend) ? getBackend(backend) : null) : backend;
  if (!entry) {
    return { ok: false, code: ERROR_CODES.unknown_backend, message: `Unknown backend: ${backend}` };
  }
  // A launch override replaces the PATH lookup entirely — used by tests and
  // by wrapper scripts; verify the override's own binary instead.
  const overrideRaw = env?.[`RELAYROOK_BACKEND_CMD_${entry.id.toUpperCase()}`];
  if (overrideRaw) {
    try {
      const argv = JSON.parse(overrideRaw);
      const bin = Array.isArray(argv) ? argv[0] : null;
      if (typeof bin === 'string' && (existsSync(bin) || whichSync(bin, env))) {
        return { ok: true, executable: 'override' };
      }
      return {
        ok: false,
        code: ERROR_CODES.backend_not_installed,
        message: `Override command ${bin} is not executable`,
        backend: entry.id,
      };
    } catch {
      return {
        ok: false,
        code: ERROR_CODES.backend_not_installed,
        message: 'Backend override is not valid JSON argv',
        backend: entry.id,
      };
    }
  }
  if (entry.adapter === 'npm-package') {
    const adapter = resolveClaudeAdapter(stateDir, env);
    const check = { executable: adapter.path ? 'resolved' : null, source: adapter.source, ok: true, adapter: null };
    if (!adapter.path) {
      check.ok = false;
      check.code = ERROR_CODES.adapter_not_ready;
      check.message = `${entry.adapterPackage}@${entry.adapterVersion} is not installed; run relayrook bootstrap ` +
        `--backend ${entry.id}`;
      return check;
    }
    // Pinned-adapter policy: a bootstrapped install whose version differs from
    // the pin is a typed mismatch, not a quiet upgrade.
    if (adapter.source === 'bootstrapped' && adapter.version && adapter.version !== entry.adapterVersion) {
      check.ok = false;
      check.adapter = {
        ok: false,
        code: ERROR_CODES.adapter_version_mismatch,
        message: `Installed adapter ${adapter.version} does not match pinned ${entry.adapterVersion}; rerun bootstrap`,
        installed: adapter.version,
        pinned: entry.adapterVersion,
      };
    } else {
      check.adapter = { ok: true, version: adapter.version ?? entry.adapterVersion, source: adapter.source };
    }
    return check;
  }
  const executable = whichSync(entry.command, env);
  if (!executable) {
    return {
      ok: false,
      code: ERROR_CODES.backend_not_installed,
      message: `${entry.command} not found on PATH`,
      backend: entry.id,
    };
  }
  return { ok: true, executable: 'resolved' };
}

/**
 * Model capability evidence: what the last probe advertised. Never claims
 * support the wire has not shown.
 * @param {string} backendId
 * @param {any} probeCache
 */
function modelCheck(backendId, probeCache) {
  if (backendId !== 'codex') {
    return { ok: null, note: 'model inventory arrives with session metadata' };
  }
  const cached = typeof probeCache?.get === 'function' ? probeCache.get('codex-advertised-models') : null;
  if (!Array.isArray(cached) || cached.length === 0) {
    return { ok: null, note: 'no model/list probe on record; run doctor --probe' };
  }
  return { ok: true, advertised: cached.map((m) => m.id ?? m).filter(Boolean) };
}

/** @param {any} check */
function stripAdapter(check) {
  const { adapter, ...rest } = check;
  return rest;
}
