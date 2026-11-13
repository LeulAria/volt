# 20 · ADEMark: Volt on the ADEMark method, next to the published field

Status: **final** (2026-11-13). Branch `e3/ade`, worktree `volt-e3-ade`.

**ADEMark method, unofficial.** Everything here uses ADEMark's own replay server, native helper (`procs`, `idle`,
`sample`), prompts (TASKS.md) and procedures (TESTS.md A1-A11, B1-B4), but run in a normal macOS account on a shared
laptop, not in the dedicated `ademark` user on the reference Mac mini M4. None of these numbers is an ADEMark result,
and none may be published as one. The published numbers quoted next to ours are ADEMark's own (official runs).

## Summary

- **Where Volt is first.** On the in-app tests that our DOM timing can take, Volt is ahead of every published ADE:
  new thread to typing (A3) 127 ms for 0.0.6 and 154 ms for the dev build against the best published 183 ms
  (Emdash), and opening a 2,000-message thread (A11) 30 ms (dev) against 77 ms (Zeron). Our DOM times are lower
  bounds of ADEMark's pixel times (at least one frame, 8-17 ms, more with composite), and the margins are larger than
  that, but they are not official numbers.
- **Cold start (A1)**: 0.0.6 reaches typing in 1.26 s, below the best published 1.76 s (super.engineering). That is
  not a win on equal terms: we cannot `purge` the file cache, so our "cold" start reads warm files. On this Mac,
  by first window (the one launch measure we could take for every app), Volt 0.0.6 is **4th of 7** (522 ms), behind
  the three native or WebKit apps (super.engineering 292, MonoCode 341, Zeron 371 ms) and the fastest of the four
  Electron apps (Claude.app 647, Paseo 758, T3 Code 1,157 ms).
- **Relaunch (A2)**: 0.0.6 1.62 s to typing; it would place 10th of 14 published (leader Diri 0.67 s). By first
  window here it is 5th of 7 (499 ms, tied with Claude.app's 497 ms). Volt relaunches no faster than it cold-starts
  because nothing is purged between them and the agent server is up in both; the time is the workbench starting.
- **First word (A4)**: the dev build 331 ms (244 ms before the request leaves, 83 ms from response to screen); it
  would place 3rd of 12 published (Diri 256, Orca 302). The 244 ms is the hop renderer -> agent server -> ACP adapter
  -> Claude Code -> request; Diri and Orca leave in 116-124 ms. 0.0.6's 202 ms is not comparable (the replay answers
  its unmatched prompt with a two-letter fallback).
- **Weight (A5) and idle CPU (A6)**: Volt 0.0.6 with its 5 seeded threads, at rest, weighs 788 MB, the **heaviest of
  the 7 shipped apps measured here** (Zeron 90, super.engineering 157, Paseo 296, Claude.app 532, MonoCode 568,
  T3 Code 604 MB; none of them had threads or a project). Against the published totals (which include each app's
  agent processes) it would place 4th of 14. Idle CPU 0.52 % of a core and 32 wakeups/s: 5th of 7 here (Paseo,
  super.engineering and Zeron at 0.11-0.13 %), 2nd of 15 published. The dev build is not a product number
  (unbundled: 1,391 MB app, plus 4 Claude sessions left from earlier tests, 2,537 MB).
- **Typing lag (A8)**: 8.1 ms p95 in the page with 5 streams; not comparable to ADEMark's key-to-pixel 48-92 ms and not
  ranked.
- **Tokens (Track B)**: this branch's dev build costs $0.144 for "hi" and $0.270 for the real prompt, last of 15 and
  14th of 15 against the published field (Paseo $0.006 and $0.150), because every "hi" writes 13-16K tokens of cache.
  The tokens branch (`e3/tokens`, report 23, final) brings "hi" to 21.1K tokens and $0.0057 (n 3), level with Paseo's
  $0.006, and B3 to $0.151 against Paseo's $0.150, on its own rig.
- All numbers: ADEMark method, unofficial, medians of rows with the 1-minute load at most 14 at a test's start and
  end. Overloaded first-pass rows were replaced by the evening retake (listed under "Replaced samples").

## Headline table

Volt's clean medians (n, range, 1-minute load at start and end of those rows), the comparison apps measured on this
Mac, and ADEMark's published leaders (official, Mac mini M4, `control-2026-11-10`; the Bare Claude Code CLI is left
out of the ranks because it is not an ADE). "Place" is where Volt's number would fall in the published list; the
methods differ (see "What differs"), so it is an indication, not a ranking.

| Test | Volt 0.0.6 (installed, copy) | Volt dev (`e3/ade`, unbundled) | Apps on this Mac (same rig) | Published leaders | Volt's place among published |
|---|---|---|---|---|---|
| A1 cold, launch to typing | **1.26 s** (n 5, 1.20-2.98; load 5.9-12.5) | 3.31 s (n 5, 2.65-3.98; load 6.3-13.6) | Ready not taken (no composer, see Method) | super.engineering 1.76, MonoCode 1.80, Zeron 1.92 s | 0.0.6 1st of 13 (no purge: warm files); dev 9th |
| A1 cold, first window | 522 ms (n 5, 464-1,837) | 1,001 ms (n 5, 580-1,263) | super.engineering 292, MonoCode 341, Zeron 371, Claude.app 647, Paseo 758, T3 Code 1,157 ms | not published | here: 0.0.6 4th of 7, dev 7th of 8 |
| A2 relaunch, to typing | 1.62 s (n 7, 1.12-2.56; load 4.8-13.3) | 2.65 s (n 4, 2.57-3.37; load 5.2-11.8) | Ready not taken | Diri 0.67, Zeron 0.78, super.engineering 0.85 s | 0.0.6 10th of 14; dev 11th |
| A2 relaunch, first window | 499 ms (n 7, 452-936) | 593 ms (n 4, 573-854) | super.engineering 272, Zeron 331, MonoCode 332, Claude.app 497, Paseo 727, T3 Code 1,168 ms | not published | here: 0.0.6 5th of 7, dev 6th of 8 |
| A3 new thread to typing | **127 ms** (n 7, 88-540; load 3.8-13.8) | **154 ms** (n 9, 120-209; load 6.4-12.8) | not taken | Emdash 183, MonoCode 191, T3 Code 202 ms | 1st of 11 (both builds) |
| A4 Enter to first word | 202 ms (n 6, 164-370; replay fallback answer, not comparable) | 331 ms (n 10, 264-421; load 6.4-13.3): 244 before the request, 83 on screen | not taken | Diri 256, Orca 302, Zeron 606 ms | dev 3rd of 12 |
| A5 weight, 5 idle threads | 788 MB (n 1; load 8.7; 0 agent processes) | 2,537 MB (n 1; app 1,391 + 4 live Claude sessions 1,146) | at rest, no threads: Zeron 90, super.engineering 157, Paseo 296, Claude.app 532, MonoCode 568, T3 Code 604 MB | total: super.engineering 134, MonoCode 419, Capy 593 MB | 0.0.6 4th of 14 (total), 11th of 15 (app only, just above Bb's 787.5); here: 7th of 7 |
| A6 idle CPU (front) | 0.52 % (n 1), 32 wakeups/s | 4.2 % (n 1), 82 wakeups/s | Zeron 0.11, super.engineering 0.11, Paseo 0.13, Claude.app 0.30, T3 Code 0.95, MonoCode 44.7 % | super.engineering 0.18, Diri 0.55, Capy 0.56 % | 0.0.6 2nd of 15; here: 5th of 7 |
| A8 typing lag p95, 5 streams | could not run (0.0.6 prompt not matched by the replay) | 8.1 ms in-page (n 2, 8.0-8.3; load 8.6-10.0) | not taken | T3 Code 48, Traycer 50, Synara 51 ms (key to pixels) | not comparable, not ranked |
| A11 open the 2,000-message thread | could not run (same reason) | **30 ms** to the last message visible (n 5, 25-34; load 7.7-8.8); DOM quiet after 1.45 s (1.26-14.4 s) | not taken | Zeron 77, Diri 88, Paseo 90 ms | 1st of 12 |
| B1 "hi" cost | $0.103 (n 4, 0.077-0.805) | $0.144 (n 3, 0.119-0.144) | not taken | Paseo 0.006, Bb 0.006, MonoCode 0.007 | 0.0.6 12th of 15, dev 15th; `e3/tokens` $0.0057 (n 3) would tie 1st |
| B3 real prompt cost | $0.217 (n 1) | $0.270 (n 1) | not taken | Paseo 0.150, Bb 0.166, super.engineering 0.169 | 0.0.6 11th of 15, dev 14th; `e3/tokens` $0.151 (n 3) would be 2nd |
| B4 AGENTS.md canary in the request | yes | yes | not taken | yes for every published app | level |

Volt's comparison-app columns: data `data/ademark/trackA-others-<app>.jsonl`; 5 launch repetitions per app (A1 and
A2 window; Paseo A1 n 4 clean, MonoCode A2 n 4 clean, the rest n 5; loads 6.1-13.5), one A5/A6 sample per app (loads
4.6-8.9).

## Track A (launch and in-app speed) in detail

**A1, A2 (launch).** What Volt's time is made of: first window at about 0.5 s, then about 0.7-1.1 s until the
workbench has restored the chat and focused the composer (0.0.6). The three apps ahead of it by first window are
native or WebKit shells (super.engineering, Zeron, MonoCode: 2-8 processes, no Chromium); the Electron apps measured
here open their first window later than Volt 0.0.6 at cold start (Claude.app ties it at relaunch). The dev build is unbundled (thousands of module files) and
is not a launch number for users. Volt is not first at relaunch because its relaunch costs the same as its cold
start; Diri, Zeron and super.engineering relaunch in under 0.9 s published.

**A3 (new thread).** Cmd+N to the probe text in a fresh thread's composer: 127 ms (0.0.6), 154 ms (dev). The
published field starts at 183 ms; a pixel read adds one to two frames (8-33 ms at 60-120 Hz), which still leaves both
builds under 183 ms. This is the speed area's target (report 21), measured here on the replay rig.

**A4 (first word).** Dev 331 ms = 244 ms from Enter to the request reaching the replay server + 83 ms from the
response to the word on screen. Volt is 3rd, not 1st, because of the 244 ms: the prompt goes from the renderer to
the agent server, through the ACP adapter and the agent SDK to the `claude` CLI, which then builds and sends the
request; Diri (116 ms) and Orca (124 ms) send sooner, and the Bare CLI 57 ms. The 83 ms on-screen half is 3rd of 12
published (Synara 70, Paseo 76).

**A5, A6 (weight and idle CPU).** 0.0.6's 788 MB: GPU process 216 MB, renderer 159 MB, extension and plugin hosts
89 MB, app main 74 MB, agent server and its code-index and file-watcher children 136 MB, helpers. With 5 restored
threads it starts no agent process until a thread is used (like MonoCode, super.engineering and Capy in the
published run, which also report 0 agents); the published apps that keep 5 agents alive carry 700-960 MB of them.
The first 0.0.6 sample (rep 1) is excluded: it ran with no window open (no renderer process in the sample) and four
Claude sessions left from the A4 runs, 1,331 MB; it is in the data file. The comparison apps here were measured with
no project and no threads, so they are lighter than in the published run (Zeron 90 MB here vs 209 MB published,
Paseo 296 vs 559 MB); Volt carried its arena project and 5 threads. MonoCode's 44.7 % CPU at rest (n 1) is what the
sample shows; its published front CPU is 9.0 %.

**A8 (typing lag).** 5 replay streams in 5 new threads, 60 keys at 250 ms in the composer: p95 8.1 ms (n 2) from
`keydown.timeStamp` to the first frame after the composer's DOM changed. That leaves out the OS input path,
compositor and display that ADEMark's key-to-pixel number includes, so it is not ranked.

**A11 (long thread).** The 2,000-message replay thread (`replay:long-2000`, built once with `volt-drive.mjs`):
switching to it from a seeded thread shows its last message in 30 ms (n 5), and the thread area stops changing after
1.45 s median (one run 14.4 s: the rail kept updating). ADEMark's "open" is click to the end marker on screen; its
leader is 77 ms. Only the dev build could run A11 (0.0.6's prompts are not matched by the replay, see "Not done").

### Replaced samples

The first pass (13:44-14:58) ran with the load rising to 15-58 during its launch rows. Replaced by the retake
(17:57-18:31):

| Arm | Test | First-pass rows dropped (load over 14 at start or end) | Retake rows used | Retake rows dropped |
|---|---|---|---|---|
| dev | A1 | reps 1-5 (end loads 16-58) | reps 8-11 | rep 7 (end 27.1) |
| dev | A2 | reps 1-5 (end loads 19.6-37.8) | reps 9-11 | rep 7 (end 21.8); rep 8 lost (its run was terminated) |
| dev | A3 | rep 5 (end 16.4) | reps 7-10 | none |
| dev | A8 | reps 1-2 (end 22.8, 32.0) | reps 3-4 | rep 5 (end 16.1) |
| dev | A11 | none usable (all 5 first-pass rows failed: the long-thread row was not found) | reps 1-5 | none |
| dev | A5/A6 | not run in the first pass | rep 2 | rep 1 (end 14.7) |
| 0.0.6 | A1 | reps 1-5 (end loads 14.3-33) | reps 8-11 | rep 7 (end 19.6) |
| 0.0.6 | A2 | reps 1, 2, 4 (end 25.1, 17.4, 24.7) | reps 8-11 | rep 7 (end 16.6) |
| 0.0.6 | A3 | rep 2 (end 15.5); rep 5 failed (CDP target not found) | reps 7-10 | none |
| 0.0.6 | A4 | reps 3, 4 (end 14.1, 16.1) | reps 7-10 | none |
| 0.0.6 | A5/A6 | not run in the first pass | rep 2 | rep 1 (no window open; clean by load) |

Kept from the first pass (clean): dev A1/A2 rep 6, A3 reps 1-4 and 6, A4 reps 1-6; 0.0.6 A1 rep 6, A2 reps 3, 5, 6,
A3 reps 1, 3, 4, A4 reps 1 and 2.

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

Placement against the published field (B1 and B3 dollars, 14 published ADEs each, Bare CLI left out): this branch's
dev build is last for "hi" ($0.144) and 14th of 15 for B3 ($0.270, ahead of Traycer only); 0.0.6 is 12th ($0.103)
and 11th ($0.217). Volt is not first here because of the per-thread cache write above and, in 0.0.6, the 100K-token
tool list. The tokens branch (`e3/tokens`, `23-tokens.md`, final) fixed the dev side on its own rig: "hi" 21.1K
tokens in one request, $0.0057 median (n 3; 0.0056-0.0656, the high run paid a 7.7K cache write), level with
Paseo's $0.006; B3 74.0K tokens, $0.151 median (n 3; 0.072-0.167) against Paseo's $0.150. Those are its numbers, not
re-measured here.

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
  at 15-58, so they were retaken in a second pass (`trackA.sh retake`, 17:57-18:31), interleaving the two arms per
  repetition. Overloaded rows stay in the data files and are listed apart; every median below uses clean rows only
  (first-pass clean rows plus retake clean rows), with the load range of those rows.
- **Comparison apps on this Mac** (`trackA.sh others`, 18:33-19:16, `ADE_WINDOW_ONLY=1`, 5 repetitions; a first start with the DOM echo on was
  stopped after one T3 Code row, which waited its full 60 s for a composer that never appears, and that row was dropped): T3 Code
  Nightly 0.1.6, Paseo 0.9.2, Zeron 0.2.79, MonoCode 0.7.0, super.engineering nightly `1856ebe8` (downloaded into
  `/tmp/v3-apps/se`, not installed) and Claude.app 3.1623.3, each a copy in `/tmp/v3-apps` with an isolated HOME and
  profile. None of them was seeded: T3 Code opens on its welcome screen, Paseo with no project, Claude.app signed out,
  so no composer can take the probe keys and only **first window** (launch to the app's first on-screen window,
  `winwait`, same for every app) and A5/A6 (the app at rest after launch, no threads) were taken for them. Volt's
  first-window time is in the same rows as its Ready time, so the window column compares like with like.
- **Not the ADEMark statistic.** ADEMark reports medians of 6-10 runs on an idle machine; ours are medians of the
  clean rows, n as stated, with the range.

## Fixes on this branch

| Commit | What | Measured |
|---|---|---|
| `8e69441aa56` | fix(agent): send the ACP lead as its own prompt block. Before it, the replay server (which matches a whole text block) could not identify any Volt prompt, so A4, A7, A8, A10 and A11 could not run on Volt at all. The speed branch carries an equivalent commit, `19ffd10b7b8`; merge one of them, not both. | Enables the replay tests; no timing claim. |
| `f1021689ea2` | fix(sandbox): a loopback `ANTHROPIC_BASE_URL` (a local gateway, or the replay server) is granted like Volt's MCP port. Before it the sandbox refused it and the turn sat on "Thinking" while the CLI retried. | Enables the replay tests. |
| `0a444267dae` | fix(agent): keep the chat title when Claude Code titles a session from Volt's lead (a side effect of `8e69441aa56`). | Correctness. |
| `75aa8a9bc00` | fix(agent): the agent list opens at launch without taking the composer's focus. The first keys typed after launch went to the list. | Correctness (the keys land in the composer); the A/B was taken under load and shows no speed effect either way (see "Not done"). |

## Not done, and why

- **The comparison apps got first window and rest weight only.** Seeding each one (a project, a signed-in or replay
  provider, 5 threads) is per-app setup that ADEMark's adapters do in the `ademark` account; it was not done here, so
  their Ready (A1/A2), A3, A4, A8 and A11 were not taken on this Mac, and their A5 has no threads. For those tests
  the comparison is with ADEMark's published (official) numbers only.
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
- **A5/A6 are one clean sample per arm** (0.0.6 rep 2, dev rep 2) and one per comparison app; ADEMark also takes one
  per app, after a settle on memory slope (ours is a fixed 90 s). Dev A2 has n 4: its retake rep 8 was terminated
  mid-run and wrote no row.
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
- Data: `data/ademark/`: `trackA-volt-{dev,rel}.jsonl` (first pass), `trackA-retake-volt-{dev,rel}.jsonl` (retake),
  `trackA-others-<app>.jsonl` (T3 Code, Paseo, Zeron, MonoCode, super.engineering, Claude.app), `ab-75aa8a9-*.jsonl`,
  `published-ademark.txt`, Track B scored JSON and marks. Raw Track B captures stay outside the repo because they hold
  the owner's account e-mail. Medians: `node scripts/ademark/summarize.mjs <dir with <app>/rows.jsonl>`; the Volt
  columns above are both passes' rows of an arm in one `rows.jsonl`.
- ADEMark adapter and profile for Volt: `ademark-volt/` (`volt.ts`, `volt.json`, the patch).
