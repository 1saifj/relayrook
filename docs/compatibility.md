# Compatibility research

Observed on September 13, 2026, on one macOS machine. This records the underlying agent interfaces and the existing Devin prototype.

> **v0.1 update.** The shared RelayRook runtime now exists. It completed live inference turns through Devin, Kiro, OpenCode Go, and Claude Code with model readback and structured results. Kiro also completed a max-effort review of RelayRook through RelayRook itself. Codex app-server discovery is live, while Codex turn control remains unimplemented. See the [README status table](../README.md#what-works-in-v01).

| Agent | CLI version | Interface | Validation depth |
| :--- | :--- | :--- | :--- |
| Devin | `3000.10.21` | `devin acp` | Prompts, edits, permissions, resume, cancellation, and recovery. |
| Kiro | `2.21.4` | `kiro-cli acp` | Session creation and a completed inference turn. |
| Claude Code | `2.1.270` | `@agentclientprotocol/claude-agent-acp@0.76.0` | Session creation, model and effort readback, and completed inference. |
| Codex | `0.153.4` | `codex app-server --stdio` | Initialization, account lookup, and model discovery. |
| OpenCode | `1.18.30` | `opencode acp` | Session creation, explicit Go model selection, readback, and inference. |

## Important differences

**Model metadata varies.** Kiro returned legacy `models` metadata. Devin, Claude, and OpenCode exposed `configOptions`. The shared controller must handle both.

**Defaults need checking.** OpenCode's new ACP session selected a different model from its global configuration. The successful Go test explicitly selected and read back `opencode-go/kimi-k2.7-code` before prompting.

**Effort needs its own evidence.** Kiro's session response omits effort, then `_kiro.dev/metadata` reports it during operation; RelayRook now verifies that notification. Claude exposes effort as a config option and confirmed `max`. Codex listed supported reasoning levels per model.

**Steering differs from queueing and cancellation.** Codex exposes `turn/steer` and `turn/interrupt`. Claude's adapter advertised steering and prompt queueing. Live steering behavior remains to be tested for the shared runtime. [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude adapter](https://github.com/agentclientprotocol/claude-agent-acp)

**Permission modes are agent-specific.** Kiro's observed modes represented agent profiles; Claude's included permission modes. Matching field names do not guarantee matching behavior.

**OpenCode Go is a provider route.** Keep Go requests inside the authenticated OpenCode client and use `opencode-go/<model>` IDs. An advertised model does not establish remaining quota. [OpenCode Go](https://opencode.ai/docs/go/)

## What remains unverified

- Codex turn conformance; its app-server is discovery-only in v0.1.
- RelayRook skill discovery and execution from each parent host.
- Live permission and cancellation behavior on every backend; the common protocol lifecycle is covered by deterministic tests.
- Model-quality rankings for implementation, code review, and security review.
- Cross-platform behavior on Linux and Windows.
- Quota-aware failover and recovery after transport failures.

The Kiro and OpenCode smoke prompts asked for `ROUTER_READY` without tools. Both returned that text with `stopReason: end_turn`. These establish a working inference path, not a model-quality benchmark.

## Sources

- [Kiro ACP](https://kiro.dev/docs/cli/acp/)
- [OpenCode ACP](https://opencode.ai/docs/acp/)
- [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [acpx runtime](https://github.com/openclaw/acpx)
- [Agent Skills specification](https://agentskills.io/specification)

See the [research report](research.md) for the planned adapter architecture and the [evaluation plan](evaluation-plan.json) for proposed behavioral checks.
