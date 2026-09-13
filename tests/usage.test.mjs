import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUsage, hasUsageData } from '../src/usage.mjs';

// Codex thread/tokenUsage/updated payload shape (observed on 0.153.4).
const CODEX_PAYLOAD = {
  total: {
    totalTokens: 290589,
    inputTokens: 286846,
    cachedInputTokens: 253696,
    cacheWriteInputTokens: 0,
    outputTokens: 3743,
    reasoningOutputTokens: 1501,
  },
  last: {
    totalTokens: 32758,
    inputTokens: 31803,
    cachedInputTokens: 31104,
    outputTokens: 955,
    reasoningOutputTokens: 516,
  },
  modelContextWindow: 258400,
};

test('codex cumulative payload maps onto the canonical fields', () => {
  const r = normalizeUsage('codex', CODEX_PAYLOAD);
  assert.equal(r.backend, 'codex');
  assert.equal(r.cachedInputTokens, 253696);
  assert.equal(r.cacheWriteInputTokens, 0);
  // uncached = input - cached - cacheWrite, from the cumulative bucket.
  assert.equal(r.uncachedInputTokens, 286846 - 253696 - 0);
  assert.equal(r.outputTokens, 3743);
  assert.equal(r.reasoningOutputTokens, 1501);
  assert.equal(r.totalTokens, 290589);
  assert.equal(r.contextWindowTokens, 258400);
  assert.equal(r.raw, CODEX_PAYLOAD);
});

test('uncached input is computed arithmetically, not read from a field', () => {
  const r = normalizeUsage('codex', {
    total: { inputTokens: 100, cachedInputTokens: 30, outputTokens: 5, totalTokens: 105 },
  });
  assert.equal(r.uncachedInputTokens, 70);
  // Missing cacheWrite is treated as absent, not a blocker.
  assert.equal(r.cacheWriteInputTokens, null);
});

test('fields a provider never reports stay null, not zero', () => {
  const r = normalizeUsage('codex', { total: { inputTokens: 10 } });
  assert.equal(r.uncachedInputTokens, 10);
  assert.equal(r.cachedInputTokens, null);
  assert.equal(r.outputTokens, null);
  assert.equal(r.reasoningOutputTokens, null);
  assert.equal(r.totalTokens, null);
});

test('snake_case fields are accepted for providers that send them', () => {
  const r = normalizeUsage('kiro', {
    input_tokens: 40, cached_input_tokens: 10, output_tokens: 3, total_tokens: 43,
  });
  assert.equal(r.uncachedInputTokens, 30);
  assert.equal(r.cachedInputTokens, 10);
  assert.equal(r.outputTokens, 3);
  assert.equal(r.totalTokens, 43);
});

test('ACP context-window occupancy maps to context fields, not billing tokens', () => {
  const r = normalizeUsage('devin', { used: 51200, size: 200000 });
  assert.equal(r.contextUsedTokens, 51200);
  assert.equal(r.contextWindowTokens, 200000);
  assert.equal(r.totalTokens, null);
  assert.equal(r.uncachedInputTokens, null);
});

test('an empty or absent payload degrades to nulls plus preserved raw', () => {
  const r = normalizeUsage('opencode', undefined);
  assert.equal(r.totalTokens, null);
  assert.equal(r.raw, null);
  assert.equal(hasUsageData(r), false);
  const g = normalizeUsage('claude', { something: 'else' });
  assert.equal(hasUsageData(g), false);
  assert.deepEqual(g.raw, { something: 'else' });
});

test('caller-known fields attach: event count, latency, rate-limit snapshot', () => {
  const rateLimits = { planType: 'plus', primary: { usedPercent: 66 }, secondary: { usedPercent: 42 } };
  const r = normalizeUsage('codex', CODEX_PAYLOAD, {
    eventCount: 4,
    latencyMs: 96126,
    rateLimits,
  });
  assert.equal(r.eventCount, 4);
  assert.equal(r.latencyMs, 96126);
  assert.deepEqual(r.rateLimits, rateLimits);
});

test('hasUsageData distinguishes reported zeros from absent data', () => {
  assert.equal(hasUsageData(normalizeUsage('codex', { total: { inputTokens: 0 } })), true);
  assert.equal(hasUsageData(normalizeUsage('codex', null)), false);
});
