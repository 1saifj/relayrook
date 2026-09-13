# Compatibility research

Observed on September 13, 2026, on one macOS machine. This records the underlying agent interfaces and the existing Devin prototype.

> **v0.2.0.** All five CLIs run through the shared RelayRook runtime. Codex supports: `thread/start`, `turn/start`, streamed `item/*` events, `turn/steer`, `turn/interrupt`, `review/start`, `thread/resume`, `model/list` and `account/read` were exercised against the installed `codex app-server`. ACP backends support `session/load` resume where the agent advertises it. See the [README status table](../README.md#status).

| Agent | CLI version | Interface | Validation depth |
| :--- | :--- | :--- | :--- |
| Devin | `3000.10.21` | `devin acp` | Prompts, edits, permissions, resume, cancellation, and recovery. |
| Kiro | `2.21.4` | `kiro-cli acp` | Session creation, completed inference turns, and a max-effort review. |
| Claude Code | `2.1.270` | `@agentclientprotocol/claude-agent-acp@0.76.0` | Session creation, model and effort readback, and completed inference. |
| Codex | `0.153.4` | `codex app-server --stdio` | Threads, turns, steering, interruption, native review, resume, model/effort readback, and account presence. |
| OpenCode | `1.18.30` | `opencode acp` | Session creation, explicit Go model selection, readback, and inference. |

## Important differences

**Model metadata varies.** Kiro returned legacy `models` metadata. Devin, Claude, and OpenCode exposed `configOptions`. The shared controller must handle both.

**Defaults need checking.** OpenCode's new ACP session selected a different model from its global configuration. The successful Go test explicitly selected and read back `opencode-go/kimi-k2.7-code` before prompting.

**Effort needs its own evidence.** Kiro's session response omits effort, then `_kiro.dev/metadata` reports it during operation; RelayRook verifies that notification. Claude exposes effort as a config option and confirmed `max`. Codex listed supported reasoning levels per model.

**Steering differs from queueing and cancellation.** Codex exposes `turn/steer` and `turn/interrupt`, which RelayRook drives as `steer` and `cancel`. Claude's adapter advertised steering and prompt queueing; RelayRook does not use either, and does not present cancellation as equivalent to steering. [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude adapter](https://github.com/agentclientprotocol/claude-agent-acp)

**Permission modes are agent-specific.** Kiro's observed modes represented agent profiles; Claude's included permission modes. Matching field names do not guarantee matching behavior.

**OpenCode Go is a provider route.** Keep Go requests inside the authenticated OpenCode client and use `opencode-go/<model>` IDs. An advertised model does not establish remaining quota. [OpenCode Go](https://opencode.ai/docs/go/)

## What remains unverified

- Live permission and cancellation behavior on every backend; the common protocol lifecycle is covered by deterministic tests.
- Model-quality rankings for implementation, code review, and security review; `evals/run.mjs` produces measured evidence where credentials permit.
- Live multi-backend behavior on Linux and Windows; CI covers the runtime's own tests and both control transports on all three platforms.
- Quota-aware failover and recovery after transport failures.

The Kiro and OpenCode smoke prompts asked for `ROUTER_READY` without tools. Both returned that text with `stopReason: end_turn`. These establish a working inference path, not a model-quality benchmark.

## Sources

- [Kiro ACP](https://kiro.dev/docs/cli/acp/)
- [OpenCode ACP](https://opencode.ai/docs/acp/)
- [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [acpx runtime](https://github.com/openclaw/acpx)
- [Agent Skills specification](https://agentskills.io/specification)

See the [research report](research.md) for protocol decisions and the [evaluation plan](evaluation-plan.json) for behavioral checks.

## Installed parent hosts

The 0.2.0 candidate completed these delegations on macOS on 2026-09-13.
Each parent read an installed self-contained skill, passed its own caller id,
collected a completed child turn, and stopped the child.

| Parent | Parent control interface | Delegated backend | Outcome |
|---|---|---|---|
| Codex CLI | `exec` JSONL | Devin `swe-2-max` | completed, stopped |
| Claude Code | print stream JSON | Devin `swe-2-max` | completed, stopped |
| Kiro CLI | v3 chat stream JSON | Devin `swe-2-max` | completed, stopped |
| OpenCode Go | `run` JSON, `kimi-k2.7-code` | Devin `swe-2-max` | completed, stopped |
| Devin | print | Kiro, observed `gpt-5.6-terra` | completed, stopped |

These are discovery and delegation smoke tests. The live turns used candidate
builds; installed copies were refreshed after subsequent runtime fixes. They
do not establish compatibility with every version, host configuration, or OS.

An existing global skill can take precedence over a project skill with the same
name. Confirm the selected entrypoint's `version` after installation. Back up
and update older copies when validating a candidate. The installed Kiro CLI
requires its v3 engine for stream JSON. Noninteractive parent harnesses need
permission to execute the packaged runtime and the requested task's tools;
RelayRook cannot grant permissions withheld by the parent. Interactive approval
is preferable to broadly changing a user's global trust configuration.

Use `wait --full` to collect an unstructured answer. Reading transcript files
outside the workspace can be blocked by the parent even when RelayRook's own
control commands are permitted. Use role-built prompts when a structured
result contract is required; raw `--text` does not insert that contract.
