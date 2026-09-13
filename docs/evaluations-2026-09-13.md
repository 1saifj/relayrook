# Seeded smoke evaluations — 2026-09-13

RelayRook 0.2.0 on macOS arm64 completed a selected matrix of 12 trials: **10 passed and 2 failed**. Six preliminary trials are retained separately. Across all 18 recorded trials, 10 passed and 8 failed; six hit their timeout and one completed without a final result contract.

Each backend ran two repetitions of a pagination implementation, a cart correctness review, and a vault security review through RelayRook itself. This is a small integration exercise, not evidence of general agent quality.

| Backend / role | Observed model | Effort | Pass | Seconds per trial | Location precision / recall |
| :--- | :--- | :--- | :--- | :--- | :--- |
| codex / implementation | gpt-5.6-sol | high | 2/2 | 103.8, 94.5 | Not scored |
| codex / code-review | gpt-5.6-sol | high | 2/2 | 68.3, 77.4 | 1.00 / 1.00; 1.00 / 1.00 |
| codex / security-review | gpt-5.6-sol | high | 2/2 | 185.8, 140.6 | 0.67 / 1.00; 1.00 / 1.00 |
| opencode / implementation | opencode-go/kimi-k2.7-code | Not advertised | 0/2 | 147.6, 180.3 | Not scored |
| opencode / code-review | opencode-go/kimi-k3 | Not advertised | 2/2 | 284, 292.8 | 1.00 / 1.00; 1.00 / 1.00 |
| opencode / security-review | opencode-go/deepseek-v4-pro | Not advertised | 2/2 | 94.7, 84 | 1.00 / 1.00; 1.00 / 1.00 |

All observed model pins were verified. Codex reported and verified `high` effort. OpenCode did not advertise an effort setting.

## What the failures mean

OpenCode implementation with `opencode-go/kimi-k2.7-code` returned no final result block in one completed turn (147.6 seconds); the second turn exceeded 180 seconds. Tool events showed correct pagination edits and passing checks, but the requested result contract did not complete. Both remain failures.

The six excluded preliminary trials comprise four reviews before the cart behavior was explicitly specified (three timeouts and one expected-finding mismatch), plus two Codex security turns cut off at 120 seconds. The clarified reviews and security retries used a 300-second cap. Preliminary failures remain in the JSON report; they are not counted as successful retries.

Before the corrected matrix, three unscored diagnostic attempts were aborted: two Codex review prompts were rejected for session posture, and one OpenCode turn was interrupted while awaiting permission. They are listed separately in JSON and excluded from the 18 recorded trials. All diagnostic workers are stopped.

## Measurement limits

- Precision and recall use basename/line matching within three lines. They are **not semantic review accuracy** or evidence of general security-review quality.
- Security scoring includes only the SQL-injection and path-traversal seeds. Non-constant-time comparison observations are unscored. One additional Codex symlink finding is unmatched by this heuristic, not adjudicated as false.
- Latency includes inspected manual permissions and concurrent execution. Different models and timeout caps make it unsuitable for speed rankings.
- Source scope checks include additions, edits and deletions. All ten passing trials were scope compliant; failed implementation trials lack a completed evaluator scope verdict.
- The evaluator hides its answer-key file. The selected cart task explicitly defines required behavior without giving finding locations.
- Two repetitions of one fixture per role are insufficient to select the best agent or change global routing evidence.

## Reported token usage

Values below are per-trial means, using only provider-reported values. Missing values stay unavailable; cached input is separate from uncached input.

| Backend / role | Uncached input | Cached input | Output | Total |
| :--- | ---: | ---: | ---: | ---: |
| codex / implementation | 15248 | 192832 | 3179 | 211259 |
| codex / code-review | 19951 | 90944 | 2396 | 113291 |
| codex / security-review | 32033 | 172736 | 6735 | 211504 |
| opencode / implementation | 2049 | Unavailable | 237 | 74142 |
| opencode / code-review | 528 | Unavailable | 1373 | 74042 |
| opencode / security-review | Unavailable | Unavailable | 1990 | 85994 |

The [machine-readable report](evaluations-2026-09-13.json) includes every selected and preliminary trial, exact observed models and efforts, normalized token fields, timeout caps, and scoring limits. It excludes transcripts, private paths, raw provider payloads, and account quota data.
