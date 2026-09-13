<p align="center">
  <img src="assets/relayrook-banner.webp" alt="RelayRook — a skill for coordinating coding agents" width="960">
</p>

<p align="center">
  <strong>Give the right work to the right agent.</strong><br>
  An Agent Skill for implementation, code review, and security review across your coding CLIs.
</p>

<p align="center">
  <a href="#the-workflow">Workflow</a> ·
  <a href="#status">Status</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="docs/research.md">Research</a> ·
  <a href="https://www.skills.sh/1saifj/relayrook/relayrook">skills.sh</a>
</p>

---

> **v0.2.0.** All five CLIs — Devin, Kiro, OpenCode, Claude Code and Codex — are driven through persistent sessions with turn control, parent-held permissions, and typed outcomes. Codex runs through its app-server protocol, including steering, interruption, native review, and thread resume. The status table below separates what has been exercised live on one macOS machine from what is only advertised by an agent.

RelayRook lets the agent you already use delegate work to your installed **Devin, Claude Code, Kiro, OpenCode, and Codex** CLIs. It discovers what is installed, chooses a route, keeps a persistent session, pauses on permission requests, and returns typed turn outcomes.

Every handoff makes the chosen agent, provider, model, and reasoning effort visible. Nothing is substituted silently.

## The workflow

**Discover → Select → Delegate → Verify → Continue**

| Step | Command | What it does |
| :--- | :--- | :--- |
| **Discover** | `doctor` | Caller evidence, installed CLIs, versions, adapter readiness, configured routes |
| **Select** | `route --role <role>` | Backend, model, effort, rejected candidates, and the reason |
| **Delegate** | `start` then `prompt` | Persistent session, role-built prompt, one turn at a time |
| **Verify** | `wait` / `status --cursor` | Typed turn state, stop reason, incremental events, parsed result block |
| **Continue** | `prompt` / `steer` / `review` / `cancel` / `permission` | Follow-ups on the same session, in-flight steering, native review, cancellation, parent-held permissions |

### What you would ask

**Implementation**

> Use RelayRook to have Devin implement this fix with SWE-2 Max. Run the relevant checks and bring back the diff.

**Independent code review**

> Have another model review this branch. Focus on regressions and return findings with file and line references.

**Security review**

> Route a security review of the changed auth code. Verify the prerequisites for each finding and keep the review scoped to this repository.

**Follow-up**

> Continue the same worker session with these test failures. Keep the selected model and effort.

## Status

Measured on macOS 26.6 (darwin-arm64), Node v26.7.0, on 2026-09-13. "Live" means RelayRook itself drove it; "researched" means a separate protocol probe established it before RelayRook existed.

| Agent | CLI version | Interface | Session control | Verified through RelayRook |
| :--- | :--- | :--- | :--- | :--- |
| **Devin** | `3000.10.21` | native `devin acp` | implemented | **Live:** `swe-2-max` selected and read back; inference completed with `end_turn` and a parsed result. |
| **Kiro** | `2.21.4` | native `kiro-cli acp` | implemented | **Live:** code review plus smoke turn on `claude-opus-5`; `max` effort confirmed through `_kiro.dev/metadata`. |
| **OpenCode** | `1.18.30` | native `opencode acp` | implemented | **Live:** `opencode-go/kimi-k2.7-code` selected and read back; inference completed with `end_turn` and a parsed result. |
| **Claude Code** | `2.1.270` | pinned `@agentclientprotocol/claude-agent-acp@0.76.0` | implemented | **Live:** adapter bootstrapped without lifecycle scripts; `opus[1m]` and `max` effort confirmed; inference completed with `end_turn`. |
| **Codex** | `0.153.4` | native `codex app-server --stdio` | implemented | **Live:** `thread/start` model and effort readback; `turn/start` completed; `turn/steer`, `turn/interrupt`, `review/start` and `thread/resume` all exercised against the installed CLI. |

All five backends have completed a live inference turn through RelayRook. The full lifecycle — prompt, events, concurrent permission pauses, steering, interruption, review, cancellation, timeout, oversized payloads, serialized starts, worker-restart recovery, and stop — is also covered by deterministic protocol fixtures that speak the real protocols.

### Honest limits

- **Route weights are configured preferences, not benchmarks.** `evidenceBasis` is `configured-preference` unless measured evaluation evidence exists in `<state>/route-evidence.json` (`runs >= 2` per route). `evals/run.mjs` produces that file from isolated fixture results, recording success, precision/recall, scope compliance, latency, and normalized usage per run. A single run stays anecdotal; repeat with `--runs N` or across invocations to reach the measured threshold.
- **No quality/balanced/speed objective exists yet.** A speed- or quality-biased route is only honest once measured latency, usage, and accuracy span at least two eligible routes per role; the current evidence does not, so no such weight is configured.
- **Kiro effort is confirmed after metadata arrives.** The initial session response has no effort field. Kiro then emits `_kiro.dev/metadata`; RelayRook records `support: "agent-notification"` and verifies the observed value against the requested value.
- **Quota is always `unknown`.** A saved credential is not proof of remaining allowance, and RelayRook does not invent one.
- **Windows and Linux are supported targets; macOS is where live backend verification ran.** CI runs the runtime's own tests on all three, covering both control transports (unix sockets, named pipes). Live multi-backend evidence was collected on macOS.
- **Steering is Codex-only.** `steer` maps to `turn/steer`; the Claude adapter's steering extension is not used. Cancellation is not presented as an equivalent.
- **Native review is Codex-only.** `review` maps to `review/start`; other backends receive `prompt --role code-review`.

[Versions, protocol differences, and per-backend behaviour →](docs/compatibility.md)

## Installation

Requires **Node.js 22.13 or newer** and no runtime dependencies.

### As an Agent Skill

```bash
npx skills add 1saifj/relayrook --skill relayrook \
  --agent codex claude-code kiro-cli opencode devin
```

This repository and its skills.sh page are live. To install RelayRook globally for all five supported hosts:

```bash
npx skills add 1saifj/relayrook --skill relayrook \
  --agent codex claude-code kiro-cli opencode devin --global --yes --copy
```

You can also copy `skills/relayrook/` anywhere and run its entrypoint directly — the directory is self-contained and needs no checkout:

```bash
node skills/relayrook/scripts/relayrook.mjs doctor --caller claude-code
```

### From this repository

```bash
npm install          # dev dependencies only; the runtime has none
node bin/relayrook.js doctor --caller claude-code
```

### Claude Code backend

The base `claude` CLI has no `acp` subcommand. Install the pinned adapter once:

```bash
node bin/relayrook.js bootstrap --backend claude
```

It installs `@agentclientprotocol/claude-agent-acp@0.76.0` into the state directory — never into this repository and never into the published skill.

## Commands

All output is JSON. `{"ok": true, ...}` on stdout, `{"ok": false, "error": {"code", "message", "details"}}` on stderr with exit code 1.

```bash
relayrook doctor [--probe] [--caller <id>]
relayrook preflight [--backend <id>]
relayrook route --role implementation|code-review|security-review [--agent X] [--model Y] [--effort Z]
relayrook start --backend <id> --workspace <dir> [--model] [--effort] [--profile] [--resume auto|required|never]
relayrook prompt --session <key> --role <role> --task "..." [--check "npm test"]
relayrook steer --session <key> --text "..."            # Codex only
relayrook review --session <key> --target uncommitted-changes  # Codex only
relayrook status --session <key> --cursor <n> [--full]
relayrook wait --session <key> [--timeout ms] [--events] [--full]
relayrook permission --session <key> --option <optionId>
relayrook cancel --session <key>
relayrook stop --session <key>
relayrook cleanup
relayrook sessions
relayrook bootstrap --backend claude
```

[Full command reference, event kinds, error codes, and state layout →](skills/relayrook/references/workflows.md)

### A delegation, end to end

```bash
S=$(relayrook start --role implementation --workspace "$PWD" --caller claude-code | jq -r .session)
relayrook prompt --session "$S" --role implementation \
  --task "Fix the pagination off-by-one in list_items" --check "npm test"
relayrook wait --session "$S" --timeout 900000
```

## Design commitments

- **Explicit model control.** Devin stays pinned to `swe-2-max` unless you pass `--model`. A backend that will not confirm the requested model fails the start; it never runs on a different one.
- **Never infer success from an exit code.** Turn outcomes come from the protocol's stop reason. A print-mode agent can exit 0 after a denied tool call.
- **Parent-held permissions.** RelayRook advertises no filesystem or terminal capability, so tool requests pause the turn. The parent inspects the request and selects an advertised option within the user's authorized scope. There is no blanket-approval flag.
- **Caller identity is evidence, not a guess.** Explicit `--caller` is authoritative; router-owned delegation metadata comes next; inherited environment variables are lowest-confidence and can only name an ancestor. Conflicting signals report `ambiguous`.
- **Recursion is bounded.** Delegation depth and ancestry are recorded in router-owned state; a repeated backend or an exceeded depth is refused.
- **Reviews are read-only by default,** and security findings must carry prerequisites, attacker control, trust boundary, evidence and a safe verification method. "No findings" and "incomplete" are distinct statuses.
- **State lives outside your repository,** at `$RELAYROOK_STATE_DIR`, `$XDG_STATE_HOME/relayrook`, or `~/.local/state/relayrook`. Metadata writes are atomic; events are cursor-addressable with bounded retention and an explicit `cursorGap`; full per-turn transcripts are kept on disk.
- **Polling stays compact.** `wait` omits raw event chunks by default and omits a duplicate answer when its structured result parsed successfully. Use `--events` for event replay and `--full` for the full answer and discovery metadata.
- **Usage is normalized, never invented.** Each turn carries one canonical record — uncached/cached/cache-write input, output and reasoning tokens, totals, event count, latency, and the latest rate-limit snapshot — with the provider payload preserved under `raw`. A field the provider did not report is `null`, not zero.
- **No credentials in output.** Only environment variable *names* are recorded, paths are home-redacted, and `account/read` is reduced to a presence flag.

## Repository layout

```text
src/                          runtime, adapters, router, state
bin/relayrook.js              development entrypoint
skills/relayrook/             the distributable skill
  SKILL.md                    portable skill prompt
  agents/openai.yaml          optional Codex host metadata
  bin/relayrook[.cmd]         self-locating launchers (posix + Windows)
  references/                 command reference and per-backend behaviour
  scripts/relayrook.mjs       self-contained entrypoint
  scripts/lib/                byte-for-byte copy of src/ (npm run build)
tests/                        unit and end-to-end tests (node --test)
evals/                        trigger and role fixtures, isolated eval runner
docs/                         research, compatibility, inventory, evaluation plan
```

`skills/relayrook/scripts/lib/` is generated by `npm run build`. `node scripts/build-skill.mjs --check` and `tests/packaging.test.mjs` both fail if it drifts from `src/`, and the packaging test proves a copied skill directory runs with no repository present.

## Checks

```bash
npm run lint       # formatting plus a hygiene scan for paths, e-mails, and tokens
npm run typecheck  # TypeScript over JSDoc-annotated ESM
npm test           # unit, protocol lifecycle, packaging, and platform checks
npm run check      # all three
```

## Roadmap

- [x] Research native ACP and structured alternatives across five coding CLIs.
- [x] Validate a persistent Devin prototype and basic Kiro/OpenCode Go inference.
- [x] Implement shared discovery, session control, permissions, and routing.
- [x] Ship a self-contained skill subtree that runs without the development checkout.
- [x] Drive live turns through Devin, Kiro, OpenCode Go, Claude Code, and Codex via RelayRook itself.
- [x] Implement Codex app-server thread and turn control, including `turn/steer`, `turn/interrupt`, `thread/resume`, and `review/start`.
- [x] Support macOS, Linux and Windows with per-platform control transports and restart-safe sessions.
- [x] Add capability preflight, typed unavailable-execution errors, signed delegation envelopes, and control-token authentication.
- [x] Evaluate implementation and review behavior on isolated tasks via `evals/run.mjs`; [record repeated trials and limitations](docs/evaluations-2026-09-13.md).
- [ ] Add a generic quality/balanced/speed routing objective once measured evidence spans multiple eligible routes per role.
- [x] Verify installed-skill delegation from Codex, Claude Code, Kiro, OpenCode, and Devin on macOS.
- [x] Publish the first release under `1saifj/relayrook` and verify skills.sh discovery and installation.

## Research & contributions

Start with the [research report](docs/research.md), [compatibility notes](docs/compatibility.md), and [evaluation plan](docs/evaluation-plan.json).

Useful contributions include reproducible agent compatibility reports, focused protocol fixes, and realistic evaluation fixtures. Include the CLI version, transport, model, effort, expected behavior, and observed result. Remove credentials and private repository content from examples.

---

<p align="center">
  <strong>RelayRook</strong> · An Agent Skill by <a href="https://github.com/1saifj">1saifj</a><br>
  Discover the options. Delegate with intent. Verify the result.
</p>
