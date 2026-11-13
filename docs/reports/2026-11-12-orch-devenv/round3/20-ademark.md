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

__METHOD__

## Fixes on this branch

| Commit | What | Measured |
|---|---|---|
| `8e69441aa56` | fix(agent): send the ACP lead as its own prompt block. Before it, the replay server (which matches a whole text block) could not identify any Volt prompt, so A4, A7, A8, A10 and A11 could not run on Volt at all. The speed branch carries an equivalent commit, `19ffd10b7b8`; merge one of them, not both. | Enables the replay tests; no timing claim. |
| `f1021689ea2` | fix(sandbox): a loopback `ANTHROPIC_BASE_URL` (a local gateway, or the replay server) is granted like Volt's MCP port. Before it the sandbox refused it and the turn sat on "Thinking" while the CLI retried. | Enables the replay tests. |
| `0a444267dae` | fix(agent): keep the chat title when Claude Code titles a session from Volt's lead (a side effect of `8e69441aa56`). | Correctness. |
| `75aa8a9bc00` | fix(agent): the agent list opens at launch without taking the composer's focus. The first keys typed after launch went to the list. | __AB__ |

## Not done, and why

__NOTDONE__

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
