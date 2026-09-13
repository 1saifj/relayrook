/**
 * Typed errors. Every failure surfaced by the CLI carries a stable machine code
 * so a calling agent can branch on it instead of parsing prose.
 */

export const ERROR_CODES = Object.freeze({
  usage: 'usage',
  unknown_command: 'unknown_command',
  unknown_backend: 'unknown_backend',
  unknown_role: 'unknown_role',
  backend_not_installed: 'backend_not_installed',
  adapter_not_ready: 'adapter_not_ready',
  session_control_not_implemented: 'session_control_not_implemented',
  session_not_found: 'session_not_found',
  session_not_running: 'session_not_running',
  worker_start_failed: 'worker_start_failed',
  active_turn: 'active_turn',
  no_active_turn: 'no_active_turn',
  turn_timeout: 'turn_timeout',
  permission_not_pending: 'permission_not_pending',
  permission_option_invalid: 'permission_option_invalid',
  pin_unsatisfiable: 'pin_unsatisfiable',
  no_eligible_route: 'no_eligible_route',
  recursion_depth_exceeded: 'recursion_depth_exceeded',
  recursive_backend: 'recursive_backend',
  caller_ambiguous: 'caller_ambiguous',
  route_envelope_invalid: 'route_envelope_invalid',
  protocol_error: 'protocol_error',
  line_overflow: 'line_overflow',
  process_exited: 'process_exited',
  model_rejected: 'model_rejected',
  bootstrap_failed: 'bootstrap_failed',
  state_error: 'state_error',
  local_execution_unavailable: 'local_execution_unavailable',
  node_version_unsupported: 'node_version_unsupported',
  transport_unavailable: 'transport_unavailable',
  unsupported_backend_version: 'unsupported_backend_version',
  adapter_version_mismatch: 'adapter_version_mismatch',
  session_not_resumable: 'session_not_resumable',
  capability_unsupported: 'capability_unsupported',
  role_posture_mismatch: 'role_posture_mismatch',
  control_unauthorized: 'control_unauthorized',
});

export class RelayRookError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'RelayRookError';
    this.code = code;
    this.details = details ?? {};
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {RelayRookError}
 */
export function fail(code, message, details) {
  return new RelayRookError(code, message, details);
}

/**
 * Normalise any thrown value into the error envelope shape.
 * @param {unknown} err
 */
export function toErrorEnvelope(err) {
  if (err instanceof RelayRookError) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'internal_error', message, details: {} };
}

/**
 * Turn lifecycle states. `completed` only means the backend reported a terminal
 * turn; it is never derived from a process exit code.
 */
export const TURN_STATES = Object.freeze([
  'idle',
  'running',
  'awaiting-permission',
  'completed',
  'cancelled',
  'failed',
  'timed-out',
]);

/** Stop reasons observed across ACP backends, plus RelayRook-local reasons. */
export const STOP_REASONS = Object.freeze([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
  'relayrook_timeout',
  'relayrook_process_exited',
  'relayrook_protocol_error',
]);

/**
 * Classify a message a backend reported mid-turn, so a delegating agent can
 * tell "this backend is out of quota, route elsewhere" from "retry this".
 *
 * The provider's own words are the evidence; this only labels them.
 * @param {string|null|undefined} message
 * @returns {{category: 'quota'|'auth'|'rate-limit'|'unknown', retryable: boolean, reroute: boolean}}
 */
export function classifyBackendError(message) {
  const text = String(message ?? '').toLowerCase();
  if (/usage limit|out of credits|purchase more credits|quota (?:exceeded|exhausted)|insufficient (?:credits|quota)/.test(text)) {
    return { category: 'quota', retryable: false, reroute: true };
  }
  if (/rate limit|too many requests|429/.test(text)) {
    return { category: 'rate-limit', retryable: true, reroute: false };
  }
  if (/unauthorized|not authenticated|invalid api key|401|403|log ?in again/.test(text)) {
    return { category: 'auth', retryable: false, reroute: true };
  }
  return { category: 'unknown', retryable: true, reroute: false };
}
