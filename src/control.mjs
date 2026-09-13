import net from 'node:net';
import { chmodSync, existsSync } from 'node:fs';

import { JsonRpcPeer } from './rpc.mjs';
import { fail, ERROR_CODES } from './errors.mjs';

/**
 * The CLI is invoked once per command, so the persistent backend process lives
 * in a detached worker. Commands reach it over a unix domain socket in the
 * session directory, speaking the same newline JSON-RPC framing as ACP itself.
 */

/**
 * @param {string} socketPath
 * @param {Record<string, (params: any) => Promise<any>>} handlers
 */
export function serveControl(socketPath, handlers) {
  if (existsSync(socketPath)) {
    throw fail(ERROR_CODES.state_error, `Refusing to replace an existing control socket: ${socketPath}`);
  }
  const server = net.createServer((socket) => {
    const peer = new JsonRpcPeer({
      input: socket,
      output: socket,
      onRequest: async (method, params) => {
        const handler = handlers[method];
        if (!handler) throw fail(ERROR_CODES.protocol_error, `Unknown control method: ${method}`);
        return handler(params ?? {});
      },
      onTransportError: () => {},
    });
    socket.on('close', () => peer.close());
    socket.on('error', () => peer.close());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
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
 * @param {{timeoutMs?: number}} [options]
 */
export function callControl(socketPath, method, params = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  return new Promise((resolve, reject) => {
    if (!existsSync(socketPath)) {
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
      peer.request(method, params, { timeoutMs }).then(
        (result) => finish(resolve, result),
        (err) => finish(reject, err),
      );
    });
  });
}

/**
 * Liveness check used for session reuse: a socket file alone does not prove a
 * live worker, so we actually round-trip a ping.
 * @param {string} socketPath
 * @param {number} [timeoutMs]
 */
export async function pingControl(socketPath, timeoutMs = 3000) {
  try {
    const result = await callControl(socketPath, 'ping', {}, { timeoutMs });
    return { alive: true, result };
  } catch (err) {
    return { alive: false, error: err instanceof Error ? err.message : String(err) };
  }
}
