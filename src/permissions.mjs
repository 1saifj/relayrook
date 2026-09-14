import { realpathSync } from 'node:fs';
import path from 'node:path';

import { fail, ERROR_CODES } from './errors.mjs';

/**
 * Permission posture: how much a delegated agent may do before it has to ask.
 *
 * Every supported CLI has its own permission system, and they do not agree on
 * names, granularity or defaults. RelayRook maps one vocabulary onto each of
 * them and — this is the part that matters — reports which mechanism actually
 * carried the posture, so a caller is never told a session is read-only when
 * nothing but a prompt says so.
 */
export const PERMISSION_MODES = Object.freeze(['read-only', 'gated', 'auto-edits', 'full-auto']);

/**
 * How a posture is held:
 *
 * - `backend-sandbox`: the backend itself refuses the action, whichever tool
 *   asks. In practice this means an OS-level sandbox — Codex's — because
 *   withholding an edit tool is not the same thing: an agent denied its edit
 *   tool will reach for the shell, and RelayRook has watched OpenCode do
 *   exactly that (`cat > file <<'EOF'` after `edit: deny`).
 * - `parent-gated`: the action reaches the parent as a permission request and
 *   cannot proceed until the parent answers. Safe, but it costs a round trip
 *   per action and depends on the parent answering honestly.
 * - `prompt-only`: nothing but the role prompt discourages it. Reported so a
 *   caller can decide whether that is good enough.
 */
export const ENFORCEMENT = Object.freeze(['backend-sandbox', 'parent-gated', 'prompt-only']);

/** Modes that let the agent act on the workspace without asking. */
const UNGATED = new Set(['auto-edits', 'full-auto']);

/**
 * Per-backend mapping. Each mode yields the launch changes RelayRook makes and
 * an honest enforcement claim.
 *
 * Sources are the installed CLIs' own interfaces: `devin --help`
 * (`--permission-mode`, `DEVIN_PERMISSION_MODE`) and `devin acp --help`
 * (`--agent-type review`); `kiro-cli acp --help` (`--trust-all-tools`,
 * `--trust-tools`); OpenCode's config `permission` block loaded through
 * `OPENCODE_CONFIG`; `ACP_PERMISSION_MODE` for the pinned Claude adapter; and
 * the Codex app-server sandbox and approval policies.
 */
const BACKEND_POSTURES = Object.freeze({
  devin: {
    mechanism: 'DEVIN_PERMISSION_MODE + devin acp --agent-type',
    modes: {
      'read-only': {
        // The review agent has read-only plus shell tools, so the edit tool is
        // gone but the shell is not: a write attempt becomes a command the
        // parent must approve.
        args: ['--agent-type', 'review'],
        env: { DEVIN_PERMISSION_MODE: 'auto' },
        enforcement: 'parent-gated',
        note: 'the review agent has no edit tool; it keeps shell tools, so a write through the shell asks the parent',
      },
      gated: {
        env: { DEVIN_PERMISSION_MODE: 'auto' },
        enforcement: 'parent-gated',
        note: 'auto approves read-only tools; edits and commands ask, and the ask reaches the parent',
      },
      'auto-edits': {
        env: { DEVIN_PERMISSION_MODE: 'accept-edits' },
        enforcement: 'parent-gated',
        note: 'workspace edits are auto-approved; commands still ask',
      },
      'full-auto': {
        env: { DEVIN_PERMISSION_MODE: 'dangerous' },
        enforcement: 'prompt-only',
        note: 'dangerous auto-approves every tool; nothing reaches the parent',
      },
    },
  },
  kiro: {
    mechanism: 'kiro-cli acp --trust-all-tools',
    modes: {
      'read-only': { enforcement: 'parent-gated', note: 'no native read-only agent; every write asks the parent' },
      gated: { enforcement: 'parent-gated', note: 'default: every tool asks the parent' },
      'auto-edits': {
        enforcement: 'parent-gated',
        note: 'Kiro trusts tools by name, not by category; edits keep asking the parent',
        unsupported: true,
      },
      'full-auto': {
        args: ['--trust-all-tools'],
        enforcement: 'prompt-only',
        note: 'trust-all-tools auto-approves every request; nothing reaches the parent',
      },
    },
  },
  opencode: {
    mechanism: 'OPENCODE_CONFIG permission rules',
    modes: {
      'read-only': {
        config: { edit: 'deny', bash: 'ask', webfetch: 'deny' },
        enforcement: 'parent-gated',
        note:
          'edit and webfetch are denied outright; observed live, the agent then writes through bash, which asks the parent',
      },
      gated: {
        config: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
        enforcement: 'parent-gated',
        note: 'every edit, command and fetch asks the parent',
      },
      'auto-edits': {
        config: { edit: 'allow', bash: 'ask', webfetch: 'ask' },
        enforcement: 'parent-gated',
        note: 'edits are allowed outright; commands and fetches ask the parent',
      },
      'full-auto': {
        config: { edit: 'allow', bash: 'allow', webfetch: 'allow' },
        enforcement: 'prompt-only',
        note: 'every tool is allowed; nothing reaches the parent',
      },
    },
  },
  claude: {
    mechanism: 'ACP_PERMISSION_MODE',
    modes: {
      'read-only': {
        env: { ACP_PERMISSION_MODE: 'plan' },
        enforcement: 'parent-gated',
        note: 'plan mode withholds the edit tools; it is not a sandbox, so shell activity still asks the parent',
      },
      gated: { env: { ACP_PERMISSION_MODE: 'default' }, enforcement: 'parent-gated', note: 'file operations ask the parent' },
      'auto-edits': {
        env: { ACP_PERMISSION_MODE: 'acceptEdits' },
        enforcement: 'parent-gated',
        note: 'file edits are auto-accepted; other operations ask the parent',
      },
      'full-auto': {
        env: { ACP_PERMISSION_MODE: 'bypassPermissions' },
        enforcement: 'prompt-only',
        note: 'bypassPermissions skips every check; nothing reaches the parent',
      },
    },
  },
  codex: {
    mechanism: 'app-server sandbox + approval policy',
    modes: {
      'read-only': {
        codex: { sandbox: 'read-only', approvalPolicy: 'never' },
        enforcement: 'backend-sandbox',
        note: 'an OS-level sandbox denies every write, shell included, rather than asking',
      },
      gated: {
        codex: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
        enforcement: 'parent-gated',
        note: 'writes stay inside the workspace; anything else asks the parent',
      },
      'auto-edits': {
        codex: { sandbox: 'workspace-write', approvalPolicy: 'never' },
        enforcement: 'backend-sandbox',
        note: 'the sandbox bounds the damage; escapes fail instead of asking',
      },
      'full-auto': {
        codex: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
        enforcement: 'prompt-only',
        note: 'no sandbox and no approvals',
      },
    },
  },
});

/**
 * The mode a role implies when the caller did not pick one. Reviews are
 * read-only; implementation is gated, because an unattended write loop is the
 * one thing a delegating agent cannot take back.
 * @param {{role?: string|null, profile?: string|null}} input
 */
export function defaultPermissionMode(input = {}) {
  if (input.profile === 'read-only') return 'read-only';
  if (input.role === 'code-review' || input.role === 'security-review') return 'read-only';
  return 'gated';
}

/** @param {string|null|undefined} mode */
export function normalizePermissionMode(mode) {
  if (mode === undefined || mode === null || mode === '') return null;
  const value = String(mode);
  if (!PERMISSION_MODES.includes(value)) {
    throw fail(ERROR_CODES.usage, `--permission-mode must be one of ${PERMISSION_MODES.join(', ')}`, { mode: value });
  }
  return value;
}

/**
 * Resolve the posture for one session.
 *
 * @param {{backend: string, mode: string, sessionDir?: string|null,
 *   codexOverrides?: {sandbox?: string, approvalPolicy?: string}|null}} input
 * @returns {{mode: string, backend: string, mechanism: string, enforcement: string,
 *   note: string, requestedUnsupported: boolean, env: Record<string,string>, args: string[],
 *   codex: {sandbox?: string, approvalPolicy?: string}|null,
 *   configFile: {path: string, contents: string}|null}}
 */
export function resolvePermissionPosture(input) {
  const mode = normalizePermissionMode(input.mode) ?? 'gated';
  const table = BACKEND_POSTURES[input.backend];
  if (!table) {
    return {
      mode,
      backend: input.backend,
      mechanism: 'none',
      enforcement: 'prompt-only',
      note: 'RelayRook knows no permission mechanism for this backend',
      requestedUnsupported: false,
      env: {},
      args: [],
      codex: null,
      configFile: null,
    };
  }
  const entry = table.modes[mode];
  /** @type {Record<string, string>} */
  const env = { ...(entry.env ?? {}) };
  /** @type {string[]} */
  const args = [...(entry.args ?? [])];
  let configFile = null;

  if (entry.config && input.sessionDir) {
    const file = path.join(input.sessionDir, 'opencode-permission.json');
    configFile = {
      path: file,
      contents: `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: entry.config }, null, 2)}\n`,
    };
    env.OPENCODE_CONFIG = file;
  }

  const codex = entry.codex ? { ...entry.codex, ...(input.codexOverrides ?? {}) } : null;
  // A caller that pins its own sandbox or approval policy has overridden the
  // posture, so the enforcement claim must not keep describing the mapping.
  const overridden = Boolean(entry.codex && input.codexOverrides && Object.keys(input.codexOverrides).length > 0);

  return {
    mode,
    backend: input.backend,
    mechanism: table.mechanism,
    enforcement: overridden ? 'parent-gated' : entry.enforcement,
    note: overridden ? 'caller pinned the sandbox or approval policy explicitly' : entry.note,
    requestedUnsupported: Boolean(entry.unsupported),
    env,
    args,
    codex,
    configFile,
  };
}

/**
 * Whether a posture lets the delegated agent change the workspace without the
 * parent seeing a request. Used to refuse a read-only role running ungated.
 * @param {string} mode
 */
export function isUngated(mode) {
  return UNGATED.has(mode);
}

/** Commands whose blast radius is larger than the task that asked for them. */
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.)/i,
  /\bsudo\b/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /\b(mkfs|dd\s+if=|shutdown|reboot|killall)\b/i,
  /\bnpm\s+(publish|unpublish)\b/i,
  /\bdocker\s+(rm|rmi|system\s+prune)\b/i,
  /\bdrop\s+(table|database)\b/i,
  />\s*\/(?:etc|usr|bin|dev)\b/i,
];

/** Commands that leave the machine. */
const NETWORK_PATTERNS = [
  // Anchored as a command, so `~/.ssh/id_rsa` is a credential path rather than
  // a network call.
  /(?:^|[\s|;&(])(curl|wget|nc|ssh|scp|rsync)\s/i,
  /\bgit\s+(clone|fetch|pull|push|remote\s+add)\b/i,
  /\b(npm|pnpm|yarn|pip|pip3|cargo|go|brew|apt|apt-get)\s+(i\b|install|add|get|publish|update|upgrade)/i,
];

/** Where a credential usually lives. */
const SECRET_PATTERNS = [
  /\.env\b/i,
  /\bid_rsa\b/i,
  /\.ssh\//i,
  /\bcredentials?\b/i,
  /\.netrc\b/i,
  /\bsecrets?\.(json|ya?ml|toml)\b/i,
];

/**
 * Pull plausible filesystem paths out of a rendered command or title. This is
 * evidence for a decision, not a parser: anything it misses falls into the
 * conservative branch below.
 * @param {string} text
 */
function extractPaths(text) {
  const matches = text.match(/(?:^|[\s'"=(])((?:~|\.{1,2})?\/[^\s'";:|&)]+|[\w.-]+\/[^\s'";:|&)]+)/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/^[\s'"=(]+/, '').replace(/[.,;:]+$/, '')))].slice(0, 20);
}

/** @param {any[]} candidates */
function firstString(candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}

/**
 * Text carried inside an ACP tool call's content blocks — where several agents
 * put the shell command they are asking about.
 * @param {any} content
 */
function contentTexts(content) {
  if (!Array.isArray(content)) return [];
  /** @type {string[]} */
  const out = [];
  for (const block of content) {
    const inner = block?.content ?? block;
    if (typeof inner?.text === 'string') out.push(inner.text);
    if (typeof inner?.resource?.text === 'string') out.push(inner.resource.text);
  }
  return out;
}

/**
 * Prefixes that count as "inside the workspace". macOS resolves `/tmp` to
 * `/private/tmp`, and agents report the resolved path, so a naive prefix test
 * calls every request in a temp workspace an escape.
 * @param {string|null|undefined} workspace
 */
function workspacePrefixes(workspace) {
  if (!workspace) return [];
  const base = String(workspace).replace(/\/+$/, '');
  const variants = new Set([base]);
  try {
    variants.add(realpathSync(base));
  } catch {
    // The workspace may not exist yet; the literal path is still a prefix.
  }
  for (const variant of [...variants]) {
    if (variant.startsWith('/private/')) variants.add(variant.slice('/private'.length));
    else variants.add(`/private${variant}`);
  }
  return [...variants];
}

/**
 * Describe one permission request so the parent decides on evidence rather
 * than on a title.
 *
 * Backends disagree on where the action is written down: OpenCode and Kiro put
 * the command in `title`, Devin leaves `title` null and carries it in
 * `_meta["cognition.ai/editableCommand"]`, and option names sometimes name it
 * too. All of that is read as evidence.
 *
 * The recommendation is deliberately timid: `allow` only for work that stays
 * inside the workspace and carries no destructive, networked or credential
 * signal. Everything else is `ask-user`, including anything this function did
 * not understand. It never recommends an option the agent did not advertise.
 *
 * @param {{requestId?: string, toolCall?: any, options?: any[]}} request
 * @param {{workspace?: string|null}} [context]
 */
export function classifyPermissionRequest(request, context = {}) {
  const toolCall = request?.toolCall ?? {};
  const meta = toolCall._meta ?? {};
  const title = String(toolCall.title ?? '');
  const command = firstString([
    toolCall.rawInput?.command,
    meta['cognition.ai/editableCommand'],
    ...contentTexts(toolCall.content),
  ]);
  const declaredPaths = [
    ...(Array.isArray(toolCall.locations) ? toolCall.locations.map((location) => location?.path) : []),
    toolCall.rawInput?.file_path,
    toolCall.rawInput?.path,
    toolCall.rawInput?.abs_path,
  ].filter((value) => typeof value === 'string' && value !== '');
  const optionText = (request?.options ?? []).map((option) => String(option?.name ?? '')).join(' ');

  const kindRaw = String(toolCall.kind ?? '').toLowerCase();
  const action =
    kindRaw === 'edit' || /\b(edit|write|create|patch|apply)\b/i.test(title)
      ? 'edit'
      : kindRaw === 'execute' || command !== '' || /\b(run|execute|bash|shell|command)\b/i.test(title)
        ? 'execute'
        : kindRaw === 'read' || /\b(read|open|cat|view)\b/i.test(title)
          ? 'read'
          : kindRaw === 'fetch' || /\b(fetch|http|url)\b/i.test(title)
            ? 'network'
            : 'other';

  // Option names describe the action but are not paths: an agent's phrasing
  // must never widen what counts as "inside the workspace".
  const commandEvidence = `${title} ${command} ${JSON.stringify(toolCall.rawInput ?? '')} ${optionText}`;
  const paths = [...new Set([...declaredPaths, ...extractPaths(`${command} ${title} ${declaredPaths.join(' ')}`)])];
  const prefixes = workspacePrefixes(context.workspace);
  const outsideWorkspace = paths.some((candidate) => {
    if (!candidate.startsWith('/')) return false;
    if (prefixes.length === 0) return true;
    return !prefixes.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`));
  });
  const destructive = DESTRUCTIVE_PATTERNS.some((re) => re.test(commandEvidence));
  const network = action === 'network' || NETWORK_PATTERNS.some((re) => re.test(commandEvidence));
  const touchesSecrets = SECRET_PATTERNS.some((re) => re.test(commandEvidence));
  const identified = command !== '' || declaredPaths.length > 0 || title !== '';

  /** @type {string[]} */
  const reasons = [];
  if (destructive) reasons.push('the command is destructive or irreversible');
  if (network) reasons.push('the action leaves this machine');
  if (touchesSecrets) reasons.push('the target looks like a credential');
  if (outsideWorkspace) reasons.push('a path outside the workspace is involved');
  if (!identified) reasons.push('the request names no command, file or title to judge');

  return {
    action,
    command: command || null,
    paths,
    outsideWorkspace,
    destructive,
    network,
    touchesSecrets,
    recommendation: reasons.length === 0 ? 'allow' : 'ask-user',
    reasons,
  };
}
