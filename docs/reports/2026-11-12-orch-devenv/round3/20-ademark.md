# 20 · ADEMark: Volt on the ADEMark method, next to the published field

Status: draft (2026-11-13). Branch `e3/ade`, worktree `volt-e3-ade`.

**ADEMark method, unofficial.** Everything here uses ADEMark's own replay server, native helper (`procs`, `idle`,
`sample`), prompts (TASKS.md) and procedures (TESTS.md A1-A11, B1-B4), but run in a normal macOS account on a shared
laptop, not in the dedicated `ademark` user on the reference Mac mini M4. None of these numbers is an ADEMark result,
and none may be published as one. The published numbers quoted next to ours are ADEMark's own (official runs).

## Summary

__SUMMARY__

## Headline table

__HEADLINE__

## Track B (tokens) in detail

Captured with `scripts/ademark/capture.ts` (a base-URL proxy in front of api.anthropic.com; ADEMark uses a mitmproxy
addon) and scored with `scripts/ademark/b-analyze.mjs` using ADEMark's split (fresh input, cache write, cache read,
output, side calls) and its price file `prices/2026-10.json`. Claude Opus 5.5 at high effort, Full access, the
arena (`arena/`, with the `ledger-ok` canary in `AGENTS.md` and `CLAUDE.md`) as the project. These turns used the
owner's own Claude login, not ADEMark's dedicated account, so the account's claude.ai connector tools
(`mcp__claude_ai_Claude_Docs__*`) and its `userEmail` reminder are in every request. An official run would not have
them; they are small (0.4K tokens in the dev build, 1.4K in 0.0.6) and are listed apart below.

| Arm | Test | n | First request input (tokens) | Cache write | Cache read | Output | Side-call tokens | $ (median, range) | Main requests / tool calls |
|---|---|---|---|---|---|---|---|---|---|
| Volt dev (`e3/ade`, Claude Code 2.1.322 via agent SDK 0.3.322) | B1 "hi" | 3 | 29,524 / 32,681 / 32,686 | 13,266-16,428 | 16,256 | 49-76 | 3,216-10,835 | **0.144** (0.119-0.144) | 1 / 0 |
| Volt dev | B3 real prompt | 1 | 33,343 | 21,991 | 120,907 | 3,090 | 3,945 | **0.270** | 4 / 2 |
| Volt 0.0.6 installed (its own `claude-agent-acp` from npx: Claude Code 2.1.280, SDK 0.3.280) | B1 "hi" | 4 | 99,639-100,222 | 6,090-99,637 | 0-94,130 | 13-67 | 5,807-13,093 | **0.103** (0.077-0.805; 0.805 is the first, cold-cache run) | 1 / 0 |
| Volt 0.0.6 | B3 real prompt | 1 | 100,235 | 11,334 | 293,654 | 2,974 | 6,044 | **0.217** | 3 / 3 |

Published (official) leaders for the same tests: B1 $ Paseo 0.006, bb 0.006, MonoCode 0.007 (all cache read only, about
22.1K tokens, no cache write); Bare Claude Code CLI 0.096; Claude.app 0.110; T3 Code 0.141. B3 $ Paseo 0.150,
MonoCode 0.170, Bare CLI 0.210, T3 Code 0.212.

B2 (request anatomy of the first B1 request, sizes from the JSON at 4 characters per token; ADEMark counts with
`count_tokens`, so these are approximate):

| Segment | Volt dev | Volt 0.0.6 | Bare CLI (published) | Paseo (published) |
|---|---|---|---|---|
| System prompt | 1.9K | 1.9K | 2.3K | 1.9K |
| Built-in tools | 8.4K (13 tools incl. `ToolSearch`; the rest deferred) | 21.6K (31 tools, none deferred) | 17.3K | 8.0K |
| MCP tools | 3.1K (6 Volt tools 2.7K, 3 account connector tools 0.4K; every other Volt tool deferred behind `ToolSearch`) | 38.3K (123 Volt tools 36.9K, 8 account connector tools 1.4K) | 0 | 0 |
| Messages (Volt's `[Volt]` lead, `<volt_workspace>`, skills list, the prompt) | 6.9-9.2K | 4.0-4.4K | 0.55K injected | 0.55K injected |
| Tools in the request | 22 | 162 | | |

B4 (repo rules): the canary text is in the main request in every arena run of both builds (`in-request` yes). B1
answers in the arena end with `ledger-ok` (checked on the 0.0.6 arena run; the dev runs' answers were not recorded).
0.0.6's B1 repetitions 1-3 ran in a scratch folder, because a new chat in 0.0.6 starts with no project unless one is
picked; repetition 4 and B3 ran in the arena (`volt-drive.mjs project-send`).

What the numbers say:

- **The installed 0.0.6 sends about 100K tokens for "hi"**, 3.4x the dev build, because the adapter it fetches with
  npx bundles agent SDK 0.3.280, which sends every Volt MCP tool's schema (about 37K tokens) and every built-in tool up
  front. The dev build runs the system `claude` 2.1.322 (SDK 0.3.322), whose tool search defers them: 22 tools sent.
  Most of the dev/0.0.6 difference is the adapter version, not Volt's own code; the next release should pin an adapter
  with tool search.
- **The dev build pays 13-16K tokens of cache write on every "hi"**: the cached prefix ends after the tools
  (16,256 tokens read every time) and the first user message, which carries Volt's lead and workspace block, differs
  per thread, so it is written fresh. Paseo, bb and MonoCode pay no write at all; that is the whole gap between $0.144
  and $0.006. Stable text first and per-thread text last in the first message would let it cache. This is the tokens
  area's work (report 23); not changed here.
- Volt's own messages (6.9-9.2K) are larger than every published ADE's injected text (0.4-1.1K).

## Method

- **Rig.** ADEMark `f38966f` cloned to `~/.volt-r3/ademark`; its replay server (`bench/replay/server.ts`, port 18951,
  its own session files), its native helper (`ademark-native procs / idle / sample`) and its clock. Our runner
  `scripts/ademark/run.ts` follows TESTS.md A1-A11 step by step; `trackA.sh` sequences the runs; `setup.sh` rebuilds the
  rig after a reboot. Every app runs with an isolated HOME and profile, `ANTHROPIC_BASE_URL` pointed at the replay
  server and a dummy key, and the same `claude` binary first on PATH (2.1.322 in the first pass, 2.1.323 after the
  second reboot: Claude Code updated itself in between).
- **Arms.** Volt dev = this branch's unbundled `out/` on a private copy of the dev Electron (the worktree's
  `.build/electron` is shared with the user's own dev Volt). Volt 0.0.6 = a copy of `/Applications/Volt.app`. Both
  with Claude Opus 5.5, high effort, Full access, 5 seeded threads (`replay:seed`), arena `arena/` as the project.
- **What differs from an official run.** No `sudo purge` before A1; Ready is read from the DOM over CDP ("DOM echo":
  the probe text is in the focused composer), not from screen pixels, because this account has no Screen Recording
  grant for the harness; probe keys go in through CDP `Input.dispatchKeyEvent`, not CGEventPost (the user works at
  this Mac, and CGEventPost would type into whatever is in front); Electron apps launch with
  `--remote-debugging-port`, which the method forbids on a timed launch. DOM time is before paint and composite, so
  our A1-A4 and A11 times are lower bounds against ADEMark's pixel times (at least one frame, ~8-17 ms, often more).
  **A8 is not comparable at all**: ours is `keydown.timeStamp` to the first animation frame after the composer's DOM
  changed, inside the page; ADEMark's is key post to changed pixels, which adds the OS input path, compositor and
  display (the published field is 48-92 ms; no Electron app paints a key in 8 ms end to end).
- **Load.** 14 cores, five agents. A test starts only when the 1-minute load is at most 14 (`run.ts` load gate); a row
  counts as **clean** only when the 1-minute load was at most 14 both at its start and when its row was written
  (`summarize.mjs`). The first pass (13:44-14:58) gated only the start; most of its launch rows ended with the load
  at 15-58, so they were retaken in a second pass (`trackA.sh retake`), interleaving the two arms per repetition.
  Overloaded rows stay in the data files and are listed apart; medians below use clean rows only.
- **Not the ADEMark statistic.** ADEMark reports medians of 6-10 runs on an idle machine; ours are medians of the
  clean rows, n as stated, with the range.

## Fixes on this branch

| Commit | What | Measured |
|---|---|---|
| `8e69441aa56` | fix(agent): send the ACP lead as its own prompt block. Before it, the replay server (which matches a whole text block) could not identify any Volt prompt, so A4, A7, A8, A10 and A11 could not run on Volt at all. The speed branch carries an equivalent commit, `19ffd10b7b8`; merge one of them, not both. | Enables the replay tests; no timing claim. |
| `f1021689ea2` | fix(sandbox): a loopback `ANTHROPIC_BASE_URL` (a local gateway, or the replay server) is granted like Volt's MCP port. Before it the sandbox refused it and the turn sat on "Thinking" while the CLI retried. | Enables the replay tests. |
| `0a444267dae` | fix(agent): keep the chat title when Claude Code titles a session from Volt's lead (a side effect of `8e69441aa56`). | Correctness. |
| `75aa8a9bc00` | fix(agent): the agent list opens at launch without taking the composer's focus. The first keys typed after launch went to the list. | __AB__ |

## Not done, and why

- **The comparison apps were not measured on this rig.** `trackA.sh others` and `run.ts` support T3 Code, Paseo,
  Zeron, MonoCode, Claude.app and super.engineering, but two reboots (09:03 and about 15:00) and a machine at load
  15-237 all afternoon left time for the two Volt arms only. The draft covered no comparison app, so nothing was
  retaken for them; the comparison in this report is with ADEMark's published (official) numbers, which come from a
  different machine and a stricter method. super.engineering was not downloaded again after the second reboot.
- **A7 (weight with 5 streams), A9, A10, A12** were not run. **A11 scroll** (frame gaps during 20 wheel events) needs
  CGEvent scroll and frame capture, which need the Screen Recording grant; only A11 open was taken. **A6 covered,
  energy and package power** need a covering window and `powermetrics` (sudo); only CPU (front) and wakeups were taken.
- **Volt 0.0.6 cannot run A8 or A11 against the replay**, and its A4 is answered by the replay's fallback `ok`: 0.0.6
  puts Volt's lead and the prompt in one text block, so the replay server cannot tell which session it is
  (`8e69441aa56` fixes that for the next release). The long thread could not be built in 0.0.6 for the same reason.
- **The A/B of `75aa8a9bc00`** (focus at launch) was taken in the morning with 7 of its 8 rows ending at load 15-34: A2
  ready median 6.4 s before vs 7.7 s after (n 4 each, ranges 4.7-8.1 and 7.3-13.3 s). That is noise under load, not a
  measured effect either way; the fix is a correctness fix (the first keys went to the agent list) and is listed
  without a speed claim. Raw rows: `data/ademark/ab-75aa8a9-*.jsonl`.
- **Track B** has n 3 (dev "hi"), n 4 (0.0.6 "hi") and n 1 (each B3), short of ADEMark's 3+3 for B3; more live Opus
  turns were not spent. B4 "obeyed" was checked in 0.0.6's arena answer only.
- **An official run** needs the `ademark` macOS user, which only the owner can create (next section).

## What the owner must do for an official run

ADEMark official runs happen only in a dedicated macOS administrator user `ademark`, which only the owner can create,
started by hand from Ghostty (RUNBOOK.md §0 and §4.1):

1. `sudo sysadminctl -addUser ademark -fullName "ADEMark" -password - -admin`, then quit every app, log out of the
   owner's account (switching users is not enough) and log in as `ademark`.
2. In the owner's account once: `sudo zsh bench/ops/install-machine.zsh` (installs the `ademark-machine` helper and its
   sudoers rule; read the warning in RUNBOOK.md first).
3. In `ademark`: clone ADEMark to `~/ADEMark`, apply our adapter patch
   (`ademark-volt/0001-Add-Volt-adapter-and-profile-draft-not-gated.patch`, against zqkra/ademark `f38966f`), build
   the native helper (`bash bench/native/build.sh`), `bun bench/cli.ts account setup --apply` and trust the mitmproxy
   certificate it prints, grant the permissions of §4.11 (Screen Recording and Accessibility for the harness, so Ready
   is read from pixels, not from the DOM as here), and calibrate Volt per `bench/adapters/CALIBRATE.md` until
   `bun bench/cli.ts doctor` shows a gate for it.
4. Install Volt in `/Applications` inside `ademark`, sign in to Claude there with the dedicated account (no claude.ai
   connectors), then `bun bench/cli.ts prepare --tracks A,B --agent claude` and, the next night,
   `bun bench/cli.ts night --until 07:30` from Ghostty.
5. Submitting upstream is a separate decision: the adapter is kept here as a patch; no PR was opened.

## Files

- Scripts: `scripts/ademark/` (`run.ts` runner, `trackA.sh` sequences, `setup.sh` rig rebuild, `winwait.swift` first
  window without Screen Recording, `capture.ts` Track B proxy, `b-analyze.mjs` Track B scoring, `summarize.mjs`
  medians, `volt-drive.mjs` untimed setup over CDP).
- Data: `data/ademark/` (Track A rows per arm, Track B scored JSON and marks; raw captures stay outside the repo
  because they hold the owner's account e-mail).
- ADEMark adapter and profile for Volt: `ademark-volt/` (`volt.ts`, `volt.json`, the patch).
