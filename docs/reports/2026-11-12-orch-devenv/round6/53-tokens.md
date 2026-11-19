# Round 6: prompt size (tokens)

Status: **final** (2026-11-15). Branch `e6/tokens`, worktree
`volt-e5-tokens`, from `7f07f73d677`. ADEMark Track B method, unofficial (this Mac, a clean Claude config dir instead
of ADEMark's `ademark` macOS user).

## Summary

- "hi" (B1) in a Volt Claude chat on Opus 5.5 at medium effort: **12.2K to 11.4K tokens** (n=3 each, every run
  within 0.1K). The bare Claude CLI at the version Volt runs (Claude Code 2.1.322, the SDK binary inside the global
  `claude-agent-acp` 0.106.0), same model and effort: **18.1K**. Ratio to the bare CLI 0.67 to **0.63**; Paseo's 0.58
  (10.5K here) is **not reached**.
- The real prompt (B3): **47.4K to 44.3K** (n=3 each; 43.9K without the composer predictor's side call, which fired in
  1 of 3 runs on each build); bare CLI 60.4K. Ratio 0.78 to **0.73**; Paseo's 0.43 is **not reached**. B3 cost
  $0.0689 to **$0.0667** (medians; the runs that read the cache $0.060-0.067, below the round-5 target of $0.069).
- How: Claude Code 2.1.322's hooks modules can rewrite named sections of its system prompt (`prompt.section`), each
  per-request attachment (`prompt.attachment`) and the attribution lines, not only defer tools. A probe module against
  the real binary gave the names and types (see Method). Volt's module now rewrites eight of Claude Code's texts and
  compacts its own; the chat title prompt and the visuals note were shortened too.
- Found on the way: a `tool.describe` handler for a *loaded* built-in tool makes Claude Code build every tool
  description at session start, before Volt has set Full access, and Claude Code then keeps its longer Bash description
  (+116 tokens in every request). The ToolSearch rewrite that caused it was dropped.
- Still Claude Code's and the user's call (not changed): the three task tools orch keeps loaded (1.6K tokens per
  request), Claude Code's memory section (about 560 tokens), the Skill tool (909) and the skills list at 400 characters.

## Before / after (Opus 5.5 at medium effort, medians, n and range)

Before = `7f07f73d677` (`volt-e5-base`, run as is). After = `e6/tokens` at `e01ab9f39cd`. Bare = Claude Code 2.1.322
(`claude -p --effort medium`, the binary inside `/opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp`,
which Volt's adapter runs). Matrix `r6a` (before, after at `83425c156cf`+`2ef97bcf19b`, bare, interleaved) and `r6b`
(after at the branch tip, alone; the counts do not depend on the other arms). Load 40-70 during the runs: token counts
do not depend on it and no timing is reported here. ADEMark's published runs use Opus 5.5 at high effort; round 5
measured the bare CLI at high (18.1K / 61.1K), the same within 0.3K.

| Test | Before | After (r6b) | Bare CLI 2.1.322 medium, this Mac | Paseo (site) | Bare CLI (site) |
|---|---|---|---|---|---|
| B1 "hi": total | 12.2K (12.2-12.3K, n=3) | **11.4K** (11.4-11.4K, n=3) | 18.1K (18.1-18.1K, n=3) | 22.2K | 38.2K |
| B1: $ (cache read) | 0.0038 (0.0038-0.0399) | **0.0036** (0.0035-0.0340) | 0.0049 (0.0048-0.1454) | 0.0058 | 0.0963 |
| B3 real prompt: total | 47.4K (47.0-49.7K, n=3) | **44.3K** (43.9-47.1K, n=3) | 60.4K (59.9-60.7K, n=3) | 73.2K | 168.3K |
| B3: main thread | 45.7K | **43.0K** | 60.4K | | |
| B3: $ | 0.0689 (0.0623-0.1169) | **0.0667** (0.0603-0.1114) | 0.0710 (0.0710-0.1177) | 0.150 | 0.210 |
| B3: main requests | 3 | 3 | 3 | | |
| B3: side calls | 1.3K title (2.8K predictor in 1 run) | 1.2K title (2.9K predictor in 1 run) | 0 | | |
| B4 AGENTS.md canary obeyed | 6 of 6 | 6 of 6 | 6 of 6 | yes | yes |

The maxima with `$` are the first run of a prefix, which writes it to the cache. r6a's after arm (the module with the
ToolSearch rewrite) measured 11.5K / 44.0K; r6a's B3 windows also caught the rig's own `claude -p` checks
(`modcheck.mjs`, run during the matrix), which `analyze.mjs` now leaves out by user agent (`TOK_EXCLUDE_RE`).

**Against the targets** (ADEMark's rule off its reference Mac: the gap to the bare CLI on the same Mac):

| | Volt after / bare, this Mac | Paseo / bare, ADEMark site | Needed here for Paseo's ratio |
|---|---|---|---|
| B1 | 11.4K / 18.1K = **0.63** (before 0.67) | 22.2K / 38.2K = 0.58 | 10.5K |
| B3 | 44.3K / 60.4K = **0.73** (before 0.78) | 73.2K / 168.3K = 0.43 | 26.0K |

### Where "hi" went (anatomy, `anatomy.mjs`, counted one by one, r6a bodies)

| Part | Before | After (r6a) | Note |
|---|---|---|---|
| system prompt block | 2,780 | **2,655** | `# Environment`: Claude Code CLI/desktop and `/fast` lines gone (Volt's rules unchanged in r6a; -40 more at the tip) |
| Bash | 1,504 | 1,620 (r6a) / **1,504** (tip) | the ToolSearch handler cost the lean Bash text; see fix 8 |
| ToolSearch | 821 | 737 (r6a) / 821 (tip) | |
| Edit, Read, Skill, Write | 3,063 | 3,063 | Claude Code's |
| delegate_task, message_task, wait_tasks | 1,598 | 1,598 | orch's, always loaded |
| deferred-tools reminder (+ agent types) | 1,047 + 268 | **963** (r6a; -42 more at the tip) | grouped names, one line of agent types, one-line preamble |
| Volt MCP instructions | 36 + 635 | 36 + 635 | |
| skills list | 1,443 | **1,251** | keybindings-help and plugin-authoring gone |
| CLAUDE.md / AGENTS.md reminder | 301 | 301 | the canary's carrier |
| session context (e-mail, git status) | 290 | **235** | |
| attribution reminder | 210 | **136** | |
| environment, model, date | 295 + 14 | 295 + 14 | Claude Code's |

[anatomy-before-r6a-b1.txt](data/tokens/anatomy-before-r6a-b1.txt), [anatomy-after-r6a-b1.txt](data/tokens/anatomy-after-r6a-b1.txt),
[anatomy-bare-r6a-b1.txt](data/tokens/anatomy-bare-r6a-b1.txt).

## Method

- Rig: `round6/scripts/tokens/` (round 5's scripts on the round-6 profiles). Capture proxy `proxy.mjs` on 19973 in
  `ANTHROPIC_BASE_URL` of both test instances and the bare CLI; `cfg-clean` config dir (the login's access token only,
  `CLEAN=1`: no claude.ai connectors, skill or plugin sync). Arena: ADEMark's `arena/` (Ledger, AGENTS.md canary).
- Instances: after on CDP 9973 (`~/.volt-r6/tokens/ud`), before on CDP 9979 (`~/.volt-r6/tokens/ud-base`, from the
  read-only `volt-e5-base`). `matrix.sh <tag> claude-opus-5-5 medium 3` with `B3_N=3`, `TOK_ACCESS=full`, sandbox Off
  (it blocks the proxy's port). Both instances spawn `/opt/homebrew/bin/claude-agent-acp` (checked with `ps`), so no
  `claudeAcpPatch.ts` preload was in play.
- Hooks probe (`~/.volt-r6/tokens/exp/p1-p3`, not committed): one-event modules that append `[[SECTION name=...]]`,
  `[[ATTACHMENT type=...]]`, `[[ATTRIBUTION kind=...]]` markers to what they see, run with `claude -p hi --plugin-dir`.
  A module that writes files or registers without a matcher is dropped silently, so markers in the captured body are
  the only reliable trace. Found: `prompt.section` names `heron_brook` (reasoning effort), `pronouns`, `action_caution`,
  `user_privacy`, `session_guidance`, `memory`, `env_info_simple`, `env_info_model`, `context_management`,
  `act_dont_rederive` (the opening block with the security policy and `# Harness` is not a section); `prompt.attachment`
  types `deferred_tools_delta`, `agent_listing_delta`, `skill_listing`, `mcp_instructions_delta`, `environment`,
  `model`, `date`, `instructions` (CLAUDE.md), `session_context`, `remote_session_change` (the attribution reminder),
  `auto_mode`; `attribution.text` kinds `commit` and `pr`. A section handler may return `text: null` to drop it.
- `modcheck.mjs` against the real binary after every module change (`MODCHECK_ROOT` runs another tree's module;
  `CLAUDE_CODE_ENTRYPOINT=sdk-ts` as the SDK starts it; prints whether Bash carries its long description). Never run it
  while a matrix is open: its requests land in the windows.
- `counttext.mjs` (new): `count_tokens` of a text, for before/after counts of a rewrite.
- `analyze.mjs` with ADEMark's `prices/2026-10.json`. Data: [`analysis-r6a.md`](data/tokens/analysis-r6a.md),
  [`analysis-r6b.md`](data/tokens/analysis-r6b.md), matrix logs, [`windows.jsonl`](data/tokens/windows.jsonl),
  `capture.jsonl.gz` (metadata and usage of every request; bodies not committed, they carry the account's e-mail).

## Fixes

| Commit | What | Tokens per request ("hi", Opus 5.5) |
|---|---|---|
| `83425c156cf` | perf(acp): the hooks module rewrites more of Claude Code's texts (1-7 below) | -880 (r6a) |
| `aa0300b96db` | perf(acp): deferred-tools preamble one line, main rules shorter, no tool.describe on loaded tools (8-10) | -42, -5, -32 |
| `2ef97bcf19b` | perf(agent): chat title prompt's rules 584 to 452 tokens | -132 per new chat (side call) |
| `e01ab9f39cd` | perf(agent): visuals note 291 to 236 tokens | -55 per session's first code turn |

### 1. Volt's tool names grouped (`compactVoltToolNames`)

Three or more names with one first word are written once: `browser_{act,audit,click,...}`, `device_{...}`,
`thread_{...}`; the line says `a_{b,c} stands for a_b, a_c`. 835 to 665 tokens for the 135 names (`counttext.mjs`).
Every tool stays listed; `select:mcp__volt__<name>` loads it as before (capability check below).

### 2. Agent types in one line

`Agent tool types (each described in full in the Agent tool once loaded): claude, Explore, general-purpose, Plan,
statusline-setup, web-fetch.` The Agent tool's description carries the full reminder when loaded (as in round 5). 268
tokens to about 40.

### 3. Attribution reminder (`voltAttributionNote`, attachment `remote_session_change`)

The two lines (`Co-Authored-By: ...`, `🤖 Generated with ...`) and the rule that the user's own instructions win, without
the preamble on which earlier guidance it replaces: 210 to 136 tokens. Any other text of that type is left alone.

### 4. `# Environment` section (`voltEnvInfo`, section `env_info_simple`)

The Claude model IDs line stays; "Claude Code is available as a CLI, desktop app, web app and IDE extensions" and
"Fast mode ... /fast" go (they describe another product; Volt has no `/fast`).

### 5. Skills listing (`voltSkillListing`, attachment `skill_listing`)

`keybindings-help` (the terminal's `keybindings.json`) and `plugin-authoring` (mods for the terminal's panes and status
line) have nothing to act on inside Volt and leave the list: 1,443 to 1,251 tokens. Every other bundled skill stays
at the user's 400-character cut.

### 6. Session context (`voltSessionContext`, attachment `session_context`)

The e-mail's four-sentence privacy paragraph becomes one line with the same rule; the closing note ("Claude Code
attached this context automatically...") is kept short. The git status is untouched. 290 to 235 tokens.

### 7. (dropped) ToolSearch description

See 8: it cost more than it saved.

### 8. No `tool.describe` for a loaded tool (`aa0300b96db`)

In r6a every after request's Bash description carried `IMPORTANT: Avoid using this tool to run cat, head, tail, sed,
awk, or echo commands...` (+116 tokens) while before's did not. Under `claude -p` both modules show the line, so it is
not the module's text: Claude Code picks its shorter Bash description when bypass permissions are on at the moment the
tool descriptions are first built (`bashFirstDescriptionTrimmed`, cached per process), and a `tool.describe` handler
for a loaded built-in made it build them at session start, before Volt had set Full access. Without the handler, "hi"
measured 11,390 tokens (r6x, n=1) against 11,460 with it.

### 9. Deferred-tools preamble (`aa0300b96db`)

Claude Code's three sentences ("The following deferred tools are now available via ToolSearch. Their schemas are NOT
loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query ...") become
`Deferred tools (schemas not loaded: run ToolSearch "select:<name>[,<name>...]" before calling one):` 84 to 42
tokens; only that exact wording is replaced.

### 10. Main rules (`aa0300b96db`)

The Subagents and Tasks bullets, the ask rule and the lazy rule say the same in fewer words: 514 to 509 tokens for the
block (`counttext.mjs`), fewer characters than tokens saved. Kept because the wording is no worse; not a gain worth
repeating.

### 11. Title prompt (`2ef97bcf19b`)

Volt's title call (`claude -p` on Haiku, a side call ADEMark counts with every new chat) carried 584 tokens of rules
and seven examples; four bullets and five examples now (452). The title tests pass unchanged; `volt-title` in the
capture fell from 1,337 to 1,200 tokens.

### 12. Visuals note (`e01ab9f39cd`)

291 to 236 tokens on a session's first code turn: the fence fallback goes (the note is only sent when the visual
tools are reachable, and the volt MCP instructions say it for Claude Code chats).

## Capability checks

`capcheck.mjs` on the after build (Haiku 5.5, `capfx` fixture, one run per family, `CAP_PREFIX=cap6`,
[capcheck-cap6.md](data/tokens/capcheck-cap6.md)): the point was the grouped names (`browser_{act,...}`) and the one-line
agent types, so the families whose tools are grouped or deferred were run. Every one loaded its tool by full name
through ToolSearch and used it:

| Family | Used | Tools (from the chat's trace) |
|---|---|---|
| code | yes | find_symbol, code_nav |
| chart | yes | render_chart (after a Terminal count) |
| browser | yes | browser_navigate, browser_act |
| threads | yes | thread_list |
| ask (multiple choice) | yes | ask_question: the question tray showed (the runner skips it, 6 times, so the run did not end) |

Round 5's before/after of all 11 families (8 of 11 before, 10 of 11 after) stands for the parts unchanged here. The
AGENTS.md canary (B4) was obeyed in every r6a and r6b run (12 of 12 Volt runs). Not re-run: `lazycheck.mjs` (Agent,
ReportFindings through ToolSearch); the Agent tool's description still carries the full agent listing, checked in the
module's unit test.

## Not done, and why

- **10.5K and 26.0K.** What is left of "hi" at the tip: Claude Code's system prompt 2.6K, its six tools 5.4K, the
  skills list 1.25K, its reminders 1.0K; orch's three task tools 1.6K; Volt's rules 0.5K, MCP instructions 0.67K,
  tool names 0.67K. The levers that would reach 0.58 are decisions for others: deferring `delegate_task`,
  `wait_tasks` and `message_task` behind ToolSearch (-1.6K per request, 0.54 on "hi"; orch keeps them loaded because
  Haiku leads searched for them, round 4), turning Claude Code's auto memory off for main chats (-560 and the
  MEMORY.md index; the user's chats rely on it), the Skill tool's own description (909; the user chose to keep the
  tool) and the "Downloaded files are untrusted" paragraph in the environment (110, security guidance).
- The opening block of Claude Code's prompt (security policy, `# Harness` with its `<pasted_content>` bullet that Volt
  never produces, about 150 tokens) is not a `prompt.section`, so it cannot be rewritten from a hooks module.
- B3's shape is three model requests (two reads batched, a `node -e` date probe, the answer) in every run of every arm;
  the prefix cut counts three times, nothing else changed.
- Effort: ADEMark publishes Opus 5.5 at high; the user chose medium for live turns, and the bare CLI was measured at
  medium too (round 5's high: 18.1K / 61.1K, the same within 0.3K).
- Not run on ADEMark's Mac or as its `ademark` user; Paseo not run here.

## Commits

| Commit | What |
|---|---|
| `83425c156cf` | perf(acp): Claude main chat's hooks module says more of Claude Code's per-request text in fewer words |
| `9bbebbf0d7d` | docs(reports): round 6 token rig (round 5's scripts on the round-6 profiles, counttext.mjs) |
| `2ef97bcf19b` | perf(agent): the chat title prompt's rules in fewer words (584 to 452 tokens per new chat) |
| `aa0300b96db` | perf(acp): deferred-tools preamble in one line, main rules in fewer words, no tool.describe on loaded tools |
| `e01ab9f39cd` | perf(agent): the visuals note in fewer words (291 to 236 tokens on a session's first code turn) |
| `4b6eedaca78` | docs(reports): round 6 token data (r6a matrix, anatomy) and rig fixes (modcheck root/entrypoint, analyze exclusions) |
| (this report) | docs(reports): round 6 tokens report, r6b data, capability check |

Typecheck (`compile-check-ts-native`) clean at `e01ab9f39cd`. Tests touched, passing: `claudeWorkRules.test.ts` (18),
`contextPack.test.ts` (25), `titleGeneration.test.ts` (12). `modcheck.mjs` against the real binary after every module
change: the module loads (lazy tools absent from `tools[]`), every rewrite found in the request body.
