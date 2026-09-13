# Changelog

## 0.2.0

The cross-harness release: every supported CLI runs through persistent
sessions, and the runtime carries the safety and recovery machinery a host
needs to delegate confidently.

### Backends

- **Codex is a full backend.** Sessions are Codex threads: `thread/start`
  opens them with model and reasoning-effort readback, `thread/resume`
  restores them after a worker restart, `turn/start` runs prompts with
  streamed `item/*` events, `turn/steer` feeds input to the in-flight turn,
  `turn/interrupt` cancels — including a cancel issued while `turn/start` is
  still in flight — and `review/start` runs Codex's native review.
  Sandbox and approval policy map onto app-server values; review roles run in
  a read-only sandbox with approvals off unless overridden, and prompting a
  review role or starting a native review in a session without read-only posture fails with
  `role_posture_mismatch`. A method-not-found reply is reported as
  `unsupported_backend_version`. Verified against Codex `0.153.4`.
- **ACP backends resume.** Devin, Kiro, OpenCode and the Claude adapter use
  `session/load` where the agent advertises it; a refused load is
  `session_not_resumable`, never a silent restart.

### Sessions and recovery

- Session metadata carries `schemaVersion` and migrates forward; a newer
  unknown schema is refused rather than misread.
- `start --resume auto|required|never` controls worker-restart recovery, and a
  session is reported `recovered` only when the backend confirmed the resume.
- `cleanup` pings every recorded worker, marks dead ones `orphaned`, removes
  stale control endpoints, and kills a leftover backend process only when the
  live pid still carries the recorded backend command and process start marker;
  an unverifiable identity is reported as `orphanBackendUnverified` and left running.

### Security

- Every control request requires the session's `control.token`; a missing or
  wrong token fails with `control_unauthorized`.
- `RELAYROOK_ROUTE` delegation envelopes are signed with an HMAC key scoped to
  the state directory; unsigned, malformed, or foreign envelopes fail with
  `route_envelope_invalid`.
- Caller ids accept any normalized host id; known hosts keep explicit
  detection, and environment markers are recorded as evidence, not proof.

### Preflight and platforms

- `preflight` checks Node version, process spawning, state-dir write access,
  control transport, backend executables, adapter readiness and pinned-version
  match, and returns typed blockers such as `local_execution_unavailable`. The
  command's `ok` means the report was produced; `passed` carries the verdict,
  so a blocked environment exits 0 with a readable report. `start` fails with
  the typed blockers when preflight cannot pass.
- macOS, Linux and Windows are supported: Unix uses private sockets, Windows
  uses a named pipe guarded by the per-session control token, and `.cmd`
  shims spawn correctly and stop through process-tree termination. CI runs the
  suite on all three.
- The installed skill is self-locating: `bin/relayrook` (and `relayrook.cmd`
  on Windows) resolve the bundled runtime from the skill subtree, so commands
  work from any current directory and paths with spaces.

### Routing evidence

- `route` reads `<state>/route-evidence.json`: measured results
  (`runs >= 2`, success rate, precision) score on top of configured weights,
  and the response distinguishes `configured-preference` from
  `measured+configured`.
- `evals/run.mjs` drives held-out implementation, code-review, and
  security-review fixtures through the real CLI, scores checks and
  seeded-finding precision/recall, enforces scope compliance, and records
  latency and usage per run. Runs are reported as pass, fail, or skip; skips
  are never counted.
- Turn usage normalizes into one canonical record — uncached, cached and
  cache-write input, output and reasoning tokens, totals, event count,
  latency, and the latest rate-limit snapshot — with the provider payload
  preserved under `raw` and unreported fields left `null`. Evidence entries
  carry means of each dimension across runs, so repeated `--runs N`
  invocations build comparisons that count as measured at the existing
  `runs >= 2` threshold.

## 0.1.0

First release: discovery, routing, and persistent ACP sessions for Devin,
Kiro, OpenCode, and Claude Code; Codex discovery only.
