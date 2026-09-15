import { createWriteStream } from 'node:fs';
import path from 'node:path';

import { AcpConnection } from './adapters/acp.mjs';
import { CodexAppServerConnection } from './adapters/codex.mjs';
import { appendTurnAnswer, EventLog, SessionStore, writeTurnRecord, LIMITS, SESSION_SCHEMA_VERSION } from './state.mjs';
import { classifyBackendError, fail, ERROR_CODES } from './errors.mjs';
import { getBackend } from './backends.mjs';
import { classifyPermissionRequest } from './permissions.mjs';
import { serveControl } from './control.mjs';
import { normalizeUsage } from './usage.mjs';
import { newId, redactPath, toNonNegativeInt, toPositiveInt } from './util.mjs';
import { processIdentity } from './platform.mjs';

export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Inactivity window for a running turn. This is the watchdog that matters: a
 * turn is judged by whether the backend is still producing anything, never by
 * how long the work has taken. An agent that streams thoughts, tool calls or
 * text for two hours is healthy; one that has emitted nothing for ten minutes
 * is not. `0` disables it.
 */
export const DEFAULT_TURN_STALL_MS = 10 * 60 * 1000;

/**
 * Wall-clock backstop for a turn that keeps producing output forever. It is
 * deliberately far larger than the inactivity window, because a busy turn must
 * never be killed for being long. `0` disables it.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Pick the connection implementation for a backend. ACP backends share the
 * generic connection; the Codex app-server has its own.
 * @param {any} args
 */
/**
 * A backend error arrives as whatever shape the provider chose. Pull a human
 * message out of it without losing the payload.
 * @param {any} error
 */
export function backendErrorMessage(error) {
  if (error == null) return '';
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error);
      return backendErrorMessage(parsed) || error;
    } catch {
      return error;
    }
  }
  if (typeof error === 'object') {
    const direct = error.message ?? error.error ?? error.detail ?? null;
    // Codes travel with the message: providers put the machine-readable reason
    // in a sibling field (`code`, `type`, `codexErrorInfo`), and dropping it
    // leaves a quota failure looking like an unrecognised one.
    const codes = [error.code, error.type, error.codexErrorInfo, error.status]
      .filter((value) => typeof value === 'string' || typeof value === 'number')
      .join(' ');
    const message =
      typeof direct === 'string'
        ? backendErrorMessage(direct)
        : direct && typeof direct === 'object'
          ? backendErrorMessage(direct)
          : JSON.stringify(error);
    return codes ? `${message} [${codes}]`.trim() : message;
  }
  return String(error);
}

export function createBackendConnection(args) {
  if (args.backend?.kind === 'app-server') return new CodexAppServerConnection(args);
  return new AcpConnection(args);
}

/**
 * The persistent session worker.
 *
 * It owns one backend child process, keeps a typed turn state machine, records
 * every protocol event with a monotonic cursor, and pauses on permission
 * requests until the parent answers with an option the agent actually offered.
 *
 * When the launch spec carries `resume`, the worker re-attaches to the
 * persisted backend-native session instead of opening a new one. A backend
 * that cannot resume is reported — the worker never claims continuity it did
 * not get.
 */
export class SessionWorker {
  /**
   * @param {{
   *   store: SessionStore,
   *   spec: any,
   *   createConnection?: (args: any) => any,
   *   now?: () => number,
   * }} options
   */
  constructor(options) {
    this.store = options.store;
    this.spec = options.spec;
    this.createConnection = options.createConnection ?? createBackendConnection;
    this.now = options.now ?? (() => Date.now());
    this.log = new EventLog(this.store).load();
    this.connection = null;
    this.server = null;
    /** @type {any} */
    this.turn = null;
    this.drivePending = false;
    /** @type {Map<string, {request: any, resolve: (d: any) => void}>} */
    this.pendingPermissions = new Map();
    this.idleTimer = null;
    this.idleTimeoutMs = toPositiveInt(this.spec.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    /** Wall-clock backstop timer for the active turn. */
    this.deadlineTimer = null;
    /** Inactivity timer for the active turn. */
    this.stallTimer = null;
    this.status = 'starting';
    this.lastError = null;
    this.stopping = false;
    this.meta = this.#baseMeta();
  }

  #baseMeta() {
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      key: this.store.key,
      backend: this.spec.backend,
      workspace: this.spec.workspace,
      profile: this.spec.profile ?? 'default',
      permissions: this.spec.permissions ?? null,
      pid: process.pid,
      backendPid: null,
      backendCommand: null,
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
      resume: { supported: null, mechanism: null, lastAttempt: null },
      recovered: false,
      previousSessions: this.spec.previousSessions ?? [],
      quota: null,
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
      classification: p.request.classification ?? null,
    }));
    this.store.writeMeta(this.meta);
  }

  /**
   * Map the latest provider usage payload onto the canonical record. `null`
   * fields mean the provider did not report that field; `raw` keeps the
   * provider payload verbatim for auditing.
   * @param {any} update
   */
  #normalizedUsage(update) {
    return normalizeUsage(this.spec.backend, update?.usage ?? update, {
      eventCount: this.turn?.usageEvents ?? null,
      latencyMs: this.turn?.startedAt ? Math.max(0, this.now() - Date.parse(this.turn.startedAt)) : null,
      rateLimits: this.connection?.lastRateLimits ?? null,
    });
  }

  /** @param {any} turn */
  #turnSummary(turn) {
    return {
      id: turn.id,
      state: turn.state,
      mechanism: turn.mechanism ?? 'prompt',
      nativeTurnId: turn.nativeTurnId ?? null,
      stopReason: turn.stopReason,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt ?? null,
      firstTextAt: turn.firstTextAt ?? null,
      usage: turn.usage ?? null,
      answerChars: turn.answerChars,
      answerTruncated: turn.answerTruncated,
      awaitingPermission: turn.state === 'awaiting-permission',
      error: turn.error ?? null,
      backendError: turn.backendError ?? null,
      backendNotices: turn.backendNotices ?? [],
      watchdog: this.#watchdogSummary(turn),
      recordDir: redactPath(this.store.turnDir(turn.id)),
    };
  }

  /**
   * What the watchdogs currently know about a turn. `silentMs` is the honest
   * liveness signal a parent should read: it is time since the backend last
   * said anything, not time since the turn began.
   * @param {any} turn
   */
  #watchdogSummary(turn) {
    const wd = turn?.watchdog;
    if (!wd) return null;
    const now = this.now();
    const active = !turn.finishedAt;
    return {
      stallTimeoutMs: wd.stallTimeoutMs,
      deadlineMs: wd.deadlineMs,
      stallAction: wd.stallAction,
      stalled: wd.stalled,
      stallCount: wd.stallCount,
      timeoutKind: wd.timeoutKind,
      silentMs: active ? Math.max(0, now - wd.lastActivityAtMs) : null,
      lastActivityAt: new Date(wd.lastActivityAtMs).toISOString(),
      deadlineAt: wd.deadlineMs > 0 ? new Date(wd.startedAtMs + wd.deadlineMs).toISOString() : null,
      remainingMs: wd.deadlineMs > 0 && active ? Math.max(0, wd.startedAtMs + wd.deadlineMs - now) : null,
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
      profile: this.spec.profile ?? 'default',
      codex: this.spec.codex ?? undefined,
      command: this.spec.commandOverride ?? undefined,
      argsPrefix: this.spec.argsOverride ?? undefined,
      // Permission posture flags belong after the backend's own protocol
      // arguments (`devin acp --agent-type review`, `kiro-cli acp -a`).
      extraArgs: this.spec.permissionArgs ?? undefined,
      env: this.spec.env ?? {},
      maxLineBytes: this.spec.maxLineBytes,
      stderrStream,
      onUpdate: (update) => this.#onUpdate(update),
      onPermissionRequest: (request) => this.#onPermissionRequest(request),
      onTransportError: (err) => this.#onTransportError(err),
    });

    await this.connection.start();
    this.meta.backendPid = this.connection.child?.pid ?? null;
    const backendIdentity = await processIdentity(this.meta.backendPid);
    this.meta.backendCommand = backendIdentity?.command ?? this.connection.child?.spawnfile ?? null;
    this.meta.backendProcessStartedAt = backendIdentity?.startedAt ?? null;
    const init = await this.connection.initialize(toPositiveInt(this.spec.initTimeoutMs, 60000));
    const described =
      typeof this.connection.describeInit === 'function'
        ? this.connection.describeInit()
        : {
            protocolVersion: init?.protocolVersion ?? null,
            agentInfo: init?.agentInfo ?? null,
            agentCapabilities: init?.agentCapabilities ?? null,
          };
    this.meta.protocolVersion = described.protocolVersion;
    this.meta.agentInfo = described.agentInfo;
    this.meta.agentCapabilities = described.agentCapabilities;

    const resume = this.spec.resume ?? null;
    const canResume = typeof this.connection.resumeSession === 'function';
    this.meta.resume.mechanism = canResume ? (backend.resumeMechanism ?? 'session/load') : null;
    this.meta.resume.supported = canResume ? null : false;

    let resumed = false;
    if (resume?.nativeSessionId) {
      if (canResume) {
        this.meta.resume.lastAttempt = {
          at: new Date(this.now()).toISOString(),
          nativeSessionId: resume.nativeSessionId,
          ok: null,
        };
        try {
          await this.connection.resumeSession({
            nativeSessionId: resume.nativeSessionId,
            cwd: this.spec.workspace,
            timeoutMs: toPositiveInt(this.spec.sessionTimeoutMs, 120000),
          });
          this.meta.sessionId = this.connection.sessionId;
          this.meta.resume.supported = true;
          this.meta.resume.lastAttempt.ok = true;
          this.meta.recovered = this.meta.sessionId === resume.nativeSessionId;
          resumed = true;
          this.#emit({
            kind: 'session_recovered',
            nativeSessionId: this.meta.sessionId,
            mechanism: this.meta.resume.mechanism,
          });
        } catch (err) {
          // An agent can advertise `loadSession` and still refuse the call.
          // Only `required` fails closed on that: the default is to say so and
          // continue on a fresh native session, because refusing to start at
          // all would leave the caller with no way back into the workspace.
          if (resume.policy === 'required') throw err;
          this.meta.resume.supported = false;
          this.meta.resume.lastAttempt.ok = false;
          this.meta.resume.lastAttempt.error = {
            code: err?.code ?? 'unknown',
            message: err?.message ?? String(err),
          };
          this.#emit({
            kind: 'session_not_resumable',
            nativeSessionId: resume.nativeSessionId,
            reason: `resume was rejected (${err?.message ?? err}); starting a fresh native session`,
          });
        }
      } else {
        // The backend has no resume primitive at all; the spec decides whether
        // to fail closed or continue — either way it is recorded.
        if (resume.policy === 'required') {
          throw fail(ERROR_CODES.session_not_resumable, `${backend.id} does not support session resume`, {
            backend: backend.id,
            nativeSessionId: resume.nativeSessionId,
          });
        }
        this.meta.resume.supported = false;
        this.#emit({
          kind: 'session_not_resumable',
          nativeSessionId: resume.nativeSessionId,
          reason: 'backend has no resume primitive; starting a fresh native session',
        });
      }
    }

    if (!resumed) {
      if (typeof this.connection.createSession === 'function') {
        await this.connection.createSession({
          cwd: this.spec.workspace,
          timeoutMs: toPositiveInt(this.spec.sessionTimeoutMs, 120000),
        });
      } else {
        await this.connection.newSession({
          cwd: this.spec.workspace,
          timeoutMs: toPositiveInt(this.spec.sessionTimeoutMs, 120000),
        });
      }
      this.meta.sessionId = this.connection.sessionId;
    }

    if (backend.id === 'codex' && this.connection.policies) {
      this.meta.codex = {
        sandbox: this.connection.policies.sandbox,
        approvalPolicy: this.connection.policies.approvalPolicy,
      };
    }

    await this.#applyModelAndEffort();

    this.status = 'ready';
    this.#emit({
      kind: 'session_ready',
      sessionId: this.connection.sessionId,
      backend: backend.id,
      recovered: this.meta.recovered,
    });
    this.#saveMeta();

    const token = this.store.mintControlToken();
    this.server = await serveControl(this.store.socketPath, this.#handlers(), { token });
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
      // Launch-flag backends (Devin, Kiro) get the model at spawn time; Codex
      // sets it in thread/start. Either way the session response is the only
      // readback available.
      const observed = metadata.model.currentModel;
      const verified = Boolean(requested) && observed === requested;
      this.meta.model = { requested, observed, source, verified };
      if (requested && observed && !verified) {
        throw fail(ERROR_CODES.model_rejected, `Backend reported model ${observed}, not the requested ${requested}`, {
          requested,
          observed,
        });
      }
      if (requested && !observed && backend.modelSelection === 'thread-start') {
        throw fail(ERROR_CODES.model_rejected, `Backend did not report the model it selected`, { requested });
      }
    }

    const effort = this.spec.effort ?? null;
    if (!effort) {
      this.meta.effort = {
        requested: null,
        observed: metadata.effort.currentEffort,
        verified: false,
        support: metadata.effort.configId
          ? 'advertised'
          : backend.effortMechanism === 'turn-parameter'
            ? 'turn-parameter'
            : 'not-advertised',
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
    if (backend.effortMechanism === 'turn-parameter') {
      // Codex applies effort per turn and reports it through thread/read once
      // the first turn is running; verification lands via the
      // `_codex/threadSettings` readback notification.
      const advertised = metadata.effort.availableEfforts;
      this.meta.effort = {
        requested: effort,
        observed: metadata.effort.currentEffort,
        verified: false,
        support: advertised.length === 0 || advertised.includes(effort) ? 'turn-parameter' : 'turn-parameter-unadvertised',
        availableEfforts: advertised,
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
    if (this.turn?.finishedAt) return;
    this.#noteActivity();
    const kind = update?.sessionUpdate ?? 'unknown';
    if (kind === 'agent_notification' && update?.method === '_kiro.dev/session/update' && this.turn) {
      // Kiro announces its own trouble before failing a turn: stall notices and
      // retry warnings ("Response timed out - retrying", attempt 3 of 3). They
      // are the only explanation a later JSON-RPC "Internal error" comes with.
      const vendor = update?.params?.update ?? {};
      if (vendor.sessionUpdate === 'retry_warning' || vendor.sessionUpdate === 'stream_stall_notice') {
        const notices = (this.turn.backendNotices ??= []);
        notices.push({
          kind: vendor.sessionUpdate,
          message: String(vendor.message ?? ''),
          attempt: vendor.attempt ?? null,
          maxAttempts: vendor.maxAttempts ?? null,
          at: new Date(this.now()).toISOString(),
        });
        if (notices.length > 5) notices.splice(0, notices.length - 5);
      }
    }
    if (kind === 'agent_notification' && update?.method === '_kiro.dev/metadata') {
      const observed = update?.params?.effort ?? null;
      if (observed && this.meta.effort.requested) {
        this.meta.effort.observed = observed;
        this.meta.effort.verified = observed === this.meta.effort.requested;
        this.meta.effort.support = 'agent-notification';
        this.#saveMeta();
      }
    }
    if (kind === 'agent_notification' && update?.method === '_codex/threadSettings') {
      const observed = update?.params?.effort ?? null;
      const model = update?.params?.model ?? null;
      if (observed) {
        this.meta.effort.observed = observed;
        if (this.meta.effort.requested) this.meta.effort.verified = observed === this.meta.effort.requested;
      }
      if (model) this.meta.model.threadReadback = model;
      if (update?.params?.sandbox && this.meta.codex) this.meta.codex.sandbox = update.params.sandbox;
      this.#saveMeta();
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
      case 'codex_item':
        this.#emit({ kind: 'tool_call', update: { item: update.item, phase: update.phase } });
        break;
      case 'plan':
        this.#emit({ kind: 'plan', update });
        break;
      case 'turn_diff':
        this.#emit({ kind: 'diff', text: update?.text ?? '' });
        break;
      case 'usage_update':
        if (this.turn) {
          this.turn.usageEvents += 1;
          this.turn.usage = this.#normalizedUsage(update);
        }
        this.#emit({ kind: 'usage_update', update });
        break;
      case 'model_rerouted':
        // A mid-turn model substitution is material evidence: the model that
        // produced the output may not be the model that was requested.
        this.meta.model.rerouted = { from: update.from ?? null, to: update.to ?? null, reason: update.reason ?? null };
        this.#emit({ kind: 'model_rerouted', from: update.from ?? null, to: update.to ?? null, reason: update.reason ?? null });
        this.#saveMeta();
        break;
      case 'rate_limits':
        this.meta.quota = { state: 'observed', ...update.rateLimits };
        this.#emit({ kind: 'rate_limits', rateLimits: update.rateLimits });
        this.#saveMeta();
        break;
      case 'server_error': {
        const message = backendErrorMessage(update.error);
        const classified = classifyBackendError(message);
        // Kept on the turn: a backend that says "you've hit your usage limit"
        // and then reports a bare `failed` turn would otherwise leave the
        // caller re-running something that cannot succeed.
        if (this.turn && !this.turn.finishedAt) {
          this.turn.backendError = {
            code: 'server_error',
            message,
            category: classified.category,
            retryable: classified.retryable,
            reroute: classified.reroute,
            willRetry: update.willRetry === true,
          };
        }
        this.#emit({
          kind: 'error',
          code: 'server_error',
          message: message.slice(0, 500),
          category: classified.category,
          retryable: classified.retryable,
          reroute: classified.reroute,
          willRetry: update.willRetry,
        });
        break;
      }
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
    if (this.stopping || this.turn?.finishedAt) return Promise.resolve({ cancelled: true });
    const requestId = request?.requestId ?? request?.toolCall?.toolCallId ?? newId();
    // Classified once, on arrival: the parent answering this request should not
    // have to re-derive whether it stays inside the workspace.
    const classification = classifyPermissionRequest(request, { workspace: this.spec.workspace });
    const normalised = { ...request, requestId, classification };
    if (this.turn) this.turn.state = 'awaiting-permission';

    /** @type {(decision: any) => void} */
    let settle;
    const decided = new Promise((resolve) => {
      settle = resolve;
    });

    this.#noteActivity();
    // Registered before the metadata write, so the very first `status` that
    // observes `awaiting-permission` already lists the request to answer.
    this.pendingPermissions.set(requestId, {
      request: normalised,
      resolve: (decision) => {
        this.pendingPermissions.delete(requestId);
        if (this.turn && this.turn.state === 'awaiting-permission') {
          this.turn.state = this.pendingPermissions.size > 0 ? 'awaiting-permission' : 'running';
        }
        // The turn is live again from here. Without this, a stall timer armed
        // before the pause can fire a moment later, read the whole wait as
        // backend silence, and cancel a turn that just resumed.
        this.#noteActivity();
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
      classification,
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

  /**
   * (Re)arm both turn watchdogs. Called when a turn starts and whenever its
   * budget is changed by `extend`.
   * @param {string} turnId
   */
  #armWatchdogs(turnId) {
    this.#clearTurnTimers();
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.finishedAt) return;
    const wd = turn.watchdog;
    if (wd.deadlineMs > 0) {
      const remaining = Math.max(1, wd.startedAtMs + wd.deadlineMs - this.now());
      this.deadlineTimer = setTimeout(() => this.#onDeadline(turnId), remaining);
      this.deadlineTimer.unref?.();
    }
    this.#armStallTimer(turnId);
  }

  /** @param {string} turnId */
  #armStallTimer(turnId) {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.finishedAt) return;
    const wd = turn.watchdog;
    if (!wd || wd.stallTimeoutMs <= 0) return;
    this.stallTimer = setTimeout(() => this.#onStall(turnId), wd.stallTimeoutMs);
    this.stallTimer.unref?.();
  }

  #clearTurnTimers() {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.deadlineTimer = null;
    this.stallTimer = null;
  }

  /**
   * Any backend-originated signal — text, thought, tool call, plan, diff, usage
   * or a permission request — counts as progress and restarts the inactivity
   * window. A turn that reports a stall and then speaks again is un-stalled.
   */
  #noteActivity() {
    const turn = this.turn;
    if (!turn || turn.finishedAt || !turn.watchdog) return;
    const wd = turn.watchdog;
    const silentMs = Math.max(0, this.now() - wd.lastActivityAtMs);
    wd.lastActivityAtMs = this.now();
    if (wd.stalled) {
      wd.stalled = false;
      this.#emit({ kind: 'turn_resumed', silentMs, stallCount: wd.stallCount });
    }
    this.#armStallTimer(turn.id);
  }

  /**
   * The inactivity window elapsed. The default action is to report, not to
   * kill: the parent is another agent and can steer, extend or cancel with
   * more context than a timer has.
   * @param {string} turnId
   */
  #onStall(turnId) {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.finishedAt) return;
    const wd = turn.watchdog;
    // A turn blocked on a permission request is waiting for us, not silent.
    if (turn.state === 'awaiting-permission') {
      wd.lastActivityAtMs = this.now();
      this.#armStallTimer(turnId);
      return;
    }
    const silentMs = Math.max(0, this.now() - wd.lastActivityAtMs);
    wd.stalled = true;
    wd.stallCount += 1;
    this.#emit({
      kind: 'turn_stalled',
      silentMs,
      stallTimeoutMs: wd.stallTimeoutMs,
      stallCount: wd.stallCount,
      action: wd.stallAction,
    });
    this.#saveMeta();
    if (wd.stallAction === 'cancel') {
      this.#timeoutTurn(turnId, 'stall', silentMs);
      return;
    }
    // Report-only: keep the turn alive and report again every window.
    this.#armStallTimer(turnId);
  }

  /** @param {string} turnId */
  #onDeadline(turnId) {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.finishedAt) return;
    this.#timeoutTurn(turnId, 'deadline', Math.max(0, this.now() - turn.watchdog.startedAtMs));
  }

  /**
   * @param {string} turnId
   * @param {'stall'|'deadline'} kind
   * @param {number} elapsedMs
   */
  #timeoutTurn(turnId, kind, elapsedMs) {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.finishedAt) return;
    const wd = turn.watchdog;
    wd.timeoutKind = kind;
    this.#emit({
      kind: 'turn_timeout',
      reason: kind,
      timeoutMs: kind === 'stall' ? wd.stallTimeoutMs : wd.deadlineMs,
      elapsedMs,
    });
    this.connection.cancel();
    for (const [, pending] of this.pendingPermissions) pending.resolve({ cancelled: true });
    turn.state = 'timed-out';
    turn.stopReason = 'relayrook_timeout';
    const message =
      kind === 'stall'
        ? `Turn produced no output for ${wd.stallTimeoutMs}ms`
        : `Turn exceeded its ${wd.deadlineMs}ms wall-clock deadline`;
    this.#finishTurn(turnId, null, fail(ERROR_CODES.turn_timeout, message, { reason: kind, elapsedMs }));
  }

  /**
   * Give the active turn more budget without disturbing it. This is what makes
   * the watchdog interactive: a reported stall is a question to the parent, and
   * `extend` is one of the answers.
   * @param {{turnId?: string, timeoutMs?: number, stallTimeoutMs?: number, stallAction?: string, resetDeadline?: boolean}} params
   */
  async extendTurn(params = {}) {
    const turn = this.turn;
    if (!turn || (turn.state !== 'running' && turn.state !== 'awaiting-permission')) {
      throw fail(ERROR_CODES.no_active_turn, 'No active turn to extend');
    }
    if (params.turnId && params.turnId !== turn.id) {
      throw fail(ERROR_CODES.no_active_turn, 'Requested turn is not the active turn', {
        requested: params.turnId,
        active: turn.id,
      });
    }
    const wd = turn.watchdog;
    if (params.timeoutMs !== undefined) wd.deadlineMs = toNonNegativeInt(params.timeoutMs, wd.deadlineMs);
    if (params.stallTimeoutMs !== undefined) {
      wd.stallTimeoutMs = toNonNegativeInt(params.stallTimeoutMs, wd.stallTimeoutMs);
    }
    if (params.stallAction === 'cancel' || params.stallAction === 'report') wd.stallAction = params.stallAction;
    if (params.resetDeadline) wd.startedAtMs = this.now();
    wd.stalled = false;
    wd.lastActivityAtMs = this.now();
    this.#emit({
      kind: 'turn_extended',
      deadlineMs: wd.deadlineMs,
      stallTimeoutMs: wd.stallTimeoutMs,
      stallAction: wd.stallAction,
      resetDeadline: Boolean(params.resetDeadline),
    });
    this.#armWatchdogs(turn.id);
    this.#saveMeta();
    return { ok: true, turnId: turn.id, watchdog: this.#watchdogSummary(turn) };
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
      steer: async (params) => this.steerTurn(params),
      review: async (params) => this.startReview(params),
      status: async (params) => this.readStatus(params),
      cancel: async (params) => this.cancelTurn(params),
      extend: async (params) => this.extendTurn(params),
      permission: async (params) => this.answerPermission(params),
      stop: async () => {
        setTimeout(() => void this.shutdown('stop-requested'), 10).unref?.();
        return { ok: true, stopping: true };
      },
    };
  }

  /**
   * Begin a turn, whatever mechanism drives it. Overlapping an active turn is
   * refused with a typed error rather than queued, so a caller can never
   * accidentally interleave two mutating prompts against the same workspace.
   * @param {{text?: string, review?: {target: any, delivery: string}, mechanism: string,
   *   timeoutMs?: number, stallTimeoutMs?: number, stallAction?: string, metadata?: any}} params
   */
  async #startTurn(params) {
    this.#resetIdleTimer();
    if (this.drivePending || (this.turn && (this.turn.state === 'running' || this.turn.state === 'awaiting-permission'))) {
      throw fail(ERROR_CODES.active_turn, 'A turn is already active on this session', {
        turnId: this.turn.id,
        state: this.turn.state,
      });
    }
    if (this.status !== 'ready') {
      throw fail(ERROR_CODES.session_not_running, `Session is ${this.status}`, { status: this.status });
    }

    const turnId = newId();
    const startedAtMs = this.now();
    // Two independent watchdogs, because "slow" and "hung" are different
    // failures. The inactivity window judges liveness; the wall-clock deadline
    // is only a backstop. Either is disabled with 0.
    const watchdog = {
      stallTimeoutMs: toNonNegativeInt(params?.stallTimeoutMs, DEFAULT_TURN_STALL_MS),
      deadlineMs: toNonNegativeInt(params?.timeoutMs, DEFAULT_TURN_TIMEOUT_MS),
      stallAction: params?.stallAction === 'cancel' ? 'cancel' : 'report',
      startedAtMs,
      lastActivityAtMs: startedAtMs,
      stalled: false,
      stallCount: 0,
      timeoutKind: null,
    };
    this.turn = {
      id: turnId,
      watchdog,
      state: 'running',
      mechanism: params.mechanism,
      nativeTurnId: null,
      stopReason: null,
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      firstTextAt: null,
      answer: '',
      answerChars: 0,
      answerTruncated: false,
      usage: null,
      usageEvents: 0,
      events: [],
      error: null,
      prompt: params.text ?? null,
      reviewTarget: params.review?.target ?? null,
      metadata: params?.metadata ?? null,
    };
    writeTurnRecord(this.store, turnId, { prompt: params.text ?? '', answer: '' });
    this.#emit({ kind: 'turn_started', mechanism: params.mechanism, prompt_chars: params.text?.length ?? 0 });
    this.#saveMeta();

    this.#armWatchdogs(turnId);

    this.drivePending = true;
    const drive = params.review ? this.connection.review(params.review) : this.connection.prompt(params.text);
    if (this.connection.activeTurnId) this.turn.nativeTurnId = this.connection.activeTurnId;
    drive
      .then(
        (result) => this.#finishTurn(turnId, result, null),
        (err) => this.#finishTurn(turnId, null, err),
      )
      .finally(() => {
        this.drivePending = false;
        this.#clearTurnTimers();
      });

    return {
      turnId,
      state: 'running',
      startedAt: this.turn.startedAt,
      watchdog: this.#watchdogSummary(this.turn),
    };
  }

  /**
   * Submit one prompt turn.
   * @param {{text: string, timeoutMs?: number, stallTimeoutMs?: number, stallAction?: string, metadata?: any}} params
   */
  async submitPrompt(params) {
    const text = String(params?.text ?? '');
    if (text.trim() === '') throw fail(ERROR_CODES.usage, 'Prompt text is empty');
    return this.#startTurn({
      text,
      mechanism: 'prompt',
      timeoutMs: params?.timeoutMs,
      stallTimeoutMs: params?.stallTimeoutMs,
      stallAction: params?.stallAction,
      metadata: params?.metadata,
    });
  }

  /**
   * Native review primitive (Codex `review/start`). Backends without one
   * report a typed unsupported error; the generic path is `prompt` with the
   * code-review role, which is what `relayrook prompt --role code-review`
   * already does.
   * @param {{target?: any, delivery?: string, timeoutMs?: number, stallTimeoutMs?: number, stallAction?: string}} params
   */
  async startReview(params) {
    if (typeof this.connection.review !== 'function') {
      throw fail(
        ERROR_CODES.capability_unsupported,
        `${this.spec.backend} has no native review primitive; use prompt --role code-review instead`,
        { capability: 'review', backend: this.spec.backend },
      );
    }
    if (this.meta.profile !== 'read-only' || this.meta.codex?.sandbox !== 'read-only') {
      throw fail(
        ERROR_CODES.role_posture_mismatch,
        'Native review requires a read-only session; start the session with --role code-review or --profile read-only',
        { profile: this.meta.profile, sandbox: this.meta.codex?.sandbox ?? null },
      );
    }
    return this.#startTurn({
      review: { target: params?.target ?? { type: 'uncommittedChanges' }, delivery: params?.delivery ?? 'inline' },
      mechanism: 'review/start',
      timeoutMs: params?.timeoutMs,
      stallTimeoutMs: params?.stallTimeoutMs,
      stallAction: params?.stallAction,
    });
  }

  /**
   * Steer the active turn with additional input. Only backends with a real
   * steering primitive (Codex `turn/steer`) support this; it is a different
   * operation from cancellation and is never silently mapped onto it.
   * @param {{text?: string}} params
   */
  async steerTurn(params) {
    if (!this.turn || (this.turn.state !== 'running' && this.turn.state !== 'awaiting-permission')) {
      throw fail(ERROR_CODES.no_active_turn, 'No active turn to steer');
    }
    if (typeof this.connection.steer !== 'function') {
      throw fail(
        ERROR_CODES.capability_unsupported,
        `${this.spec.backend} does not support steering; use cancel and a follow-up prompt instead`,
        { capability: 'steer', backend: this.spec.backend },
      );
    }
    const text = String(params?.text ?? '');
    if (text.trim() === '') throw fail(ERROR_CODES.usage, 'Steer text is empty');
    const result = await this.connection.steer(text);
    this.#emit({ kind: 'steered', chars: text.length });
    this.#saveMeta();
    return { ok: true, turnId: this.turn.id, nativeTurnId: result?.turnId ?? null };
  }

  /**
   * @param {string} turnId
   * @param {any} result
   * @param {any} err
   */
  #finishTurn(turnId, result, err) {
    if (!this.turn || this.turn.id !== turnId || this.turn.finishedAt) return;
    this.#clearTurnTimers();
    const turn = this.turn;
    /** Attach the backend's own explanation to a failure that has none. */
    const explainFailure = () => {
      if (turn.state !== 'failed' || !turn.backendError) return;
      const generic = !turn.error || turn.error.code === 'backend_turn_failed';
      turn.error = generic
        ? { ...turn.backendError, code: `backend_${turn.backendError.category.replace('-', '_')}` }
        : { ...turn.error, backendError: turn.backendError };
    };
    turn.finishedAt = new Date(this.now()).toISOString();

    if (err) {
      turn.state = turn.state === 'timed-out' ? 'timed-out' : 'failed';
      turn.stopReason = turn.state === 'timed-out' ? 'relayrook_timeout' : mapErrorStopReason(err);
      turn.error = { code: err?.code ?? 'internal_error', message: err?.message ?? String(err) };
      if (turn.stopReason === 'backend_error') {
        // The backend answered the prompt with a JSON-RPC error: its failure,
        // not a RelayRook protocol violation. Reporting it as
        // relayrook_protocol_error sent callers after RelayRook when Kiro's own
        // model request had timed out three times.
        const notices = turn.backendNotices ?? [];
        const classified = classifyBackendError([err?.message, ...notices.map((n) => n.message)].join(' | '));
        turn.error = {
          code: ERROR_CODES.backend_error,
          message: err?.message ?? 'Backend returned an error',
          rpcCode: err?.details?.rpcCode ?? null,
          category: classified.category,
          retryable: classified.retryable,
          reroute: classified.reroute,
          notices,
        };
      }
    } else {
      const stopReason = result?.stopReason ?? null;
      turn.stopReason = stopReason;
      // Turn outcome comes from the protocol's stop reason, never from an exit
      // code and never from the mere absence of an error.
      if (turn.state === 'timed-out') {
        turn.stopReason = 'relayrook_timeout';
      } else if (stopReason === 'cancelled') {
        turn.state = 'cancelled';
      } else if (stopReason === 'failed') {
        turn.state = 'failed';
        const codexError = result?.error;
        turn.error = {
          code: codexError?.codexErrorInfo ?? 'backend_turn_failed',
          message: codexError?.message ?? 'Backend reported a failed turn',
        };
      } else if (stopReason === null) {
        turn.state = 'failed';
        turn.error = { code: ERROR_CODES.protocol_error, message: 'Backend returned no stopReason' };
      } else {
        turn.state = 'completed';
      }
      if (result?.usage) turn.usage = this.#normalizedUsage(result.usage);
      turn.result = result;
    }

    explainFailure();

    // Finalize the usage record: latency and event count are only knowable
    // once the turn ends. A turn whose provider never reported usage keeps
    // usage: null rather than a zeroed record.
    if (turn.usage) {
      turn.usage.latencyMs = Math.max(0, Date.parse(turn.finishedAt) - Date.parse(turn.startedAt));
      turn.usage.eventCount = turn.usageEvents;
      turn.usage.rateLimits = this.connection?.lastRateLimits ?? turn.usage.rateLimits ?? null;
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
        mechanism: turn.mechanism,
        nativeTurnId: turn.nativeTurnId,
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
    this.#clearTurnTimers();
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
  // An error *response* from the backend carries its JSON-RPC code; a protocol
  // violation RelayRook detects itself does not.
  if (err?.code === ERROR_CODES.protocol_error && err?.details?.rpcCode !== undefined) return 'backend_error';
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
