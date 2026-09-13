import { fail, ERROR_CODES } from './errors.mjs';

/**
 * Backend registry.
 *
 * Launch command lines come from `docs/research.md` §2 (observed entrypoints).
 * `metadataStyle` records the difference the research called out as material:
 * Kiro returns legacy `models.currentModelId` / `availableModels`, while Devin,
 * Claude and OpenCode return `configOptions`.
 *
 * @typedef {'acp'|'app-server'} BackendKind
 * @typedef {'configOptions'|'models'|'native'} MetadataStyle
 * @typedef {'launch-flag'|'set_config_option'|'turn-parameter'} ModelSelection
 */

/** @type {Record<string, any>} */
const REGISTRY = {
  devin: {
    id: 'devin',
    label: 'Devin',
    kind: 'acp',
    command: 'devin',
    args: ['acp'],
    versionArgs: ['--version'],
    adapter: 'native',
    sessionSupport: 'implemented',
    metadataStyle: 'configOptions',
    modelSelection: 'launch-flag',
    modelFlag: '--model',
    effortFlag: null,
    // docs/research.md: "Preserve the Devin SWE-2 Max pin". Fixed unless the
    // caller passes --model explicitly; never substituted silently.
    defaultModel: 'swe-2-max',
    modelPinPolicy: 'fixed-default',
    effortReadback: false,
    provider: 'devin',
    modelFamily: 'devin',
    billingRoute: 'devin-subscription',
    notes: 'Native ACP. Pinned to swe-2-max by default.',
  },
  kiro: {
    id: 'kiro',
    label: 'Kiro',
    kind: 'acp',
    command: 'kiro-cli',
    args: ['acp'],
    versionArgs: ['--version'],
    adapter: 'native',
    sessionSupport: 'implemented',
    // Legacy metadata shape: session/new returns `models`, not `configOptions`.
    metadataStyle: 'models',
    modelSelection: 'launch-flag',
    modelFlag: '--model',
    effortFlag: '--effort',
    defaultModel: null,
    modelPinPolicy: 'caller-choice',
    // The session response omits effort; `_kiro.dev/metadata` reports it later.
    effortReadback: true,
    provider: 'kiro',
    modelFamily: 'anthropic',
    billingRoute: 'kiro-subscription',
    notes: 'Native ACP with legacy models metadata. Effort is verified from a vendor notification.',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    kind: 'acp',
    command: 'opencode',
    args: ['acp'],
    versionArgs: ['--version'],
    adapter: 'native',
    sessionSupport: 'implemented',
    metadataStyle: 'configOptions',
    // A new ACP session picked a different default from the global config, so
    // the model is always selected and read back explicitly.
    modelSelection: 'set_config_option',
    modelConfigId: 'model',
    modelFlag: null,
    effortFlag: null,
    defaultModel: null,
    modelPinPolicy: 'caller-choice',
    effortReadback: true,
    provider: 'opencode',
    modelFamily: 'opencode',
    billingRoute: 'opencode-subscription',
    notes: 'Native ACP. opencode-go/<model> IDs stay inside the authenticated OpenCode client.',
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    kind: 'acp',
    // Provided by the pinned adapter package, not by the base `claude` CLI.
    command: 'claude-agent-acp',
    args: [],
    versionArgs: ['--version'],
    adapter: 'npm-package',
    adapterPackage: '@agentclientprotocol/claude-agent-acp',
    adapterVersion: '0.76.0',
    hostCommand: 'claude',
    hostVersionArgs: ['--version'],
    sessionSupport: 'implemented',
    metadataStyle: 'configOptions',
    modelSelection: 'set_config_option',
    modelConfigId: 'model',
    modelFlag: null,
    effortFlag: null,
    defaultModel: null,
    modelPinPolicy: 'caller-choice',
    effortReadback: true,
    provider: 'anthropic',
    modelFamily: 'anthropic',
    billingRoute: 'claude-subscription',
    notes: 'Requires the pinned ACP adapter package; run `relayrook bootstrap --backend claude`.',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    kind: 'app-server',
    command: 'codex',
    args: ['app-server', '--stdio'],
    versionArgs: ['--version'],
    adapter: 'native-app-server',
    // v0.1 implements discovery only (initialize, model/list, account/read).
    // Turn control (thread/start, turn/start, turn/steer, turn/interrupt,
    // review/start) is NOT implemented and must not be advertised as working.
    sessionSupport: 'not-implemented',
    sessionSupportReason:
      'v0.1 implements Codex app-server discovery only (initialize, model/list, account/read).' +
      ' Thread and turn control are not implemented.',
    metadataStyle: 'native',
    modelSelection: 'turn-parameter',
    modelFlag: null,
    effortFlag: null,
    defaultModel: null,
    modelPinPolicy: 'caller-choice',
    effortReadback: false,
    provider: 'openai',
    modelFamily: 'openai',
    billingRoute: 'chatgpt-subscription',
    notes: 'Discovery only in v0.1. Not eligible for delegation routes.',
  },
};

export const BACKEND_IDS = Object.freeze(Object.keys(REGISTRY));

/** @param {string} id */
export function getBackend(id) {
  const backend = REGISTRY[id];
  if (!backend) {
    throw fail(ERROR_CODES.unknown_backend, `Unknown backend: ${id}`, { known: BACKEND_IDS });
  }
  return backend;
}

/** @param {string} id */
export function hasBackend(id) {
  return Object.hasOwn(REGISTRY, id);
}

export function allBackends() {
  return BACKEND_IDS.map((id) => REGISTRY[id]);
}

/**
 * Build the launch argv for an ACP backend, applying launch-flag model/effort
 * selection where the CLI supports it.
 * @param {any} backend
 * @param {{model?: string|null, effort?: string|null, extraArgs?: string[]}} spec
 */
export function buildLaunchArgs(backend, spec = {}) {
  const args = [...backend.args];
  const model = spec.model ?? backend.defaultModel ?? null;
  if (model && backend.modelSelection === 'launch-flag' && backend.modelFlag) {
    args.push(backend.modelFlag, model);
  }
  if (spec.effort && backend.effortFlag) {
    args.push(backend.effortFlag, spec.effort);
  }
  if (spec.extraArgs?.length) args.push(...spec.extraArgs);
  return args;
}

/**
 * Resolve the model this backend should run with, honouring an explicit pin.
 *
 * Returns the source so callers can prove nothing was substituted: `pin` means
 * the caller asked for it, `backend-default` means the registry's fixed default
 * (Devin's swe-2-max), `unset` means the backend decides and we read it back.
 * @param {any} backend
 * @param {string|null|undefined} pinnedModel
 */
export function resolveModel(backend, pinnedModel) {
  if (pinnedModel) return { model: pinnedModel, source: 'pin' };
  if (backend.defaultModel) return { model: backend.defaultModel, source: 'backend-default' };
  return { model: null, source: 'unset' };
}

/**
 * Read the current model out of a `session/new` result, handling both the
 * legacy `models` shape and the newer `configOptions` shape.
 * @param {any} backend
 * @param {any} sessionResult
 */
export function readModelMetadata(backend, sessionResult) {
  const result = sessionResult ?? {};
  if (result.models && typeof result.models === 'object') {
    const available = Array.isArray(result.models.availableModels) ? result.models.availableModels : [];
    return {
      metadataStyle: 'models',
      currentModel: result.models.currentModelId ?? null,
      availableModels: available.map((m) => ({
        id: m.modelId ?? m.id ?? null,
        name: m.name ?? m.modelId ?? null,
        description: m.description ?? null,
      })),
      configId: null,
    };
  }
  const option = findConfigOption(result.configOptions, 'model', [/^model$/i]);
  if (option) {
    const options = Array.isArray(option.options) ? option.options : [];
    return {
      metadataStyle: 'configOptions',
      currentModel: option.currentValue ?? null,
      availableModels: options.map((o) => ({
        id: o.value ?? o.id ?? null,
        name: o.name ?? o.value ?? null,
        description: o.description ?? null,
      })),
      configId: option.id ?? 'model',
    };
  }
  return { metadataStyle: backend.metadataStyle, currentModel: null, availableModels: [], configId: null };
}

/**
 * Locate a config option by category, falling back to id patterns. Backends do
 * not agree on the id for reasoning effort, so we discover it instead of
 * hard-coding one agent's spelling.
 * @param {any[]|undefined} configOptions
 * @param {string|null} category
 * @param {RegExp[]} idPatterns
 */
export function findConfigOption(configOptions, category, idPatterns) {
  if (!Array.isArray(configOptions)) return null;
  if (category) {
    const byCategory = configOptions.find((o) => o && o.category === category);
    if (byCategory) return byCategory;
  }
  for (const pattern of idPatterns) {
    const match = configOptions.find((o) => o && typeof o.id === 'string' && pattern.test(o.id));
    if (match) return match;
  }
  return null;
}

export const EFFORT_OPTION_PATTERNS = Object.freeze([/effort/i, /thought/i, /thinking/i, /reasoning/i]);

/**
 * Read the effort option out of a session result, if the backend exposes one.
 * @param {any} sessionResult
 */
export function readEffortMetadata(sessionResult) {
  const option = findConfigOption(sessionResult?.configOptions, 'thought_level', [...EFFORT_OPTION_PATTERNS]);
  if (!option) return { configId: null, currentEffort: null, availableEfforts: [] };
  const options = Array.isArray(option.options) ? option.options : [];
  return {
    configId: option.id ?? null,
    currentEffort: option.currentValue ?? null,
    availableEfforts: options.map((o) => o.value ?? o.id).filter(Boolean),
  };
}
