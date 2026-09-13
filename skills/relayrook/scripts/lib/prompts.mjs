import { assertRole } from './routing.mjs';

/**
 * Role prompt construction.
 *
 * Reviews are read-only by default: the delegated agent is told not to modify
 * the workspace, and security review additionally has to supply prerequisites,
 * attacker control, trust boundary and a safe verification method for every
 * finding. "No findings" must come back as a distinct outcome from an
 * incomplete review, so the result envelope carries an explicit status.
 */

export const RESULT_FENCE = 'relayrook-result';

export const REVIEW_STATUSES = Object.freeze(['complete-no-findings', 'complete-with-findings', 'incomplete']);

const SHARED_RESULT_CONTRACT = [
  `End your reply with a fenced \`${RESULT_FENCE}\` block containing JSON.`,
  'Use status "complete-no-findings" only when you examined the whole requested scope and found nothing.',
  'Use status "incomplete" when anything blocked you (missing files, unreadable code, denied permission,' +
    ' truncated context) and say what was not covered.',
].join(' ');

const READ_ONLY_CLAUSE = [
  'This is a read-only task. Do not edit, create, move or delete any file.',
  'Do not run commands that mutate the workspace, install packages, or reach the network.',
  'Read-only inspection commands are fine.',
].join(' ');

/**
 * @param {{
 *   role: string,
 *   task: string,
 *   workspace: string,
 *   scope?: string|null,
 *   checks?: string[],
 *   readOnly?: boolean,
 *   context?: string|null,
 * }} input
 */
export function buildPrompt(input) {
  const role = assertRole(input.role);
  switch (role) {
    case 'implementation':
      return buildImplementationPrompt(input);
    case 'code-review':
      return buildCodeReviewPrompt(input);
    case 'security-review':
      return buildSecurityReviewPrompt(input);
    default:
      throw new Error(`unreachable role ${role}`);
  }
}

/** @param {any} input */
function buildImplementationPrompt(input) {
  const sections = [
    'You are completing an implementation task delegated through RelayRook.',
    `Workspace: ${input.workspace}`,
    input.scope ? `Scope: ${input.scope}` : null,
    '',
    'Task:',
    input.task,
    '',
    input.context ? `Additional context:\n${input.context}\n` : null,
    'Requirements:',
    '- Stay inside the workspace and keep the change minimal and focused.',
    '- Preserve unrelated modifications already present in the working tree.',
    checksLine(input.checks),
    '- Report the diff you produced, the commands you ran, and their real output.',
    '- If you could not finish, say exactly what is incomplete and why. Do not claim success you did not verify.',
    '',
    SHARED_RESULT_CONTRACT,
    resultSchemaBlock('implementation'),
  ];
  return sections.filter((line) => line !== null).join('\n');
}

/** @param {any} input */
function buildCodeReviewPrompt(input) {
  const sections = [
    'You are performing an independent code review delegated through RelayRook.',
    `Workspace: ${input.workspace}`,
    input.scope ? `Review scope: ${input.scope}` : null,
    '',
    'Review request:',
    input.task,
    '',
    input.context ? `Additional context:\n${input.context}\n` : null,
    input.readOnly === false ? null : READ_ONLY_CLAUSE,
    '',
    'For every finding report: path, line, severity, trigger, consequence, evidence, and a suggested correction.',
    '- Severity is one of: critical, high, medium, low.',
    '- Trigger is the concrete input or state that reaches the defect.',
    '- Consequence is what the user or system observes when it happens.',
    '- Evidence is the code you actually read, quoted or cited by path and line.',
    '- Do not report style preferences as defects, and do not invent line numbers.',
    '',
    SHARED_RESULT_CONTRACT,
    resultSchemaBlock('code-review'),
  ];
  return sections.filter((line) => line !== null).join('\n');
}

/** @param {any} input */
function buildSecurityReviewPrompt(input) {
  const sections = [
    'You are performing a defensive security review delegated through RelayRook.',
    `Workspace: ${input.workspace}`,
    input.scope ? `Review scope: ${input.scope}` : null,
    '',
    'Review request:',
    input.task,
    '',
    input.context ? `Additional context:\n${input.context}\n` : null,
    input.readOnly === false ? null : READ_ONLY_CLAUSE,
    'Do not exploit anything, do not attack any live system, and do not exfiltrate data.',
    '',
    'For every finding report all of:',
    '- path and line',
    '- severity (critical, high, medium, low)',
    '- prerequisites: what must already be true for this to be reachable',
    '- attackerControl: exactly which input or state an attacker controls',
    '- trustBoundary: the boundary being crossed',
    '- consequence: the concrete impact if exploited',
    '- evidence: reproducible evidence from the code you read, cited by path and line',
    '- safeVerification: a non-destructive way the maintainer can confirm it locally',
    '- suggestedCorrection',
    '',
    'Do not report a finding you could not trace to reachable code. If a pattern looks dangerous but is' +
      ' unreachable or already mitigated, say so instead of filing it.',
    'Report a defect you are unsure about as low severity with your uncertainty stated, not as a confident critical.',
    '',
    SHARED_RESULT_CONTRACT,
    resultSchemaBlock('security-review'),
  ];
  return sections.filter((line) => line !== null).join('\n');
}

/** @param {string[]|undefined} checks */
function checksLine(checks) {
  if (!checks || checks.length === 0) {
    return '- Run the checks that already exist in this repository and report their real output.';
  }
  return `- Run these checks and report their real output: ${checks.join(', ')}.`;
}

/** @param {string} role */
function resultSchemaBlock(role) {
  const findingFields =
    role === 'security-review'
      ? '"path", "line", "severity", "prerequisites", "attackerControl", "trustBoundary", "consequence",' +
        ' "evidence", "safeVerification", "suggestedCorrection"'
      : role === 'code-review'
        ? '"path", "line", "severity", "trigger", "consequence", "evidence", "suggestedCorrection"'
        : '"path", "line", "summary"';
  const extra =
    role === 'implementation'
      ? '\n  "commands": [{"command": "...", "exitCode": 0, "output": "..."}],\n  "diffSummary": "...",'
      : '';
  return [
    '',
    '```' + RESULT_FENCE,
    '{',
    `  "role": "${role}",`,
    '  "status": "complete-no-findings" | "complete-with-findings" | "incomplete",',
    '  "notCovered": ["..."],' + extra,
    `  "findings": [{ ${findingFields} }]`,
    '}',
    '```',
  ].join('\n');
}

/**
 * Extract the structured result block from an agent reply.
 *
 * A missing or unparseable block is reported as `incomplete` with a reason —
 * never silently treated as "no findings".
 * @param {string} text
 */
export function parseResultBlock(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, status: 'incomplete', reason: 'empty reply', result: null };
  }
  const fence = new RegExp('^```' + RESULT_FENCE + '[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)^```[^\\S\\r\\n]*$', 'gm');
  let match;
  const candidates = [];
  while ((match = fence.exec(text)) !== null) candidates.push(match[1]);
  if (candidates.length === 0) {
    return { ok: false, status: 'incomplete', reason: `no ${RESULT_FENCE} block in reply`, result: null };
  }
  let lastError = null;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(candidates[index]);
      const status = REVIEW_STATUSES.includes(parsed.status) ? parsed.status : 'incomplete';
      return {
        ok: true,
        status,
        reason: status === parsed.status ? null : `unrecognised status ${JSON.stringify(parsed.status)}`,
        result: parsed,
      };
    } catch (err) {
      lastError = err;
    }
  }
  return {
    ok: false,
    status: 'incomplete',
    reason: `unparseable ${RESULT_FENCE} block: ${lastError instanceof Error ? lastError.message : lastError}`,
    result: null,
  };
}
