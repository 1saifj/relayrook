import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { getBackend } from './backends.mjs';
import { fail, ERROR_CODES } from './errors.mjs';
import { resolveClaudeAdapter } from './discovery.mjs';
import { redactPath, writeJsonAtomic } from './util.mjs';

/**
 * Install a backend's pinned adapter package into the state directory.
 *
 * The version is pinned exactly — no floating `@latest` on a normal turn — and
 * the install lands outside both the target repository and the skill directory,
 * so a published skill never carries third-party code it did not author.
 *
 * @param {{backend: string, stateDir: string, timeoutMs?: number, dryRun?: boolean}} input
 */
export async function bootstrapAdapter(input) {
  const backend = getBackend(input.backend);
  if (backend.adapter !== 'npm-package') {
    return {
      backend: backend.id,
      action: 'none',
      reason: `${backend.id} uses its own CLI (${backend.command}); nothing to bootstrap.`,
    };
  }

  const dir = path.join(input.stateDir, 'adapters');
  const spec = `${backend.adapterPackage}@${backend.adapterVersion}`;
  const argv = ['install', '--ignore-scripts', '--no-fund', '--no-audit', '--prefix', dir, spec];

  const existing = resolveClaudeAdapter(input.stateDir);
  if (existing.path && existing.version === backend.adapterVersion) {
    return {
      backend: backend.id,
      action: 'already-installed',
      package: backend.adapterPackage,
      version: existing.version,
      path: redactPath(existing.path),
    };
  }

  if (input.dryRun) {
    return { backend: backend.id, action: 'dry-run', command: `npm ${argv.join(' ')}`, package: spec };
  }

  mkdirSync(dir, { recursive: true });
  // A minimal manifest keeps npm from walking up into an unrelated project.
  writeJsonAtomic(path.join(dir, 'package.json'), {
    name: 'relayrook-adapters',
    private: true,
    version: '0.0.0',
    description: 'Pinned ACP adapters installed by RelayRook. Not part of the published skill.',
  });

  const result = await runNpm(argv, { cwd: dir, timeoutMs: input.timeoutMs ?? 300000 });
  if (!result.ok) {
    throw fail(ERROR_CODES.bootstrap_failed, `npm install failed for ${spec}`, {
      command: `npm ${argv.join(' ')}`,
      stderr: result.stderr.slice(-2000),
      exitCode: result.code,
    });
  }

  const installed = resolveClaudeAdapter(input.stateDir);
  if (!installed.path) {
    throw fail(ERROR_CODES.bootstrap_failed, `${spec} installed but the ${backend.command} binary was not found`, {
      searchedIn: redactPath(dir),
    });
  }
  return {
    backend: backend.id,
    action: 'installed',
    package: backend.adapterPackage,
    requestedVersion: backend.adapterVersion,
    installedVersion: installed.version,
    path: redactPath(installed.path),
  };
}

/**
 * @param {string[]} argv
 * @param {{cwd: string, timeoutMs: number}} options
 */
function runNpm(argv, options) {
  // npm ships as npm.cmd on Windows, which execFile cannot launch without a
  // shell — so the shell is enabled only there.
  const win = process.platform === 'win32';
  return new Promise((resolve) => {
    execFile(
      win ? 'npm.cmd' : 'npm',
      argv,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        shell: win,
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err === 'object' && 'code' in err ? Number(err.code) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? (err instanceof Error ? err.message : '')),
        });
      },
    );
  });
}
