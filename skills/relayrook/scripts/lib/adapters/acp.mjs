import { JsonRpcPeer } from '../rpc.mjs';
import { fail, ERROR_CODES } from '../errors.mjs';
import { buildLaunchArgs, readModelMetadata, readEffortMetadata } from '../backends.mjs';
import { IS_WINDOWS, spawnCommand, terminateWindowsProcessTree } from '../platform.mjs';

export const CLIENT_INFO = Object.freeze({ name: 'relayrook', version: '0.2.0' });
export const PROTOCOL_VERSION = 1;

/**
 * Client capabilities we advertise to an ACP agent.
 *
 * RelayRook does not lend the agent its own filesystem or terminal: the agent
 * uses its own tools inside the workspace, which keeps permission prompts
 * flowing through `session/request_permission` where the parent can see them.
 */
export const CLIENT_CAPABILITIES = Object.freeze({
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
});

/**
 * A live ACP connection to one spawned backend process.
 *
 * Everything that can only be learned from the wire (session id, current model,
 * advertised permission options, stop reason) is read back rather than assumed.
 */
export class AcpConnection {
  /**
   * @param {{
   *   backend: any,
   *   cwd: string,
   *   model?: string|null,
   *   effort?: string|null,
   *   env?: NodeJS.ProcessEnv,
   *   command?: string,
   *   argsPrefix?: string[],
   *   extraArgs?: string[],
   *   maxLineBytes?: number,
   *   stderrStream?: NodeJS.WritableStream|null,
   *   onUpdate?: (update: any, sessionId: string|null) => void,
   *   onPermissionRequest?: (request: any) => Promise<{optionId?: string, cancelled?: boolean}>,
   *   onTransportError?: (err: Error) => void,
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.backend = options.backend;
    this.child = null;
    this.peer = null;
    this.sessionId = null;
    this.initializeResult = null;
    this.sessionResult = null;
    this.exitInfo = null;
    this.closed = false;
  }

  /**
   * `argsPrefix` belongs to a launch override (a wrapper script or the resolved
   * adapter binary) and must precede the backend's own protocol arguments, so
   * the documented `acp --model ...` tail still reaches the agent.
   */
  get launchArgv() {
    const command = this.options.command ?? this.backend.command;
    const args = [
      ...(this.options.argsPrefix ?? []),
      ...buildLaunchArgs(this.backend, {
        model: this.options.model,
        effort: this.options.effort,
        extraArgs: this.options.extraArgs,
      }),
    ];
    return { command, args };
  }

  async start() {
    const { command, args } = this.launchArgv;
    const child = spawnCommand(command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.on('error', (err) => {
      this.exitInfo = { code: null, signal: null, error: err.message };
      this.peer?.close(fail(ERROR_CODES.process_exited, `Backend process error: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      // Exit status is recorded as evidence only. Turn outcomes always come
      // from the protocol, never from this code.
      this.exitInfo = { code, signal, error: null };
      this.peer?.close(fail(ERROR_CODES.process_exited, `Backend process exited (code=${code} signal=${signal})`));
    });
    if (this.options.stderrStream) child.stderr.pipe(this.options.stderrStream);
    else child.stderr.resume();

    this.peer = new JsonRpcPeer({
      input: child.stdout,
      output: child.stdin,
      maxLineBytes: this.options.maxLineBytes,
      onNotification: (method, params) => this.#onNotification(method, params),
      onRequest: (method, params) => this.#onRequest(method, params),
      onTransportError: (err) => this.options.onTransportError?.(err),
    });
    return this;
  }

  /** @param {string} method @param {any} params */
  #onNotification(method, params) {
    if (method === 'session/update') {
      this.options.onUpdate?.(params?.update ?? {}, params?.sessionId ?? null);
      return;
    }
    // Vendor-prefixed notifications (`_kiro.dev/...`, `_auth/...`) are recorded
    // verbatim so nothing observed on the wire is silently discarded.
    this.options.onUpdate?.({ sessionUpdate: 'agent_notification', method, params }, params?.sessionId ?? null);
  }

  /** @param {string} method @param {any} params */
  async #onRequest(method, params) {
    if (method === 'session/request_permission') {
      if (!this.options.onPermissionRequest) {
        return { outcome: { outcome: 'cancelled' } };
      }
      const decision = await this.options.onPermissionRequest(params ?? {});
      if (decision?.optionId) return { outcome: { outcome: 'selected', optionId: decision.optionId } };
      return { outcome: { outcome: 'cancelled' } };
    }
    // We advertised no filesystem or terminal capability, so any such request is
    // answered with method-not-found rather than a silent success.
    const err = fail(ERROR_CODES.protocol_error, `RelayRook does not implement ${method}`);
    // @ts-ignore attach the JSON-RPC code for the peer
    err.rpcCode = -32601;
    throw err;
  }

  /** @param {number} timeoutMs */
  async initialize(timeoutMs = 30000) {
    this.initializeResult = await this.peer.request(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: CLIENT_INFO },
      { timeoutMs },
    );
    return this.initializeResult;
  }

  /** @param {{cwd: string, mcpServers?: any[], timeoutMs?: number}} options */
  async newSession(options) {
    const result = await this.peer.request(
      'session/new',
      { cwd: options.cwd, mcpServers: options.mcpServers ?? [] },
      { timeoutMs: options.timeoutMs ?? 60000 },
    );
    this.sessionResult = result;
    this.sessionId = result?.sessionId ?? null;
    if (!this.sessionId) {
      throw fail(ERROR_CODES.protocol_error, 'session/new did not return a sessionId');
    }
    return result;
  }

  /**
   * Whether the agent advertised `session/load` at initialize time.
   * @returns {boolean}
   */
  get supportsResume() {
    return this.initializeResult?.agentCapabilities?.loadSession === true;
  }

  /**
   * Resume a persisted ACP session after a worker restart. Requires the agent
   * to advertise `loadSession`; a refusal is reported as
   * `session_not_resumable`, never as a recovered session.
   * @param {{nativeSessionId: string, cwd: string, timeoutMs?: number, mcpServers?: any[]}} options
   */
  async resumeSession(options) {
    if (!this.supportsResume) {
      throw fail(ERROR_CODES.session_not_resumable, `${this.backend.id} did not advertise session/load`, {
        backend: this.backend.id,
        sessionId: options.nativeSessionId,
      });
    }
    let result;
    try {
      result = await this.peer.request(
        'session/load',
        { sessionId: options.nativeSessionId, cwd: options.cwd, mcpServers: options.mcpServers ?? [] },
        { timeoutMs: options.timeoutMs ?? 60000 },
      );
    } catch (err) {
      throw fail(ERROR_CODES.session_not_resumable, `session/load was rejected: ${err?.message ?? err}`, {
        backend: this.backend.id,
        sessionId: options.nativeSessionId,
        underlying: { code: err?.code ?? 'unknown', message: err?.message ?? String(err) },
      });
    }
    this.sessionResult = result;
    this.sessionId = result?.sessionId ?? options.nativeSessionId;
    return result;
  }

  /** Normalised init description for session metadata. */
  describeInit() {
    const init = this.initializeResult ?? {};
    return {
      protocolVersion: init.protocolVersion ?? null,
      agentInfo: init.agentInfo ?? null,
      agentCapabilities: init.agentCapabilities ?? null,
    };
  }

  /** Model and effort metadata as the backend actually reported it. */
  readSessionMetadata() {
    const model = readModelMetadata(this.backend, this.sessionResult);
    const effort = readEffortMetadata(this.sessionResult);
    const modes = this.sessionResult?.modes ?? null;
    return { model, effort, modes };
  }

  /**
   * Select a model through `session/set_config_option` and read the value back.
   *
   * A requested model that is not reflected in the readback is reported as a
   * rejection; RelayRook never quietly accepts a different model.
   * @param {string} model
   * @param {{timeoutMs?: number}} [options]
   */
  async selectModel(model, options = {}) {
    const configId = this.backend.modelConfigId ?? 'model';
    const result = await this.peer.request(
      'session/set_config_option',
      { sessionId: this.sessionId, configId, value: model },
      { timeoutMs: options.timeoutMs ?? 30000 },
    );
    const configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
    const entry = configOptions.find((o) => o && o.id === configId);
    const observed = entry?.currentValue ?? null;
    if (observed !== model) {
      throw fail(ERROR_CODES.model_rejected, `Backend did not confirm model ${model}`, {
        requested: model,
        observed,
        configId,
      });
    }
    if (this.sessionResult) this.sessionResult.configOptions = configOptions;
    return { requested: model, observed, configId, verified: true };
  }

  /**
   * Set an effort/thought-level config option when the backend advertises one.
   * @param {string} effort
   * @param {{timeoutMs?: number}} [options]
   */
  async selectEffort(effort, options = {}) {
    const meta = readEffortMetadata(this.sessionResult);
    if (!meta.configId) {
      return { requested: effort, observed: null, verified: false, reason: 'backend advertises no effort option' };
    }
    const result = await this.peer.request(
      'session/set_config_option',
      { sessionId: this.sessionId, configId: meta.configId, value: effort },
      { timeoutMs: options.timeoutMs ?? 30000 },
    );
    const configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
    const entry = configOptions.find((o) => o && o.id === meta.configId);
    const observed = entry?.currentValue ?? null;
    if (this.sessionResult) this.sessionResult.configOptions = configOptions;
    return { requested: effort, observed, verified: observed === effort, configId: meta.configId };
  }

  /**
   * Submit one prompt turn.
   * @param {string} text
   * @param {{timeoutMs?: number}} [options]
   */
  prompt(text, options = {}) {
    return this.peer.request(
      'session/prompt',
      { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
      { timeoutMs: options.timeoutMs ?? 0 },
    );
  }

  /** ACP cancellation is a notification; the turn resolves with stopReason `cancelled`. */
  cancel() {
    this.peer?.notify('session/cancel', { sessionId: this.sessionId });
  }

  async close({ timeoutMs = 5000 } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.peer?.close();
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    if (IS_WINDOWS && child.pid) {
      const terminated = await terminateWindowsProcessTree(child.pid, timeoutMs);
      if (!terminated) {
        this.closed = false;
        throw fail(ERROR_CODES.state_error, `Failed to terminate backend process tree ${child.pid}`);
      }
      return;
    }
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(undefined);
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
}
