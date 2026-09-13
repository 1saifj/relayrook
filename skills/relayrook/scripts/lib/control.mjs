import net from 'node:net';
import { chmodSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

import { JsonRpcPeer } from './rpc.mjs';
import { fail, ERROR_CODES } from './errors.mjs';
import { IS_WINDOWS } from './platform.mjs';

/**
 * The CLI is invoked once per command, so the persistent backend process lives
 * in a detached worker. Commands reach it over a control transport speaking
 * the same newline JSON-RPC framing as ACP itself:
 *
 * - Unix: a socket file in the session directory (0700 dir, 0600 socket).
 * - Windows: a `\\.\pipe\` named pipe. The pipe namespace is machine-wide, so
 *   every request must carry the per-session token from `control.token`, which
 *   is protected by the same user-profile ACL as the rest of the state dir.
 *
 * The token check runs on Unix too — a stale socket left by an old worker
 * generation is then unambiguously rejected instead of being probed.
 */

function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @param {string} socketPath endpoint (unix socket path or pipe name)
 * @param {Record<string, (params: any) => Promise<any>>} handlers
 * @param {{token?: string}} [options] required auth token for every request
 */
export function serveControl(socketPath, handlers, options = {}) {
  if (!IS_WINDOWS && existsSync(socketPath)) {
    throw fail(ERROR_CODES.state_error, `Refusing to replace an existing control socket: ${socketPath}`);
  }
  const expectedToken = options.token ?? null;
  const server = net.createServer((socket) => {
    const peer = new JsonRpcPeer({
      input: socket,
      output: socket,
      onRequest: async (method, params) => {
        if (expectedToken && !tokensEqual(params?.token, expectedToken)) {
          throw fail(ERROR_CODES.control_unauthorized, 'Missing or invalid control token');
        }
        const handler = handlers[method];
        if (!handler) throw fail(ERROR_CODES.protocol_error, `Unknown control method: ${method}`);
        const { token: _token, ...rest } = params ?? {};
        return handler(rest);
      },
      onTransportError: () => {},
    });
    socket.on('close', () => peer.close());
    socket.on('error', () => peer.close());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      if (IS_WINDOWS) {
        resolve(server);
        return;
      }
      try {
        chmodSync(socketPath, 0o600);
        resolve(server);
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

/**
 * One request/response round trip against a worker's control socket.
 * @param {string} socketPath
 * @param {string} method
 * @param {any} [params]
 * @param {{timeoutMs?: number, token?: string|null}} [options]
 */
export function callControl(socketPath, method, params = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  return new Promise((resolve, reject) => {
    if (!IS_WINDOWS && !existsSync(socketPath)) {
      reject(fail(ERROR_CODES.session_not_running, 'Session worker is not running (no control socket)'));
      return;
    }
    const socket = net.connect(socketPath);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };
    socket.on('error', (err) => {
      finish(reject, fail(ERROR_CODES.session_not_running, `Control socket error: ${err.message}`));
    });
    socket.on('connect', () => {
      const peer = new JsonRpcPeer({
        input: socket,
        output: socket,
        onTransportError: () => {},
      });
      const payload = options.token ? { ...params, token: options.token } : params;
      peer.request(method, payload, { timeoutMs }).then(
        (result) => finish(resolve, result),
        (err) => finish(reject, err),
      );
    });
  });
}

/**
 * Liveness check used for session reuse: a socket file or pipe name alone does
 * not prove a live worker, so we actually round-trip a ping.
 * @param {string} socketPath
 * @param {number|{timeoutMs?: number, token?: string|null}} [optionsOrTimeout]
 */
export async function pingControl(socketPath, optionsOrTimeout = 3000) {
  const options = typeof optionsOrTimeout === 'number' ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
  try {
    const result = await callControl(socketPath, 'ping', {}, { timeoutMs: options.timeoutMs ?? 3000, token: options.token });
    return { alive: true, result };
  } catch (err) {
    return { alive: false, error: err instanceof Error ? err.message : String(err) };
  }
}
