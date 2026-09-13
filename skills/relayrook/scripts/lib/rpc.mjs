import { JsonLineReader, encodeJsonLine, DEFAULT_MAX_LINE_BYTES } from './jsonline.mjs';
import { fail, ERROR_CODES, RelayRookError } from './errors.mjs';
import { withTimeout } from './util.mjs';

/**
 * Bidirectional JSON-RPC 2.0 peer over a pair of newline-delimited streams.
 *
 * Both ACP agents and the RelayRook control socket speak this framing, so the
 * same peer drives a spawned `devin acp` child and the CLI's socket client.
 */
export class JsonRpcPeer {
  /**
   * @param {{
   *   input: NodeJS.ReadableStream,
   *   output: NodeJS.WritableStream,
   *   onNotification?: (method: string, params: any) => void,
   *   onRequest?: (method: string, params: any) => Promise<any>,
   *   onTransportError?: (err: Error) => void,
   *   maxLineBytes?: number,
   *   omitJsonRpcField?: boolean,
   * }} options
   */
  constructor(options) {
    this.output = options.output;
    this.onNotification = options.onNotification ?? (() => {});
    this.onRequest = options.onRequest ?? (async () => {
      throw fail(ERROR_CODES.protocol_error, 'No request handler registered');
    });
    this.onTransportError = options.onTransportError ?? (() => {});
    this.omitJsonRpcField = options.omitJsonRpcField === true;
    this.nextId = 1;
    this.closed = false;
    /** @type {Map<number|string, {resolve: (v: any) => void, reject: (e: any) => void}>} */
    this.pending = new Map();

    this.reader = new JsonLineReader({
      maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      onMessage: (msg) => this.#dispatch(msg),
      onError: (err) => this.onTransportError(err),
    });

    options.input.on('data', (chunk) => this.reader.push(chunk));
    options.input.on('error', (err) => this.onTransportError(err));
  }

  /** @param {any} msg */
  #dispatch(msg) {
    if (msg === null || typeof msg !== 'object') return;
    if (msg.method !== undefined && msg.id !== undefined) {
      void this.#handleIncomingRequest(msg);
      return;
    }
    if (msg.method !== undefined) {
      try {
        this.onNotification(msg.method, msg.params);
      } catch (err) {
        this.onTransportError(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }
    if (msg.id === undefined) return;
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      // A peer that speaks RelayRook's own error envelope carries its typed
      // code in `data`, so a code survives the socket instead of collapsing
      // into a generic protocol error.
      const relayed = msg.error.data?.relayrookCode;
      waiter.reject(
        fail(relayed ?? ERROR_CODES.protocol_error, msg.error.message ?? 'Peer returned an error', {
          rpcCode: msg.error.code,
          ...(msg.error.data?.details ?? {}),
        }),
      );
    } else {
      waiter.resolve(msg.result);
    }
  }

  /** @param {any} msg */
  async #handleIncomingRequest(msg) {
    try {
      const result = await this.onRequest(msg.method, msg.params ?? {});
      this.#write({ id: msg.id, result: result ?? {} });
    } catch (err) {
      const code = err && typeof err === 'object' && 'rpcCode' in err ? Number(err.rpcCode) : -32603;
      const data =
        err instanceof RelayRookError ? { relayrookCode: err.code, details: err.details } : undefined;
      this.#write({
        id: msg.id,
        error: { code, message: err instanceof Error ? err.message : String(err), data },
      });
    }
  }

  /** @param {Record<string, unknown>} payload */
  #write(payload) {
    if (this.closed) return;
    const message = this.omitJsonRpcField ? payload : { jsonrpc: '2.0', ...payload };
    try {
      this.output.write(encodeJsonLine(message));
    } catch (err) {
      this.onTransportError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @param {{timeoutMs?: number}} [options]
   */
  request(method, params, options = {}) {
    if (this.closed) {
      return Promise.reject(fail(ERROR_CODES.process_exited, `Cannot call ${method}: transport closed`));
    }
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#write({ id, method, params: params ?? {} });
    });
    const timeoutMs = options.timeoutMs ?? 0;
    return withTimeout(promise, timeoutMs, () => {
      this.pending.delete(id);
      return fail(ERROR_CODES.turn_timeout, `Timed out after ${timeoutMs}ms waiting for ${method}`, { method });
    });
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   */
  notify(method, params) {
    this.#write({ method, params: params ?? {} });
  }

  /** @param {Error} [reason] */
  close(reason) {
    if (this.closed) return;
    this.closed = true;
    const err = reason ?? fail(ERROR_CODES.process_exited, 'Transport closed');
    for (const [, waiter] of this.pending) waiter.reject(err);
    this.pending.clear();
  }
}
