import { spawn } from 'node:child_process';

import { JsonRpcPeer } from '../rpc.mjs';
import { fail, ERROR_CODES } from '../errors.mjs';

/**
 * Codex native app-server adapter — discovery only in v0.1.
 *
 * `codex app-server --stdio` speaks JSON-RPC without the `jsonrpc` envelope
 * field. This adapter implements `initialize`, the `initialized` notification,
 * `model/list` and `account/read`, which is everything `doctor` needs.
 *
 * Turn control (`thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`,
 * `review/start`) is deliberately NOT implemented here. The registry marks the
 * backend `sessionSupport: 'not-implemented'` so routing rejects it rather than
 * claiming session behaviour RelayRook has not built or tested.
 */
export class CodexAppServerProbe {
  /**
   * @param {{command?: string, args?: string[], cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number}} [options]
   */
  constructor(options = {}) {
    this.command = options.command ?? 'codex';
    this.args = options.args ?? ['app-server', '--stdio'];
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? {};
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.child = null;
    this.peer = null;
  }

  async start() {
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.resume();
    child.on('error', (err) => {
      this.peer?.close(fail(ERROR_CODES.process_exited, `codex app-server error: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      this.peer?.close(fail(ERROR_CODES.process_exited, `codex app-server exited (code=${code} signal=${signal})`));
    });
    this.peer = new JsonRpcPeer({
      input: child.stdout,
      output: child.stdin,
      omitJsonRpcField: true,
      onRequest: async (method) => {
        const err = fail(ERROR_CODES.protocol_error, `RelayRook does not implement ${method}`);
        // @ts-ignore attach the JSON-RPC code for the peer
        err.rpcCode = -32601;
        throw err;
      },
    });
    return this;
  }

  async initialize() {
    const result = await this.peer.request(
      'initialize',
      { clientInfo: { name: 'relayrook', version: '0.1.0' }, capabilities: {} },
      { timeoutMs: this.timeoutMs },
    );
    this.peer.notify('initialized', {});
    return result;
  }

  /** @param {number} [limit] */
  async listModels(limit = 100) {
    const result = await this.peer.request('model/list', { limit }, { timeoutMs: this.timeoutMs });
    const data = Array.isArray(result?.data) ? result.data : [];
    return data
      .filter((m) => m && m.hidden !== true)
      .map((m) => ({
        id: m.id ?? m.model ?? null,
        displayName: m.displayName ?? null,
        isDefault: m.isDefault === true,
        efforts: Array.isArray(m.supportedReasoningEfforts)
          ? m.supportedReasoningEfforts.map((e) => e.reasoningEffort).filter(Boolean)
          : [],
        defaultEffort: m.defaultReasoningEffort ?? null,
      }))
      .filter((m) => m.id);
  }

  /**
   * Account presence only. No identifier, email, token or plan detail is
   * returned to the caller — just whether the CLI reports an authenticated
   * account, so `doctor` output stays free of credentials.
   */
  async readAccount() {
    const result = await this.peer.request('account/read', { refreshToken: false }, { timeoutMs: this.timeoutMs });
    const account = result?.account ?? null;
    return {
      present: Boolean(account),
      type: account?.type ?? null,
      requiresOpenaiAuth: result?.requiresOpenaiAuth ?? null,
    };
  }

  async close() {
    this.peer?.close();
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(undefined);
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
}

/**
 * One-shot discovery probe used by `doctor --probe`.
 * @param {{command?: string, cwd?: string, timeoutMs?: number}} [options]
 */
export async function probeCodex(options = {}) {
  const probe = new CodexAppServerProbe(options);
  try {
    await probe.start();
    const init = await probe.initialize();
    const models = await probe.listModels();
    let account = { present: false, type: null, requiresOpenaiAuth: null };
    try {
      account = await probe.readAccount();
    } catch (err) {
      account = { present: false, type: null, requiresOpenaiAuth: null, error: describe(err) };
    }
    return {
      protocolReady: true,
      serverInfo: init?.userAgent ?? init?.serverInfo ?? null,
      models,
      account,
      sessionControl: 'not-implemented',
    };
  } catch (err) {
    return { protocolReady: false, error: describe(err), models: [], account: null, sessionControl: 'not-implemented' };
  } finally {
    await probe.close();
  }
}

/** @param {unknown} err */
function describe(err) {
  return err instanceof Error ? err.message : String(err);
}
