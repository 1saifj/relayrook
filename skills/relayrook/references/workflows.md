# RelayRook command reference

Every command prints one JSON object. Success is `{"ok": true, ...}`; failure is
`{"ok": false, "error": {"code", "message", "details"}}` on stderr with exit
code 1.

## Commands

| Command | Purpose | Key options |
| :--- | :--- | :--- |
| `doctor` | Caller evidence, installed backends, adapter readiness, configured routes | `--probe`, `--caller`, `--state-dir` |
| `route` | Choose a backend/model/effort for a role | `--role`, `--agent`, `--model`, `--effort`, `--avoid`, `--allow-provider`, `--prefer-provider` |
| `start` | Create or reuse a persistent session | `--backend`/`--agent` or `--role`, `--workspace`, `--model`, `--effort`, `--profile`, `--no-reuse` |
| `prompt` | Submit one turn | `--session`, `--text` or (`--role` and `--task`), `--scope`, `--check`, `--timeout` |
| `status` | Session state plus events from a cursor | `--session`, `--cursor`, `--limit`, `--turn`, `--full` |
| `wait` | Poll to a terminal turn state | `--session`, `--cursor`, `--timeout`, `--poll`, `--events`, `--full` |
| `cancel` | Cancel the active turn | `--session`, `--turn` |
| `permission` | Answer a pending permission request | `--session`, `--request`, `--option` or `--cancel` |
| `stop` | Stop the session worker | `--session` |
| `sessions` | List known sessions | — |
| `bootstrap` | Install a pinned adapter package | `--backend`, `--dry-run` |
| `prompt-preview` | Print the prompt a role would send | `--role`, `--task`, `--workspace`, `--scope`, `--check` |
| `parse-result` | Extract the `relayrook-result` block from a reply | `--file` or `--text` |

## Turn states

| State | Meaning |
| :--- | :--- |
| `running` | The backend accepted the prompt and has not finished |
| `awaiting-permission` | Paused on a tool request; only the parent can unblock it |
| `completed` | The backend returned a terminal `stopReason` other than `cancelled` |
| `cancelled` | The backend confirmed `stopReason: cancelled` |
| `failed` | Transport error, protocol error, or a missing `stopReason` |
| `timed-out` | RelayRook's turn timeout fired and cancellation was requested |

A turn state is never derived from a process exit code. A print-mode agent can
exit 0 after a denied tool call, so only the protocol's stop reason counts.

## Stop reasons

Backend reasons pass through unchanged: `end_turn`, `max_tokens`,
`max_turn_requests`, `refusal`, `cancelled`. RelayRook adds
`relayrook_timeout`, `relayrook_process_exited` and `relayrook_protocol_error`
for conditions the backend never reported.

## Events and cursors

Events are appended with a monotonic `cursor`. Pass the previous response's
`nextCursor` to read only what is new. Retention is bounded at 2000 events; if
your cursor predates the retained window the response sets `cursorGap: true`, so
a gap is always visible rather than silently skipped. Per-event text is capped at
8 KiB with `truncated: true`; the full text stays in
`<state>/sessions/<key>/turns/<turnId>/`.

Event kinds: `session_ready`, `turn_started`, `text`, `thought`, `tool_call`,
`tool_call_update`, `plan`, `usage_update`, `permission`, `permission_resolved`,
`cancel_requested`, `turn_timeout`, `turn_finished`, `error`,
`session_stopping`, `agent_update`, `agent_notification`.

`wait` stays compact by default: it returns `eventCount` without replaying raw
events, and when `parsedResult.ok` is true it omits the duplicate answer text.
Pass `--events` for event replay and `--full` for the full answer plus model and
mode discovery metadata. `status` keeps event paging but also needs `--full` for
the complete discovery metadata.

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
`route_envelope_invalid`, `protocol_error`, `line_overflow`, `process_exited`, `model_rejected`,
`bootstrap_failed`, `state_error`.

## State layout

State lives outside the target repository, at `$RELAYROOK_STATE_DIR`,
`$XDG_STATE_HOME/relayrook`, or `~/.local/state/relayrook`.

```text
<state>/
  probe-cache.json
  adapters/                      pinned adapter packages installed by bootstrap
  sessions/<key>/
    meta.json                    crash-safe metadata (atomic write + rename)
    request.json                 the launch spec
    events.jsonl                 bounded, cursor-addressable event log
    control.sock                 worker control socket
    worker.log                   worker diagnostics
    turns/<turnId>/              prompt.txt, events.jsonl, answer.txt, result.json
```

The session key is a hash of backend, workspace, model, effort and profile, so
an identical `start` reuses the warm worker. Reuse is confirmed by pinging the
control socket — a leftover socket file is not treated as a live worker.

## Caller and recursion

Precedence: explicit `--caller`, then router-owned delegation metadata carried
in `RELAYROOK_ROUTE`, then host environment signals plus the parent process
name, then `unknown` with a reason. Conflicting host signals produce
`ambiguous: true` with the candidates listed.

Each delegation increments `depth` and appends the backend to `ancestry`.
Depth reaching `--max-depth` (default 3) fails with `recursion_depth_exceeded`;
a backend already in the ancestry is rejected unless `--allow-repeat-backend`.

## Testing hook

`RELAYROOK_BACKEND_CMD_<BACKEND>` overrides a backend's launch argv with a JSON
array, e.g. `RELAYROOK_BACKEND_CMD_DEVIN='["node","/path/to/stub.mjs"]'`. It
exists for tests and wrapper scripts; normal use needs no override.
