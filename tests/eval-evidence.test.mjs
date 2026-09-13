import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateEvidence, mergeEvidence } from '../evals/run.mjs';

const run = (over) => ({
  role: 'code-review', backend: 'codex', model: 'm', effort: 'high',
  status: 'pass', scopeCompliant: true, latencyMs: 1000,
  scores: { precision: 1 }, usage: { uncachedInputTokens: 100, totalTokens: 200 },
  ...over,
});

test('skips never count toward runs or any dimension', () => {
  const out = aggregateEvidence([run({ status: 'skip' }), run({})]);
  const e = out['code-review|codex|m|high'];
  assert.equal(e.runs, 1);
  assert.equal(e.successRate, 1);
  assert.equal(e.samples.latency, 1);
});

test('a single run stays anecdotal input: runs below the measured threshold', () => {
  const out = aggregateEvidence([run({})]);
  assert.equal(out['code-review|codex|m|high'].runs, 1);
});

test('dimensions no run reported stay null, not zero or invented', () => {
  const out = aggregateEvidence([
    run({ scopeCompliant: null, latencyMs: null, usage: null }),
  ]);
  const e = out['code-review|codex|m|high'];
  assert.equal(e.scopeComplianceRate, null);
  assert.equal(e.meanLatencyMs, null);
  assert.equal(e.meanTotalTokens, null);
  assert.equal(e.samples.scope, 0);
});

test('means weight only the runs that reported the dimension', () => {
  const out = aggregateEvidence([
    run({ latencyMs: 1000 }),
    run({ latencyMs: 3000 }),
    run({ latencyMs: null, status: 'fail' }),
  ]);
  const e = out['code-review|codex|m|high'];
  assert.equal(e.runs, 3);
  assert.equal(e.meanLatencyMs, 2000);
  assert.equal(e.samples.latency, 2);
  assert.equal(e.successRate, 2 / 3);
  assert.equal(e.scopeComplianceRate, 1);
});

test('merging across invocations accumulates runs and reweights means', () => {
  const first = aggregateEvidence([run({ latencyMs: 1000, usage: { uncachedInputTokens: 100, totalTokens: 200 } })]);
  const second = aggregateEvidence([run({ latencyMs: 3000, usage: { uncachedInputTokens: 300, totalTokens: 600 } })]);
  const merged = mergeEvidence(mergeEvidence({}, first), second);
  const e = merged['code-review|codex|m|high'];
  assert.equal(e.runs, 2);
  assert.equal(e.meanLatencyMs, 2000);
  assert.equal(e.meanUncachedInputTokens, 200);
  assert.equal(e.meanTotalTokens, 400);
  assert.equal(e.samples.latency, 2);
});

test('a legacy entry without sample counts weights its means by runs', () => {
  const legacy = { 'code-review|codex|m|high': { runs: 2, successRate: 1, precision: 1, meanLatencyMs: 1000 } };
  const next = aggregateEvidence([run({ latencyMs: 3000 })]);
  const merged = mergeEvidence(legacy, next);
  const e = merged['code-review|codex|m|high'];
  assert.equal(e.runs, 3);
  // (1000*2 + 3000*1) / 3
  assert.equal(Math.round(e.meanLatencyMs), 1667);
  assert.equal(e.samples.latency, 3);
});


test('workspace preparation hides evaluator answer keys', async () => {
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { prepareWorkspace } = await import('../evals/run.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'relayrook-eval-isolation-'));
  try {
    writeFileSync(path.join(dir, 'eval.json'), '{"findings":["secret answer"]}');
    writeFileSync(path.join(dir, 'task.mjs'), 'export const task = 1;');
    const workspace = `${dir}-workspace`;
    try {
      prepareWorkspace(dir, workspace);
      assert.equal(existsSync(path.join(workspace, 'eval.json')), false);
      assert.equal(existsSync(path.join(workspace, 'task.mjs')), true);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scope accounting includes deletions alongside additions and edits', async () => {
  const { changedFiles } = await import('../evals/run.mjs');
  assert.deepEqual(changedFiles(new Map([['deleted', 'a'], ['edited', 'b'], ['same', 'c']]),
    new Map([['added', 'd'], ['edited', 'e'], ['same', 'c']])), ['added', 'deleted', 'edited']);
});

test('evaluation starts the session with the requested review posture', async () => {
  const { sessionStartArgs } = await import('../evals/run.mjs');
  const args = sessionStartArgs('codex', '/workspace', 'security-review', 'eval-runner', '/state');
  assert.equal(args[args.indexOf('--role') + 1], 'security-review');
});
