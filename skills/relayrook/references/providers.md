# Backend behaviour

Recorded from local research on 2026-09-13 (macOS). Model inventories are
availability hints: a saved credential is not proof of remaining quota, and an
advertised model is weaker evidence than a completed turn.

## Devin — `devin acp`

- Native ACP. Session control implemented and exercised live: prompts, file
  edits, shell permission prompts, resume, cancellation.
- Model is set at launch (`--model`) and defaults to `swe-2-max`. RelayRook
  preserves that pin unless the caller passes `--model` explicitly.
- Permission options observed include `allow_once`, `allow_session`,
  `allow_always`, plus a global variant. Options vary per request; always read
  them from the pending request rather than assuming a fixed set.
- Metadata style: `configOptions`.

## Kiro — `kiro-cli acp`

- Native ACP. Legacy metadata: `session/new` returns
  `models.currentModelId` and `models.availableModels`, not `configOptions`.
- Model and effort are launch flags (`--model`, `--effort`). The session response
  omits effort, then `_kiro.dev/metadata` reports it. RelayRook verifies that
  observed value and records `support: "agent-notification"`.
- `modes` names agent profiles here, not permission modes. The same field name
  means something different on Claude.
- A completed turn with `claude-opus-5` is on record for this machine.

## OpenCode — `opencode acp`

- Native ACP with `configOptions`. A new session picked a different default
  model from the global configuration, so RelayRook always selects the model
  with `session/set_config_option` and requires the readback to match. A
  mismatch is `model_rejected`, never a silent substitution.
- OpenCode Go is a provider subscription inside the authenticated OpenCode
  client, addressed with `opencode-go/<model>` IDs. No key is extracted and no
  custom proxy is used.
- A completed turn with `opencode-go/kimi-k2.7-code` is on record. One smoke
  turn reported 70,414 input tokens for 5 output tokens, which makes startup
  context composition worth measuring before tuning.

## Claude Code — `@agentclientprotocol/claude-agent-acp`

- The base `claude` CLI has no `acp` subcommand. The adapter is a separate
  package, pinned to `0.76.0`, installed by `relayrook bootstrap --backend
  claude` into the state directory — never into the skill or the repository.
- Metadata style: `configOptions`, including a `mode` option whose values are
  permission modes (`default`, `acceptEdits`, `plan`, `auto`,
  `bypassPermissions`) and a `model` option.
- The adapter advertised a steering extension and prompt queueing. RelayRook
  does not use either, and does not present cancellation as equivalent to
  steering.
- Session creation, `opus[1m]`, `max` effort, and a completed inference turn
  were verified through RelayRook.

## Codex — `codex app-server --stdio`

- Native app-server protocol over stdio JSON-RPC. The server omits the
  `jsonrpc` envelope field; the adapter accepts both framed and bare replies.
- A RelayRook session is a Codex **thread**: `thread/start` opens it,
  `thread/resume` restores it after a worker restart, and `thread/read`
  re-reads it. Model and reasoning effort are requested on the thread and read
  back from the `thread` object — an unconfirmed substitution fails the start
  with `model_rejected`.
- A prompt is `turn/start`; streamed events arrive as `item/*` notifications
  and the turn ends on `turn/completed`. `turn/steer` feeds additional input
  to the in-flight turn (`steer` command) and `turn/interrupt` cancels it
  (`cancel`). `review/start` runs Codex's native review (`review` command)
  against uncommitted changes, a base branch, a commit, or custom
  instructions.
- Sandbox and approval policy map onto app-server values; review roles run
  with a read-only sandbox and approvals off unless overridden.
- Approval and permission requests surface as pending permissions with the
  advertised options; v1 (`execCommandApproval`/`applyPatchApproval`) and v2
  (`item/tool/call`) request shapes are both mapped.
- A method-not-found reply means the installed Codex predates the v2 surface —
  reported as `unsupported_backend_version`, not a generic protocol error.
  Verified against Codex `0.153.4`.
- `account/read` is reduced to a presence flag and an account type. No
  identifier, e-mail, plan detail or token reaches RelayRook output.
- `thread/tokenUsage/updated` carries cumulative input/cached/output/
  reasoning counters; `account/rateLimits/updated` carries window utilization.
  Both land on the turn's normalized usage record — counters under the token
  fields, the latest rate-limit snapshot under `rateLimits`.

## Quota

Quota is reported as `unknown` for every backend. Unknown quota and exhausted
quota are different facts, and RelayRook does not invent a remaining
allowance. Where a provider does emit rate-limit state, it surfaces as
`rate_limits` events and the latest snapshot on the turn usage record;
comparing two snapshots gives a delta — RelayRook records snapshots and never
invents one. ACP `session/usage_update` payloads report context-window
occupancy (`used`/`size`), not billing totals, and normalize accordingly.
Failover stays inside the configured policy: a quota or transport error never
moves work to a differently billed provider on its own, and a provider policy
refusal is reported, not routed around.

## Permission systems

Each backend's own lever, and what RelayRook does with it. `enforcement` is
what the mode is actually held by, not what it is called.

| Backend | Lever RelayRook drives | `read-only` | `gated` | `auto-edits` | `full-auto` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Devin | `DEVIN_PERMISSION_MODE`, `devin acp --agent-type` | `--agent-type review` + `auto` — the review agent has no edit tool (backend-sandbox) | `auto`: read-only tools auto-approved, edits and commands ask (parent-gated) | `accept-edits` (parent-gated for commands) | `dangerous` (prompt-only) |
| Kiro | `kiro-cli acp --trust-all-tools` | no native read-only agent; every write asks (parent-gated) | default: everything asks (parent-gated) | unsupported — Kiro trusts tools by name, not category; reported as `requestedUnsupported` | `--trust-all-tools` (prompt-only) |
| OpenCode | `OPENCODE_CONFIG` permission rules written into the session directory | `edit: deny`, `webfetch: deny` (backend-sandbox) | all `ask` (parent-gated) | `edit: allow` (parent-gated for bash) | all `allow` (prompt-only) |
| Claude Code | `ACP_PERMISSION_MODE` | `plan` (backend-sandbox) | `default` (parent-gated) | `acceptEdits` (parent-gated) | `bypassPermissions` (prompt-only) |
| Codex | app-server sandbox + approval policy | `read-only` + `never` (backend-sandbox) | `workspace-write` + `on-request` (parent-gated) | `workspace-write` + `never` — the sandbox bounds it, escapes fail rather than ask (backend-sandbox) | `danger-full-access` + `never` (prompt-only) |

An explicit `--sandbox` or `--approval-policy` overrides the Codex mapping; the
posture then reports `parent-gated` with a note that the caller pinned it,
rather than keeping a claim the mapping no longer makes.

Devin's `--sandbox` flag (macOS seatbelt / Linux bwrap) is a separate process
sandbox for its exec tool and is not driven by `--permission-mode`; a caller
that wants it can set `DEVIN_SANDBOX` in the environment RelayRook inherits.

The permission *options* inside a request are always the agent's own. RelayRook
refuses an option the agent did not advertise (`permission_option_invalid`),
because a plausible-looking `allow_always` that the agent never offered is a
protocol error, not a decision.
