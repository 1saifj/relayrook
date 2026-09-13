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
  v0.1 does not use either, and does not present cancellation as equivalent to
  steering.
- Session creation, `opus[1m]`, `max` effort, and a completed inference turn
  were verified through RelayRook.

## Codex — `codex app-server --stdio`

- **Discovery only in v0.1.** `initialize`, `model/list` and `account/read` are
  implemented, which is what `doctor --probe` reports. The app-server omits the
  `jsonrpc` envelope field, which the adapter handles.
- Thread and turn control (`thread/start`, `turn/start`, `turn/steer`,
  `turn/interrupt`, `review/start`) are **not implemented**. `start --backend
  codex` fails with `session_control_not_implemented`, and routing rejects
  Codex with that reason rather than pretending the session behaviour exists.
- `account/read` is reduced to a presence flag and an account type. No
  identifier, e-mail, plan detail or token reaches RelayRook output.

## Quota

Quota is reported as `unknown` for every backend. Unknown quota and exhausted
quota are different facts, and RelayRook does not invent a remaining allowance.
Failover stays inside the configured policy: a quota or transport error never
moves work to a differently billed provider on its own, and a provider policy
refusal is reported, not routed around.
