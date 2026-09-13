# Changelog

## Unreleased

### Turn watchdogs

A turn is now judged by whether the backend is still producing anything, not by
how long the work has taken. The old single 20-minute wall-clock timer
cancelled healthy long-running delegations — a Devin or Kiro implementation
that was actively streaming at minute 21 was killed and reported as
`relayrook_timeout`.

- **Inactivity watchdog** (`--stall-timeout`, default 10 minutes). Any
  backend-originated event restarts the window. A turn paused on a permission
  request is waiting for the parent, not silent, and is never counted as
  stalled.
- **Stalls are reported, not fatal.** The default `--stall-action report` emits
  `turn_stalled`, keeps the turn running, and returns from `wait` with
  `waitOutcome: "stalled"` so the parent can steer, extend or cancel with more
  context than a timer has. `--stall-action cancel` restores kill-on-silence.
- **Wall clock is a backstop** (`--timeout`, default 60 minutes, `0` disables)
  for a turn that keeps producing output forever. `turn_timeout` now carries
  `reason: "stall" | "deadline"` and the turn summary carries `watchdog`
  (`silentMs`, `stalled`, `stallCount`, `remainingMs`, `deadlineAt`,
  `timeoutKind`).
- **`extend`** changes the budget of a turn already in flight, so a reported
  stall or an approaching deadline no longer forces a re-prompt.

### Permission postures

`start --permission-mode read-only|gated|auto-edits|full-auto` maps one
vocabulary onto each backend's own permission system, and the session reports
which mechanism actually holds the posture — `backend-sandbox`, `parent-gated`
or `prompt-only` — so a caller is never told a session is read-only when only
the prompt says so.

- Devin read-only launches `devin acp --agent-type review`, an agent with no
  edit tool, and sets `DEVIN_PERMISSION_MODE`; OpenCode postures are written as
  an `OPENCODE_CONFIG` permission file in the session directory; Claude uses
  `ACP_PERMISSION_MODE`; Codex keeps the sandbox and approval-policy mapping.
- Only Codex claims `backend-sandbox`. Live evidence corrected the rest:
  OpenCode with `edit: deny` wrote the file through `cat > file <<'EOF'`
  instead, arriving as a `bash` permission request. Withholding an edit tool
  is `parent-gated`, not a sandbox, and the docs say why that distinction
  changes how a reviewer should read a bash request.
- Kiro reports `auto-edits` as `requestedUnsupported` rather than pretending:
  it trusts tools by name, not by category.
- The posture is part of the session key, so reusing a warm worker can never
  widen what a delegated agent may do, and review roles refuse to start with an
  ungated mode.
- `references/providers.md` documents each backend's lever; `SKILL.md` says
  when to pick each mode and how to decide a single permission request.

### Backend failures explain themselves

A backend can report an error mid-turn and then finish the turn as `failed`
with nothing attached. Codex out of credits does exactly that: the reply reads
"Review was interrupted. Please re-run" while the real cause — "You've hit your
usage limit" — arrived in a separate notification. The provider's message is
now kept on the turn as `backendError` and promoted into `turn.error` when the
failure would otherwise be bare, with a category (`quota`, `rate-limit`,
`auth`, `unknown`) and `retryable` / `reroute` flags, so a host re-routes
instead of re-running work that cannot succeed.

### Fixed

- **A command's own `ok` field could overwrite the success envelope.** The CLI
  built its response as `{ok: true, ...result}`, so `parse-result` on a reply
  with no result block returned `ok: false` with exit code 0 — a host reading
  `.ok` saw a failed command, a host reading the exit code saw success. The
  envelope is now authoritative and `parse-result` reports `found`.
- **A missing workspace was blamed on the backend.** `start --workspace` into a
  directory that does not exist failed with `spawn /path/to/devin ENOENT`,
  which reads as a missing CLI. The workspace is checked before anything is
  spawned.
- **A refused resume locked the caller out of the session.** An agent that
  advertises `loadSession` and then rejects `session/load` — what a real agent
  does once its stored session has expired — made every subsequent `start`
  fail with `worker_start_failed`, with no way back into that workspace short
  of `--resume never` or deleting state. `auto` now records the refusal
  (`resume.lastAttempt.ok: false`, a `session_not_resumable` event) and
  continues on a fresh native session; `required` still fails closed.
- **Orphan cleanup could kill an unrelated process.** On macOS, process
  identity was read with `ps -o comm= -o lstart=`, and BSD `ps` pads every
  column but the last — so the recorded command was truncated to 16 characters
  and two different binaries in the same directory compared equal. Identity now
  reads `comm` last and keeps the whole path.

## 0.2.1

Agent-host discovery uses `doctor --compact`, a stable small schema containing
caller identity, readiness, backend arrays, configured route summaries,
warnings, and active-session summaries. Route selection stays in `route
--role`; hosts no longer need to parse the diagnostic doctor report or infer
its collection shapes. The supported global installation command names the
five RelayRook hosts explicitly so the installer does not include agents that
lack global skill directories.

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
