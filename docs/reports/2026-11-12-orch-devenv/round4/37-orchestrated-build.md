# Round 4, c1: ADEMark C1 (Orchestrated Build) on Volt

Status: draft (results pending; this file is rewritten when the runs are in).

## Method (ADEMark method, unofficial)

What is the same as ADEMark (TASKS.md, TESTS.md section 4, bench/tracks/c):

- **Prompt.** `tasks/C1-orchestrated-build/prompt.md` from the ADEMark clone (`~/.volt-r4/ademark`, v1.0.0 task
  folder, arena at commit `270c930`), byte for byte, with the four handoff codes filled in per run by ADEMark's own
  algorithm (`HMAC-SHA256(seed, "W<n>")`, first 6 base32 characters; checked equal to `bench/core/tasks.ts`
  `generateHandoffCodes`). The seed is `ademark-volt-r4-<run id>`, so every run has fresh codes. Volt's one-line
  orchestration trigger goes first, as ADEMark sends every app's (rule 4 of TASKS.md):
  `Use Volt's delegate_task to run the four work items in parallel, one subagent per item.` It is written like the
  Synara and Capy trigger lines (an instruction, not a slash command) and says nothing about worktrees, merging or
  reports: those come from the C1 text itself. C1 has no follow-up messages (those belong to C2).
- **Arena.** A fresh clone of ADEMark's `arena/` per run, on `main` (`scripts/c1/mkarena.sh`).
- **Pins.** Opus 5.5, high effort, full access. In Volt: the model picker's Opus 5.5 row with Effort set to High
  (Volt's shipped default for Opus 5.5 is Medium; ADEMark pins high for every app), Permissions: Full access. The
  Bare CLI runs `claude -p --model claude-opus-5-5 --effort high --dangerously-skip-permissions`.
- **Clean agent config.** Both arms run Claude Code on a throwaway config dir holding only the live login's access
  token (`mkcfg.sh`, `CLEAN=1`: no user settings, MCP servers, skills, plugins or memory), like ADEMark's fresh
  `ademark` macOS user.
- **Capture.** Every model request of every Claude Code process goes through a logging reverse proxy
  (`scripts/c1/proxy.mjs`, `ANTHROPIC_BASE_URL`), which records the usage of each response and reads each request
  body the way ADEMark's `tracks/c/agents.ts` does (client session, coding tools, whether it answers a tool, the
  thread it starts).
- **End of a run** (TESTS.md 4, since 2026-11-11): after the first end of turn, the run is over when no request has
  answered a tool for 5 minutes; the end time is the last answer to a tool (or the first end of turn when none
  followed). Cap 45 minutes. `time-to-green` = end time minus `t0` (taken just before Enter) when shipped is 5/5.
- **tokens-total** = input + cache write + cache read + output of every completion in the run window, side calls
  included (`runTokens`); USD from ADEMark's `prices/2026-10.json`, per request.
- **handoff** = items whose `W<n> | <branch> | <code>` line in `REPORT.md` has the right code (`handoffCount`);
  **codes placed** = modules whose first line is `// handoff: <code>`.
- **fan-out** = most worker sessions (Claude Code session logs with a worktree `cwd`) running at once, and how many
  ran.

What differs from ADEMark, and why:

- **shipped uses our own tests, not ADEMark's hidden tests.** The hidden tests are published only as SHA-256, so
  `shipped` and `time-to-green` here are graded with tests we wrote from the task text in round 3
  (`scripts/c1/tests/`, the same groups: W1 limiter + API, W2, W3, W4 create + idempotency, Integration with
  `npm test` on main). They are labelled "own tests" everywhere and are not comparable with the site's 5/5.
- **Volt's sandbox is Off** for the lead and every subagent (profile default, set in the runtime's storage before
  launch). Volt's shipped default on macOS is a workspace-write Seatbelt sandbox whose network goes through Volt's
  filtering proxy and refuses loopback ports, so the capture proxy on 127.0.0.1 could not be reached with it on
  (ADEMark's mitmproxy capture would meet the same wall). Both Volt builds run the same way.
- **The Bare CLI runs headless** (`claude -p`, stream-json), not interactively in Ghostty. Its prompt is the
  C1-solo text.
- **Off the reference Mac**: this Mac is shared with three to six other agents. Every run records the load; a run
  taken above load 14 has its time marked "under load" and kept out of any timing claim.
- **No C3 probe** (chat lock) runs during C1 here.
- Versions: Volt's agents send as Claude Code 2.1.322 (`agent-sdk/0.3.322`, the ACP adapter's bundle); the Bare CLI
  is Claude Code 2.1.323 (User-Agent of the captured requests).

Scripts: `scripts/c1/` (`runvolt.mjs`, `runcli.mjs`, `proxy.mjs`, `grade.mjs`, `analyze.mjs`, `common.mjs`).
Data: `data/c1/` (`c1-runs.jsonl` rows; per run the prompt sent, grade, capture rows without bodies, Volt traces).
