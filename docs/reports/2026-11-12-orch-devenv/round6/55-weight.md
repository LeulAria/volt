# Round 6: weight (A5/A7/A9/A10 on release builds)

Status: **in progress** (2026-11-15).

Branch `e6/weight`, worktree `volt-e5-weight`, from `7f07f73d677`. Scripts `round6/scripts/weight/` (round 5's rig
with `~/.volt-r6` paths), data `round6/data/weight/`.

**ADEMark method, unofficial.** ADEMark's sampler (`ademark-native`, `phys_footprint`, its app/agents grouping),
its replay server and its seed and A7 prompts, run by our own CDP scripts on a shared Apple M4 Max laptop with six
other agents' work on it. MB = MiB.

## Summary

(to come)

## Results

(to come)

## What lives after a chat finishes (dev build, process list)

Seeding 5 threads by paste (as ADEMark's `timed.send` pastes), then looking at the tree:

- the chat in use keeps its agent (ACP adapter + Claude CLI) for 15 minutes (`IDLE_AGENT_TTL_MS`);
- every other chat's agent stops 30 s after its turn (`IDLE_AGENT_GRACE_MS`; it resumes on the next send);
- a **spare for the next new chat**, refilled when a run ends, lived 10 minutes (`SPARE_AGENT_TTL_MS`);
- the **Tab predictor** (a text-only ACP session: adapter + CLI, `--tools=`, low effort) boots on the composer's
  first inline-completion request, which a paste triggers too, and stops after 10 idle minutes.

So round 5's "3 adapters at rest-20" were the chat in use, the refilled spare and the predictor.

## Fixes

| Commit | What | Evidence |
|---|---|---|
| `cdc82211e86` | The spare refilled after a run lives 20 s, not 10 min. A new chat warms its own agent when it opens (300 ms after the open, at once on a click), about a second before anyone can send. | (release numbers to come) |

## Not done, and why

- **One ACP adapter for several chats.** The adapter is spawned per chat with the chat's sandbox wrap
  (`acpProvider.ts` `stdio.spawn({ ..., sandbox })`) and its `CLAUDE_CONFIG_DIR` overlay; sharing one process would
  put several chats in one sandbox and one account overlay. Not built (as round 5).
