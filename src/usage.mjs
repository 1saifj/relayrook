/**
 * Provider-neutral usage records.
 *
 * Every backend reports usage differently: Codex sends cumulative token
 * counters on `thread/tokenUsage/updated`, ACP agents send context-window
 * occupancy on `session/usage_update`, and some report nothing at all. This
 * module maps whatever arrived onto one canonical shape. A field the provider
 * did not report is `null` — never zero, never estimated — and the raw
 * payload is preserved verbatim under `raw` for auditing.
 */

/**
 * Fields every normalized record carries. `null` means "not reported"; the
 * number zero means the provider actually reported zero.
 */
const TOKEN_FIELDS = [
  'uncachedInputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'totalTokens',
];

/** @param {unknown} v @returns {number|null} */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Read a field under camelCase or snake_case, whichever the provider sent. */
function pick(obj, camel, snake) {
  return num(obj?.[camel]) ?? num(obj?.[snake]);
}

/**
 * Normalize one provider usage payload.
 *
 * @param {string} backendId
 * @param {any} raw the provider payload as received (already unwrapped from
 *   the transport envelope by the adapter, or the whole update when the
 *   adapter passed it through)
 * @param {{rateLimits?: any, latencyMs?: number|null, eventCount?: number|null}} [extra]
 *   fields only the caller knows: the latest rate-limit snapshot, the turn's
 *   wall-clock latency, and how many usage events were seen.
 */
export function normalizeUsage(backendId, raw, extra = {}) {
  // Codex reports {total: {...}, last: {...}, modelContextWindow}; the
  // cumulative `total` bucket is the record-keeping view. ACP agents send a
  // flat object. Unknown payloads degrade to all-null fields plus `raw`.
  const totals = raw?.total && typeof raw.total === 'object' ? raw.total : raw ?? {};

  const input = pick(totals, 'inputTokens', 'input_tokens');
  const cached = pick(totals, 'cachedInputTokens', 'cached_input_tokens');
  const cacheWrite = pick(totals, 'cacheWriteInputTokens', 'cache_write_input_tokens');
  const contextUsed = pick(raw, 'used', 'used') ?? pick(totals, 'used', 'used');
  const contextWindow = num(raw?.modelContextWindow) ?? pick(raw, 'size', 'size');

  const record = {
    backend: backendId,
    uncachedInputTokens: input === null ? null : Math.max(0, input - (cached ?? 0) - (cacheWrite ?? 0)),
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: pick(totals, 'outputTokens', 'output_tokens'),
    reasoningOutputTokens: pick(totals, 'reasoningOutputTokens', 'reasoning_output_tokens'),
    totalTokens: pick(totals, 'totalTokens', 'total_tokens'),
    contextUsedTokens: contextUsed,
    contextWindowTokens: contextWindow,
    // Caller-known context, filled by the worker at turn end.
    eventCount: extra.eventCount ?? null,
    latencyMs: extra.latencyMs ?? null,
    // Latest observed rate-limit snapshot (shape: {planType, primary,
    // secondary}) or null when the provider never reported one. Deltas are
    // computed by whoever compares two snapshots — see evals/run.mjs.
    rateLimits: extra.rateLimits ?? null,
    raw: raw ?? null,
  };
  return record;
}

/**
 * Whether a normalized record carries any provider-reported token data at
 * all — distinguishing "the provider reported zeros" from "nothing was ever
 * reported".
 * @param {any} record
 */
export function hasUsageData(record) {
  return TOKEN_FIELDS.some((f) => typeof record?.[f] === 'number') ||
    typeof record?.contextUsedTokens === 'number';
}
