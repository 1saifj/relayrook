import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
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
 *   note: string, reviewSafe: boolean, writesUnsupervised: boolean,
 *   requestedUnsupported: boolean, env: Record<string,string>, args: string[],
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
      reviewSafe: false,
      writesUnsupervised: isUngated(mode),
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
  // Enforcement follows the effective policy, never the mode's name. A
  // `read-only` mode pinned to `danger-full-access` keeps the mapped
  // `approvalPolicy: never`, so nothing sandboxes it and nothing asks — a
  // posture that must not be reported as `parent-gated`.
  const overridden = Boolean(entry.codex && input.codexOverrides && Object.keys(input.codexOverrides).length > 0);
  const derived = codex ? codexEnforcement(codex) : null;
  const enforcement = derived ? derived.enforcement : entry.enforcement;
  const note = derived && overridden ? derived.note : entry.note;
  // A sandbox that still lets the agent write inside the workspace without
  // asking is fine for implementation and wrong for a reviewer.
  const writesUnsupervised = derived ? derived.writesUnsupervised : isUngated(mode);

  return {
    mode,
    backend: input.backend,
    mechanism: table.mechanism,
    enforcement,
    note,
    // Whether this posture is fit for a read-only role: the mode must be
    // read-only and something other than the prompt must hold it.
    reviewSafe: mode === 'read-only' && enforcement !== 'prompt-only' && !writesUnsupervised,
    writesUnsupervised,
    requestedUnsupported: Boolean(entry.unsupported),
    env,
    args,
    codex,
    configFile,
  };
}

/**
 * What a Codex sandbox and approval policy actually enforce together.
 * @param {{sandbox?: string, approvalPolicy?: string}} codex
 */
export function codexEnforcement(codex) {
  const sandbox = codex.sandbox ?? 'workspace-write';
  const approvals = codex.approvalPolicy ?? 'on-request';
  const asks = approvals !== 'never';
  if (sandbox === 'read-only') {
    return {
      enforcement: 'backend-sandbox',
      writesUnsupervised: false,
      note: 'an OS-level sandbox denies every write, shell included',
    };
  }
  if (sandbox === 'workspace-write') {
    return asks
      ? {
          enforcement: 'parent-gated',
          writesUnsupervised: false,
          note: 'writes stay in the workspace; anything else asks the parent',
        }
      : {
          enforcement: 'backend-sandbox',
          writesUnsupervised: true,
          note: 'the sandbox bounds writes to the workspace; escapes fail instead of asking',
        };
  }
  return asks
    ? { enforcement: 'parent-gated', writesUnsupervised: false, note: 'no sandbox, but every action asks the parent' }
    : {
        enforcement: 'prompt-only',
        writesUnsupervised: true,
        note: 'no sandbox and no approvals: nothing constrains this session',
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
  // `git restore .` and `git checkout .` discard uncommitted work as surely as
  // a delete; `stash drop`, `branch -D` and `amend` rewrite it.
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+(--\s+)?[.*])/i,
  /\bgit\s+(restore\s|stash\s+(drop|clear)|branch\s+-D|commit\s+--amend|filter-branch|rebase)/i,
  /\b(gh|glab)\s+(pr|issue|release|repo|api|workflow|secret)\b/i,
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
  /(?:^|[\s|;&(])(curl|wget|nc|ssh|scp|rsync|gh|glab|aws|gcloud|az|kubectl|terraform|heroku|flyctl|vercel|netlify)\s/i,
  /\bgit\s+(clone|fetch|pull|push|remote\s+add)\b/i,
  /\b(npm|pnpm|yarn|pip|pip3|cargo|go|brew|apt|apt-get)\s+(i\b|install|add|get|publish|update|upgrade)/i,
];

/**
 * Commands an automated answerer may approve on its own.
 *
 * A blacklist cannot make "allow" safe: the command that discards a day of
 * work is always the one nobody thought to list. So anything that runs a shell
 * command is judged by this positive list instead, and every segment of a
 * compound command has to match.
 */
const ALLOWED_COMMANDS = [
  /^(ls|pwd|cat|head|tail|wc|file|stat|tree|du|df|env|date|whoami|basename|dirname|realpath)\b/i,
  /^(grep|rg|ag|find|fd|sed\s+-n|awk|cut|sort|uniq|tr|jq|yq|xargs\s+cat|nl|diff|cmp)\b/i,
  /^(printf|echo)\b/i,
  /^git\s+(status|diff|log|show|rev-parse|describe|ls-files|blame|shortlog|config\s+--get|branch\s*$|branch\s+(-l|--list))\b/i,
  /^(npm|pnpm|yarn)\s+(test|run\s+[\w:-]+|ls|why|exec\s+tsc)\b/i,
  /^node\s+(?!.*(-e|--eval|--input-type))\S+/i,
  /^(npx\s+tsc|tsc|eslint|prettier|vitest|jest|pytest|cargo\s+(test|check|clippy)|go\s+(test|vet|build))\b/i,
  /^cd\s+\S+$/i,
];

/**
 * Whether every segment of a compound command is on the allowlist.
 * @param {string} command
 */
export function isAllowlistedCommand(command) {
  const text = String(command ?? '').trim();
  if (text === '') return false;
  // Substitution and redirection hide a second command inside the first.
  if (/[`$][({]|>>?\s*\S|<\s*\S|<<|\beval\b/.test(text)) return false;
  const segments = text
    .split(/\|\||&&|[;|&\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  if (segments.length === 0) return false;
  return segments.every((segment) => ALLOWED_COMMANDS.some((re) => re.test(segment)));
}

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
  const base = path.resolve(String(workspace));
  const variants = new Set([base]);
  try {
    variants.add(realpathSync(base));
  } catch {
    // The workspace may not exist yet; the literal path is still a prefix.
  }
  for (const variant of [...variants]) {
    if (variant.startsWith('/private/')) variants.add(variant.slice('/private'.length));
    else if (variant.startsWith('/')) variants.add(`/private${variant}`);
  }
  return [...variants];
}

/** A Windows absolute path (`C:\\...`, `\\\\server\\share`) written on any platform. */
function isWindowsAbsolute(candidate) {
  return /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\');
}

/**
 * Decide whether one path named by a request lands outside the workspace.
 *
 * Every candidate is resolved against the workspace before comparison, so
 * `../outside.txt` and `/ws/../outside.txt` are escapes rather than "not
 * absolute, therefore fine". A Windows absolute path is an escape whenever the
 * workspace is not itself on that drive, because this process cannot
 * meaningfully compare the two.
 * @param {string} candidate
 * @param {string[]} prefixes
 */
function escapesWorkspace(candidate, prefixes) {
  if (prefixes.length === 0) return candidate.startsWith('/') || isWindowsAbsolute(candidate);
  if (isWindowsAbsolute(candidate)) {
    const normalized = candidate.replace(/\\/g, '/');
    return !prefixes.some((prefix) => {
      const p = prefix.replace(/\\/g, '/');
      return normalized === p || normalized.toLowerCase().startsWith(`${p.toLowerCase()}/`);
    });
  }
  return prefixes.every((prefix) => {
    const resolved = path.resolve(prefix, candidate.replace(/^~(?=\/|$)/, homedir()));
    const relative = path.relative(prefix, resolved);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  });
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
  const kind = String(toolCall.kind ?? '').toLowerCase();
  // Kiro and OpenCode write the command into the title ("Running: npm test",
  // or the bare command); Devin and Codex put it in structured fields. Reading
  // only the structured ones leaves the title-carrying backends unjudgeable,
  // which reads as "not allowlisted" for every command they send.
  const titleCommand =
    kind === 'execute' || /^(running|run|execute|executing|command)\b/i.test(title)
      ? title.replace(/^(running|run|execute|executing|command)\s*:?\s*/i, '')
      : '';
  const command = firstString([
    toolCall.rawInput?.command,
    meta['cognition.ai/editableCommand'],
    ...contentTexts(toolCall.content),
    titleCommand,
  ]);
  const declaredPaths = [
    ...(Array.isArray(toolCall.locations) ? toolCall.locations.map((location) => location?.path) : []),
    toolCall.rawInput?.file_path,
    toolCall.rawInput?.path,
    toolCall.rawInput?.abs_path,
  ].filter((value) => typeof value === 'string' && value !== '');
  const optionText = (request?.options ?? []).map((option) => String(option?.name ?? '')).join(' ');

  const kindRaw = kind;
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
  const outsideWorkspace = paths.some((candidate) => escapesWorkspace(candidate, prefixes));
  const destructive = DESTRUCTIVE_PATTERNS.some((re) => re.test(commandEvidence));
  const network = action === 'network' || NETWORK_PATTERNS.some((re) => re.test(commandEvidence));
  const touchesSecrets = SECRET_PATTERNS.some((re) => re.test(commandEvidence));
  const identified = command !== '' || declaredPaths.length > 0 || title !== '';
  // An execute request is only ever *recommended* when its command is on the
  // positive list; everything else is judged by the caller.
  const allowlisted = command === '' ? action !== 'execute' : isAllowlistedCommand(command);

  /** @type {string[]} */
  const reasons = [];
  if (destructive) reasons.push('the command is destructive or irreversible');
  if (network) reasons.push('the action leaves this machine');
  if (touchesSecrets) reasons.push('the target looks like a credential');
  if (outsideWorkspace) reasons.push('a path outside the workspace is involved');
  if (!identified) reasons.push('the request names no command, file or title to judge');
  if (action === 'execute' && !allowlisted) reasons.push('the command is not one an automated answerer may approve');

  return {
    action,
    command: command || null,
    allowlisted,
    paths,
    outsideWorkspace,
    destructive,
    network,
    touchesSecrets,
    recommendation: reasons.length === 0 ? 'allow' : 'ask-user',
    reasons,
  };
}
