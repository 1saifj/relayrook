import { JsonRpcPeer } from '../rpc.mjs';
import { fail, ERROR_CODES } from '../errors.mjs';
import { IS_WINDOWS, spawnCommand, terminateWindowsProcessTree } from '../platform.mjs';
import { newId } from '../util.mjs';

export const CODEX_CLIENT_INFO = Object.freeze({ name: 'relayrook', version: '0.2.0' });

/**
 * Codex app-server adapter (`codex app-server --stdio`).
 *
 * Codex speaks newline JSON-RPC without the `jsonrpc` envelope field and maps
 * RelayRook concepts onto threads and turns:
 *
 *   session  -> thread  (thread/start, thread/resume, thread/read)
 *   prompt   -> turn    (turn/start; streamed items; turn/completed)
 *   steer    -> turn/steer on the in-flight turn
 *   cancel   -> turn/interrupt
 *   review   -> review/start (inline or detached)
 *
 * Permission requests arrive as server->client requests
 * (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
 * `item/permissions/requestApproval`). They are normalised into the same
 * pending-permission shape ACP sessions use, so the parent answers them with
 * the same `permission` command and only ever with an advertised option.
 *
 * Everything that can be read back is read back: `thread/start` returns the
 * effective model and reasoning effort, `thread/read` re-reads them, and
 * `thread/resume` reports them for a recovered session.
 */

/** Map a RelayRook profile onto Codex sandbox and approval policy. */
export function codexProfilePolicies(profile, overrides = {}) {
  const readOnly = profile === 'read-only';
  return {
    sandbox: overrides.sandbox ?? (readOnly ? 'read-only' : 'workspace-write'),
    // Read-only sessions never ask: anything the sandbox cannot grant is
    // denied outright instead of round-tripping to the parent.
    approvalPolicy: overrides.approvalPolicy ?? (readOnly ? 'never' : 'on-request'),
  };
}

const APPROVAL_OPTIONS = Object.freeze([
  { optionId: 'accept', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'acceptForSession', name: 'Allow for session', kind: 'allow_always' },
  { optionId: 'decline', name: 'Decline', kind: 'reject_once' },
  { optionId: 'cancel', name: 'Cancel turn', kind: 'reject_turn' },
]);

export class CodexAppServerConnection {
  /**
   * Same construction shape as AcpConnection, plus Codex session options.
   * @param {{
   *   backend: any,
   *   cwd: string,
   *   model?: string|null,
   *   effort?: string|null,
   *   profile?: string,
   *   codex?: {sandbox?: string, approvalPolicy?: string},
   *   env?: NodeJS.ProcessEnv,
   *   command?: string,
   *   argsPrefix?: string[],
   *   extraArgs?: string[],
   *   maxLineBytes?: number,
   *   timeoutMs?: number,
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
    this.threadId = null;
    this.initializeResult = null;
    this.threadResult = null;
    this.models = [];
    this.exitInfo = null;
    this.closed = false;
    /** @type {Map<string, {resolve: (v: any) => void, reject: (e: any) => void}>} */
    this.pendingTurns = new Map();
    /** @type {Map<string, any>} completed turns that arrived before registration */
    this.completedTurns = new Map();
    this.activeTurnId = null;
    this.turnStarting = false;
    this.cancelRequested = false;
    /** @type {{text: string, resolve: (value: any) => void, reject: (error: any) => void}[]} */
    this.pendingSteers = [];
    this.lastRateLimits = null;
    /** @type {Map<string, string>} streamed agentMessage deltas per item, for dedup */
    this.messageDeltas = new Map();
  }

  get sessionId() {
    return this.threadId;
  }

  get launchArgv() {
    const command = this.options.command ?? this.backend.command;
    const args = [...(this.options.argsPrefix ?? []), ...this.backend.args, ...(this.options.extraArgs ?? [])];
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
      const failure = fail(ERROR_CODES.process_exited, `codex app-server error: ${err.message}`);
      this.peer?.close(failure);
      this.#failAllTurns(failure);
    });
    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal, error: null };
      const failure = fail(ERROR_CODES.process_exited, `codex app-server exited (code=${code} signal=${signal})`);
      this.peer?.close(failure);
      this.#failAllTurns(failure);
    });
    if (this.options.stderrStream) child.stderr.pipe(this.options.stderrStream);
    else child.stderr.resume();

    this.peer = new JsonRpcPeer({
      input: child.stdout,
      output: child.stdin,
      maxLineBytes: this.options.maxLineBytes,
      omitJsonRpcField: true,
      onNotification: (method, params) => this.#onNotification(method, params),
      onRequest: (method, params) => this.#onRequest(method, params),
      onTransportError: (err) => this.options.onTransportError?.(err),
    });
    return this;
  }

  /** @param {number} timeoutMs */
  async initialize(timeoutMs = 30000) {
    this.initializeResult = await this.peer.request(
      'initialize',
      { clientInfo: CODEX_CLIENT_INFO, capabilities: {} },
      { timeoutMs },
    );
    this.peer.notify('initialized', {});
    return this.initializeResult;
  }

  /** Normalised init description for session metadata. */
  describeInit() {
    const init = this.initializeResult ?? {};
    return {
      protocolVersion: null,
      agentInfo: { userAgent: init.userAgent ?? null, codexHome: null, platformOs: init.platformOs ?? null },
      agentCapabilities: {
        resume: 'thread/resume',
        steer: 'turn/steer',
        review: 'review/start',
        modelList: 'model/list',
      },
    };
  }

  /**
   * Create a session: `model/list` (advertised capability evidence) then
   * `thread/start` with the requested model, sandbox and approval policy.
   * The response carries the effective model and default effort — both are
   * read back, never assumed.
   * @param {{cwd: string, timeoutMs?: number}} options
   */
  async createSession(options) {
    this.models = await this.listModels().catch(() => []);
    const policies = codexProfilePolicies(this.options.profile ?? 'default', this.options.codex ?? {});
    const params = {
      cwd: options.cwd,
      approvalPolicy: policies.approvalPolicy,
      sandbox: policies.sandbox,
      ephemeral: false,
      serviceName: 'relayrook',
    };
    if (this.options.model) params.model = this.options.model;
    const result = await this.#request('thread/start', params, options.timeoutMs ?? 60000);
    this.threadResult = result;
    this.threadId = result?.thread?.id ?? null;
    if (!this.threadId) {
      throw fail(ERROR_CODES.protocol_error, 'thread/start did not return a thread id');
    }
    this.policies = policies;
    return result;
  }

  /**
   * Resume a persisted thread after a worker restart. The resumed thread's
   * workspace must match the session's; a thread that moved is not our
   * session and is refused rather than silently adopted.
   * @param {{nativeSessionId: string, cwd: string, timeoutMs?: number}} options
   */
  async resumeSession(options) {
    let result;
    try {
      result = await this.#request(
        'thread/resume',
        { threadId: options.nativeSessionId },
        options.timeoutMs ?? 60000,
      );
    } catch (err) {
      // Unsupported-version errors stay typed as such; a protocol rejection of
      // the resume itself is a session_not_resumable, never a silent restart.
      if (err?.code === ERROR_CODES.unsupported_backend_version) throw err;
      throw fail(ERROR_CODES.session_not_resumable, `thread/resume was rejected: ${err?.message ?? err}`, {
        threadId: options.nativeSessionId,
        underlying: { code: err?.code ?? 'unknown', message: err?.message ?? String(err) },
      });
    }
    const thread = result?.thread ?? null;
    if (!thread?.id) {
      throw fail(ERROR_CODES.session_not_resumable, 'thread/resume returned no thread', {
        threadId: options.nativeSessionId,
      });
    }
    const resumedCwd = result?.cwd ?? thread?.cwd ?? null;
    if (resumedCwd && options.cwd && resumedCwd !== options.cwd) {
      throw fail(ERROR_CODES.session_not_resumable, 'Resumed thread workspace does not match the session workspace', {
        threadId: options.nativeSessionId,
        resumedCwd,
        expectedCwd: options.cwd,
      });
    }
    this.threadResult = result;
    this.threadId = thread.id;
    this.models = await this.listModels().catch(() => this.models);
    const policies = codexProfilePolicies(this.options.profile ?? 'default', this.options.codex ?? {});
    this.policies = policies;
    return result;
  }

  /** Model and effort metadata in the same shape ACP sessions report. */
  readSessionMetadata() {
    const result = this.threadResult ?? {};
    const currentModel = result.model ?? result.thread?.model ?? null;
    const selected = this.models.find((m) => m.id === currentModel) ?? null;
    return {
      model: {
        metadataStyle: 'native',
        currentModel,
        availableModels: this.models.map((m) => ({
          id: m.id,
          name: m.displayName ?? m.id,
          description: m.description ?? null,
        })),
        configId: null,
      },
      effort: {
        configId: null,
        currentEffort: result.reasoningEffort ?? result.thread?.reasoningEffort ?? null,
        availableEfforts: selected?.efforts ?? [],
      },
      modes: null,
    };
  }

  /**
   * Model selection happens inside `thread/start`; this hook exists so the
   * worker can treat it uniformly. It returns the readback.
   * @param {string} model
   */
  async selectModel(model) {
    const observed = this.threadResult?.model ?? null;
    return { requested: model, observed, verified: observed === model, configId: null };
  }

  /**
   * Effort is a per-turn parameter; the readback arrives via
   * `readEffectiveSettings` after the turn starts.
   * @param {string} effort
   */
  async selectEffort(effort) {
    return { requested: effort, observed: null, verified: false, support: 'turn-parameter' };
  }

  /**
   * Re-read the thread's effective model and effort (e.g. after a turn has
   * applied a per-turn effort override). Emits the readback as an update so
   * the worker can verify what was requested.
   */
  async readEffectiveSettings() {
    if (!this.threadId) return null;
    const result = await this.#request('thread/read', { threadId: this.threadId }, 30000).catch(() => null);
    if (!result) return null;
    const settings = {
      model: result.model ?? result.thread?.model ?? null,
      effort: result.reasoningEffort ?? result.thread?.reasoningEffort ?? null,
      approvalPolicy: result.approvalPolicy ?? result.thread?.approvalPolicy ?? null,
      sandbox: result.sandbox ?? result.thread?.sandboxPolicy ?? null,
    };
    this.options.onUpdate?.(
      { sessionUpdate: 'agent_notification', method: '_codex/threadSettings', params: settings },
      this.threadId,
    );
    return settings;
  }

  /** @param {number} [limit] */
  async listModels(limit = 100) {
    const result = await this.#request('model/list', { limit }, this.options.timeoutMs ?? 30000);
    const data = Array.isArray(result?.data) ? result.data : [];
    const models = data
      .filter((m) => m && m.hidden !== true)
      .map((m) => ({
        id: m.id ?? m.model ?? null,
        displayName: m.displayName ?? null,
        description: m.description ?? null,
        isDefault: m.isDefault === true,
        efforts: Array.isArray(m.supportedReasoningEfforts)
          ? m.supportedReasoningEfforts.map((e) => e.reasoningEffort).filter(Boolean)
          : [],
        defaultEffort: m.defaultReasoningEffort ?? null,
      }))
      .filter((m) => m.id);
    this.models = models;
    return models;
  }

  /**
   * Account presence only. No identifier, email, token or plan detail is
   * returned to the caller — just whether the CLI reports an authenticated
   * account, so `doctor` output stays free of credentials.
   */
  async readAccount() {
    const result = await this.#request('account/read', { refreshToken: false }, this.options.timeoutMs ?? 30000);
    const account = result?.account ?? null;
    return {
      present: Boolean(account),
      type: account?.type ?? null,
      requiresOpenaiAuth: result?.requiresOpenaiAuth ?? null,
    };
  }

  /**
   * Submit one prompt turn. Resolves when Codex reports `turn/completed` for
   * the turn this call started.
   * @param {string} text
   */
  prompt(text) {
    return this.#startTurn({ input: [{ type: 'text', text }] });
  }

  /**
   * Steer the in-flight turn. Distinct from cancellation: the turn continues
   * with the additional input.
   * @param {string} text
   */
  async steer(text) {
    if (!this.threadId) {
      throw fail(ERROR_CODES.capability_unsupported, 'No active Codex turn to steer', { capability: 'steer' });
    }
    if (!this.activeTurnId && this.turnStarting) {
      return new Promise((resolve, reject) => {
        this.pendingSteers.push({ text, resolve, reject });
      });
    }
    if (!this.activeTurnId) {
      throw fail(ERROR_CODES.capability_unsupported, 'No active Codex turn to steer', { capability: 'steer' });
    }
    return this.#steerActiveTurn(text);
  }

  /** @param {string} text */
  async #steerActiveTurn(text) {
    const result = await this.#request('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: this.activeTurnId,
      input: [{ type: 'text', text }],
    });
    return { turnId: result?.turnId ?? this.activeTurnId, expectedTurnId: this.activeTurnId };
  }

  /**
   * Native Codex review as a turn. `delivery: 'inline'` keeps the review on
   * this thread; 'detached' runs it on a dedicated review thread.
   * @param {{target?: any, delivery?: 'inline'|'detached'}} options
   */
  review(options = {}) {
    if (!this.threadId) {
      throw fail(ERROR_CODES.session_not_running, 'Codex thread is not started');
    }
    const target = options.target ?? { type: 'uncommittedChanges' };
    const delivery = options.delivery === 'detached' ? 'detached' : 'inline';
    return this.#startTurn({ review: { target, delivery } });
  }

  /**
   * Interrupt the active turn. The turn resolves with status `interrupted`.
   * Between `turn/start` being sent and its reply carrying the turn id there
   * is nothing to interrupt yet — the request is remembered and fired the
   * moment the id arrives, so `cancel` is never a silent no-op.
   */
  cancel() {
    if (!this.threadId) return;
    if (!this.activeTurnId) {
      this.cancelRequested = true;
      return;
    }
    this.peer
      ?.request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId }, { timeoutMs: 15000 })
      .catch(() => {});
  }

  /**
   * Shared turn driver for `turn/start` and `review/start`.
   * @param {{input?: any[], review?: {target: any, delivery: string}}} what
   */
  async #startTurn(what) {
    if (!this.threadId) {
      throw fail(ERROR_CODES.session_not_running, 'Codex thread is not started');
    }
    // A cancel aimed at a previous (or failed) start must not carry over.
    this.cancelRequested = false;
    this.turnStarting = true;
    let result;
    try {
      if (what.review) {
        result = await this.#request(
          'review/start',
          { threadId: this.threadId, target: what.review.target, delivery: what.review.delivery },
          60000,
        );
      } else {
        const params = { threadId: this.threadId, input: what.input };
        if (this.options.effort) params.effort = this.options.effort;
        result = await this.#request('turn/start', params, 60000);
      }
    } catch (error) {
      this.turnStarting = false;
      for (const pending of this.pendingSteers.splice(0)) pending.reject(error);
      throw error;
    }
    const turn = result?.turn ?? null;
    const nativeTurnId = turn?.id ?? null;
    if (!nativeTurnId) {
      const error = fail(ERROR_CODES.protocol_error, 'Codex did not return a turn id');
      this.turnStarting = false;
      for (const pending of this.pendingSteers.splice(0)) pending.reject(error);
      throw error;
    }
    const pending = new Promise((resolve, reject) => {
      this.pendingTurns.set(nativeTurnId, { resolve, reject });
    });
    this.activeTurnId = nativeTurnId;
    this.turnStarting = false;
    this.messageDeltas.clear();
    // A cancel that arrived while turn/start was in flight interrupts the
    // turn it was aimed at as soon as the id is known.
    if (this.cancelRequested) {
      this.cancelRequested = false;
      this.cancel();
    }
    for (const queued of this.pendingSteers.splice(0)) {
      this.#steerActiveTurn(queued.text).then(queued.resolve, queued.reject);
    }
    // A turn that completed before we registered it (impossibly fast) still
    // resolves — the completed notification is stashed by id.
    if (this.completedTurns.has(nativeTurnId)) {
      this.#settleTurn(this.completedTurns.get(nativeTurnId));
    }
    if (this.options.effort) {
      void this.readEffectiveSettings();
    }
    return pending;
  }

  /** @param {any} turn the `turn` object from a turn/completed notification */
  #settleTurn(turn) {
    const pending = this.pendingTurns.get(turn.id);
    if (this.activeTurnId === turn.id) this.activeTurnId = null;
    if (!pending) {
      this.completedTurns.set(turn.id, turn);
      return;
    }
    this.pendingTurns.delete(turn.id);
    if (turn.status === 'completed') {
      pending.resolve({ stopReason: 'end_turn', nativeStatus: 'completed', codexTurn: turn });
    } else if (turn.status === 'interrupted') {
      pending.resolve({ stopReason: 'cancelled', nativeStatus: 'interrupted', codexTurn: turn });
    } else {
      pending.resolve({
        stopReason: 'failed',
        nativeStatus: turn.status ?? 'failed',
        error: turn.error ?? null,
        codexTurn: turn,
      });
    }
  }

  /** @param {Error} err */
  #failAllTurns(err) {
    for (const [, pending] of this.pendingTurns) pending.reject(err);
    this.pendingTurns.clear();
    for (const pending of this.pendingSteers.splice(0)) pending.reject(err);
    this.turnStarting = false;
    this.activeTurnId = null;
  }

  /** @param {string} method @param {any} params */
  #onNotification(method, params) {
    const emit = (update) => this.options.onUpdate?.(update, this.threadId);
    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = params?.delta ?? '';
        if (typeof params?.itemId === 'string') {
          this.messageDeltas.set(params.itemId, (this.messageDeltas.get(params.itemId) ?? '') + delta);
        }
        emit({ sessionUpdate: 'agent_message_chunk', content: { text: delta } });
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const item = params?.item;
        emit({
          sessionUpdate: 'codex_item',
          phase: method === 'item/started' ? 'started' : 'completed',
          item: summarizeItem(item),
        });
        // Review turns deliver their verdict as a completed agentMessage item
        // rather than item/agentMessage/delta chunks. Emit whatever the deltas
        // did not already stream for this item — normally all of it, nothing
        // when the full text already arrived as deltas.
        if (method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string' && item.text) {
          const streamed = this.messageDeltas.get(item.id ?? '') ?? '';
          const missing = item.text.startsWith(streamed) ? item.text.slice(streamed.length) : item.text;
          if (missing) emit({ sessionUpdate: 'agent_message_chunk', content: { text: missing } });
        }
        return;
      }
      case 'turn/completed': {
        const turn = params?.turn ?? {};
        emit({ sessionUpdate: 'agent_notification', method: 'codex/turn_completed', params: { status: turn.status } });
        this.#settleTurn(turn);
        return;
      }
      case 'turn/diff/updated':
        emit({ sessionUpdate: 'turn_diff', text: params?.diff ?? '' });
        return;
      case 'thread/tokenUsage/updated':
        this.lastTokenUsage = params?.tokenUsage ?? params ?? null;
        emit({ sessionUpdate: 'usage_update', usage: this.lastTokenUsage });
        return;
      case 'model/rerouted':
        emit({
          sessionUpdate: 'model_rerouted',
          from: params?.from ?? null,
          to: params?.to ?? null,
          reason: params?.reason ?? null,
        });
        return;
      case 'account/rateLimits/updated':
        this.lastRateLimits = summarizeRateLimits(params);
        emit({ sessionUpdate: 'rate_limits', rateLimits: this.lastRateLimits });
        return;
      case 'error':
        emit({ sessionUpdate: 'server_error', error: params?.error ?? null, willRetry: params?.willRetry === true });
        return;
      default:
        emit({ sessionUpdate: 'agent_notification', method: `codex/${method}`, params: summarizeParams(params) });
    }
  }

  /**
   * Server->client requests: approvals become pending permissions; everything
   * else is declined with method-not-found so Codex never waits on a handler
   * RelayRook does not implement.
   * @param {string} method @param {any} params
   */
  async #onRequest(method, params) {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.#approval(params, {
          kind: 'execute',
          title: params?.command ? `Run: ${shortCommand(params.command)}` : 'Run command',
        });
      case 'item/fileChange/requestApproval':
        return this.#approval(params, { kind: 'edit', title: 'Apply file changes' });
      case 'item/permissions/requestApproval':
        return this.#permissionsApproval(params);
      case 'execCommandApproval':
      case 'applyPatchApproval':
        // v1 approval surface kept for older servers: same pause/answer flow,
        // mapped onto the v1 ReviewDecision shape.
        return this.#legacyApproval(params, method);
      case 'item/tool/requestUserInput':
        // Structured questions cannot be answered by a router; answer empty so
        // the turn is never left blocked, and record that we skipped it.
        this.options.onUpdate?.(
          { sessionUpdate: 'agent_notification', method: 'codex/user_input_skipped', params: summarizeParams(params) },
          this.threadId,
        );
        return { answers: {} };
      case 'item/tool/call':
        // Dynamic tools are never registered by RelayRook, so the call cannot
        // succeed; an empty failure is schema-valid and unblocks the turn.
        return { success: false, contentItems: [] };
      default: {
        const err = fail(ERROR_CODES.protocol_error, `RelayRook does not implement ${method}`);
        // @ts-ignore attach the JSON-RPC code for the peer
        err.rpcCode = -32601;
        throw err;
      }
    }
  }

  /**
   * Pause for the parent and map the chosen option onto a v2 decision.
   * @param {any} params @param {{kind: string, title: string}} tool
   */
  async #approval(params, tool) {
    const amendment = Array.isArray(params?.proposedExecpolicyAmendment)
      ? [{ optionId: 'acceptWithExecpolicyAmendment', name: 'Allow and remember rule', kind: 'allow_always' }]
      : [];
    const options = [...APPROVAL_OPTIONS.slice(0, 2), ...amendment, ...APPROVAL_OPTIONS.slice(2)];
    const decision = await this.#askParent({
      requestId: params?.itemId ?? newId(),
      toolCall: {
        toolCallId: params?.itemId ?? null,
        title: tool.title,
        kind: tool.kind,
        detail: summarizeParams(params),
      },
      options,
    });
    return { decision: decision?.optionId ?? 'cancel' };
  }

  /** @param {any} params */
  async #permissionsApproval(params) {
    const requested = params?.permissions ?? {};
    const decision = await this.#askParent({
      requestId: params?.itemId ?? newId(),
      toolCall: {
        toolCallId: params?.itemId ?? null,
        title: 'Grant additional permissions',
        kind: 'permission',
        detail: summarizeParams(params),
      },
      options: APPROVAL_OPTIONS,
    });
    const optionId = decision?.optionId ?? 'cancel';
    if (optionId === 'accept') return { permissions: requested, scope: 'turn' };
    if (optionId === 'acceptForSession') return { permissions: requested, scope: 'session' };
    if (optionId === 'cancel') this.cancel();
    return { permissions: {}, scope: 'turn' };
  }

  /** @param {any} params @param {string} method */
  async #legacyApproval(params, method) {
    const decision = await this.#askParent({
      requestId: newId(),
      toolCall: {
        toolCallId: null,
        title: method === 'execCommandApproval' ? `Run: ${shortCommand(params?.command)}` : 'Apply patch',
        kind: method === 'execCommandApproval' ? 'execute' : 'edit',
        detail: summarizeParams(params),
      },
      options: [
        { optionId: 'approved', name: 'Approve', kind: 'allow_once' },
        { optionId: 'denied', name: 'Deny', kind: 'reject_once' },
      ],
    });
    if (decision?.optionId === 'approved') return { decision: { approved: {} } };
    return { decision: { denied: { rejection: 'Denied through RelayRook permission control' } } };
  }

  /**
   * @param {any} request
   * @returns {Promise<{optionId?: string, cancelled?: boolean}>}
   */
  #askParent(request) {
    if (!this.options.onPermissionRequest) return Promise.resolve({ cancelled: true });
    return this.options.onPermissionRequest(request);
  }

  /**
   * Method-not-found from the server means this Codex predates the v2 surface
   * — reported as an unsupported version, not a generic protocol error.
   * @param {string} method @param {any} params @param {number} [timeoutMs]
   */
  async #request(method, params, timeoutMs) {
    try {
      return await this.peer.request(method, params, { timeoutMs });
    } catch (err) {
      if (err?.details?.rpcCode === -32601) {
        throw fail(
          ERROR_CODES.unsupported_backend_version,
          `codex app-server does not implement ${method}; upgrade the Codex CLI`,
          { method, backend: 'codex' },
        );
      }
      throw err;
    }
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

/**
 * One-shot discovery probe used by `doctor --probe` and capability preflight.
 * @param {{command?: string, cwd?: string, timeoutMs?: number}} [options]
 */
export async function probeCodex(options = {}) {
  const backend = { command: options.command ?? 'codex', args: ['app-server', '--stdio'] };
  const probe = new CodexAppServerConnection({ backend, cwd: options.cwd ?? process.cwd(), timeoutMs: options.timeoutMs });
  try {
    await probe.start();
    const init = await probe.initialize(options.timeoutMs ?? 30000);
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
      sessionControl: 'implemented',
      capabilities: { resume: 'thread/resume', steer: 'turn/steer', review: 'review/start' },
    };
  } catch (err) {
    return { protocolReady: false, error: describe(err), models: [], account: null, sessionControl: 'implemented' };
  } finally {
    await probe.close();
  }
}

/** @param {any} item */
function summarizeItem(item) {
  if (!item || typeof item !== 'object') return item ?? null;
  const summary = { id: item.id ?? null, type: item.type ?? null };
  if (typeof item.text === 'string') summary.text = item.text.slice(0, 4000);
  if (typeof item.command === 'string') summary.command = item.command.slice(0, 1000);
  if (item.phase) summary.phase = item.phase;
  if (item.exitCode !== undefined) summary.exitCode = item.exitCode;
  if (Array.isArray(item.changes)) summary.changeCount = item.changes.length;
  return summary;
}

/** @param {any} params keep event payloads small and credential-free */
function summarizeParams(params) {
  if (!params || typeof params !== 'object') return params ?? null;
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') out[key] = value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = `[${value.length} items]`;
    else if (typeof value === 'object') out[key] = '{…}';
  }
  return out;
}

/** @param {any} params */
function summarizeRateLimits(params) {
  const primary = params?.primary ?? params?.rateLimits?.primary ?? null;
  const secondary = params?.secondary ?? params?.rateLimits?.secondary ?? null;
  const pick = (w) =>
    w
      ? {
          usedPercent: w.usedPercent ?? null,
          windowDurationMins: w.windowDurationMins ?? null,
          resetsAt: w.resetsAt ?? null,
        }
      : null;
  return { planType: params?.planType ?? null, primary: pick(primary), secondary: pick(secondary) };
}

/** @param {any} command */
function shortCommand(command) {
  if (Array.isArray(command)) return command.join(' ').slice(0, 120);
  return String(command ?? '').slice(0, 120);
}

/** @param {unknown} err */
function describe(err) {
  return err instanceof Error ? err.message : String(err);
}
