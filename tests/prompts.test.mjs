import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPrompt, parseResultBlock, RESULT_FENCE, REVIEW_STATUSES } from '../src/prompts.mjs';
import { ERROR_CODES } from '../src/errors.mjs';

const base = { task: 'Check the auth middleware', workspace: '/w', scope: 'src/auth' };

test('an implementation prompt asks for a diff, real command output and honest incompleteness', () => {
  const prompt = buildPrompt({ ...base, role: 'implementation', checks: ['npm test'] });
  assert.match(prompt, /implementation task delegated through RelayRook/);
  assert.match(prompt, /Run these checks and report their real output: npm test\./);
  assert.match(prompt, /Report the diff you produced/);
  assert.match(prompt, /Preserve unrelated modifications/);
  assert.match(prompt, /Do not claim success you did not verify/);
  assert.doesNotMatch(prompt, /read-only task/);
});

test('implementation falls back to the repository’s existing checks', () => {
  const prompt = buildPrompt({ ...base, role: 'implementation' });
  assert.match(prompt, /checks that already exist in this repository/);
});

test('a code review is read-only and demands the full finding shape', () => {
  const prompt = buildPrompt({ ...base, role: 'code-review' });
  assert.match(prompt, /This is a read-only task\./);
  assert.match(prompt, /Do not edit, create, move or delete any file/);
  for (const field of ['path', 'line', 'severity', 'trigger', 'consequence', 'evidence', 'suggested correction']) {
    assert.match(prompt, new RegExp(field, 'i'), `missing ${field}`);
  }
  assert.match(prompt, /do not invent line numbers/i);
});

test('a security review additionally demands prerequisites, attacker control, trust boundary and safe verification', () => {
  const prompt = buildPrompt({ ...base, role: 'security-review' });
  assert.match(prompt, /This is a read-only task\./);
  assert.match(prompt, /Do not exploit anything/);
  for (const field of [
    'prerequisites',
    'attackerControl',
    'trustBoundary',
    'consequence',
    'evidence',
    'safeVerification',
    'suggestedCorrection',
  ]) {
    assert.ok(prompt.includes(field), `missing ${field}`);
  }
  assert.match(prompt, /reproducible evidence/i);
  assert.match(prompt, /unreachable or already mitigated/);
});

test('review read-only can be lifted only by an explicit flag', () => {
  const prompt = buildPrompt({ ...base, role: 'code-review', readOnly: false });
  assert.doesNotMatch(prompt, /This is a read-only task\./);
});

test('every role states that no findings and incomplete are different outcomes', () => {
  for (const role of ['implementation', 'code-review', 'security-review']) {
    const prompt = buildPrompt({ ...base, role });
    assert.match(prompt, /complete-no-findings/);
    assert.match(prompt, /"incomplete"/);
    assert.match(prompt, new RegExp('```' + RESULT_FENCE));
  }
});

test('an unknown role is rejected before any prompt is built', () => {
  assert.throws(
    () => buildPrompt({ ...base, role: 'vibes' }),
    (/** @type {any} */ err) => err.code === ERROR_CODES.unknown_role,
  );
});

test('scope and context reach the prompt when supplied', () => {
  const prompt = buildPrompt({ ...base, role: 'code-review', context: 'The diff touches session cookies.' });
  assert.match(prompt, /Review scope: src\/auth/);
  assert.match(prompt, /session cookies/);
});

test('the result block is parsed from a reply', () => {
  const body = '{"role":"code-review","status":"complete-with-findings","findings":[{"path":"a.js","line":3}]}';
  const reply = ['Here is what I found.', '```' + RESULT_FENCE, body, '```'].join('\n');
  const parsed = parseResultBlock(reply);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, 'complete-with-findings');
  assert.equal(parsed.result.findings.length, 1);
});

test('a missing result block is incomplete, not "no findings"', () => {
  const parsed = parseResultBlock('I looked at everything and it seems fine.');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, 'incomplete');
  assert.match(parsed.reason, /no relayrook-result block/);
});

test('an unparseable result block is incomplete with the parse error', () => {
  const parsed = parseResultBlock(['```' + RESULT_FENCE, '{oops', '```'].join('\n'));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, 'incomplete');
  assert.match(parsed.reason, /unparseable/);
});

test('an unrecognised status downgrades to incomplete and says why', () => {
  const parsed = parseResultBlock(['```' + RESULT_FENCE, '{"status":"looks-good"}', '```'].join('\n'));
  assert.equal(parsed.status, 'incomplete');
  assert.match(parsed.reason, /unrecognised status/);
});

test('an empty reply is incomplete', () => {
  assert.equal(parseResultBlock('').status, 'incomplete');
  assert.equal(parseResultBlock(null).status, 'incomplete');
});

test('the last result block wins when a reply contains several', () => {
  const reply = [
    '```' + RESULT_FENCE,
    '{"status":"incomplete"}',
    '```',
    'on reflection:',
    '```' + RESULT_FENCE,
    '{"status":"complete-no-findings"}',
    '```',
  ].join('\n');
  assert.equal(parseResultBlock(reply).status, 'complete-no-findings');
});

test('a result block can contain triple backticks inside a JSON string', () => {
  const body = JSON.stringify({
    role: 'code-review',
    status: 'complete-with-findings',
    findings: [{ evidence: 'The source contains ```js\\nexample()\\n``` inline.' }],
  }, null, 2);
  const reply = ['```' + RESULT_FENCE, body, '```'].join('\n');
  const parsed = parseResultBlock(reply);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.findings[0].evidence.includes('```js'), true);
});

test('the accepted status vocabulary is fixed', () => {
  assert.deepEqual(REVIEW_STATUSES, ['complete-no-findings', 'complete-with-findings', 'incomplete']);
});
