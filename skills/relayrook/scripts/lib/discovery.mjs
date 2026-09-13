import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { allBackends, getBackend } from './backends.mjs';
import { redactPath, shortHash, writeJsonAtomic } from './util.mjs';
import { spawnCommand } from './platform.mjs';

/**
 * Deterministic, cheap discovery first (PATH + `--version`), protocol probes
 * only when asked. docs/research.md §8: never spend an LLM call on a PATH check.
 *
 * Evidence states are reported as independent fields, not as a ladder:
 * an unauthenticated process can still advertise models, and an authenticated
 * account can still have no quota.
 */
export const EVIDENCE_FIELDS = Object.freeze([
  'installed',
  'protocolReady',
  'authenticated',
  'modelAdvertised',
  'modelSmokeTested',
  'taskQualified',
]);

export const CLAUDE_ADAPTER_BIN_ENV = 'RELAYROOK_CLAUDE_ACP_BIN';

/**
 * Resolve an executable on PATH without invoking a shell.
 * @param {string} command
 * @param {NodeJS.ProcessEnv} [env]
 */
export function whichSync(command, env = process.env) {
  if (command.includes(path.sep)) {
    return isExecutable(command) ? path.resolve(command) : null;
  }
  const pathValue = env.PATH ?? '';
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** @param {string} file */
function isExecutable(file) {
  try {
    const stats = statSync(file);
    if (!stats.isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return null;
  }
}

/**
 * Run `<command> --version` with a hard timeout and capture the first line.
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs?: number, cwd?: string}} [options]
 */
export function probeVersion(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawnCommand(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ ok: false, version: null, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, version: null, error: `version probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      if (out.length < 4096) out += String(c);
    });
    child.stderr.on('data', (c) => {
      if (errOut.length < 4096) errOut += String(c);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, version: null, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = (out.trim() || errOut.trim()).split('\n')[0]?.trim() ?? '';
      const version = extractVersion(text);
      // Exit code is evidence about the probe only, never about a turn.
      finish({ ok: text.length > 0, version, raw: text || null, exitCode: code });
    });
  });
}

/** @param {string} text */
export function extractVersion(text) {
  const match = /\b(\d+(?:\.\d+)+(?:[-+][\w.]+)?)\b/.exec(text ?? '');
  return match ? match[1] : null;
}

/**
 * Where the pinned Claude ACP adapter binary can be found, if anywhere.
 * @param {string} stateDir
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveClaudeAdapter(stateDir, env = process.env) {
  const backend = getBackend('claude');
  const override = env[CLAUDE_ADAPTER_BIN_ENV];
  if (override && existsSync(override)) {
    return { path: override, source: 'env-override', version: null };
  }
  const onPath = whichSync(backend.command, env);
  if (onPath) return { path: onPath, source: 'path', version: null };
  const bundled = path.join(
    stateDir,
    'adapters',
    'node_modules',
    '.bin',
    process.platform === 'win32' ? `${backend.command}.cmd` : backend.command,
  );
  if (existsSync(bundled)) {
    return { path: bundled, source: 'bootstrapped', version: readAdapterVersion(stateDir) };
  }
  return { path: null, source: 'missing', version: null };
}

/** @param {string} stateDir */
function readAdapterVersion(stateDir) {
  const pkg = path.join(
    stateDir,
    'adapters',
    'node_modules',
    '@agentclientprotocol',
    'claude-agent-acp',
    'package.json',
  );
  try {
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Cheap deterministic discovery for one backend.
 * @param {any} backend
 * @param {{stateDir: string, env?: NodeJS.ProcessEnv, timeoutMs?: number}} options
 */
export async function discoverBackend(backend, options) {
  const env = options.env ?? process.env;
  const record = {
    id: backend.id,
    label: backend.label,
    kind: backend.kind,
    adapter: backend.adapter,
    provider: backend.provider,
    billingRoute: backend.billingRoute,
    sessionSupport: backend.sessionSupport,
    sessionSupportReason: backend.sessionSupportReason ?? null,
    metadataStyle: backend.metadataStyle,
    modelSelection: backend.modelSelection,
    defaultModel: backend.defaultModel,
    modelPinPolicy: backend.modelPinPolicy,
    effortReadback: backend.effortReadback,
    notes: backend.notes,
    evidence: {
      installed: false,
      protocolReady: null,
      authenticated: null,
      modelAdvertised: null,
      modelSmokeTested: false,
      taskQualified: false,
    },
    executable: null,
    version: null,
    adapterReadiness: null,
    quota: 'unknown',
    problems: [],
  };

  if (backend.adapter === 'npm-package') {
    // The base CLI proves the host is installed; the adapter binary is what we
    // actually launch, and it ships separately.
    const host = whichSync(backend.hostCommand, env);
    record.hostExecutable = redactPath(host);
    const adapter = resolveClaudeAdapter(options.stateDir, env);
    record.adapterReadiness = {
      package: backend.adapterPackage,
      pinnedVersion: backend.adapterVersion,
      installedVersion: adapter.version,
      source: adapter.source,
      path: redactPath(adapter.path),
      ready: Boolean(adapter.path),
      bootstrapCommand: 'relayrook bootstrap --backend claude',
    };
    record.executable = redactPath(adapter.path);
    record.evidence.installed = Boolean(host) && Boolean(adapter.path);
    if (!host) record.problems.push(`${backend.hostCommand} not found on PATH`);
    if (!adapter.path) record.problems.push(`${backend.adapterPackage} not installed; run the bootstrap command`);
    if (host) {
      const hostVersion = await probeVersion(backend.hostCommand, backend.hostVersionArgs, {
        timeoutMs: options.timeoutMs,
      });
      record.hostVersion = hostVersion.version;
    }
    return record;
  }

  const executable = whichSync(backend.command, env);
  record.executable = redactPath(executable);
  record.evidence.installed = Boolean(executable);
  if (!executable) {
    record.problems.push(`${backend.command} not found on PATH`);
    return record;
  }
  // Probe the resolved path, not the bare name: on Windows a `.cmd` shim can
  // only be executed through cmd.exe, and spawnCommand can only tell it needs
  // that route from a real file extension.
  const version = await probeVersion(executable, backend.versionArgs, { timeoutMs: options.timeoutMs });
  record.version = version.version;
  if (!version.version && version.error) record.problems.push(`version probe failed: ${version.error}`);
  return record;
}

/**
 * Discover every backend. Failures are contained per backend so one broken CLI
 * cannot fail the whole inventory.
 * @param {{stateDir: string, env?: NodeJS.ProcessEnv, timeoutMs?: number}} options
 */
export async function discoverAll(options) {
  const results = await Promise.all(
    allBackends().map(async (backend) => {
      try {
        return await discoverBackend(backend, options);
      } catch (err) {
        return {
          id: backend.id,
          label: backend.label,
          evidence: { installed: false },
          problems: [err instanceof Error ? err.message : String(err)],
        };
      }
    }),
  );
  return results;
}

/**
 * Capability probe cache keyed by executable path, version and a configuration
 * fingerprint, as docs/research.md §4 requires. An upgrade changes the key, so
 * a stale probe can never be served for a new binary.
 */
export class ProbeCache {
  /** @param {string} stateDir */
  constructor(stateDir) {
    this.file = path.join(stateDir, 'probe-cache.json');
    /** @type {Record<string, any>} */
    this.data = {};
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  /** @param {{backend: string, executable: string|null, version: string|null, fingerprint?: string}} key */
  static key(key) {
    return shortHash([key.backend, key.executable ?? '', key.version ?? '', key.fingerprint ?? ''].join('|'));
  }

  /** @param {string} key @param {number} maxAgeMs */
  get(key, maxAgeMs = 6 * 60 * 60 * 1000) {
    const entry = this.data[key];
    if (!entry) return null;
    if (Date.now() - Date.parse(entry.storedAt) > maxAgeMs) return null;
    return entry.value;
  }

  /** @param {string} key @param {any} value */
  set(key, value) {
    this.data[key] = { storedAt: new Date().toISOString(), value };
    writeJsonAtomic(this.file, this.data);
  }

  /** @param {string} key */
  invalidate(key) {
    delete this.data[key];
    writeJsonAtomic(this.file, this.data);
  }
}
