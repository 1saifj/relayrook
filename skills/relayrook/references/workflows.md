# RelayRook command reference

Every command prints one JSON object. Success is `{"ok": true, ...}`; failure is
`{"ok": false, "error": {"code", "message", "details"}}` on stderr with exit
code 1.

## Commands

| Command | Purpose | Key options |
| :--- | :--- | :--- |
| `doctor` | Caller evidence, installed backends, adapter readiness, configured routes | `--compact`, `--probe`, `--caller`, `--state-dir` |
| `preflight` | Capability checks without starting a session | `--backend`, `--caller`, `--state-dir` |
| `route` | Choose a backend/model/effort for a role | `--role`, `--agent`, `--model`, `--effort`, `--avoid`, `--allow-provider`, `--prefer-provider` |
| `start` | Create or reuse a persistent session | `--backend`/`--agent` or `--role`, `--workspace`, `--model`, `--effort`, `--profile`, `--resume`, `--sandbox`, `--approval-policy`, `--no-reuse` |
| `prompt` | Submit one turn | `--session`, `--text` or (`--role` and `--task`), `--scope`, `--check`, `--stall-timeout`, `--stall-action`, `--timeout` |
| `steer` | Add input to the in-flight turn (Codex `turn/steer` only) | `--session`, `--text` |
| `review` | Run a native review turn (Codex `review/start` only) | `--session`, `--target`, `--branch`, `--commit`, `--instructions`, `--delivery` |
| `status` | Session state plus events from a cursor | `--session`, `--cursor`, `--limit`, `--turn`, `--full` |
| `wait` | Poll to a terminal turn state or a reported stall | `--session`, `--cursor`, `--timeout`, `--poll`, `--events`, `--full`, `--through-stall` |
| `extend` | Give the active turn more watchdog budget | `--session`, `--stall-timeout`, `--stall-action`, `--timeout`, `--reset-deadline` |
| `cancel` | Cancel the active turn | `--session`, `--turn` |
| `permission` | Answer a pending permission request | `--session`, `--request`, `--option` or `--cancel` |
| `stop` | Stop the session worker | `--session` |
| `cleanup` | Reap dead workers and stale control endpoints | `--state-dir` |
| `sessions` | List known sessions | — |
| `bootstrap` | Install a pinned adapter package | `--backend`, `--dry-run` |
| `prompt-preview` | Print the prompt a role would send | `--role`, `--task`, `--workspace`, `--scope`, `--check` |
| `parse-result` | Extract the `relayrook-result` block from a reply | `--file` or `--text` |

`preflight` returns one check per capability — `node`, `localExecution`,
`stateDir`, `transport`, and per backend `executable`, `adapter`, `model` —
each with `ok` and, on failure, a typed `code` such as
`local_execution_unavailable` or `transport_unavailable`. Blockers are listed
separately from passing checks so a host can act on them. The command's
top-level `ok` means the report was produced; `passed` carries the capability
verdict, so a blocked environment still exits 0 with a readable report.

For ordinary delegation, run `doctor --compact` once and then use `route
--role <role>` for selection. Do not derive a selection by parsing `doctor`.
Both full and compact doctor responses represent `backends` and `routes` as
arrays. Compact doctor uses schema `relayrook.doctor.compact.v1`, keeps only
host-relevant readiness fields, configured installed candidates, warnings and
active-session summaries; full doctor retains diagnostic evidence. A backend's
`version` is the version of the thing RelayRook would launch, and is `null`
when it cannot launch it; where only the base CLI is present — Claude Code
without its pinned adapter — that version is reported as `hostVersion`.

`--resume` controls worker-restart recovery: `auto` resumes the backend-native
session where the backend supports it, `required` fails with
`session_not_resumable` when it cannot, and `never` starts fresh. A session is
reported as `recovered` only when the backend confirmed the resume.

Codex sessions accept `--sandbox read-only|workspace-write|danger-full-access`
and `--approval-policy never|on-request|untrusted`; both flags fail with
`capability_unsupported` on any other backend. Review and security-review roles
default to the `read-only` profile, which maps onto a read-only Codex sandbox
with approvals off. The posture is enforced at prompt time too: `prompt --role
code-review` against a Codex session whose recorded sandbox is not `read-only`
fails with `role_posture_mismatch` rather than letting a reviewer write without
a permission request reaching the parent. Native `review` applies the same
posture check before calling `review/start`.

## Orchestration

RelayRook moves work; the caller keeps ownership of it.

- **Delegate only when useful.** A second agent earns its cost when it adds
  independence (a reviewer that did not write the code), a capability or
  subscription the caller lacks, or a bounded task that runs while the caller
  continues. Answering a question or making a small edit directly is faster
  and cheaper.
- **The caller owns the whole.** Architecture, decomposition into bounded
  tasks, integration of results and final verification stay with the caller.
  A delegated `complete-*` claim is input to that verification, not a
  substitute for it.
- **Bounded task contracts.** Each delegation states the task, the files or
  directories it may touch, the evidence to return (diff summary, commands
  run, findings), and the checks that must pass. `prompt --scope` bounds the
  workspace view; the role contract bounds the reply.
- **Non-overlapping writers.** Parallel implementation sessions own disjoint
  files. Two agents editing the same file produce lost updates that no later
  review can fully repair; split the work or sequence it.
- **Independent read-only review.** The review roles run read-only by
  default, so the reviewer cannot fix what it finds — findings stay
  measurable, and the caller decides what to apply.
- **Separate verification.** Builds, tests and checks run against the
  integrated tree after delegated work lands. `evals/run.mjs` follows the
  same rule: a run scores from observed outcomes — check exit codes,
  file-level diffs, seeded-finding recall — never from the agent's
  self-report.

## Permission request classification

Every pending permission carries a `classification` alongside the agent's own
options, so a parent decides on evidence instead of on a title:

| Field | Meaning |
| :--- | :--- |
| `action` | `read`, `edit`, `execute`, `network` or `other` |
| `command` | The shell command, read from `rawInput.command`, vendor `_meta` (Devin leaves `title` null and writes it there), content blocks or the title |
| `paths` | Paths named by the request, from `locations`, `rawInput` and the command text |
| `outsideWorkspace` | An absolute path outside the session workspace is involved; `/tmp` and `/private/tmp` are the same directory |
| `destructive` | `rm -rf`, `git push`, `git reset --hard`, `sudo`, `npm publish` and similar |
| `network` | The action leaves this machine |
| `touchesSecrets` | The target looks like a credential (`.env`, `~/.ssh`, `credentials`) |
| `allowlisted` | The command matches the positive allowlist of read-only and build/test commands; every segment of a compound command must match, and substitution or redirection disqualifies it |
| `recommendation` | `allow` only when none of the above fired, the request named something judgeable, and an execute request is allowlisted; otherwise `ask-user`, with `reasons` |

Paths are resolved against the workspace before comparison, so `../outside`,
`<workspace>/../outside`, `~/x` and a Windows absolute path are all escapes
rather than "not absolute, therefore inside"; `/tmp` and `/private/tmp` are the
same directory.

The recommendation is deliberately timid and never names an option: relay only
options the agent advertised, and treat `allow` as "nothing suspicious was
found", not as consent. `evals/run.mjs --auto-answer` uses exactly this
classification to run unattended in a disposable fixture workspace.

## Turn watchdogs

A turn is judged by whether the backend is still saying anything, never by how
long the work has taken. Two independent watchdogs enforce that, and each is
disabled by passing `0`:

| Watchdog | Flag | Default | Fires when |
| :--- | :--- | :--- | :--- |
| Inactivity | `--stall-timeout <ms>` | 600000 (10 min) | The backend produced no event at all for the whole window |
| Wall clock | `--timeout <ms>` | 3600000 (60 min) | The turn has run that long, however busy it is |

Any backend-originated event — text, thought, tool call, plan, diff, usage or a
permission request — restarts the inactivity window. A turn paused on a
permission request is waiting for the parent, not silent, so it is never
counted as stalled.

A stall is reported, not fatal. `--stall-action report` (the default) emits
`turn_stalled`, leaves the turn running and returns from `wait` with
`waitOutcome: "stalled"`, so the parent can steer, extend, cancel, or simply
wait again for the next window. `--stall-action cancel` restores kill-on-silence
for a host that cannot poll. Only the wall-clock backstop ends a busy turn on
its own.

`extend` changes the budget of the turn already in flight: `--timeout` and
`--stall-timeout` set new values, `--reset-deadline` restarts the wall clock
from now, and any extend clears a reported stall. Every turn summary carries a
`watchdog` block — `silentMs`, `stalled`, `stallCount`, `remainingMs`,
`deadlineAt`, `timeoutKind` — so liveness is readable without inferring it from
event timestamps.

## Turn states

| State | Meaning |
| :--- | :--- |
| `running` | The backend accepted the prompt and has not finished |
| `awaiting-permission` | Paused on a tool request; only the parent can unblock it |
| `completed` | The backend returned a terminal `stopReason` other than `cancelled` |
| `cancelled` | The backend confirmed `stopReason: cancelled` |
| `failed` | Transport error, protocol error, or a missing `stopReason` |
| `timed-out` | A watchdog fired and cancellation was requested; `watchdog.timeoutKind` is `stall` or `deadline` |

A turn state is never derived from a process exit code. A print-mode agent can
exit 0 after a denied tool call, so only the protocol's stop reason counts.

## Stop reasons

Backend reasons pass through unchanged: `end_turn`, `max_tokens`,
`max_turn_requests`, `refusal`, `cancelled`. RelayRook adds
`relayrook_timeout`, `relayrook_process_exited` and `relayrook_protocol_error`
for conditions the backend never reported. `relayrook_timeout` covers both
watchdogs; read `watchdog.timeoutKind` to tell a silent backend (`stall`) from
one that simply ran out of wall clock (`deadline`).

## Backend errors

A backend can report an error mid-turn and then finish the turn as `failed`
with nothing attached — Codex out of credits does exactly that, and a caller
told only "failed" re-runs work that cannot succeed. RelayRook keeps the
provider's own message on the turn as `backendError` and, when the failure
would otherwise be bare, promotes it into `turn.error` with a category:

| Category | `retryable` | `reroute` | Meaning |
| :--- | :--- | :--- | :--- |
| `quota` | no | yes | The subscription is exhausted. Route the work to another backend. |
| `rate-limit` | yes | no | Slow down and retry the same backend. |
| `auth` | no | yes | The backend is not authenticated; the user must fix it. |
| `unknown` | yes | no | Unrecognised; the provider's text is preserved verbatim. |

## Events and cursors

Events are appended with a monotonic `cursor`. Pass the previous response's
`nextCursor` to read only what is new. Retention is bounded at 2000 events; if
your cursor predates the retained window the response sets `cursorGap: true`, so
a gap is always visible rather than silently skipped. Per-event text is capped at
8 KiB with `truncated: true`; the full text stays in
`<state>/sessions/<key>/turns/<turnId>/`.

Event kinds: `session_ready`, `session_recovered`, `session_not_resumable`,
`turn_started`, `steered`, `text`, `thought`, `tool_call`, `tool_call_update`,
`plan`, `diff`, `usage_update`, `model_rerouted`, `rate_limits`, `permission`,
`permission_resolved`, `cancel_requested`, `turn_stalled`, `turn_resumed`,
`turn_extended`, `turn_timeout`, `turn_finished`, `error`, `session_stopping`,
`agent_update`, `agent_notification`.

`turn_stalled` carries `silentMs`, `stallCount` and the configured `action`;
`turn_resumed` follows when the backend speaks again; `turn_timeout` carries
`reason: "stall" | "deadline"`.

`wait` stays compact by default: it returns `eventCount` without replaying raw
events, and when `parsedResult.ok` is true it omits the duplicate answer text.
Pass `--events` for event replay and `--full` for the full answer plus model and
mode discovery metadata. `status` keeps event paging but also needs `--full` for
the complete discovery metadata.

## Turn usage

When a backend reports usage, the turn summary carries one normalized record
with the provider payload preserved verbatim under `raw`:

| Field | Meaning |
| :--- | :--- |
| `uncachedInputTokens` | reported input minus cached and cache-write input |
| `cachedInputTokens` | input served from the provider's cache |
| `cacheWriteInputTokens` | input written to the provider's cache |
| `outputTokens` | generated output tokens |
| `reasoningOutputTokens` | output spent on reasoning, where reported |
| `totalTokens` | the provider's reported total |
| `contextUsedTokens` / `contextWindowTokens` | context-window occupancy |
| `eventCount` | usage events observed during the turn |
| `latencyMs` | wall-clock turn latency |
| `rateLimits` | latest provider rate-limit snapshot, or null |

A field the provider did not report is `null` — never zero, never estimated;
a zero means the provider reported zero. Codex reports cumulative counters on
`thread/tokenUsage/updated` and rate-limit snapshots as `rate_limits` events.
ACP agents that send `session/usage_update` report context-window occupancy,
which maps to the context fields rather than billing totals. A backend that
reports nothing yields all-null fields with `raw: null`.

## Permissions

RelayRook advertises no filesystem or terminal capability to the agent, so tool
requests arrive as `session/request_permission` and pause the turn. The parent
must inspect the concrete request and choose one advertised `optionId`; anything
else fails with `permission_option_invalid`. Existing user authorization can
cover routine actions within the delegated task. Ask the user when the request
exceeds that scope or is consequential and irreversible. There is no blanket
approval flag. `permission --cancel` declines, and the turn continues with the
agent's own handling of a refused tool.

## Error codes

`usage`, `unknown_command`, `unknown_backend`, `unknown_role`,
`backend_not_installed`, `adapter_not_ready`,
`session_control_not_implemented`, `session_not_found`, `session_not_running`,
`worker_start_failed`, `active_turn`, `no_active_turn`, `turn_timeout`,
`permission_not_pending`, `permission_option_invalid`, `pin_unsatisfiable`,
`no_eligible_route`, `recursion_depth_exceeded`, `recursive_backend`,
`caller_ambiguous`, `route_envelope_invalid`, `protocol_error`, `line_overflow`,
`process_exited`, `model_rejected`, `bootstrap_failed`, `state_error`,
`local_execution_unavailable`, `node_version_unsupported`,
`transport_unavailable`, `unsupported_backend_version`,
`adapter_version_mismatch`, `session_not_resumable`, `capability_unsupported`,
`role_posture_mismatch`, `control_unauthorized`.

## State layout

State lives outside the target repository, at `$RELAYROOK_STATE_DIR`,
`$XDG_STATE_HOME/relayrook`, or `~/.local/state/relayrook`.

```text
<state>/
  probe-cache.json
  route-integrity.key            HMAC key that signs delegation envelopes (0600)
  route-evidence.json            optional measured route evaluation results
  adapters/                      pinned adapter packages installed by bootstrap
  sessions/<key>/
    meta.json                    crash-safe metadata (atomic write + rename, schemaVersion 2)
    request.json                 the launch spec
    events.jsonl                 bounded, cursor-addressable event log
    control.sock                 worker control socket (Unix) or named pipe (Windows)
    control.token                per-session token required by every control call
    worker.log                   worker diagnostics
    turns/<turnId>/              prompt.txt, events.jsonl, answer.txt, result.json
```

The session key is a hash of backend, workspace, model, effort and profile, so
an identical `start` reuses the warm worker. Reuse is confirmed by pinging the
control socket — a leftover socket file is not treated as a live worker. Every
control request must carry the session's `control.token`; a missing or wrong
token fails with `control_unauthorized`. On Unix the socket file is created
mode 0600; on Windows the pipe namespace is machine-wide, so the per-session
`control.token` — itself protected by the user-profile ACL — is the access
control, and every control call must carry it. `cleanup` pings every recorded
worker, marks dead ones `orphaned`, removes their stale endpoints, and kills
an orphaned backend process only when the live pid carries both the recorded
command name and process start marker — an identity it cannot verify is reported as
`orphanBackendUnverified` and left alone.

## Caller and recursion

Precedence: explicit `--caller`, then router-owned delegation metadata carried
in `RELAYROOK_ROUTE`, then host environment signals plus the parent process
name, then `unknown` with a reason. Conflicting host signals produce
`ambiguous: true` with the candidates listed.

Each delegation increments `depth` and appends the backend to `ancestry`.
Depth reaching `--max-depth` (default 3) fails with `recursion_depth_exceeded`;
a backend already in the ancestry is rejected unless `--allow-repeat-backend`.

`RELAYROOK_ROUTE` is the route envelope: JSON carrying the root caller, the
parent, depth, ancestry and an HMAC-SHA256 signature over those fields. The
signature is minted with `route-integrity.key`, a 32-byte per-state-directory
key. An envelope that fails verification — unsigned, malformed, or signed for
a different state directory — is refused with `route_envelope_invalid`, so a
forged or inherited envelope can never pass as trusted ancestry. The trust
boundary is the state directory: anything that can read `route-integrity.key`
can mint a valid envelope, which is why the key is created mode 0600 and state
stays outside the repository.

## Route evidence

`route` scores each candidate from its configured weight, whether a verified
turn is on record, and whether the backend's provider family differs from the
caller's. On top of that, `<state>/route-evidence.json` can carry measured
results keyed `role|backend|model|effort` with `runs`, `successRate` and
`precision`. A route counts as measured at `runs >= 2`; below that it is
anecdotal and does not shift the score. When at least one candidate is
measured, the response `evidenceBasis` is `measured+configured`; otherwise it
is `configured-preference`. `evals/run.mjs` writes this file from held-out
task results.

Each eval run records success, precision and recall against seeded findings,
scope compliance (a change outside the fixture's allowed files fails the run),
turn latency, and the normalized usage record. Entries merge across
invocations, so `--runs N` — or repeated calls — builds comparisons per
route key; aggregated `scopeComplianceRate`, `meanLatencyMs` and token means
average only the runs that reported them, and stay `null` when none did.
Skipped runs never count.

There is no generic quality/balanced/speed objective. A speed- or
quality-biased selection is only honest once measured latency, usage and
accuracy span at least two eligible routes for the same role; until the
evidence file carries that, such an objective would be an invented weight, so
it stays future work.

## Testing hook

`RELAYROOK_BACKEND_CMD_<BACKEND>` overrides a backend's launch argv with a JSON
array, e.g. `RELAYROOK_BACKEND_CMD_DEVIN='["node","/path/to/stub.mjs"]'`. It
exists for tests and wrapper scripts; normal use needs no override.
