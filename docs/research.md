# RelayRook: research and design

Protocol research recorded on 2026-09-13. RelayRook packages a portable Agent Skill and a dependency-free runtime at `1saifj/relayrook`. The [compatibility matrix](compatibility.md) records execution evidence and its limits.

RelayRook is one small Agent Skill backed by a tested runtime. It discovers local agents and their account-visible models, chooses a route for implementation or review, and controls a persistent agent session. Prefer ACP for portability and a native structured interface when it provides a demonstrated advantage. A skill alone cannot guarantee access to every host's tools or infer a user's subscriptions from installed binaries.

## 1. What is actually available here

| CLI | Installed version | Authentication evidence | Structured interface | Research validation |
|---|---|---|---|---|
| Devin | 3000.10.21 | Existing authenticated account | Native `devin acp` | Prior live tests: text, edits, shell permissions, resume, cancellation |
| Kiro | 2.21.4 | `whoami` returned account information | Native `kiro-cli acp` | Real prompt passed with `claude-opus-5`, requesting max effort |
| Claude Code | 2.1.263 | `auth status`: logged in, first-party Claude account, Max subscription | Claude Agent SDK / bidirectional streaming; ACP adapter | Adapter initialize/new succeeded; model, effort, and mode controls returned |
| Codex | 0.153.4 | ChatGPT login; native `account/read` succeeded | Native app-server; ACP adapter also available | App-server initialize and live `model/list` succeeded |
| OpenCode | 1.18.30 | Saved OpenCode Go credential and successful Go model turn | Native ACP; HTTP/SSE server and SDK | Explicit selection/readback and real prompt passed with `opencode-go/kimi-k2.7-code` |

Model inventories are availability hints. A saved credential is not proof of remaining quota or permission to use every listed model. A minimal successful model turn provides stronger evidence than a catalogue entry.

Observed models include:

- **Devin:** `swe-2-max`, the existing user-pinned model. Preserve it whenever the Devin route is selected.
- **Kiro:** 19 advertised choices, including `claude-opus-5`, `claude-sonnet-5`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. The CLI accepts separate `--model` and `--effort` options. Its default `auto` does not identify a fixed model.
- **Codex:** live app-server results included `gpt-6-astra`, the GPT-5.6 Sol/Terra/Luna family, `gpt-5.5`, and `gpt-5.3-codex-spark`, with supported effort levels per model. Do not promote hidden/internal cached entries into public routing candidates.
- **Claude Code:** the adapter reported alias `opus[1m]` with display name Opus 5, plus `claude-fable-5-1[1m]` (Fable 5.1), `sonnet` (Sonnet 5), and `haiku` (Haiku 4.5). Its current effort was high and its advertised choices included max. These are session-advertised choices, not individually inference-tested models. Do not assume an alias names the same concrete version forever.
- **OpenCode Go:** 27 advertised routes, including `opencode-go/deepseek-v4-pro`, `opencode-go/kimi-k3`, `opencode-go/kimi-k2.7-code`, `opencode-go/qwen3.8-max`, and `opencode-go/glm-5.3`. The global OpenCode configuration and the new ACP session selected different defaults in our probe; explicit selection and readback are essential.

OpenCode Go is a provider subscription, not a separate coding agent. Use the authenticated OpenCode harness and `opencode-go/<model>` IDs. Its catalogue and included usage vary. Let the official client handle the subscription and conversation identifiers; do not extract its key into a custom proxy. [OpenCode Go documentation](https://opencode.ai/docs/go/)

The Kiro and Go smoke tests asked for exactly `ROUTER_READY` without tools. Both returned that text and `stopReason: end_turn`. They establish that these two routes can perform inference through ACP here. Claude's probe stopped after creating a session; Codex's probe checked initialization, models, and account state. Neither is an implementation-quality test. The separate inventory JSON records these distinctions.

## 2. Transport decision

| Backend | Preferred implementation | Why / qualification |
|---|---|---|
| Devin | Native ACP | Already verified locally; retain the SWE-2 Max lock |
| Kiro | Native ACP | Available in installed CLI; requires legacy model metadata support |
| Claude | Pinned Claude ACP adapter through a shared runtime | Provides common ACP sessions, tools, and permissions; SDK is an alternative when native controls justify it |
| Codex | Native app-server adapter, with ACP as an interoperable alternative | Native model discovery, review mode, limits, and steering are useful to this router |
| OpenCode | Native ACP; optional server adapter | ACP is enough for normal delegation; HTTP/SSE exposes richer provider/session management |

Observed launch entrypoints, each started as a persistent child process by the controller:

```bash
devin acp --model swe-2-max
kiro-cli acp --model claude-opus-5 --effort max
claude-agent-acp
codex app-server --stdio
opencode acp
```

`claude-agent-acp` is the executable from the pinned adapter package, not a command installed by the base Claude CLI. These processes expect structured protocol messages; piping a plain English prompt into them is not the control interface. ACP requires initialization, session creation/loading, model configuration, prompt submission, update handling, and replies to permission requests. OpenCode model selection in this probe used `session/set_config_option`, with `configId: model` and `value: opencode-go/kimi-k2.7-code`, followed by checking the returned value.

The Codex app-server defines `turn/steer`, which adds instructions to an active turn, and `turn/interrupt`, which cancels it. It also exposes `review/start`. Preserve these native capabilities instead of presenting cancellation-and-restart as equivalent to steering. [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)

Claude's documented SDK supports streaming input, interruption, and programmatic controls; its maintained ACP adapter wraps that SDK. The adapter is a separate package, not a `claude acp` built-in command. [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)

The locally probed Claude adapter also advertised a steering extension and prompt queueing. These were capability observations, not live steering tests. The common controller should expose distinct outcomes for immediate steering, queueing behind the active turn, and cancellation; it should not present them as interchangeable.

OpenCode's native server offers provider discovery, asynchronous prompts, session cancellation, and event streams. Use loopback binding and authentication if that adapter is enabled. Its server is a structured alternative, not automatically a faster model engine. [OpenCode server](https://opencode.ai/docs/server/), [OpenCode ACP](https://opencode.ai/docs/acp/)

Observed protocol differences are material:

- Devin and OpenCode returned `configOptions`; Kiro returned legacy `models.currentModelId` and `availableModels`.
- Kiro modes named agent profiles; Devin modes represented permission/workflow choices. Equal field names do not imply equal semantics.
- Kiro accepted `--effort max`, but its observed session response did not independently report an effort value. Record this as requested, not fully read-back verified.
- Capabilities such as filesystem access, terminal ownership, load, fork, and live configuration vary by backend and version. Negotiate them; do not hard-code assumptions from Devin.
- The earlier Devin tests showed why OS exit status alone is insufficient: print mode returned 0 after a denied tool call. Use typed completion status and actual tool/task evidence.

## 3. Runtime architecture

RelayRook implements ACP directly over newline JSON-RPC, with a separate native Codex app-server adapter. The runtime has no production dependencies. Both adapters share persistent workers, session state, event pagination, parent permission decisions, and typed outcomes.

The `acpx` runtime was evaluated as an architectural reference for persistent sessions, asynchronous permission callbacks, and per-child environment configuration. RelayRook does not embed it. The Claude backend uses the separately bootstrapped `@agentclientprotocol/claude-agent-acp@0.76.0` adapter. [acpx runtime contract](https://github.com/openclaw/acpx/blob/main/src/runtime/public/contract.ts), [Claude adapter](https://github.com/agentclientprotocol/claude-agent-acp)

Direct executable resolution preserves the user's installed CLIs and authenticated subscription routes. Model and effort requests are read back where supported. Codex's thread and turn primitives remain distinct from ACP prompts and cancellation.

## 4. Caller and availability detection

The router should report **who is calling**, **what can run**, and **how certain it is** as separate fields.

Recommended caller resolution order (our design):

1. Explicit `--caller` supplied by the host-facing skill/controller.
2. Router-owned parent metadata carried into child sessions, including root caller, immediate parent, route ID, and delegation depth.
3. Host-specific environment signals plus nearest parent-process executable identity.
4. `unknown` with a reason when evidence conflicts or is absent.

This Codex environment exposes `CODEX_THREAD_ID` and `CODEX_SESSION_ID`. Such signals can be inherited by child processes, so their presence alone cannot establish the immediate caller. Do not infer the caller from the working directory, installed skill paths, or model self-identification. Avoid depending on undocumented environment markers as a permanent API.

Availability should progress through explicit states:

`installed`, `protocol-ready`, `authenticated`, `model-advertised`, `model-smoke-tested`, and `task-qualified`

These are separate evidence fields, not a guaranteed sequence: an unauthenticated process may still advertise models, and an authenticated account may have no remaining quota.

Track unknown quota separately from zero quota. Cache capability probes by executable path/version, provider, and configuration fingerprint; invalidate after upgrades and relevant errors. Keep credentials inside their native clients. A failure in one provider should not make the entire inventory fail.

Prevent routing loops with a bounded delegation depth and recorded ancestry. Usually prefer a different model family for an independent review; prohibit accidental recursion, not every intentional use of the same CLI.

## 5. Choosing the best available route

There is no defensible universal ranking from documentation alone. Agent quality depends on the model, provider, tools, repository, prompt, and task. The release should describe tested routes and publish evidence, not claim that one model is always the best security reviewer.

Use eligibility filters before scoring:

- User-pinned agent/model and explicit constraints.
- Compatible protocol, authentication, model and effort support.
- Required workspace/tool access and permissions.
- Budget, quota evidence, allowed providers, and data-handling preferences.
- Caller/delegation-loop constraints.

Then choose among eligible routes using per-role evaluation results, recent reliability, total completion latency, subscription preference, and cost. Return the selected agent, provider, exact requested model/effort, observed model when available, rejected candidates, and a concise reason. Do not equate cheapest, largest, or newest with best.

Provisional candidates to evaluate:

| Role | Candidate approach, not an established benchmark winner |
|---|---|
| Implementation | Keep Devin SWE-2 Max as the pinned Devin route; compare it with Codex and selected Go coding models on real repository changes |
| Code review | Choose a strong reviewer independently from the implementation model; compare Codex with Claude's account-visible Opus and Fable routes |
| Security review | Strong reasoning plus focused security instructions, reproducible evidence, and an independent verification pass for serious findings |
| Fast bounded work | Evaluate lower-latency Go routes and smaller account-visible models against acceptance tests before promoting them |

The same Claude model through Kiro and Claude Code is not an independent model family; the harness and subscription route still differ. Do not silently switch from a subscription route to an API-billed provider. Failover for a quota or transport error should remain within the configured policy; a provider policy refusal is not a signal to evade it through another provider.

A code review result should contain path, line, severity, trigger, consequence, evidence, and suggested correction. A security finding should additionally identify prerequisites, attacker control, the affected trust boundary, and a safe verification method. “No findings” must remain distinct from incomplete or failed review.

## 6. Writing a skill that works across hosts

Use a short portable `SKILL.md` with standard `name`, `description`, and optional compatibility metadata. Put detailed procedures in references and deterministic behavior in scripts. Keep host-specific features optional. The Agent Skills format is the common packaging layer; it does not standardize every host's tools or permissions. [Agent Skills specification](https://agentskills.io/specification)

The core instructions should explain when to invoke the router, how to supply the user's task, how to interpret events and permissions, and when task evidence is sufficient. Model catalogues, provider pricing, and retry state belong in runtime data rather than a long static prompt. Ground the guidance in observed operational traps. [Skill creation best practices](https://agentskills.io/skill-creation/best-practices)

Test discovery as well as execution. Use relevant prompts and close negative examples: explicit requests to use another coding agent should trigger; a request to explain ACP or make a trivial edit locally should not automatically launch multiple paid agents. Keep held-out trigger cases so we do not merely tune wording to examples. [Optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions)

Evaluate task results with and without the skill, or against the previous version. Record correctness, tools, token usage, time, and failures. A successful protocol greeting is not proof of a good implementation or a good security review. [Skill output evaluation](https://agentskills.io/skill-creation/evaluating-skills)

Host differences:

- Codex: standard skill plus optional `agents/openai.yaml`; its native protocol can reference a skill explicitly.
- Claude Code: standard skill with Claude-specific substitution/frontmatter only in optional host guidance. Do not require Claude-only variables in shared instructions. [Claude skills](https://code.claude.com/docs/en/skills)
- OpenCode: supports Agent Skills discovery, but its permission controls remain its own. [OpenCode skills](https://opencode.ai/docs/skills/)
- Kiro: default-agent discovery and custom-agent resource configuration differ; verify against the installed engine. Current CLI docs span version 3 while this machine is on 2.21.4. The skills installer documents explicit `skill://` resources for custom agents. [Kiro skills](https://kiro.dev/docs/cli/skills/), [skills installer](https://github.com/vercel-labs/skills)
- All hosts: the installed skill must carry or fetch a pinned runtime correctly. Files outside the selected skill directory are not a safe dependency assumption for `npx skills add`.

## 7. Validation required before calling it portable

A release matrix should cover all five backends, the parent hosts we claim to support, and operating systems separately. Begin on this Mac; add Linux CI and Windows coverage before claiming those platforms.

Mandatory behavioral cases:

- Missing CLI; stale credential; missing model; unknown quota; expired quota.
- Successful prompt, resumed context, model and effort confirmation.
- Tool approval and denial; unsupported client request; clarification handling.
- Cancellation followed by safe resumption; native steering where advertised.
- Crashed process and reconnect; no duplicate mutating prompt replay.
- Wrong caller signals, inherited environment, recursion prevention.
- Dirty repository preservation, isolated implementation workspace, read-only review scope.
- Large streamed messages, event cursor gaps, context exhaustion, partial output.
- No implicit API billing change; no accidental provider/model substitution.
- Installation/discovery from GitHub under each supported agent name.

Use seeded code fixtures for implementation and review, and benign fixtures with known security defects plus clean examples. Measure false positives as well as missed issues. Run fresh hold-out tasks and several repetitions before assigning route scores. Maintain transcript-derived evidence and a versioned compatibility table.

## 8. Performance design

Keep a warm worker per backend/workspace/security profile, with bounded idle cleanup. Reuse the conversation for related corrections; give independent reviewers only the needed diff, context, and checks. Batch text deltas before returning them to the parent, retain full events on disk, and keep inventories out of normal response context.

The OpenCode Go smoke response reported **70,414 input tokens** for **5 output tokens**. This identifies startup/context composition as something to measure before tuning; the probe did not attribute those tokens to individual configuration sources or determine how much was cached. Reported token usage or an estimated cost field is not proof of a separate subscription charge. Inspect inherited instructions, skills, tools, and plugins, then test any narrower worker profile explicitly. Preserve required repository instructions and make configuration changes visible.

Perform cheap deterministic discovery first. Probe only plausible candidates, reuse cached capabilities, and avoid LLM calls for PATH/version checks. Preinstall pinned adapters once. Parallelize truly independent work only when requested or permitted; serialize edits that share ownership. Respect provider concurrency and quota limits.

Measure cold start, warm dispatch, first useful output, full completion, validation success, and total cost separately. The previous Devin helper measured about 0.08 seconds for warm controller access and 0.05–0.06 seconds for prompt submission; those measurements exclude model inference and are not a cross-agent benchmark.

Keep requested reasoning effort as an independent quality control. Preserve the Devin SWE-2 Max pin; never silently lower effort or enable a potentially differently billed fast mode to improve a latency number. ACP reduces orchestration friction, but it does not itself make model inference faster.

## 9. GitHub and skills.sh release path

The project is **RelayRook**, with `relayrook` as the repository and skill slug. The public repository is `1saifj/relayrook`.

Package layout:

```text
relayrook/
  README.md
  LICENSE
  package.json
  package-lock.json
  src/                         # Runtime source and adapters
  tests/                       # Deterministic protocol/routing tests
  evals/                       # Trigger and role-quality fixtures
  docs/compatibility.md
  skills/relayrook/
    SKILL.md
    agents/openai.yaml
    scripts/relayrook.mjs         # Self-contained distribution entrypoint
    references/workflows.md
    references/providers.md
  .github/workflows/ci.yml
```

Bundle the runtime into the installed skill, or use an explicit pinned bootstrap with integrity and offline-cache behavior. Do not ship an entrypoint that only works from a development checkout. Exclude local paths, account IDs, credentials, transcripts, and private configuration from the public package.

Release sequence: implement and test locally; create the public GitHub repository under `1saifj`; push the reviewed package and tagged release; verify discovery with `npx skills add 1saifj/relayrook --list`; test installation in isolated profiles for the intended hosts; then verify the resulting directory page.

Installation command:

```bash
npx skills add 1saifj/relayrook --skill relayrook \
  --agent codex claude-code kiro-cli opencode devin
```

The installer currently knows those five agent IDs and discovers `skills/<name>/SKILL.md`. [skills CLI repository](https://github.com/vercel-labs/skills)

skills.sh does not require uploading a separate skill package to a marketplace. Its FAQ says public GitHub skills are tracked and listed through installation telemetry from `npx skills add`. A GitHub push alone does not prove a directory listing is visible, and timing/ranking should not be promised. [skills.sh FAQ](https://www.skills.sh/docs/faq)

## Decision

RelayRook combines one portable skill, a direct ACP runtime, a native Codex adapter, live inventory, explicit caller metadata, and role-specific evidence. Compatibility claims follow the execution matrix; discovery, successful inference, and task quality are separate results.
