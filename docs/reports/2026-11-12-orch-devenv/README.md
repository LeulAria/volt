# Orchestration, sandbox and dev-environment test pass (2026-11-12)

Branch `feat/orch-and-devenv-revamp`. The "before" baseline is the installed Volt 0.0.6
(`/Applications/Volt.app`, commit `de2ea41`, 2026-11-04) or this branch before a fix, as each
report says.

Two chats worked on this request at the same time. This chat's reports are the numbered files
below. The first chat ("So in this branch i want you to merge main…") had its agents work on
`e2e/orch`, `e2e/ide` and `e2e/sbx`; those branches are merged here and their review is in
[`parallel/`](parallel/README.md).

## Reports

| # | Report | Area |
|---|---|---|
| 00 | [00-merge.md](00-merge.md) | Merging main and the open PRs, type check, unit suites |
| 01 | [01-orchestrator.md](01-orchestrator.md) | Orchestrator end to end: speed, tokens, cost, reliability |
| 02 | [02-code-intelligence.md](02-code-intelligence.md) | Code intelligence on the user's hotel app (**partial**: the agent was stopped) |
| 03 | [03-sandbox.md](03-sandbox.md) | Sandbox performance, adversarial suite, first-party extensions |
| 04 | [04-sample-extension.md](04-sample-extension.md) | Agent Lab sample: permissions at install, malicious behavior at runtime |
| 05 | [05-ide-tooling.md](05-ide-tooling.md) | Debug, tests, HTTP, Docker, DB, profiler (**pointer**: results are in parallel/02) |
| 06 | [06-agent-to-agent.md](06-agent-to-agent.md) | Teams, councils and subagents compared with Claude Code's own |
| P | [parallel/](parallel/README.md) | The first chat's review: orchestrator micro-bench, code intelligence A/B on a hotel PMS, sandbox attack matrix |
| R2 | [round2/](round2/README.md) | Round 2 (2026-11-12/13): benchmark against Hermes Agent, Claude Code, Cursor and T3 Code; round 1's open items; UI sweep |
| R3 | [round3/](round3/README.md) | Round 3 (2026-11-13): ADEMark method next to the published field, app speed, long threads, tokens, orchestration vs Claude Code |

## Headline numbers

| Area | Before | After | Where |
|---|---|---|---|
| B1 orchestration (4 Haiku subagents, 3 parallel + 1 dependent): critical path | 28.1 s | 20.4 s median (18.1–22.8 s) | 01 |
| B1 subagent cost (cold cache / warm cache) | $1.38 | $0.89 / $0.39–0.43 | 01 |
| Prompt per subagent request | 43.7k tokens | 29.3–30.2k | 01 |
| Lean spare adopted by the next subagent | first-run synthesis only | 1–159 ms, every run | 01 |
| `delegate_task` fan-out of 20 parts: saves / bytes / time to start all | 20 / 2.9 MB / 128 ms | 2 / 161 KB / 17 ms | parallel/01 |
| Wake-ups of a parent for one 3-part `delegate_task` | 3 | 1 | parallel/01 |
| Team of 3 on a 6-item board (sandboxed chat) | blocked (approval card, then the sandbox gate), then every member did every item | each item claimed once, 29 s, $0.79 | 06 |
| Council (Haiku + Grok) | 456 s, Grok turns hanging on denied SQLite writes | 123–146 s, verdict correct | 06 |
| Sandboxed agent launch prepare / launcher path (load 18) | 41 ms / 133 ms | 9 ms / 70 ms | 03 |
| Adversarial sandbox suite | 34 passing | 40 passing | 03 |
| Attack matrix: canary reads, home writes, git hooks, tasks.json, Docker socket, shell child, delayed attack | through without the sandbox | blocked and warned in every sandboxed arm, 3/3 runs | parallel/03 |
| Malicious Agent Lab switches in the default (unsandboxed) extension host | 5 of 7 got through, no warning | 6 high + 8 medium findings at install, "Run in a Sandbox", runtime warning; blocked in the sandboxed host | 04 |
| Volt code tools in a Supervised (sandboxed) chat | all failed ("this chat has no folder") | working | parallel/02 |
| Code index per query vs ripgrep (in-process) | 37–82 ms | 0.04–6.8 ms | parallel/02 |
| Full unit suite | 15,803 passing | see "Verification" | 00 |

### Was the 10× / 100× target reached?

No, and the reports say why with numbers. After these fixes Volt's own orchestration overhead is
milliseconds (parallel/01). About 90% of a short subagent's time is the model: time to the first
token on a ~30k prompt, thinking and output. The process start is the next largest piece. Measured
gains are 27% on wall time and 35–72% on cost for orchestration, and 7–19% on time with 36% less
tool output for code questions (parallel/02). Teams and councils went from not working in a
sandboxed chat to working. Claude Code's native subagents are still about 2.3× leaner per request
(06), because they run in the parent's process and get a stripped-down prompt.

## Commits in this pass (on top of `e33c552f2fc`)

This chat:
- `6268883cd46` perf(orchestrator): delegated Claude subagents start lean
- `0b9815e5bb5` feat(agent window): open a typed folder path from the project picker
- `4c5cb8714c0` fix(sandbox): faster agent launches, two address/port holes, quiet harness housekeeping
- `26154dbf32a` feat(extensions): scan an extension's code at install, warn when Volt refuses its calls; Agent Lab sample
- `7828efbf6e1` fix(orchestra): team and council tools run like delegate_task, from any chat
- `dc367c381f7` fix(agents): Grok's SQLite sidecars in the sandbox; Antigravity starts without --model
- `14b31bc942d`, `bfa7d1d4f37`, `f3e638cc767`: merges of `e2e/orch`, `e2e/sbx` (Agent Lab samples
  split, install sheet keeps the pre-install review and the code scan) and `e2e/ide`

The first chat (merged): 30 commits on `e2e/orch`, `e2e/ide` and `e2e/sbx`; the list is in
`git log e33c552f2fc..HEAD`, and each is described in its parallel report.

## Verification

- `tsgo`: 0 errors after the last merge.
- Suites run while changing code (all passing): Claude work rules, ACP provider, agent pool,
  orchestrator and runtime (213); host tools (54/39); host-tool sandbox classes (9); orchestra
  (191); providers as data and sandbox (283); sandbox attestation (17); adversarial and Seatbelt
  equivalence (43); ACP and Antigravity (110); security, extension, code-scan and sandbox after the
  `e2e/sbx` merge (330).
- The full unit suite after all merges is in 00-merge.md, "After all merges".

## Still open (needs a decision or more work)

- **Antigravity in a sandboxed chat:** its language server needs a random loopback listen port.
  The sandbox allows only granted ports, and on macOS a granted port is reachable on every interface
  (03, 06). Your call: run Antigravity only with the sandbox off, or grant it one fixed port.
- **fx in a sandboxed chat:** "Failed to load startup state". Its login is likely in the keychain,
  which agent sandboxes deny, and it has no secure-storage bridge like Claude's (06).
- **Network-on sandboxes allow egress to any host** (parallel/03, attack matrix): the sandbox
  limits files, not where an agent with network on can send data. Hostname rules apply to extension
  hosts (T3), not agent chats.
- **Default council seating** doesn't check whether providers can run (quota, sandbox support). A
  2-seat council's blind review shows each reviewer one answer.
- **Chat titles** sometimes come from the agent's first words ("I couldn't run this. No `council`")
  instead of the request.
- **Runtime checks never done:** notebook run, `code_action rename` applied live, the "+" menu's
  HTTP Client entry, Container Tools download at build, and agent use of Scratch and canvas (05).
- **Agents rarely pick the IDE tools** (debugger, test runner, profiler, HTTP, Docker): 1 run in 13
  (parallel/02).
- **UI details seen while testing, not changed:**
  - the background orbit labels draw over the project bar (design from PR #87);
  - transcript rows "ToolSearch" and "Thinking" overlap while streaming;
  - a stray "–" glyph in the left margin;
  - the first recent project's path is cut mid-word in the picker;
  - a yellow "Sandbox is partial here" notice sits at the top of every sandboxed chat.
- `git stash` "cancelled code-intel agent partial work" holds the stopped agent's unverified edits
  (code_nav output, `alwaysLoad` for IDE tools, routing guidance). Review or drop it.
