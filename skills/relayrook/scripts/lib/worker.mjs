import { createWriteStream } from 'node:fs';
import path from 'node:path';

import { AcpConnection } from './adapters/acp.mjs';
import { appendTurnAnswer, EventLog, SessionStore, writeTurnRecord, LIMITS } from './state.mjs';
import { fail, ERROR_CODES } from './errors.mjs';
import { getBackend } from './backends.mjs';
import { serveControl } from './control.mjs';
import { newId, redactPath, toPositiveInt } from './util.mjs';

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The persistent session worker.
 *
 * It owns one backend child process, keeps a typed turn state machine, records
 * every protocol event with a monotonic cursor, and pauses on permission
 * requests until the parent answers with an option the agent actually offered.
 */
export class SessionWorker {
  /**
   * @param {{
   *   store: SessionStore,
   *   spec: any,
   *   createConnection?: (args: any) => AcpConnection,
   *   now?: () => number,
   * }} options
   */
  constructor(options) {
    this.store = options.store;
    this.spec = options.spec;
    this.createConnection = options.createConnection ?? ((args) => new AcpConnection(args));
    this.now = options.now ?? (() => Date.now());
    this.log = new EventLog(this.store).load();
    this.connection = null;
    this.server = null;
    /** @type {any} */
    this.turn = null;
    /** @type {Map<string, {request: any, resolve: (d: any) => void}>} */
    this.pendingPermissions = new Map();
    this.idleTimer = null;
    this.idleTimeoutMs = toPositiveInt(this.spec.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    this.status = 'starting';
    this.lastError = null;
    this.stopping = false;
    this.meta = this.#baseMeta();
  }

  #baseMeta() {
    return {
      key: this.store.key,
      backend: this.spec.backend,
      workspace: this.spec.workspace,
      profile: this.spec.profile ?? 'default',
      pid: process.pid,
      startedAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      status: this.status,
      sessionId: null,
      agentInfo: null,
      protocolVersion: null,
      agentCapabilities: null,
      model: { requested: this.spec.model ?? null, observed: null, source: 'unset', verified: false },
      effort: { requested: this.spec.effort ?? null, observed: null, verified: false, support: null },
      availableModels: [],
      modes: null,
      caller: this.spec.caller ?? null,
      route: this.spec.route ?? null,
      turn: null,
      pendingPermissions: [],
      lastError: null,
      socket: redactPath(this.store.socketPath),
      dir: redactPath(this.store.dir),
    };
  }

  #saveMeta() {
    this.meta.updatedAt = new Date(this.now()).toISOString();
    this.meta.status = this.status;
    this.meta.lastError = this.lastError;
    this.meta.turn = this.turn ? this.#turnSummary(this.turn) : null;
    this.meta.pendingPermissions = [...this.pendingPermissions.values()].map((p) => ({
      requestId: p.request.requestId,
      toolCallId: p.request.toolCall?.toolCallId ?? null,
      title: p.request.toolCall?.title ?? null,
      options: p.request.options,
    }));
    this.store.writeMeta(this.meta);
  }

  /** @param {any} turn */
  #turnSummary(turn) {
    return {
      id: turn.id,
      state: turn.state,
      stopReason: turn.stopReason,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt ?? null,
      firstTextAt: turn.firstTextAt ?? null,
      usage: turn.usage ?? null,
      answerChars: turn.answerChars,
      answerTruncated: turn.answerTruncated,
      awaitingPermission: turn.state === 'awaiting-permission',
      error: turn.error ?? null,
      recordDir: redactPath(this.store.turnDir(turn.id)),
    };
  }

  /** @param {{kind: string, [k: string]: any}} event */
  #emit(event) {
    const stored = this.log.append({ turnId: this.turn?.id ?? null, ...event });
    if (this.turn) this.turn.events.push(stored);
    return stored;
  }

  async start() {
    const backend = getBackend(this.spec.backend);
    if (backend.sessionSupport !== 'implemented') {
      throw fail(ERROR_CODES.session_control_not_implemented, backend.sessionSupportReason ?? 'unsupported backend', {
        backend: backend.id,
      });
    }
    const stderrStream = createWriteStream(this.store.logFile, { flags: 'a' });
    this.connection = this.createConnection({
      backend,
      cwd: this.spec.workspace,
      model: this.spec.model ?? null,
      effort: this.spec.effort ?? null,
      command: this.spec.commandOverride ?? undefined,
      argsPrefix: this.spec.argsOverride ?? undefined,
      env: this.spec.env ?? {},
      maxLineBytes: this.spec.maxLineBytes,
      stderrStream,
      onUpdate: (update) => this.#onUpdate(update),
      onPermissionRequest: (request) => this.#onPermissionRequest(request),
      onTransportError: (err) => this.#onTransportError(err),
    });

    await this.connection.start();
    const init = await this.connection.initialize(toPositiveInt(this.spec.initTimeoutMs, 60000));
    this.meta.protocolVersion = init?.protocolVersion ?? null;
    this.meta.agentInfo = init?.agentInfo ?? null;
    this.meta.agentCapabilities = init?.agentCapabilities ?? null;

    await this.connection.newSession({
      cwd: this.spec.workspace,
      timeoutMs: toPositiveInt(this.spec.sessionTimeoutMs, 120000),
    });
    this.meta.sessionId = this.connection.sessionId;

    await this.#applyModelAndEffort();

    this.status = 'ready';
    this.#emit({ kind: 'session_ready', sessionId: this.connection.sessionId, backend: backend.id });
    this.#saveMeta();

    this.server = await serveControl(this.store.socketPath, this.#handlers());
    this.#resetIdleTimer();
    return this;
  }

  async #applyModelAndEffort() {
    const backend = getBackend(this.spec.backend);
    const metadata = this.connection.readSessionMetadata();
    this.meta.availableModels = metadata.model.availableModels;
    this.meta.modes = metadata.modes;
    this.meta.metadataStyle = metadata.model.metadataStyle;

    const requested = this.spec.model ?? backend.defaultModel ?? null;
    const source = this.spec.model ? 'pin' : backend.defaultModel ? 'backend-default' : 'unset';

    if (requested && backend.modelSelection === 'set_config_option') {
      // Verified selection: the readback must equal what we asked for. A
      // backend that rejects the value outright is reported against the model
      // that was asked for, not as a bare transport error.
      let selection;
      try {
        selection = await this.connection.selectModel(requested);
      } catch (err) {
        if (err?.code === ERROR_CODES.model_rejected) throw err;
        throw fail(ERROR_CODES.model_rejected, `Backend rejected model ${requested}: ${err?.message ?? err}`, {
          requested,
          backend: backend.id,
          underlying: { code: err?.code ?? 'unknown', message: err?.message ?? String(err) },
        });
      }
      this.meta.model = { requested, observed: selection.observed, source, verified: true };
    } else {
      // Launch-flag backends (Devin, Kiro) get the model at spawn time; the
      // session response is the only readback available.
      const observed = metadata.model.currentModel;
      const verified = Boolean(requested) && observed === requested;
      this.meta.model = { requested, observed, source, verified };
      if (requested && observed && !verified) {
        throw fail(ERROR_CODES.model_rejected, `Backend reported model ${observed}, not the requested ${requested}`, {
          requested,
          observed,
        });
      }
    }

    const effort = this.spec.effort ?? null;
    if (!effort) {
      this.meta.effort = {
        requested: null,
        observed: metadata.effort.currentEffort,
        verified: false,
        support: metadata.effort.configId ? 'advertised' : 'not-advertised',
      };
      return;
    }
    if (metadata.effort.configId) {
      const result = await this.connection.selectEffort(effort);
      this.meta.effort = {
        requested: effort,
        observed: result.observed,
        verified: result.verified === true,
        support: 'set_config_option',
      };
      return;
    }
    // Kiro accepts --effort at launch but does not report it back; say so
    // instead of implying the request was confirmed.
    this.meta.effort = {
      requested: effort,
      observed: null,
      verified: false,
      support: backend.effortFlag ? 'launch-flag-not-read-back' : 'unsupported',
    };
  }

  /** @param {any} update */
  #onUpdate(update) {
    const kind = update?.sessionUpdate ?? 'unknown';
    if (kind === 'agent_notification' && update?.method === '_kiro.dev/metadata') {
      const observed = update?.params?.effort ?? null;
      if (observed && this.meta.effort.requested) {
        this.meta.effort.observed = observed;
        this.meta.effort.verified = observed === this.meta.effort.requested;
        this.meta.effort.support = 'agent-notification';
        this.#saveMeta();
      }
    }
    switch (kind) {
      case 'agent_message_chunk': {
        const text = update?.content?.text ?? '';
        if (this.turn) {
          if (!this.turn.firstTextAt) this.turn.firstTextAt = new Date(this.now()).toISOString();
          appendTurnAnswer(this.store, this.turn.id, text);
          this.turn.answerChars += text.length;
          this.turn.answer += text;
          if (this.turn.answer.length > LIMITS.maxAnswerChars) {
            this.turn.answer = this.turn.answer.slice(-LIMITS.maxAnswerChars);
            this.turn.answerTruncated = true;
          }
        }
        this.#emit({ kind: 'text', text });
        break;
      }
      case 'agent_thought_chunk':
        this.#emit({ kind: 'thought', text: update?.content?.text ?? '' });
        break;
      case 'tool_call':
        this.#emit({ kind: 'tool_call', update });
        break;
      case 'tool_call_update':
        this.#emit({ kind: 'tool_call_update', update });
        break;
      case 'plan':
        this.#emit({ kind: 'plan', update });
        break;
      case 'usage_update':
        if (this.turn) this.turn.usage = update;
        this.#emit({ kind: 'usage_update', update });
        break;
      default:
        this.#emit({ kind: 'agent_update', update });
    }
  }

  /**
   * Pause the turn and surface the request. The worker never auto-approves;
   * it resolves only when the parent selects one of the advertised options.
   * @param {any} request
   */
  #onPermissionRequest(request) {
    const requestId = request?.requestId ?? request?.toolCall?.toolCallId ?? newId();
    const normalised = { ...request, requestId };
    if (this.turn) this.turn.state = 'awaiting-permission';

    /** @type {(decision: any) => void} */
    let settle;
    const decided = new Promise((resolve) => {
      settle = resolve;
    });

    // Registered before the metadata write, so the very first `status` that
    // observes `awaiting-permission` already lists the request to answer.
    this.pendingPermissions.set(requestId, {
      request: normalised,
      resolve: (decision) => {
        this.pendingPermissions.delete(requestId);
        if (this.turn && this.turn.state === 'awaiting-permission') {
          this.turn.state = this.pendingPermissions.size > 0 ? 'awaiting-permission' : 'running';
        }
        this.#emit({
          kind: 'permission_resolved',
          requestId,
          option: decision.optionId ?? null,
          cancelled: !decision.optionId,
        });
        this.#saveMeta();
        settle(decision);
      },
    });

    this.#emit({
      kind: 'permission',
      requestId,
      toolCall: request?.toolCall ?? null,
      options: request?.options ?? [],
    });
    this.#saveMeta();
    return decided;
  }

  /** @param {any} err */
  #onTransportError(err) {
    this.lastError = { code: err?.code ?? 'transport_error', message: err?.message ?? String(err) };
    this.#emit({ kind: 'error', code: this.lastError.code, message: this.lastError.message });
    this.#saveMeta();
  }

  #resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.turn && (this.turn.state === 'running' || this.turn.state === 'awaiting-permission')) {
        this.#resetIdleTimer();
        return;
      }
      void this.shutdown('idle-timeout');
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  #handlers() {
    return {
      ping: async () => ({ ok: true, status: this.status, meta: this.meta }),
      meta: async () => ({ meta: this.meta }),
      prompt: async (params) => this.submitPrompt(params),
      status: async (params) => this.readStatus(params),
      cancel: async (params) => this.cancelTurn(params),
      permission: async (params) => this.answerPermission(params),
      stop: async () => {
        setTimeout(() => void this.shutdown('stop-requested'), 10).unref?.();
        return { ok: true, stopping: true };
      },
    };
  }

  /**
   * Submit one turn. Overlapping an active turn is refused with a typed error
   * rather than queued, so a caller can never accidentally interleave two
   * mutating prompts against the same workspace.
   * @param {{text: string, timeoutMs?: number, metadata?: any}} params
   */
  async submitPrompt(params) {
    this.#resetIdleTimer();
    if (this.turn && (this.turn.state === 'running' || this.turn.state === 'awaiting-permission')) {
      throw fail(ERROR_CODES.active_turn, 'A turn is already active on this session', {
        turnId: this.turn.id,
        state: this.turn.state,
      });
    }
    if (this.status !== 'ready') {
      throw fail(ERROR_CODES.session_not_running, `Session is ${this.status}`, { status: this.status });
    }
    const text = String(params?.text ?? '');
    if (text.trim() === '') throw fail(ERROR_CODES.usage, 'Prompt text is empty');

    const turnId = newId();
    const timeoutMs = toPositiveInt(params?.timeoutMs, DEFAULT_TURN_TIMEOUT_MS);
    this.turn = {
      id: turnId,
      state: 'running',
      stopReason: null,
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      firstTextAt: null,
      answer: '',
      answerChars: 0,
      answerTruncated: false,
      usage: null,
      events: [],
      error: null,
      prompt: text,
      metadata: params?.metadata ?? null,
    };
    writeTurnRecord(this.store, turnId, { prompt: text, answer: '' });
    this.#emit({ kind: 'turn_started', prompt_chars: text.length });
    this.#saveMeta();

    const timer = setTimeout(() => {
      if (this.turn?.id !== turnId) return;
      this.#emit({ kind: 'turn_timeout', timeoutMs });
      this.connection.cancel();
      for (const [, pending] of this.pendingPermissions) pending.resolve({ cancelled: true });
      this.turn.state = 'timed-out';
      this.turn.stopReason = 'relayrook_timeout';
      this.#saveMeta();
    }, timeoutMs);
    timer.unref?.();

    this.connection
      .prompt(text)
      .then(
        (result) => this.#finishTurn(turnId, result, null),
        (err) => this.#finishTurn(turnId, null, err),
      )
      .finally(() => clearTimeout(timer));

    return { turnId, state: 'running', startedAt: this.turn.startedAt };
  }

  /**
   * @param {string} turnId
   * @param {any} result
   * @param {any} err
   */
  #finishTurn(turnId, result, err) {
    if (!this.turn || this.turn.id !== turnId) return;
    const turn = this.turn;
    turn.finishedAt = new Date(this.now()).toISOString();

    if (err) {
      turn.state = turn.state === 'timed-out' ? 'timed-out' : 'failed';
      turn.stopReason = turn.state === 'timed-out' ? 'relayrook_timeout' : mapErrorStopReason(err);
      turn.error = { code: err?.code ?? 'internal_error', message: err?.message ?? String(err) };
    } else {
      const stopReason = result?.stopReason ?? null;
      turn.stopReason = stopReason;
      // Turn outcome comes from the protocol's stop reason, never from an exit
      // code and never from the mere absence of an error.
      if (turn.state === 'timed-out') {
        turn.stopReason = 'relayrook_timeout';
      } else if (stopReason === 'cancelled') {
        turn.state = 'cancelled';
      } else if (stopReason === null) {
        turn.state = 'failed';
        turn.error = { code: ERROR_CODES.protocol_error, message: 'Backend returned no stopReason' };
      } else {
        turn.state = 'completed';
      }
      if (result?.usage) turn.usage = result.usage;
      turn.result = result;
    }

    // Resolve any still-pending permission so the agent is not left blocked.
    for (const [, pending] of this.pendingPermissions) pending.resolve({ cancelled: true });
    this.pendingPermissions.clear();

    this.#emit({ kind: 'turn_finished', state: turn.state, stopReason: turn.stopReason });
    writeTurnRecord(this.store, turnId, {
      events: turn.events,
      result: {
        turnId,
        state: turn.state,
        stopReason: turn.stopReason,
        usage: turn.usage,
        error: turn.error,
        startedAt: turn.startedAt,
        finishedAt: turn.finishedAt,
        firstTextAt: turn.firstTextAt,
        answerChars: turn.answerChars,
        answerTruncatedInMemory: turn.answerTruncated,
      },
    });
    this.#saveMeta();
    this.#resetIdleTimer();
  }

  /** @param {{cursor?: number, limit?: number, turnId?: string|null}} params */
  async readStatus(params = {}) {
    this.#resetIdleTimer();
    const page = this.log.read({
      cursor: Number(params.cursor ?? 0),
      limit: Number(params.limit ?? 200),
      turnId: params.turnId ?? null,
    });
    return {
      status: this.status,
      meta: this.meta,
      turn: this.turn ? this.#turnSummary(this.turn) : null,
      answer: this.turn?.answer ?? '',
      answerTruncated: this.turn?.answerTruncated ?? false,
      pendingPermissions: this.meta.pendingPermissions,
      ...page,
    };
  }

  /** @param {{turnId?: string}} params */
  async cancelTurn(params = {}) {
    if (!this.turn || (this.turn.state !== 'running' && this.turn.state !== 'awaiting-permission')) {
      throw fail(ERROR_CODES.no_active_turn, 'No active turn to cancel');
    }
    if (params.turnId && params.turnId !== this.turn.id) {
      throw fail(ERROR_CODES.no_active_turn, 'Requested turn is not the active turn', {
        requested: params.turnId,
        active: this.turn.id,
      });
    }
    this.#emit({ kind: 'cancel_requested' });
    this.connection.cancel();
    // Any blocked permission is released so the agent can unwind cleanly.
    for (const [, pending] of this.pendingPermissions) pending.resolve({ cancelled: true });
    this.#saveMeta();
    return { ok: true, turnId: this.turn.id };
  }

  /**
   * Answer a pending permission request.
   *
   * The option must be one the agent advertised for that request; anything else
   * is rejected rather than coerced, and there is no blanket approval path.
   * @param {{requestId?: string, optionId?: string, cancel?: boolean}} params
   */
  async answerPermission(params = {}) {
    const requestId = params.requestId ?? [...this.pendingPermissions.keys()][0];
    const pending = requestId ? this.pendingPermissions.get(requestId) : undefined;
    if (!pending) {
      throw fail(ERROR_CODES.permission_not_pending, 'No pending permission request with that id', {
        requestId: requestId ?? null,
        pending: [...this.pendingPermissions.keys()],
      });
    }
    if (params.cancel === true) {
      pending.resolve({ cancelled: true });
      return { ok: true, requestId, outcome: 'cancelled' };
    }
    const options = Array.isArray(pending.request.options) ? pending.request.options : [];
    const allowed = options.map((o) => o.optionId).filter(Boolean);
    if (!params.optionId || !allowed.includes(params.optionId)) {
      throw fail(ERROR_CODES.permission_option_invalid, 'Permission option is not one the agent advertised', {
        requestId,
        requested: params.optionId ?? null,
        allowed,
      });
    }
    pending.resolve({ optionId: params.optionId });
    return { ok: true, requestId, outcome: 'selected', optionId: params.optionId };
  }

  /** @param {string} reason */
  async shutdown(reason) {
    if (this.stopping) return;
    this.stopping = true;
    this.status = 'stopping';
    this.#emit({ kind: 'session_stopping', reason });
    for (const [, pending] of this.pendingPermissions) pending.resolve({ cancelled: true });
    this.pendingPermissions.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      await this.connection?.close();
    } catch {
      // Closing is best effort; the recorded status is what callers read.
    }
    this.status = 'stopped';
    this.#saveMeta();
    await new Promise((resolve) => {
      if (!this.server) {
        resolve(undefined);
        return;
      }
      this.server.close(() => resolve(undefined));
    });
  }
}

/** @param {any} err */
function mapErrorStopReason(err) {
  if (err?.code === ERROR_CODES.process_exited) return 'relayrook_process_exited';
  if (err?.code === ERROR_CODES.turn_timeout) return 'relayrook_timeout';
  return 'relayrook_protocol_error';
}

/**
 * Worker entrypoint body, shared by the spawnable entry module.
 * @param {{sessionDir: string}} options
 */
export async function runWorker(options) {
  const dir = path.resolve(options.sessionDir);
  const stateDir = path.dirname(path.dirname(dir));
  const key = path.basename(dir);
  const store = new SessionStore(stateDir, key).ensure();
  const spec = store.readRequest();
  const worker = new SessionWorker({ store, spec });

  const onFatal = async (err) => {
    worker.status = 'failed';
    worker.lastError = { code: err?.code ?? 'internal_error', message: err?.message ?? String(err) };
    try {
      worker.meta.status = 'failed';
      worker.meta.lastError = worker.lastError;
      store.writeMeta(worker.meta);
    } catch {
      // Nothing further can be recorded if the state directory is unwritable.
    }
    process.exitCode = 1;
  };

  process.on('SIGTERM', () => void worker.shutdown('sigterm'));
  process.on('SIGINT', () => void worker.shutdown('sigint'));

  try {
    await worker.start();
  } catch (err) {
    await onFatal(err);
    await worker.shutdown('start-failed');
  }
  return worker;
}
