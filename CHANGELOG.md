# Changelog

## Unreleased

### Classifier false positives from a live review

A session driving two Kiro reviews hit enough false flags that it replaced
RelayRook's classification with its own allow-by-default gate — one that
approved every non-execute request, edits included, in a read-only review.
The flags that drove it there were wrong:

- `tool --version >/dev/null 2>&1` read as destructive: redirecting into
  `/dev` was matched without exempting `/dev/null`, `/dev/stdout`,
  `/dev/stderr` and `/dev/tty`.
- `/opt/homebrew/bin/shellcheck src/x.sh` read as a workspace escape: the
  program word was treated as a target. Tools addressed by their install
  directory are now judged as the bare tool; a script run from anywhere else
  still asks.
- A file read whose content contained a URL read as a network call, and the
  URL became the path `//`: content blocks were treated as the command.
  Content now counts only when it declares itself a shell command, and a URL
  is never a path.
- Code that mentioned `curl` or `rm -rf` inside an edit's new file body was
  judged as those commands. Evidence is now the request's command, title and
  options, not the file body.
- `process.env` read as a `.env` file, while
  `application_default_credentials.json` was not recognised as a credential
  at all. Secret detection is now path-shaped.

The allowlist also gained version and help lookups, common linters, and shell
grammar around listed commands. In the other direction it now refuses commands
that carry a second one inside a listed first word — `env sh -c`,
`awk 'BEGIN{system(...)}'`, `find -exec` and `-delete`, backticks and `$VAR`
expansion — and code evaluated through `node -p`, `--print`, `-r`,
`--require`, `--import` and `--loader`, not just `-e`. A read or edit request
that does not name the file it touches is never recommended.

### Host denials

`SKILL.md` now tells a host what to do when its own permission system refuses
a RelayRook command — Claude Code's auto mode does exactly that. A session
that hit the denial retried under a different `--permission-mode`, then tried
to write its own settings file to allow the call. The skill now says to stop,
never to grant the permission itself, and to hand the user the exact allow
rule along with what it permits.

### Fixes from an independent review

RelayRook delegated a read-only review of its own 0.3.0 changes to Kiro on
`gpt-5.6-sol` at effort `max`, through its own gated session. Nine findings,
all confirmed:

- **A widened Codex session could be reused by a plain one.** The session key
  carried the permission mode's *name* but not the effective sandbox and
  approval policy, so a `gated` start could attach to a warm
  `danger-full-access` worker. Both are now part of session identity.
- **`read-only` pinned to a wider sandbox still reported `parent-gated`.**
  The mapped `approvalPolicy: never` survived the override, so nothing
  sandboxed the session and nothing asked. Enforcement is now derived from the
  effective sandbox/approval pair, and the posture reports `reviewSafe`.
- **A review role could be prompted into an ungated ACP session.** The posture
  check only covered Codex; it now reads the recorded posture for every
  backend, at start and at prompt time.
- **Classification treated relative and Windows paths as inside the
  workspace.** `../outside.txt`, `<workspace>/../outside`, `~/x` and
  `C:\Windows\...` were all "not absolute, therefore fine". Paths are now
  resolved against the workspace before comparison.
- **Absence from a blacklist was treated as safety.** `git restore .` and
  `gh pr create` were recommended. A shell command is now recommended only
  when every segment matches a positive allowlist, and substitution or
  redirection disqualifies it.
- **A resumed turn inherited the time it spent awaiting permission.** A stall
  timer armed before the pause could fire moments after the parent answered
  and cancel a turn that had just resumed.
- **Provider error codes were dropped.** `{message, code: "insufficient_quota"}`
  classified as `unknown`; sibling code fields are now kept and canonical
  underscore/hyphen codes are matched.
- **The eval runner stopped a session it said it was leaving for a person**,
  and merged route evidence measured under different permission postures.
  Posture and auto-answer policy are now part of evidence identity.

## 0.3.0

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

### Permission requests arrive classified

A pending permission now carries a `classification`: the action, the command
(read from wherever the backend put it — Devin leaves `title` null and writes
it into vendor `_meta`), the paths involved, and whether anything leaves the
workspace, destroys data, reaches the network or touches a credential, with a
timid `allow` / `ask-user` recommendation and its reasons. `/tmp` and
`/private/tmp` are treated as the same directory, so a macOS temp workspace is
not read as an escape, and an agent's own option names can never widen what
counts as inside the workspace.

`evals/run.mjs` gained `--permission-mode` and `--auto-answer`, which uses that
classification to run unattended in a disposable fixture workspace and records
every decision on the run. Before this, an implementation eval could not
complete without a person answering each request: the Devin pagination fixture
now passes end to end with `check: pass` and only the fixture file changed.

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
- **Compact doctor contradicted itself.** A backend that cannot be launched
  reported `installed: false` beside the base CLI's version number — Claude
  Code without its pinned adapter read as both missing and present. `version`
  now describes the thing RelayRook would launch and the host CLI's version is
  reported as `hostVersion`.
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
