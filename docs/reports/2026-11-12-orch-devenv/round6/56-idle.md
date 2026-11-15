Status: in progress

# Round 6, area "idle": idle CPU and the at-rest footprint

Branch `e6/idle` (worktree `volt-e5-idle`), from `7f07f73d677`. Before = `volt-e5-base` (dev) and the shared minified
before build (`~/.volt-r6/min/base`), after = this branch (dev) and its minified build (`~/.volt-r6/min/idle`). One
instance at a time on CDP 9977, profiles `~/.volt-r6/idle/ud/<arm>`. ADEMark method, unofficial.

## Summary

(to be written from the measured rows)

## Before / after

Rows so far: dev builds, session 1 (2026-11-14 22:00-22:12 UTC, order before, after, timing lock held, seeded profiles,
load at each sample's start). Data: [data/idle/a6.jsonl](data/idle/a6.jsonl), raw 4 Hz samples in
[data/idle/raw/](data/idle/raw/). `node summarize.mjs` prints the medians.

| Test (dev builds) | Before | After | Load at start |
|---|---|---|---|
| A6 idle, in front: app CPU | 0.52 % (n 1) | 1.03 % (n 1) | 9.0 / 12.9 |
| A6 idle, in front: app wakeups/s | 15.2 | 14.4 | 9.0 / 12.9 |
| A6 idle, covered (cover held): app CPU | 0.36 % (n 1) | 0.90 % (n 1) | 6.3 / 12.6 |
| A6 covered: wakeups/s | 12.7 | 11.4 | 6.3 / 12.6 |
| main CPU / wakeups (front) | 0.19 % / 5.6 per s | 0.37 % / 4.8 per s | |
| agent server (front) | 0.09 % / 3.5 per s | 0.19 % / 3.5 per s | |
| extension host (front) | 0.08 % / 0.8 per s | 0.16 % / 0.9 per s | |
| shared process (front) | 0.06 % / 1.6 per s | 0.11 % / 1.3 per s | |
| A5 app RAM, median over the front sample | 1,440 MB | 1,385 MB | 9.0 / 12.9 |
| processes in the app group | 10 | 10 | |

The after row is not a regression reading: weight's minified build was compiling on the same Mac during both after
samples (load 12.6-12.9 against 6-9 for before), and every process, Volt's and Chromium's alike, shows about twice the
CPU per wakeup at equal or fewer wakeups (main 4.8 vs 5.6 per s, the shared process 1.3 vs 1.6 per s), which is cache
and scheduler contention, not code. Wakeups, the number the code controls, are lower in both variants. Session 2 (ABBA,
2 more reps per arm) and the minified arms are queued on the timing lock; the medians replace this table when they land.

## What wakes Volt at rest (dev build, exploration, load 22-89, not timings)

Censuses over the inspector of each process ([scripts/idle/timers.mjs](scripts/idle/timers.mjs),
[spawns.mjs](scripts/idle/spawns.mjs)), 60-90 s each, window visible, after the launch burst:

| Process | JS timer fires at rest | What |
|---|---|---|
| main | 0.05/s | voltAwake's 30 s tick (only within the grace period after agent work), a 60 s managed-policy refresh |
| shared process | 0.03/s | idle-callback shim, one parcel watcher event |
| extension host | 0 | nothing |
| agent server | 1.18/s | **0.5/s dev-only hot-reload poll** (`restartWhenStale`, gated on `VSCODE_DEV && !product.commit`, not in a release build), 2 x 20 s WebSocket pings, a 30 s native timer, the 60 s lonely check |

The window itself is quiet too: with the composer focused and the focus burst over, a 20 s Chromium trace
([trace-front-rest.txt](data/idle/explore/trace-front-rest.txt)) shows the renderer's main thread at 0.7 tasks/s,
no display-link callbacks and no frames drawn (the caret rests after 10 s, round 4), the browser process at 5 tasks/s.

So the JS side is near silent; what the sampler sees (round 5: main 0.31 %, two node utilities 0.22 %, agent server
0.09 %) is Chromium's and Node's own floor per process (mojo notifications ~3/s in main, the macOS memory-pressure
evaluator every 5 s, PartitionAlloc's memory reclaimer, V8 GC timers), plus the processes Volt keeps alive at rest.

What is not silent is **a window focus**. One focus event (Cmd-Tab back to Volt, or the rig's focus emulation) runs
the warm-on-intent path (round 5, firstword) and with it, measured in one census:

- main: **18 git processes** in 3 s (the workspace snapshot: status, branches, upstream, remotes, PR state);
- agent server: an ACP adapter and Claude CLI (the warm agent, 30 s TTL), a **plugin host** (Memory's context for
  the warm prompt; lives 90 s after its last message), a **code-index process fork** (50-60 MB, the index loaded,
  for one "is this project large and indexed" question; exits after 30 s), and **two `log show` reads** of the kernel
  log for the plugin host (3 s and 20 s after its launch; one `log show` is 0.3-0.6 s of CPU, and at load 29 the two
  of them sat at 30 % of a core for the whole 40 s sample).

And **10 minutes after every launch**, the worktree-limit pass measured every checkout under `~/.volt/worktrees`
with one `du -sk`: 68 checkouts here, a `du` at 28 % of a core for over a minute, every launch, because the sizes
lived only in memory.

## Fixes

1. **`f6806cb7a98` perf(storage): the worktree size pass keeps its checkout sizes across launches and runs du at low
   priority.** Sizes are saved in the user data folder (`volt-checkout-sizes.json`, atomic write) and read before the
   first pass, so a launch measures only checkouts whose chats ran since; `du` runs under `nice -n 10`. Unit test.
2. **`c6e726227e5` perf(code-index): a warm-up alone holds the index process 90 s, a search 20 min.** Opening a
   workspace warms the index; the hold was 20 minutes for any use, so a window left alone kept a 50-60 MB process
   and its watchers through A5/A6. A shorter hold never cuts a longer one; the index is on disk and catches up from
   sizes and mtimes when forked again.
3. **`ee4949db043` perf(sandbox): a host's refusals are read once in its first seconds, not twice.** The 20 s read
   is gone; a host that works is still read 2 s after its activity (at most every 30 s) and at its exit.
4. **`735834661f3` perf(code-index): a status question while no index process runs is answered from the last
   answer** (under 10 minutes old); a live process always answers itself. No more 50 MB fork per agent start.
5. **`32d5cf55e2a` perf(code-index): the status cache survives a relaunch** (`status-cache.json` in the index's data
   folder), so the first warm after a launch does not fork either.
6. **`5863d7c1839` perf(awake): the window re-sends its unchanged agent lease once a minute, not every 30 s.** The
   only renderer-to-main IPC at rest ([ipc-main-rest.txt](data/idle/explore/ipc-main-rest.txt): 3 `voltAwake.setLease`
   in 90 s, each waking main's awake evaluation); main keeps a lease 2 minutes, so 60 s keeps twice the headroom.

Live check on the dev build after a relaunch (spawn census of the agent server across one focus toggle,
[explore logs](data/idle/explore/)): before, a focus started a code-index fork and two `log show`; after, no fork and
one `log show`. Main's code index, held 20 minutes before, was gone 3 minutes after launch.

## Method

- **A5 + A6** ([scripts/idle/a5a6-batch.mjs](scripts/idle/a5a6-batch.mjs), [a6.mjs](scripts/idle/a6.mjs)): per rep a
  fresh launch of the arm with its profile seeded once (5 chats answered `replay:seed` by ADEMark's replay server on
  18977), composer focused, then ADEMark's sampler (`ademark-native sample`, 4 Hz) over main plus every process of the
  arm's profile: 60 s front after a 90 s settle, then 60 s under ADEMark's cover panel. CPU % = delta(user + sys) /
  wall of the `app` group; wakeups/s = idle-exit + interrupt wakeups; A5 = the `app` group's median RAM over the front
  sample. Arms interleaved (ABBA), timing lock held, 1-minute load <= 14 at each sample's start and recorded in the row.
  Built arms run their own binary with `--use-mock-keychain`.
- **Censuses** (analysis aids, any load): [timers.mjs](scripts/idle/timers.mjs) logs every Node timer that fires in a
  process over its inspector; [spawns.mjs](scripts/idle/spawns.mjs) every child process it starts, with the caller;
  [idle-trace.mjs](scripts/idle/idle-trace.mjs) Chromium's trace of the window's processes; `--inspect` flags on main,
  the shared process and the extension host, `SIGUSR1` on the agent server.

## Not done, and why

- **The focus burst in main (18 git processes) and the warm agent, plugin host and adapter it starts** belong to the
  warm-on-intent path (firstword's area). This report measures them; it does not change when a focus warms. What idle
  owns in that burst (the second kernel-log read, the code-index fork) is fixed above.
- **The Chromium and Node floor per process** (mojo notifications, the memory-pressure evaluator, PartitionAlloc's
  reclaimer, V8's GC timers) is not Volt's code; the only lever is fewer processes at rest. The shared process, the
  extension host (the branch chip needs the git extension, round 5) and the network service stay.
- **The plugin host a focus warm starts lives 90 s after its last message** (round 5's idle stop), the warm agent 30 s:
  a focus right before ADEMark's 90 s settle leaves the host alive into the sample's first seconds. Stopping it with
  the warm agent it served is process lifetime (weight's area); noted, not changed.
- **The agent server's 20 s WebSocket pings** (both directions) stay: longer pings would delay dead-peer detection for
  web and phone clients by minutes for about 0.1 wakeups/s.
