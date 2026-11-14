# Round 4: cold start and relaunch (ADEMark A1, A2)

Status: final (2026-11-14). Branch `e4/coldstart`, worktree `volt-e4-coldstart`. ADEMark method, unofficial.

## Summary

The user's priority was the chat on screen at once when Volt starts. Measured on two minified builds of Volt
(`gulp vscode-darwin-arm64-min`), "before" at `b2db4e7f605` and "after" at `b5af11c5e0d` (this branch), run from
their build output with their own profiles, interleaved before/after, on the same Mac and the same day:

- **The restored chat is on screen about 0.7 s sooner.** At relaunch the first frame of the window now shows the
  chat the window left (a stored picture of its screen), 53 ms after the window's first frame (n 5, 51-58), where
  before it came with the workbench, 696 ms after (n 6, 646-920). Launch to chat visible: 1,411 ms before, 720 ms
  after (5-thread profile); 1,489 ms before, 771 ms after on a profile whose last chat is ADEMark's long thread.
- **ADEMark Ready (launch to typed text showing in the composer) fell from 1.6-6.3 s to 0.9-1.1 s** (medians of the
  two attempts below). The keys land in a text area the picture places over the composer; they move into the real
  composer when the workbench takes over (0.5-0.7 s later), with their selection, and an Enter pressed meanwhile
  sends. A1 cold: 1,066 / 1,050 ms after against 4,185 / 6,057 ms before. A2 relaunch: 876 / 1,031 ms after against
  6,258 / 1,599 ms before.
- **The real composer is not faster.** At relaunch it takes keys at about the same time as before (1,449 vs 1,411 ms,
  5 threads) and somewhat later on the long chat (1,694 vs 1,489 ms; n 5 each, ranges overlap). The after build never
  showed the before build's slow mode (below), where the composer took no keys for 4-5 s; which change removes it was
  not isolated.
- **First window and main-process start: no change** (first window about 0.52-0.58 s in both builds).
- One more fix this session (`d52d10e640c`, the picture keeps only the icon variables it shows) halves the stored
  picture's CSS (146 to 54 KB) but shows **no measurable time change** (n 8 per arm).

Against ADEMark's published board (pixel timing, reference Mac): A1 leader super.engineering 1.76 s, A2 leaders Diri
0.67, Zeron 0.78, super.engineering 0.85 s. Our after A1 (about 1.05 s) would be first; our after A2 (0.88-1.03 s)
would be fourth. These are DOM-echo times over CDP, a lower bound against ADEMark's pixel reading (at least one frame),
with no `purge` before A1 (warm files).

## Before/after

Medians with n and range, ms after the launch command. Only rows whose 1-minute load was 14 or less both when the rep
started and when it ended count (others are in the data files, marked by their `uptime`). Attempt 1 ran 09:06-09:28,
attempt 2 09:48-10:09; both are reported (see "Two attempts" for why there are two).

| Test | Measure | Before (`b2db4e7f605`) | After (`b5af11c5e0d`) |
|---|---|---|---|
| A1 cold, attempt 1 | first window | 542 (n 5, 522-2,036) | 580 (n 5, 517-1,008) |
| | Ready | 4,185 (n 5, 1,818-7,403) | **1,066** (n 5, 1,029-3,116) |
| | real composer takes keys | 4,185 (same) | 1,728 (n 5, 1,607-4,401) |
| A1 cold, attempt 2 | first window | 534 (n 8, 502-896) | 536 (n 9, 528-994) |
| | Ready | 6,057 (n 8, 1,958-7,376) | **1,050** (n 9, 905-1,872) |
| | real composer takes keys | 6,057 (same) | 1,585 (n 9, 1,405-3,690) |
| A2 relaunch, attempt 1 | first window | 603 (n 8, 514-775) | 536 (n 6, 523-658) |
| | Ready | 6,258 (n 8, 1,855-8,348) | **876** (n 6, 837-1,089) |
| | real composer takes keys | 6,258 (same) | 1,549 (n 6, 1,424-3,035) |
| A2 relaunch, attempt 2 | first window | 522 (n 7, 506-535) | 540 (n 8, 497-726) |
| | Ready | 1,599 (n 7, 1,409-1,899) | **1,031** (n 8, 835-1,669) |
| | real composer takes keys | 1,599 (same) | 1,670 (n 8, 1,433-2,636) |
| Relaunch, 5 threads (first paint) | window's first frame | 701 (n 6, 659-777) | 668 (n 5, 650-711) |
| | chat visible | 1,411 (n 6, 1,313-1,697) | **720** (n 5, 703-764) |
| | first frame to chat visible | 696 (n 6, 646-920) | **53** (n 5, 51-58) |
| | real composer takes keys | 1,411 (n 6, 1,313-1,697) | 1,449 (n 5, 1,395-1,476) |
| Relaunch, long chat (first paint) | window's first frame | 696 (n 5, 665-809) | 710 (n 5, 687-875) |
| | chat visible | 1,489 (n 5, 1,399-1,706) | **771** (n 5, 743-939) |
| | first frame to chat visible | 780 (n 5, 691-982) | **60** (n 5, 56-64) |
| | real composer takes keys | 1,489 (n 5, 1,399-1,706) | 1,694 (n 5, 1,544-2,320) |

Loads of the counted rows: A1/A2 attempt 1 10.3-13.9, attempt 2 8.7-13.7; first paint 10.4-13.6 (5 threads) and
11.1-12.7 (long). In the after build Ready came from the picture's text area in every counted row (A1 14 of 14, A2 14
of 14); before has no picture, so its Ready is the real composer.

Where the time goes (medians of the app's own marks, attempt 2, ms after launch):

| Mark | Before A1 | After A1 | Before A2 | After A2 |
|---|---|---|---|---|
| main process starts (`didStartMain`) | 308 | 315 | 311 | 305 |
| window opened (`willOpenNewWindow`) | 533 | 537 | 523 | 538 |
| renderer starts | 859 | 857 | 748 | 899 |
| picture of the last screen painted | - | 888 | - | 936 |
| workbench code loaded | 1,051 | 1,056 | 894 | 1,123 |
| workbench started (restore done) | 2,188 | 1,623 | 1,376 | 1,693 |
| picture handed over to the real composer | - | 1,675 | - | 1,681 |

## Method

- Builds: `gulp vscode-darwin-arm64-min` with `VOLT_BUILD_IGNORE_TYPE_ERRORS=1` in two copies of the tree
  (`volt-e4-coldstart-base` at `b2db4e7f605`, `volt-e4-coldstart-after` at `b5af11c5e0d`, the last code commit of the
  branch when it was built; the after build reused the before build's extensions, which this branch does not touch).
  Copied to `~/.volt-r4/coldstart/apps/{before,after}`. A build from a linked worktree has no `commit` in its
  `product.json` (git cannot be read there), and without one the window gets no V8 code cache, unlike a shipped build;
  `setup.sh app` stamps the source commit into both copies.
- Profiles: `/tmp/v4-cold-ud-before` seeded with five Claude Code threads against ADEMark's replay server
  (`setup.sh seed`); `after` is a copy of it, so both arms restore the same chat. The long-chat profiles hold ADEMark's
  A11 thread (`replay:long-2000`; the seeding turn stopped at volt-drive's 30-minute limit after about 1,600 items).
  Isolated HOME per arm, CDP port 9944, launchd agent server as shipped.
- A1/A2: `scripts/coldstart/run.ts` (round 3's ADEMark runner): A1 quits the app and kills every attributed process
  and the agent server's launch agent (no `purge`: warm files); A2 quits only. Quiet gate (ADEMark's native helper),
  `winwait` for the first window, then a probe key every 50 ms over CDP; Ready is the first poll whose focused
  composer, real or the picture's text area, shows two consecutive probe letters; the runner keeps polling until the
  real composer shows them too ("real composer"). `pair.sh` alternates the arms rep by rep, quitting the other first.
  10 reps per arm and test per attempt.
- First paint: `fp2.mjs` connects to the browser's CDP endpoint as soon as it is up, auto-attaches to the window paused
  at start, installs a per-frame probe, then lets it run. Per animation frame it records the first frame, the first
  frame with a row of the restored chat in view (from the picture or the workbench) and the first frame a composer
  takes keys. `fppair.sh` alternates the arms (relaunch, agent server alive), 6 reps (5-thread) and 5 reps (long).
  The first pass counted only reply rows, which a long chat's last screen may not have; the probe now also counts
  prompts and turns (`fp-relaunch-replyonly.jsonl` is the first pass, same picture).
- Summaries: `scripts/coldstart/summarize.mjs launch|fp <files>`.

### Two attempts

Attempt 1's before arm took 5 s or more to Ready in 11 of 20 rows (A1 and A2; 6-9.4 s), where 11 diagnostic before
launches right after it (alone and paired, `diag-before`, `diag-pair`) were all 1.4-3.2 s. A second full attempt was
run; ADEMark's rule is that a re-run replaces the attempt whatever it shows, and here both are reported, side by side,
not chosen between. In attempt 2 the slow mode showed in 8 of 20 before rows (7 of 10 A1, 1 of 10 A2, the A2 one
under load).

A first try at attempt 2 was lost to a rig mistake: the first `pair.sh` was still running when a second copy was
started (09:41-09:47), and two runners shared the CDP port. Both are discarded and kept only as
`r4final2-aborted` / `r4final2-contaminated`; attempt 2 is the clean re-run after both were stopped.

### The before build's slow mode

A diagnostic launch that logs the focused element and the composer's text every 100 ms (`focuslog.mjs`,
`focuslog-a1.jsonl`, run 2) caught it: the real composer had focus and one typed letter at 1.9 s, then no key landed
until 6.3 s, when 30 queued letters arrived at once. So the window (or the CDP input path into it) stalls for 4-5 s
right after the composer appears. It happened in 19 of 40 before rows today (Ready 5 s or more) and in none of the 40
after rows (their slowest real composer: 4.9 s, under load).
In one caught case the agent server stopped 0.7 s after starting and came back 5 s later, exactly over the stall; in
the other slow rows the server log shows no restart. The cause was not found. The after build does not show it, but
which of this branch's changes removes it (the picture's own text area and focus hand-over, or the agent server
starting at launch) was not isolated.

## Fixes

All of these are in the after build except `d52d10e640c`. The builds measure them together; only `d52d10e640c` was
measured on its own.

1. `1f161af2202` perf(agent): paint the window's last screen in its first frame. Cause: a restored chat waited for the
   workbench code, the agent server's snapshot and the transcript before any of it showed. Change: the window keeps a
   sanitised picture of its own screen (elements, classes, inline styles, text, the runtime style rules they use, the
   composer's draft) when it loses focus and when it closes; the next start paints it from the window's startup
   script, with a real text area over the composer. The agent editor takes over in the frame that draws the restored
   chat: typed text and selection move into the composer, an Enter sends. Used only for the same window, size, scale
   and theme; the stored file is treated as data (no scripts, handlers, frames or links are built). A window that
   restores no chat, or a chat that never loads, takes over after restore or a 10 s deadline.
2. `b5af11c5e0d` fix(agent): paint the window snapshot in the built product too. Cause: `1f161af2202` painted the
   picture after the workbench code had loaded and only when the CSS came with that code, which is true only in dev
   builds; a built product never painted it. Change: in a built product the workbench CSS is the page's own
   stylesheet, so the picture is painted right after the splash, before the workbench code is imported (30 ms after
   the renderer starts, table above).
3. `ca095812ef0` perf(agent): a long chat's picture keeps its off-screen rows as one spacer (the long chat's picture is
   216 KB, the 5-thread one 212 KB).
4. `9bbb64f99dd` perf(agent-server): start the agent server at launch, beside the window loading, instead of when the
   window's client asks for it (after the workbench code and its services); off when `volt.agentServer.enabled` is
   false. `fccc6eb854b` polls a starting server every 20 ms instead of 150 ms. Not measured apart from the rest.
5. `d52d10e640c` perf(agent): the picture keeps only the icon variables it can show. Cause: the icon registry declares
   every icon's glyph and font as variables on `:root` (about 97 KB), and the picture copied all of them. Change: it
   keeps the variables of icons it shows (`codicon-<id>` classes) and of icons a stylesheet names through `var()`
   (the product stylesheet names 10; scanned once per window and cached). Unit test added; every icon in the picture
   is still drawn (`iconcheck.mjs` on a dev build: 39 icons, 0 missing). Measured by swapping the stored picture on
   the minified after build between its original and the trimmed form this commit writes (`trimsnap.py`,
   `fpsnap.sh`, order alternating, n 8 each, load 7.8-11.9): real composer 1,515 (1,387-1,933) vs 1,499
   (1,377-1,659) ms on 5 threads, 1,617 (1,493-2,253) vs 1,682 (1,568-2,263) ms on the long chat; chat visible 732 vs
   763 and 738 vs 727 ms. No measurable time change; the file goes from 212 to 121 KB.

Exploration that was not adopted (earlier in the round, load 37-68, not for medians): a Node compile cache for the
main process (main first line 344 vs 367 ms, n 6 each, inside noise).

## Not done, and open

- The after build's real composer is not faster, and on the long chat it came about 0.2 s later than before (n 5
  each, ranges overlap; in the separate A/B above the same build gave 1,617 ms). The workbench starts later by
  roughly that much on the long-chat profile only; the cause was not found (the picture's CSS is ruled out).
- The before build's 4-5 s stall is unexplained (see above). Its rows are kept in every median. In attempt 2, where
  before A2 had no slow row inside the load limit, the Ready gain at relaunch is 1.6 to 1.0 s, not attempt 1's 6.3 to
  0.9 s; the honest reading of A2 is the smaller one.
- Main-process start and first window are unchanged (about 0.3 s to `didStartMain`, of which about 0.2 s is loading
  the main bundle; the window opens about 0.53 s after launch). ADEMark's first-window leaders are at 0.27-0.29 s.
- The A1/A2 numbers measure the after build at `b5af11c5e0d`; `d52d10e640c` was measured by the file swap only, not
  in a rebuilt minified app (a minified build takes 1-2 hours here).
- Pixel-based Ready (ADEMark's own instrument) was not taken; ours is DOM echo over CDP.

## Data and scripts

- Rows: `data/coldstart/r4final/` (attempt 1), `data/coldstart/r4final2/` (attempt 2), `warm/` (warm-up, not
  counted: on the after bundle's first launch its main process started 4 s after the launch command, and it had no
  picture yet),
  `diag-before/`, `diag-pair/`, `focuslog-a1.jsonl`, `focuslog-a2.jsonl`, `fp-relaunch.jsonl`, `fp-long.jsonl`,
  `fp-relaunch-replyonly.jsonl`, `fp-snapcss.jsonl`, `fp-snapcss-long.jsonl`, `exp-trim.jsonl` (first, hand-trimmed
  try; load 7.8-16.3).
- Scripts: `scripts/coldstart/` (`run.ts`, `pair.sh`, `fp2.mjs`, `fppair.sh`, `fpsnap.sh`, `trimsnap.py`,
  `focuslog.mjs`, `iconcheck.mjs`, `summarize.mjs`, `setup.sh`, build scripts).
