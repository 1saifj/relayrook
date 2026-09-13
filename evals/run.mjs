#!/usr/bin/env node
/**
 * Held-out evaluation runner.
 *
 * Drives each selected backend through the real `relayrook` CLI against the
 * reproducible fixtures in `evals/fixtures/<role>/<id>/`, scores the outcome,
 * and can merge measured results into `<stateDir>/route-evidence.json` so
 * `route` prefers measured over configured evidence once `runs >= 2`.
 *
 * Every run records a status:
 *   pass   task outcome verified (check passed / findings matched within scope)
 *   fail   the backend ran but the outcome did not verify
 *   skip   the backend could not be driven (preflight blocker, not installed)
 * Skips are never counted as runs in the evidence file.
 *
 * Usage:
 *   node evals/run.mjs [--backend codex[,kiro-cli]] [--role implementation[,code-review]]
 *                      [--fixture impl-pagination] [--state-dir DIR] [--caller eval-runner]
 *                      [--timeout ms] [--runs N] [--write-evidence] [--json]
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasBackend } from '../src/backends.mjs';
import { resolveStateDir } from '../src/state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'relayrook.js');
const FIXTURES = path.join(ROOT, 'evals', 'fixtures');
const LINE_TOLERANCE = 3;

/** @param {string[]} argv */
function parseArgs(argv) {
  const flags = {
    backend: null, role: null, fixture: null, caller: 'eval-runner',
    timeout: 600000, runs: 1, writeEvidence: false, json: false, stateDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--backend') flags.backend = next()?.split(',');
    else if (arg === '--role') flags.role = next()?.split(',');
    else if (arg === '--fixture') flags.fixture = next()?.split(',');
    else if (arg === '--caller') flags.caller = next();
    else if (arg === '--timeout') flags.timeout = Number(next());
    else if (arg === '--runs') flags.runs = Number(next());
    else if (arg === '--write-evidence') flags.writeEvidence = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--state-dir') flags.stateDir = next();
    else if (arg === '--help') {
      console.log('node evals/run.mjs [--backend a,b] [--role r] [--fixture f] [--runs N] [--write-evidence] [--json]');
      process.exit(0);
    } else {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return flags;
}

/** @param {string[]} args @param {{cwd?: string, env?: any, timeout?: number}} [options] */
function cli(args, options = {}) {
  // An eval run is a fresh delegation root: the runner's own inherited route
  // envelope is signed against a different state dir and would be rejected.
  const env = { ...(options.env ?? process.env) };
  delete env.RELAYROOK_ROUTE;
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      cwd: options.cwd ?? ROOT,
      env,
      timeout: options.timeout ?? 120000,
      maxBuffer: 32 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const text = String(stdout || stderr);
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* non-JSON output */ }
      resolve({ code: err ? (err.code ?? 1) : 0, parsed, raw: text });
    });
  });
}

export function hashDir(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  const map = new Map();
  for (const file of files.sort()) {
    map.set(path.relative(dir, file), createHash('sha256').update(readFileSync(file)).digest('hex'));
  }
  return map;
}

/** Copy task inputs without exposing the evaluator's answer key. */
export function prepareWorkspace(fixtureDir, workspace) {
  cpSync(fixtureDir, workspace, { recursive: true,
    filter: (source) => path.relative(fixtureDir, source) !== 'eval.json' });
}

/** Include additions, modifications and deletions in scope accounting. */
export function changedFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file)).sort();
}

export function sessionStartArgs(backend, workspace, role, caller, stateDir) {
  return ['start', '--backend', backend, '--workspace', workspace,
    '--role', role, '--caller', caller, '--state-dir', stateDir];
}

function listFixtures(flags) {
  const out = [];
  for (const role of readdirSync(FIXTURES)) {
    if (flags.role && !flags.role.includes(role)) continue;
    const roleDir = path.join(FIXTURES, role);
    if (!existsSync(roleDir)) continue;
    for (const id of readdirSync(roleDir)) {
      if (flags.fixture && !flags.fixture.includes(id)) continue;
      const dir = path.join(roleDir, id);
      const spec = path.join(dir, 'eval.json');
      if (existsSync(spec)) out.push({ role, id, dir, spec: JSON.parse(readFileSync(spec, 'utf8')) });
    }
  }
  return out;
}

/** Match reported findings to seeded findings by path basename and line proximity. */
function scoreFindings(reported, seeds) {
  const used = new Set();
  const matched = [];
  const unmatched = [];
  for (const finding of reported ?? []) {
    const base = String(finding?.path ?? '').split('/').pop();
    const line = Number(finding?.line);
    const hit = (seeds ?? []).find((s, i) =>
      !used.has(i) &&
      String(s.path).split('/').pop() === base &&
      Number.isFinite(line) && Math.abs(line - s.line) <= LINE_TOLERANCE);
    if (hit) { used.add(seeds.indexOf(hit)); matched.push({ reported: finding, seed: hit.id }); }
    else unmatched.push(finding);
  }
  const missed = (seeds ?? []).filter((_, i) => !used.has(i)).map((s) => s.id);
  const reportedCount = (reported ?? []).length;
  return {
    truePositives: matched.length,
    falsePositives: unmatched.length,
    missed,
    precision: reportedCount === 0 ? 0 : matched.length / reportedCount,
    recall: (seeds ?? []).length === 0 ? 1 : matched.length / seeds.length,
  };
}

async function runFixture(fixture, backend, flags, runIndex) {
  const tmp = mkdtempSync(path.join(tmpdir(), `relayrook-eval-${fixture.id}-`));
  const workspace = path.join(tmp, 'workspace');
  prepareWorkspace(fixture.dir, workspace);
  const pristine = hashDir(workspace);
  const stateDir = flags.stateDir ?? path.join(tmp, 'state');

  const record = {
    fixture: fixture.id,
    role: fixture.role,
    backend,
    runIndex,
    status: 'fail',
    reason: null,
    model: null,
    effort: null,
    latencyMs: null,
    usage: null,
    turnState: null,
    resultStatus: null,
    scores: null,
    scopeViolations: null,
    scopeCompliant: null,
  };
  const cleanup = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };
  try {
    // 1. Preflight: capability checks before anything is started. The
    // command-level `ok` means the report was produced; `passed` is the
    // capability verdict — a blocker makes the run a skip, not a failure.
    const pre = await cli(['preflight', '--backend', backend, '--caller', flags.caller, '--state-dir', stateDir]);
    if (pre.parsed?.ok !== true || pre.parsed?.passed === false) {
      record.status = 'skip';
      const codes = (pre.parsed?.blockers ?? []).map((b) => b.code ?? b.check).join(',');
      record.reason = `preflight: ${codes || pre.raw.slice(0, 200)}`;
      return record;
    }

    // 2. Route for the model/effort this backend is configured to use.
    const routed = await cli([
      'route', '--role', fixture.role, '--agent', backend, '--caller', flags.caller, '--state-dir', stateDir,
    ]);
    if (!routed.parsed?.ok) {
      record.status = 'skip';
      record.reason = `route: ${routed.parsed?.error?.code ?? routed.raw.slice(0, 200)}`;
      return record;
    }
    record.model = routed.parsed.selected?.model ?? null;
    record.effort = routed.parsed.selected?.effort ?? null;

    // 3. Start a session against the fixture copy.
    const startArgs = sessionStartArgs(backend, workspace, fixture.role, flags.caller, stateDir);
    if (record.model) startArgs.push('--model', record.model);
    if (record.effort) startArgs.push('--effort', record.effort);
    const started = await cli(startArgs, { timeout: 180000 });
    if (!started.parsed?.ok) {
      record.status = 'fail';
      record.reason = `start: ${started.parsed?.error?.code ?? started.raw.slice(0, 200)}`;
      return record;
    }
    const session = started.parsed.session;

    // 4. Prompt and wait.
    const task = `${fixture.spec.task}\n\nWorkspace: ${workspace}`;
    const t0 = Date.now();
    const prompted = await cli(['prompt', '--session', session, '--role', fixture.role,
      '--task', task, '--state-dir', stateDir], { timeout: 120000 });
    if (!prompted.parsed?.ok) {
      record.status = 'fail';
      record.reason = `prompt: ${prompted.parsed?.error?.code ?? prompted.raw.slice(0, 200)}`;
      await cli(['stop', '--session', session, '--state-dir', stateDir]).catch(() => {});
      return record;
    }
    let waited;
    // Permissions remain available for an external supervisor to inspect and
    // answer. Never blanket-approve evaluator tool requests or stop the
    // session merely because it is waiting for an authorized decision.
    do {
      const remaining = Math.max(0, flags.timeout - (Date.now() - t0));
      waited = await cli([
        'wait', '--session', session, '--timeout', String(remaining),
        '--events', '--full', '--state-dir', stateDir,
      ], { timeout: remaining + 60000 });
      if ((waited.parsed?.state ?? waited.parsed?.turn?.state) !== 'awaiting-permission') break;
      if (Date.now() - t0 >= flags.timeout) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (Date.now() - t0 < flags.timeout);
    record.latencyMs = Date.now() - t0;
    await cli(['stop', '--session', session, '--state-dir', stateDir]).catch(() => {});

    if (!waited.parsed?.ok) {
      record.reason = `wait: ${waited.parsed?.error?.code ?? waited.raw.slice(0, 200)}`;
      return record;
    }
    record.turnState = waited.parsed.state ?? waited.parsed.turn?.state ?? null;
    record.resultStatus = waited.parsed.parsedResult?.status ?? null;
    // The worker keeps the canonical normalized usage record on the turn —
    // provider-specific fields already mapped, raw payload preserved, nulls
    // where the provider reported nothing.
    record.usage = waited.parsed.turn?.usage ?? null;

    // 5. Score the outcome.
    if (record.turnState !== 'completed' || !waited.parsed.parsedResult?.ok) {
      record.reason = `turn ${record.turnState ?? 'unknown'}; result ${record.resultStatus ?? 'unparsed'}`;
      return record;
    }
    const findings = waited.parsed.parsedResult.result?.findings ?? [];
    if (fixture.role === 'implementation') {
      const after = hashDir(workspace);
      const changed = changedFiles(pristine, after);
      const allowed = new Set(fixture.spec.allowedFiles ?? []);
      record.scopeViolations = changed.filter((f) => !allowed.has(f));
      record.scopeCompliant = record.scopeViolations.length === 0;
      const check = await new Promise((resolve) => {
        execFile(fixture.spec.check.split(' ')[0], fixture.spec.check.split(' ').slice(1),
          { cwd: workspace, timeout: 120000 }, (err, stdout, stderr) =>
            resolve({ code: err ? (err.code ?? 1) : 0, output: `${stdout}${stderr}`.slice(0, 2000) }));
      });
      record.scores = { checkPassed: check.code === 0, checkOutput: check.output, filesChanged: changed };
      record.status = check.code === 0 && record.scopeViolations.length === 0 ? 'pass' : 'fail';
      record.reason = check.code === 0
        ? (record.scopeViolations.length ? `out-of-scope edits: ${record.scopeViolations.join(',')}` : null)
        : `check failed: ${check.output.slice(0, 200)}`;
    } else {
      record.scores = scoreFindings(findings, fixture.spec.findings ?? []);
      const after = hashDir(workspace);
      record.scopeViolations = changedFiles(pristine, after);
      record.scopeCompliant = record.scopeViolations.length === 0;
      // A review that mutates the reviewed source fails scope compliance.
      record.status = record.scores.recall >= 0.5 && record.scopeViolations.length === 0 ? 'pass' : 'fail';
      if (record.scopeViolations.length) {
        record.reason = `review mutated source: ${record.scopeViolations.join(',')}`;
      } else if (record.scores.recall < 0.5) {
        record.reason = `missed seeded findings: ${record.scores.missed.join(',')}`;
      }
    }
    return record;
  } finally {
    cleanup();
  }
}

/**
 * Aggregate run records into measured evidence per `role|backend|model|effort`.
 * Every dimension is averaged only over the runs that reported it; a dimension
 * no run reported stays `null` rather than being invented. Skips never count.
 * @param {any[]} runs
 */
export function aggregateEvidence(runs) {
  const evidence = {};
  for (const r of runs.filter((x) => x.status !== 'skip')) {
    const key = `${r.role}|${r.backend}|${r.model ?? ''}|${r.effort ?? ''}`;
    const e = (evidence[key] ??= {
      runs: 0, successes: 0, scopeCompliant: 0, scopeKnown: 0,
      precisionSamples: [], latencySamples: [], uncachedInputSamples: [], totalTokenSamples: [],
    });
    e.runs += 1;
    if (r.status === 'pass') e.successes += 1;
    if (r.scopeCompliant !== null) { e.scopeKnown += 1; if (r.scopeCompliant) e.scopeCompliant += 1; }
    if (r.scores && typeof r.scores.precision === 'number') e.precisionSamples.push(r.scores.precision);
    if (typeof r.latencyMs === 'number') e.latencySamples.push(r.latencyMs);
    if (typeof r.usage?.uncachedInputTokens === 'number') e.uncachedInputSamples.push(r.usage.uncachedInputTokens);
    if (typeof r.usage?.totalTokens === 'number') e.totalTokenSamples.push(r.usage.totalTokens);
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const out = {};
  for (const [key, e] of Object.entries(evidence)) {
    out[key] = {
      runs: e.runs,
      successRate: e.runs ? e.successes / e.runs : 0,
      precision: e.precisionSamples.length
        ? e.precisionSamples.reduce((a, b) => a + b, 0) / e.precisionSamples.length
        : (e.runs ? e.successes / e.runs : 0),
      scopeComplianceRate: e.scopeKnown ? e.scopeCompliant / e.scopeKnown : null,
      meanLatencyMs: mean(e.latencySamples),
      meanUncachedInputTokens: mean(e.uncachedInputSamples),
      meanTotalTokens: mean(e.totalTokenSamples),
      // Per-dimension sample counts let merges weight each mean by the runs
      // that actually reported it rather than by total runs.
      samples: {
        scope: e.scopeKnown,
        latency: e.latencySamples.length,
        uncachedInput: e.uncachedInputSamples.length,
        totalTokens: e.totalTokenSamples.length,
      },
    };
  }
  return out;
}

/**
 * Merge new aggregated evidence into an existing routes map, weighting each
 * mean by how many runs contributed to it. A dimension that was never
 * reported stays `null` instead of averaging in placeholders.
 * @param {Record<string, any>} routes @param {Record<string, any>} evidenceOut
 */
export function mergeEvidence(routes, evidenceOut) {
  const merged = { ...routes };
  const weighted = (prev, next, prevN, nextN) =>
    next === null ? prev : prev === null ? next : (prev * prevN + next * nextN) / (prevN + nextN);
  for (const [key, e] of Object.entries(evidenceOut)) {
    const prev = merged[key] ?? { runs: 0, samples: {} };
    const ps = prev.samples ?? {};
    // Entries written before per-dimension counts existed derived every
    // mean from all their runs — weight them by prev.runs.
    const pn = (field, dim) =>
      ps[dim] ?? (prev[field] === null || prev[field] === undefined ? 0 : prev.runs);
    merged[key] = {
      runs: prev.runs + e.runs,
      successRate: weighted(prev.successRate ?? 0, e.successRate, prev.runs, e.runs),
      precision: weighted(prev.precision ?? 0, e.precision, prev.runs, e.runs),
      scopeComplianceRate: weighted(prev.scopeComplianceRate ?? null, e.scopeComplianceRate,
        pn('scopeComplianceRate', 'scope'), e.samples.scope),
      meanLatencyMs: weighted(prev.meanLatencyMs ?? null, e.meanLatencyMs,
        pn('meanLatencyMs', 'latency'), e.samples.latency),
      meanUncachedInputTokens: weighted(prev.meanUncachedInputTokens ?? null, e.meanUncachedInputTokens,
        pn('meanUncachedInputTokens', 'uncachedInput'), e.samples.uncachedInput),
      meanTotalTokens: weighted(prev.meanTotalTokens ?? null, e.meanTotalTokens,
        pn('meanTotalTokens', 'totalTokens'), e.samples.totalTokens),
      samples: {
        scope: pn('scopeComplianceRate', 'scope') + e.samples.scope,
        latency: pn('meanLatencyMs', 'latency') + e.samples.latency,
        uncachedInput: pn('meanUncachedInputTokens', 'uncachedInput') + e.samples.uncachedInput,
        totalTokens: pn('meanTotalTokens', 'totalTokens') + e.samples.totalTokens,
      },
    };
  }
  return merged;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const fixtures = listFixtures(flags);
  if (fixtures.length === 0) {
    console.error('no fixtures matched');
    process.exit(2);
  }
  const backends = flags.backend ?? ['devin', 'kiro', 'opencode', 'claude', 'codex'];
  const unknown = backends.filter((b) => !hasBackend(b));
  if (unknown.length) {
    console.error(`unknown backend id(s): ${unknown.join(',')} — registry ids are devin, kiro, opencode, claude, codex`);
    process.exit(2);
  }
  const runs = [];
  for (const fixture of fixtures) {
    for (const backend of backends) {
      for (let i = 0; i < flags.runs; i += 1) {
        const rec = await runFixture(fixture, backend, flags, i + 1);
        runs.push(rec);
        if (!flags.json) {
          console.error(`[${rec.status}] ${rec.role}/${rec.fixture} on ${backend} #${i + 1}` +
            (rec.reason ? ` — ${rec.reason}` : ''));
        }
      }
    }
  }

  const evidenceOut = aggregateEvidence(runs);

  // Resolve through the same resolver the CLI uses so evidence lands exactly
  // where `route` reads it — including XDG_STATE_HOME and %LOCALAPPDATA%.
  const stateDir = resolveStateDir(flags.stateDir, process.env);
  let evidenceFile = null;
  if (flags.writeEvidence && Object.keys(evidenceOut).length > 0) {
    evidenceFile = path.join(stateDir, 'route-evidence.json');
    let existing = { routes: {} };
    if (existsSync(evidenceFile)) {
      try { existing = JSON.parse(readFileSync(evidenceFile, 'utf8')); } catch { /* start fresh */ }
    }
    const routes = mergeEvidence(existing.routes ?? {}, evidenceOut);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(evidenceFile, JSON.stringify({ updatedAt: new Date().toISOString(), routes }, null, 2) + '\n');
  }

  const summary = {
    ok: true,
    fixtures: fixtures.map((f) => `${f.role}/${f.id}`),
    backends,
    counts: {
      pass: runs.filter((r) => r.status === 'pass').length,
      fail: runs.filter((r) => r.status === 'fail').length,
      skip: runs.filter((r) => r.status === 'skip').length,
    },
    runs,
    evidence: evidenceOut,
    evidenceFile,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(runs.every((r) => r.status !== 'fail') ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: { code: 'eval_runner_error', message: err?.message ?? String(err) } }));
    process.exit(1);
  });
}
