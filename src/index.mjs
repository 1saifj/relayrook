/**
 * Public runtime surface. The CLI in `cli.mjs` is a thin layer over these.
 */
export { main, VERSION } from './cli.mjs';
export { ERROR_CODES, RelayRookError, TURN_STATES, STOP_REASONS, fail } from './errors.mjs';
export {
  BACKEND_IDS,
  allBackends,
  getBackend,
  hasBackend,
  buildLaunchArgs,
  readModelMetadata,
  readEffortMetadata,
  findConfigOption,
  resolveModel,
} from './backends.mjs';
export {
  resolveCaller,
  assertNoRecursion,
  childRouteEnvelope,
  routeEnvelopeEnv,
  parseRouteEnvelope,
  collectEnvEvidence,
  CALLER_CONFIDENCE,
  DEFAULT_MAX_DEPTH,
  ROUTE_ENV_VAR,
} from './caller.mjs';
export { route, ROLES, loadRouteTable, resetRouteTableCache, assertRole, resolveEffortSupport } from './routing.mjs';
export { buildPrompt, parseResultBlock, RESULT_FENCE, REVIEW_STATUSES } from './prompts.mjs';
export { EventLog, SessionStore, resolveStateDir, listSessionKeys, writeTurnRecord, LIMITS } from './state.mjs';
export { SessionWorker, runWorker } from './worker.mjs';
export {
  startSession,
  promptSession,
  statusSession,
  waitSession,
  cancelSession,
  answerPermission,
  stopSession,
  listSessions,
  backendCommandOverride,
  resolveLaunchCommand,
  BACKEND_CMD_ENV_PREFIX,
} from './sessions.mjs';
export { discoverAll, discoverBackend, whichSync, probeVersion, extractVersion, ProbeCache } from './discovery.mjs';
export { runDoctor, parentProcessInfo } from './doctor.mjs';
export { bootstrapAdapter } from './bootstrap.mjs';
export { AcpConnection, CLIENT_CAPABILITIES, PROTOCOL_VERSION } from './adapters/acp.mjs';
export { CodexAppServerProbe, probeCodex } from './adapters/codex.mjs';
export { JsonLineReader, encodeJsonLine, DEFAULT_MAX_LINE_BYTES } from './jsonline.mjs';
export { JsonRpcPeer } from './rpc.mjs';
export { parseArgs } from './args.mjs';
