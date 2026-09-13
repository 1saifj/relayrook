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
  normalizeCallerId,
  requireCallerId,
  KNOWN_HOSTS,
  CALLER_CONFIDENCE,
  DEFAULT_MAX_DEPTH,
  ROUTE_ENV_VAR,
} from './caller.mjs';
export {
  route,
  ROLES,
  loadRouteTable,
  resetRouteTableCache,
  assertRole,
  resolveEffortSupport,
  loadRouteEvidence,
  routeEvidenceKey,
  isMeasured,
} from './routing.mjs';
export { buildPrompt, parseResultBlock, RESULT_FENCE, REVIEW_STATUSES } from './prompts.mjs';
export {
  EventLog,
  SessionStore,
  resolveStateDir,
  resolveRouteKey,
  migrateSessionMeta,
  SESSION_SCHEMA_VERSION,
  listSessionKeys,
  writeTurnRecord,
  LIMITS,
} from './state.mjs';
export { SessionWorker, runWorker, createBackendConnection } from './worker.mjs';
export {
  startSession,
  promptSession,
  steerSession,
  reviewSession,
  statusSession,
  waitSession,
  cancelSession,
  answerPermission,
  stopSession,
  listSessions,
  cleanupSessions,
  backendCommandOverride,
  resolveLaunchCommand,
  BACKEND_CMD_ENV_PREFIX,
} from './sessions.mjs';
export {
  runPreflight,
  runSessionPreflight,
  checkNode,
  checkLocalExecution,
  checkTransport,
  MIN_NODE_VERSION,
} from './preflight.mjs';
export { discoverAll, discoverBackend, whichSync, probeVersion, extractVersion, ProbeCache } from './discovery.mjs';
export { runDoctor, compactDoctorReport, parentProcessInfo } from './doctor.mjs';
export { bootstrapAdapter } from './bootstrap.mjs';
export { AcpConnection, CLIENT_CAPABILITIES, PROTOCOL_VERSION } from './adapters/acp.mjs';
export { CodexAppServerConnection, probeCodex, codexProfilePolicies, CODEX_CLIENT_INFO } from './adapters/codex.mjs';
export { probeAcp } from './adapters/acp-probe.mjs';
export { IS_WINDOWS, spawnCommand, resolveControlEndpoint, pidAlive, quoteForCmd } from './platform.mjs';
export { JsonLineReader, encodeJsonLine, DEFAULT_MAX_LINE_BYTES } from './jsonline.mjs';
export { JsonRpcPeer } from './rpc.mjs';
export { parseArgs } from './args.mjs';
