import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { readFile, readlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Platform differences, in one place.
 *
 * Control transport: Unix uses a private socket file under the session
 * directory (0700 directory, 0600 socket). Windows has no unix sockets; Node
 * maps the same `net` API onto named pipes, so the worker listens on
 * `\\.\pipe\relayrook-<hash>` and every control call carries the per-session
 * token stored in `control.token`.
 */

export const IS_WINDOWS = process.platform === 'win32';

/**
 * The control endpoint for a session. On Unix this is a filesystem socket
 * path; on Windows it is a `\\.\pipe\` name that is unique per session
 * directory so two state directories can never collide on the machine-wide
 * pipe namespace.
 * @param {string} preferred unix socket path (ignored on Windows)
 * @param {string} key session key
 */
export function resolveControlEndpoint(preferred, key) {
  if (!IS_WINDOWS) return preferred;
  const uid = process.env.USERNAME ?? process.env.USER ?? 'user';
  const digest = createHash('sha256').update(`${preferred}${key}${uid}`).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\relayrook-${digest}`;
}

/**
 * Whether a control endpoint exists on disk. Named pipes are not files, so on
 * Windows this is always false and liveness is proven by connecting instead.
 * @param {string} endpoint
 */
export function controlEndpointExists(endpoint) {
  if (IS_WINDOWS) return false;
  try {
    return existsSync(endpoint);
  } catch {
    return false;
  }
}

/** Best-effort private permissions; chmod is meaningful only on Unix. */
export function chmodPrivate(file, mode) {
  if (IS_WINDOWS) return;
  try {
    chmodSync(file, mode);
  } catch {
    // Permissions are best-effort; the control token still guards calls.
  }
}

/**
 * Default per-user state directory for this platform.
 * Windows uses %LOCALAPPDATA% (falling back to ~/AppData/Local); everything
 * else uses $XDG_STATE_HOME or ~/.local/state.
 * @param {NodeJS.ProcessEnv} env
 */
export function defaultStateBase(env = process.env) {
  if (IS_WINDOWS) {
    const local = env.LOCALAPPDATA ? path.resolve(env.LOCALAPPDATA) : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'relayrook');
  }
  const base = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'relayrook');
}

/**
 * Whether a pid refers to a live process. `process.kill(pid, 0)` is the
 * portable existence probe and works on Windows too.
 * @param {number|undefined|null} pid
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a live process's command and start marker without blocking the event
 * loop. A pid alone is not identity because operating systems reuse pids.
 * Returns null when either value cannot be established; callers must fail
 * closed rather than treating partial evidence as a match.
 * @param {number|undefined|null} pid
 * @returns {Promise<{command: string, startedAt: string}|null>}
 */
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      // /proc avoids depending on GNU ps (BusyBox ps lacks lstart). The boot
      // id plus start ticks is stable across probes and distinct after reboot.
      const [command, stat, bootId] = await Promise.all([
        readlink(`/proc/${pid}/exe`),
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      ]);
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      if (!/^\d+$/.test(startTicks ?? '') || !bootId.trim()) return null;
      return { command, startedAt: `${bootId.trim()}:${startTicks}` };
    }
    if (IS_WINDOWS) {
      const script =
        `$p=Get-Process -Id ${pid} -ErrorAction Stop; ` +
        '[pscustomobject]@{command=$p.Path;' +
        'startedAt=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress';
      const out = await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 2000);
      const parsed = JSON.parse(out.trim());
      if (typeof parsed?.command !== 'string' || typeof parsed?.startedAt !== 'string') return null;
      return { command: parsed.command, startedAt: parsed.startedAt };
    }
    const out = await execFileText('ps', ['-o', 'comm=', '-o', 'lstart=', '-p', String(pid)], 2000);
    const match = out.trim().match(/^(.*?)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/);
    if (!match?.[1] || !match?.[2]) return null;
    return { command: match[1].trim(), startedAt: match[2].replace(/\s+/g, ' ') };
  } catch {
    return null;
  }
}

/** @param {string} command @param {string[]} args @param {number} timeout */
function execFileText(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * Terminate a Windows wrapper and every process below it. npm command shims
 * run through cmd.exe, so killing only the wrapper can leave the agent alive.
 * @param {number} pid @param {number} [timeoutMs]
 */
export function terminateWindowsProcessTree(pid, timeoutMs = 5000) {
  if (!IS_WINDOWS || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killer.kill();
      resolve(false);
    }, timeoutMs);
    killer.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    killer.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

const WINDOWS_SCRIPT_EXTENSIONS = new Set(['.cmd', '.bat']);

/**
 * Quote one argument for `cmd.exe /d /v:off /s /c`. Reject characters that
 * cannot survive cmd expansion safely, even inside quotes. Delayed expansion
 * is disabled explicitly so exclamation marks remain literal.
 * @param {string} arg
 */
export function quoteForCmd(arg) {
  const text = String(arg);
  if (/["%\r\n\0]/.test(text)) {
    throw new Error('Cannot quote argument containing quotes, percent signs, or control characters for cmd.exe');
  }
  // The eventual native executable uses CRT argv parsing; backslashes just
  // before its closing quote must be doubled to remain literal.
  return `"${text.replace(/\\+$/, (slashes) => slashes + slashes)}"`;
}

/**
 * Spawn a backend command portably.
 *
 * On Windows, executables resolved to `.cmd`/`.bat` shims (the common install
 * shape for npm-distributed CLIs) cannot be spawned directly; they are run
 * through `cmd.exe /d /s /c` with explicit quoting. Native executables
 * (`.exe`, `.com`, extensionless) spawn directly on every platform.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 */
export function spawnCommand(command, args, options = {}) {
  if (IS_WINDOWS && WINDOWS_SCRIPT_EXTENSIONS.has(path.extname(command).toLowerCase())) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const line = [quoteForCmd(command), ...args.map(quoteForCmd)].join(' ');
    // /s strips the outer pair of quotes, leaving the executable and each
    // argument quoted. Node must pass this string verbatim: CRT escaping is
    // not cmd.exe escaping and breaks shim paths containing spaces.
    return spawn(comspec, ['/d', '/v:off', '/s', '/c', `"${line}"`], {
      windowsHide: true,
      ...options,
      shell: false,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(command, args, { windowsHide: true, ...options });
}
