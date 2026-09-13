import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';

import { flagBool, flagList, flagNumber, flagString, parseArgs, requireFlag } from './args.mjs';
import { fail, ERROR_CODES, toErrorEnvelope } from './errors.mjs';
import { resolveStateDir, resolveRouteKey } from './state.mjs';
import { runDoctor, parentProcessInfo } from './doctor.mjs';
import { route as routeSelect, loadRouteEvidence, ROLES } from './routing.mjs';
import { buildPrompt, parseResultBlock } from './prompts.mjs';
import { resolveCaller, childRouteEnvelope, routeEnvelopeEnv, DEFAULT_MAX_DEPTH } from './caller.mjs';
import { discoverAll, ProbeCache } from './discovery.mjs';
import { bootstrapAdapter } from './bootstrap.mjs';
import { runPreflight } from './preflight.mjs';
import { newId, redactPath } from './util.mjs';
import { DEFAULT_TURN_STALL_MS, DEFAULT_TURN_TIMEOUT_MS } from './worker.mjs';
import { getBackend } from './backends.mjs';
import { normalizePermissionMode, PERMISSION_MODES } from './permissions.mjs';
import {
  answerPermission,
  cancelSession,
  cleanupSessions,
  listSessions,
  promptSession,
  reviewSession,
  startSession,
  statusSession,
  steerSession,
  storeFor,
  stopSession,
  waitSession,
  extendSession,
} from './sessions.mjs';

export const VERSION = '0.2.1';

const BOOLEAN_FLAGS = [
  'probe',
  'json',
  'reuse',
  'dry-run',
  'allow-repeat-backend',
  'allow-unimplemented',
  'cancel',
  'read-only',
  'help',
  'quiet',
  'full',
  'compact',
  'events',
  'detached',
  'reset-deadline',
  'through-stall',
];

const USAGE = `relayrook ${VERSION} — route work to locally installed coding agents

Usage: relayrook <command> [options]

Commands
  doctor                 Report caller evidence, installed backends, adapters and configured routes
  preflight              Run capability checks without starting a session
  route                  Choose a backend/model/effort for a role
  start                  Create or reuse a persistent session for a backend and workspace
  prompt                 Submit one turn to a session
  steer                  Add input to the active turn (Codex only)
  review                 Run a native review turn (Codex only; other backends: prompt --role code-review)
  status                 Read session state and incremental events from a cursor
  wait                   Poll until the active turn reaches a terminal state
  extend                 Give the active turn more watchdog budget
  cancel                 Cancel the active turn
  permission             Answer a pending permission request with an advertised option
  stop                   Stop a session worker
  sessions               List known sessions
  cleanup                Reap dead workers, stale endpoints and orphaned backend processes
  bootstrap              Install a backend's pinned adapter package
  prompt-preview         Print the prompt RelayRook would send for a role
  parse-result           Extract the relayrook-result block from an agent reply
  version                Print version information

Common options
  --state-dir <dir>      Override the state directory (default: $RELAYROOK_STATE_DIR or the per-user state dir)
  --caller <id>          Authoritative calling agent id (any normalized id; known: codex, claude-code, kiro-cli, opencode, devin)
  --json                 Emit JSON (default; kept for explicitness)

Discovery options
  --compact              Keep doctor output small for agent-host routing

Permission options (start)
  --permission-mode <m>  ${PERMISSION_MODES.join(' | ')} (default: read-only for review roles, gated otherwise)
                         gated keeps every mutating action a request the caller answers;
                         auto-edits lets the agent write without asking; full-auto asks for nothing

Turn watchdog options (prompt, review, extend)
  --stall-timeout <ms>   Inactivity window; a turn is judged silent, never slow (default ${DEFAULT_TURN_STALL_MS}, 0 disables)
  --stall-action <a>     report | cancel — what a stall does (default report: the turn keeps running and wait returns)
  --timeout <ms>         Wall-clock backstop for the whole turn (default ${DEFAULT_TURN_TIMEOUT_MS}, 0 disables)
  --reset-deadline       extend only: restart the wall-clock budget from now
  --through-stall        wait only: keep waiting through reported stalls

Codex session options
  --sandbox <mode>       read-only | workspace-write | danger-full-access (default follows --profile)
  --approval-policy <p>  never | on-request | untrusted (default follows --profile)
  --resume <policy>      auto | required | never — dead-worker recovery behaviour

Roles: ${ROLES.join(', ')}
`;

/**
 * @param {string[]} argv
 * @param {{stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv}} [io]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const { flags, positionals } = parseArgs(argv, { booleans: BOOLEAN_FLAGS });
  const command = positionals[0];

  if (flagBool(flags, 'help')) {
    stdout.write(USAGE);
    return 0;
  }
  if (!command) {
    const envelope = toErrorEnvelope(fail(ERROR_CODES.usage, 'A command is required', { usage: USAGE }));
    stderr.write(`${JSON.stringify({ ok: false, command: null, error: envelope }, null, 2)}\n`);
    return 1;
  }

  try {
    const result = await dispatch(command, flags, positionals.slice(1), env);
    // `ok` and `command` come last: a payload that happens to carry an `ok`
    // field must not turn a successful command into a reported failure.
    stdout.write(`${JSON.stringify({ ...result, ok: true, command }, null, 2)}\n`);
    return 0;
  } catch (err) {
    const envelope = toErrorEnvelope(err);
    stderr.write(`${JSON.stringify({ ok: false, command, error: envelope }, null, 2)}\n`);
    return 1;
  }
}

/**
 * @param {string} command
 * @param {Record<string, any>} flags
 * @param {string[]} rest
 * @param {NodeJS.ProcessEnv} env
 */
async function dispatch(command, flags, rest, env) {
  const stateDir = resolveStateDir(flagString(flags, 'state-dir'), env);

  switch (command) {
    case 'version':
      return { version: VERSION, node: process.version };

    case 'doctor':
      return runDoctor({
        stateDir,
        explicitCaller: flagString(flags, 'caller') ?? null,
        probe: flagBool(flags, 'probe'),
        env,
        timeoutMs: flagNumber(flags, 'probe-timeout', 8000),
        version: VERSION,
        compact: flagBool(flags, 'compact'),
      });

    case 'preflight': {
      const probeCache = new ProbeCache(stateDir);
      const report = await runPreflight({
        stateDir,
        env,
        backend: flagString(flags, 'backend') ?? flagString(flags, 'agent') ?? null,
        probeCache,
      });
      // The command succeeded because a report was produced; the capability
      // verdict is `passed`. Merging the raw report would let its `ok:false`
      // masquerade as a command failure with no error envelope.
      return { passed: report.ok, checks: report.checks, blockers: report.blockers };
    }

    case 'route':
      return commandRoute(flags, stateDir, env);

    case 'start':
      return commandStart(flags, stateDir, env);

    case 'prompt':
      return commandPrompt(flags, stateDir, env);

    case 'steer': {
      const key = requireFlag(flags, 'session');
      const text = flagString(flags, 'text') ?? rest.join(' ');
      if (!text || !text.trim()) throw fail(ERROR_CODES.usage, 'steer requires --text');
      const result = await steerSession({ stateDir, key, text });
      return { session: key, ...result };
    }

    case 'review': {
      const key = requireFlag(flags, 'session');
      const target = reviewTarget(flags);
      const result = await reviewSession({
        stateDir,
        key,
        target,
        delivery: flagBool(flags, 'detached') ? 'detached' : 'inline',
        timeoutMs: flagNumber(flags, 'timeout', DEFAULT_TURN_TIMEOUT_MS),
        stallTimeoutMs: flagNumber(flags, 'stall-timeout', DEFAULT_TURN_STALL_MS),
        stallAction: stallAction(flags),
      });
      return { session: key, mechanism: 'review/start', ...result };
    }

    case 'status': {
      const key = requireFlag(flags, 'session');
      const snapshot = await statusSession({
        stateDir,
        key,
        cursor: flagNumber(flags, 'cursor', 0),
        limit: flagNumber(flags, 'limit', 200),
        turnId: flagString(flags, 'turn') ?? null,
      });
      return {
        session: key,
        ...snapshot,
        meta: compactMeta(snapshot.meta, flagBool(flags, 'full')),
      };
    }

    case 'wait': {
      const key = requireFlag(flags, 'session');
      const snapshot = await waitSession({
        stateDir,
        key,
        cursor: flagNumber(flags, 'cursor', 0),
        turnId: flagString(flags, 'turn') ?? null,
        timeoutMs: flagNumber(flags, 'timeout', 15 * 60 * 1000),
        pollMs: flagNumber(flags, 'poll', 250),
        stopOnStall: !flagBool(flags, 'through-stall'),
      });
      const answer = snapshot.answer ?? '';
      const parsedResult = answer ? parseResultBlock(answer) : null;
      const response = {
        session: key,
        ...snapshot,
        meta: compactMeta(snapshot.meta, flagBool(flags, 'full')),
        parsedResult,
      };
      if (!flagBool(flags, 'events')) {
        response.eventCount = response.events?.length ?? 0;
        delete response.events;
      }
      if (!flagBool(flags, 'full') && parsedResult?.ok) {
        response.answerOmitted = true;
        delete response.answer;
      }
      return response;
    }

    case 'extend': {
      const key = requireFlag(flags, 'session');
      const timeoutMs = flags.timeout === undefined ? undefined : flagNumber(flags, 'timeout', DEFAULT_TURN_TIMEOUT_MS);
      const stallTimeoutMs =
        flags['stall-timeout'] === undefined ? undefined : flagNumber(flags, 'stall-timeout', DEFAULT_TURN_STALL_MS);
      const action = flags['stall-action'] === undefined ? undefined : stallAction(flags);
      if (timeoutMs === undefined && stallTimeoutMs === undefined && action === undefined && !flagBool(flags, 'reset-deadline')) {
        throw fail(ERROR_CODES.usage, 'extend requires --timeout, --stall-timeout, --stall-action or --reset-deadline');
      }
      const result = await extendSession({
        stateDir,
        key,
        turnId: flagString(flags, 'turn'),
        timeoutMs,
        stallTimeoutMs,
        stallAction: action,
        resetDeadline: flagBool(flags, 'reset-deadline'),
      });
      return { session: key, ...result };
    }

    case 'cancel':
      return cancelSession({
        stateDir,
        key: requireFlag(flags, 'session'),
        turnId: flagString(flags, 'turn'),
      });

    case 'permission': {
      const key = requireFlag(flags, 'session');
      const cancel = flagBool(flags, 'cancel');
      const optionId = flagString(flags, 'option');
      if (!cancel && !optionId) {
        throw fail(ERROR_CODES.usage, 'permission requires --option <id> or --cancel');
      }
      const result = await answerPermission({
        stateDir,
        key,
        requestId: flagString(flags, 'request'),
        optionId,
        cancel,
      });
      return { session: key, ...result };
    }

    case 'stop':
      return stopSession({ stateDir, key: requireFlag(flags, 'session') });

    case 'sessions':
      return { stateDir: redactPath(stateDir), sessions: await listSessions(stateDir) };

    case 'cleanup':
      return { stateDir: redactPath(stateDir), ...(await cleanupSessions({ stateDir })) };

    case 'bootstrap':
      return bootstrapAdapter({
        backend: requireFlag(flags, 'backend'),
        stateDir,
        dryRun: flagBool(flags, 'dry-run'),
      });

    case 'prompt-preview': {
      const role = requireFlag(flags, 'role');
      const workspace = path.resolve(flagString(flags, 'workspace') ?? process.cwd());
      const prompt = buildPrompt({
        role,
        task: requireFlag(flags, 'task'),
        workspace,
        scope: flagString(flags, 'scope') ?? null,
        checks: flagList(flags, 'check'),
        readOnly: flagBool(flags, 'read-only', role !== 'implementation'),
        context: flagString(flags, 'context') ?? null,
      });
      return { role, workspace: redactPath(workspace), promptChars: prompt.length, prompt };
    }

    case 'parse-result': {
      const file = flagString(flags, 'file');
      const text = file ? readFileSync(path.resolve(file), 'utf8') : (flagString(flags, 'text') ?? rest.join(' '));
      const parsed = parseResultBlock(text);
      // A reply without a result block is a finding about the reply, not a
      // failure of this command.
      return { found: parsed.ok, status: parsed.status, reason: parsed.reason ?? null, result: parsed.result ?? null };
    }

    default:
      throw fail(ERROR_CODES.unknown_command, `Unknown command: ${command}`, {
        known: [
          'doctor',
          'preflight',
          'route',
          'start',
          'prompt',
          'steer',
          'review',
          'status',
          'wait',
          'cancel',
          'permission',
          'stop',
          'sessions',
          'cleanup',
          'bootstrap',
          'prompt-preview',
          'parse-result',
          'version',
        ],
      });
  }
}

/** Keep routine status polling small; `--full` preserves discovery payloads. */
function compactMeta(meta, full) {
  if (full || !meta || typeof meta !== 'object') return meta;
  const { availableModels, modes, ...compact } = meta;
  return {
    ...compact,
    availableModelsCount: Array.isArray(availableModels) ? availableModels.length : 0,
    modesAvailable: modes !== null && modes !== undefined,
  };
}

/**
 * @param {Record<string, any>} flags
 * @param {NodeJS.ProcessEnv} env
 * @param {string} stateDir
 */
async function resolveCallerState(flags, env, stateDir) {
  const parent = await parentProcessInfo();
  return resolveCaller({
    explicitCaller: flagString(flags, 'caller') ?? null,
    env,
    parentProcess: parent,
    routeKey: resolveRouteKey(stateDir),
  });
}

/**
 * Build the Codex `review/start` target from CLI flags.
 * @param {Record<string, any>} flags
 */
/**
 * What a reported stall should do. `report` keeps the turn alive and lets the
 * parent decide; `cancel` restores the old kill-on-silence behaviour for hosts
 * that cannot poll.
 * @param {Record<string, any>} flags
 */
/**
 * @param {string} workspace
 */
function assertWorkspace(workspace) {
  let stats;
  try {
    stats = statSync(workspace);
  } catch {
    throw fail(ERROR_CODES.usage, `Workspace does not exist: ${redactPath(workspace)}`, {
      workspace: redactPath(workspace),
    });
  }
  if (!stats.isDirectory()) {
    throw fail(ERROR_CODES.usage, `Workspace is not a directory: ${redactPath(workspace)}`, {
      workspace: redactPath(workspace),
    });
  }
}

function stallAction(flags) {
  const value = flagString(flags, 'stall-action') ?? 'report';
  if (value !== 'report' && value !== 'cancel') {
    throw fail(ERROR_CODES.usage, `--stall-action must be report or cancel, got ${value}`);
  }
  return value;
}

function reviewTarget(flags) {
  const target = flagString(flags, 'target') ?? 'uncommitted-changes';
  switch (target) {
    case 'uncommitted-changes':
      return { type: 'uncommittedChanges' };
    case 'base-branch': {
      const branch = flagString(flags, 'branch') ?? 'main';
      return { type: 'baseBranch', branch };
    }
    case 'commit': {
      const sha = flagString(flags, 'sha');
      if (!sha) throw fail(ERROR_CODES.usage, 'review --target commit requires --sha');
      return { type: 'commit', sha };
    }
    case 'custom': {
      const instructions = flagString(flags, 'instructions') ?? flagString(flags, 'task');
      if (!instructions) throw fail(ERROR_CODES.usage, 'review --target custom requires --instructions');
      return { type: 'custom', instructions };
    }
    default:
      throw fail(ERROR_CODES.usage, `Unknown review target ${target}`, {
        known: ['uncommitted-changes', 'base-branch', 'commit', 'custom'],
      });
  }
}

/**
 * @param {Record<string, any>} flags
 * @param {string} stateDir
 * @param {NodeJS.ProcessEnv} env
 */
async function commandRoute(flags, stateDir, env) {
  const role = requireFlag(flags, 'role');
  const callerState = await resolveCallerState(flags, env, stateDir);
  const inventory = await discoverAll({ stateDir, env });
  const allowedProviders = flagList(flags, 'allow-provider');
  const selection = routeSelect({
    role,
    pins: {
      agent: flagString(flags, 'agent') ?? null,
      model: flagString(flags, 'model') ?? null,
      effort: flagString(flags, 'effort') ?? null,
    },
    inventory,
    callerState,
    routeEvidence: loadRouteEvidence(stateDir),
    policy: {
      maxDepth: flagNumber(flags, 'max-depth', DEFAULT_MAX_DEPTH),
      allowRepeatBackend: flagBool(flags, 'allow-repeat-backend'),
      allowedProviders: allowedProviders.length > 0 ? allowedProviders : null,
      preferredProviders: flagList(flags, 'prefer-provider'),
      allowUnimplementedSession: flagBool(flags, 'allow-unimplemented'),
      avoidBackends: flagList(flags, 'avoid'),
    },
  });
  return { ...selection, caller: callerSummary(callerState) };
}

/**
 * @param {Record<string, any>} flags
 * @param {string} stateDir
 * @param {NodeJS.ProcessEnv} env
 */
async function commandStart(flags, stateDir, env) {
  const workspace = path.resolve(flagString(flags, 'workspace') ?? process.cwd());
  // Checked before anything is spawned: a backend started in a directory that
  // does not exist fails with ENOENT against the backend's own path, which
  // reads as "the CLI is missing" and sends the caller after the wrong problem.
  assertWorkspace(workspace);
  const callerState = await resolveCallerState(flags, env, stateDir);
  const role = flagString(flags, 'role') ?? null;

  let backend = flagString(flags, 'agent') ?? flagString(flags, 'backend') ?? null;
  let model = flagString(flags, 'model') ?? null;
  let effort = flagString(flags, 'effort') ?? null;
  let selection = null;

  if (!backend) {
    if (!role) throw fail(ERROR_CODES.usage, 'start requires --backend/--agent or --role');
    const inventory = await discoverAll({ stateDir, env });
    selection = routeSelect({
      role,
      pins: { agent: null, model, effort },
      inventory,
      callerState,
      routeEvidence: loadRouteEvidence(stateDir),
      policy: {
        maxDepth: flagNumber(flags, 'max-depth', DEFAULT_MAX_DEPTH),
        allowRepeatBackend: flagBool(flags, 'allow-repeat-backend'),
        preferredProviders: flagList(flags, 'prefer-provider'),
      },
    });
    backend = selection.selected.backend;
    model = selection.selected.model;
    effort = selection.selected.effort;
  }

  // Codex session policy: sandbox/approval flags are Codex-only, and passing
  // them for another backend fails explicitly rather than being ignored.
  const sandbox = flagString(flags, 'sandbox') ?? null;
  const approvalPolicy = flagString(flags, 'approval-policy') ?? null;
  /** @type {{sandbox?: string, approvalPolicy?: string}|null} */
  let codex = null;
  if (sandbox || approvalPolicy) {
    const entry = getBackend(backend);
    if (entry.id !== 'codex') {
      throw fail(ERROR_CODES.capability_unsupported, `--sandbox/--approval-policy apply to Codex sessions only`, {
        backend: entry.id,
      });
    }
    codex = {};
    if (sandbox) codex.sandbox = sandbox;
    if (approvalPolicy) codex.approvalPolicy = approvalPolicy;
  }
  const resume = /** @type {'auto'|'required'|'never'} */ (flagString(flags, 'resume') ?? 'auto');
  if (!['auto', 'required', 'never'].includes(resume)) {
    throw fail(ERROR_CODES.usage, `--resume must be auto, required or never`, { resume });
  }

  // Review roles default to the read-only profile: Codex maps that onto a
  // read-only sandbox with approvals off; for ACP backends it is part of the
  // session key and the role prompt already enforces read-only behaviour.
  const roleReadOnly = role === 'code-review' || role === 'security-review';
  const profile = flagString(flags, 'profile') ?? (roleReadOnly ? 'read-only' : 'default');

  const permissionMode = normalizePermissionMode(flagString(flags, 'permission-mode'));

  const routeId = newId();
  const envelope = childRouteEnvelope({ callerState, backend, routeId, routeKey: resolveRouteKey(stateDir) });
  const session = await startSession({
    stateDir,
    backend,
    workspace,
    model,
    effort,
    profile,
    permissionMode,
    role,
    codex,
    caller: callerSummary(callerState),
    route: { routeId, role, selection: selection?.selected ?? null },
    env: routeEnvelopeEnv(envelope),
    reuse: flagBool(flags, 'reuse', true),
    resume,
    idleTimeoutMs: flagNumber(flags, 'idle-timeout', 30 * 60 * 1000),
    startTimeoutMs: flagNumber(flags, 'start-timeout', 120000),
  });

  return {
    session: session.key,
    reused: session.reused,
    recovered: session.recovered === true,
    resume: session.resume ?? null,
    backend,
    workspace: redactPath(workspace),
    routeId,
    delegation: envelope,
    selection,
    meta: session.meta,
  };
}

/**
 * @param {Record<string, any>} flags
 * @param {string} stateDir
 * @param {NodeJS.ProcessEnv} env
 */
async function commandPrompt(flags, stateDir, env) {
  const key = requireFlag(flags, 'session');
  const role = flagString(flags, 'role') ?? null;
  const explicitText = flagString(flags, 'text');
  const task = flagString(flags, 'task');

  let text;
  let builtFor = null;
  if (explicitText) {
    text = explicitText;
  } else if (role && task) {
    const sessionMeta = storeFor(stateDir, key).readMeta();
    assertReviewPosture(role, sessionMeta);
    const explicitWorkspace = flagString(flags, 'workspace');
    const workspace = path.resolve(sessionMeta.workspace);
    if (explicitWorkspace && path.resolve(explicitWorkspace) !== workspace) {
      throw fail(ERROR_CODES.usage, '--workspace conflicts with the session workspace', {
        sessionWorkspace: redactPath(workspace),
        requestedWorkspace: redactPath(path.resolve(explicitWorkspace)),
      });
    }
    text = buildPrompt({
      role,
      task,
      workspace,
      scope: flagString(flags, 'scope') ?? null,
      checks: flagList(flags, 'check'),
      readOnly: flagBool(flags, 'read-only', role !== 'implementation'),
      context: flagString(flags, 'context') ?? null,
    });
    builtFor = { role, workspace: redactPath(workspace) };
  } else {
    throw fail(ERROR_CODES.usage, 'prompt requires --text, or --role with --task');
  }

  const submitted = await promptSession({
    stateDir,
    key,
    text,
    timeoutMs: flagNumber(flags, 'timeout', DEFAULT_TURN_TIMEOUT_MS),
    stallTimeoutMs: flagNumber(flags, 'stall-timeout', DEFAULT_TURN_STALL_MS),
    stallAction: stallAction(flags),
    metadata: builtFor,
  });
  return { session: key, ...submitted, builtFor, promptChars: text.length };
}

/**
 * Review roles run only where the session's recorded posture is read-only.
 * On Codex that posture is the negotiated sandbox — a `workspace-write`
 * session would let the reviewer edit files without a permission request
 * ever reaching the parent. ACP sessions always route writes through the
 * parent's permission channel, so the check is Codex-specific.
 * @param {string|null} role
 * @param {any} sessionMeta
 */
function assertReviewPosture(role, sessionMeta) {
  const reviewRole = role === 'code-review' || role === 'security-review';
  if (!reviewRole || sessionMeta?.backend !== 'codex') return;
  if (sessionMeta?.codex?.sandbox === 'read-only') return;
  throw fail(
    ERROR_CODES.role_posture_mismatch,
    `Role ${role} requires a read-only session posture; this codex session runs ` +
      `sandbox '${sessionMeta?.codex?.sandbox ?? 'unknown'}'. ` +
      `Start the session with --role ${role} or --sandbox read-only.`,
    { role, backend: sessionMeta?.backend, sandbox: sessionMeta?.codex?.sandbox ?? null },
  );
}

/** @param {any} callerState */
function callerSummary(callerState) {
  return {
    rootCaller: callerState.rootCaller,
    immediateParent: callerState.immediateParent,
    confidence: callerState.confidence,
    ambiguous: callerState.ambiguous === true,
    depth: callerState.depth,
    ancestry: callerState.ancestry,
    reason: callerState.reason,
  };
}
