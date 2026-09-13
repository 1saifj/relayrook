---
name: relayrook
description: Delegate implementation, code review, or security review to another locally installed coding agent (Devin, Kiro, OpenCode, Claude Code) through a persistent structured session. Use when the user asks to hand work to a different agent or model, wants an independent reviewer, names a specific CLI or subscription, or wants to continue, steer, or cancel delegated work. Do not use to explain what an agent or protocol is, or for an edit you can make yourself.
license: MIT
---

# RelayRook

Route work to another coding agent installed on this machine and control that
session through to a verified result.

Requires Node.js 22.13 or newer. The runtime is tested on macOS and its CI
suite also runs on Linux.

All commands print JSON. Run them with the entrypoint next to this file:

```bash
node "$SKILL_DIR/scripts/relayrook.mjs" <command> [options]
```

## When to use

Use it when the user wants **another** agent to do the work: a named CLI, an
independent reviewer, a specific subscription or model, or a continuation of
work already delegated. Do not launch an agent to answer a question, to explain
a protocol, or to make a small edit you can make yourself.

## Procedure

1. **Check the environment.** `doctor` reports the caller, the installed
   backends, adapter readiness and configured routes. Run it before the first
   delegation in a session.
2. **Pass `--caller`.** Environment variables are inherited by child processes,
   so they cannot prove who invoked you. Your own host id is the only
   authoritative value: `codex`, `claude-code`, `kiro-cli`, `opencode`, `devin`.
3. **Choose a route.** `route --role <role>` returns a backend, model, effort,
   the rejected candidates and the reason. Forward the user's pins with
   `--agent`, `--model`, `--effort`. An unsatisfiable pin is an error — never
   silently substitute a different agent, model, effort or billing route.
4. **Start a session.** `start` creates or reuses a persistent worker for a
   backend and workspace, and returns a session key plus the model the backend
   actually reported.
5. **Send the task.** `prompt --role <role> --task "..."` builds the role prompt
   for you. One turn at a time: submitting while a turn is active fails with
   `active_turn`.
6. **Follow the turn.** `wait` polls to a terminal state; `status --cursor N`
   pages incremental events. Both report a `cursorGap` when retention has
   dropped events you had not read.
7. **Answer permissions.** When a turn stops with `awaiting-permission`, inspect
   the exact request and its advertised options. Relay a choice when the user's
   task already authorizes that concrete action; ask the user only when it
   exceeds the authorized scope or is consequential and irreversible. Never
   send an option the agent did not advertise.
8. **Report honestly.** Use the turn's `state` and `stopReason`, never a process
   exit code. `complete-no-findings` and `incomplete` are different outcomes.

## Roles

| Role | Default posture | Result contract |
| :--- | :--- | :--- |
| `implementation` | Writes to the workspace | Diff, commands run with real output, what is incomplete |
| `code-review` | Read-only | path, line, severity, trigger, consequence, evidence, suggested correction |
| `security-review` | Read-only | the above plus prerequisites, attacker control, trust boundary, safe verification |

Reviews are read-only by default. Pass `--no-read-only` only when the user asked
for the reviewer to change code.

## Minimal delegation

```bash
S=$(node "$SKILL_DIR/scripts/relayrook.mjs" start --role implementation \
      --workspace "$PWD" --caller claude-code | jq -r .session)

node "$SKILL_DIR/scripts/relayrook.mjs" prompt --session "$S" \
  --role implementation --task "Fix the pagination off-by-one in list_items" \
  --check "npm test"

node "$SKILL_DIR/scripts/relayrook.mjs" wait --session "$S" --timeout 900000
```

## Backend status

| Backend | Interface | v0.1 session control |
| :--- | :--- | :--- |
| Devin | `devin acp` | Yes, pinned to `swe-2-max` |
| Kiro | `kiro-cli acp` | Yes; effort is verified from vendor metadata after it arrives |
| OpenCode | `opencode acp` | Yes; model selected and read back explicitly |
| Claude Code | pinned `@agentclientprotocol/claude-agent-acp` | Yes, after `bootstrap --backend claude` |
| Codex | `codex app-server --stdio` | **No** — discovery only; routing rejects it |

## References

- `references/workflows.md` — command reference, event kinds, failure states
- `references/providers.md` — per-backend behaviour, model metadata, limits
