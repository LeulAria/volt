# Volt search, context and token efficiency

How Volt finds code for its agents, what it gives them before their first step, and how it keeps
command output small. One search API sits in front of three engines (Volt's code index, FFF and
ripgrep), a retrieval step turns a user message into a budgeted block of relevant code, and RTK
compacts shell output. Every engine is optional except ripgrep, and each one either answers
exactly or declines with a reason.

## Architecture

```
user message ──► planRetrieval ──► VoltSearch ──► rankEvidence ──► snippets ──► packRetrieval ──► model
  (common)        (what it names)   (routing)      (score/file)     (±3 lines)   (token budget)
                                       │
          ┌────────────────────────────┼─────────────────────────────┐
     code index (trigram)          FFF (fff-mcp)                ripgrep (search service)
     text, regex, glob,            fuzzy file names,            anything the others
     symbols, fuzzy names          frecency, git status         decline
```

| Piece | File |
|---|---|
| Unified search API, routing and result cache | `src/vs/workbench/services/voltRuntime/browser/search/voltSearch.ts`, `common/search/searchCache.ts` |
| Search-to-context pipeline (pure) | `src/vs/workbench/services/voltRuntime/common/search/contextRetrieval.ts` |
| Search-to-context pipeline (searches, deadline, file reads) | `src/vs/workbench/services/voltRuntime/browser/search/contextRetriever.ts` |
| Code index: trigram search, early-exit scans, fuzzy file search | `src/vs/platform/voltCodeIndex/node/rootIndex.ts`, `common/fuzzyPath.ts` |
| FFF engine (MCP client, install, process lifecycle) | `src/vs/platform/voltCodeIndex/node/fffEngine.ts`, `common/fff.ts` |
| Routing between FFF and the index | `src/vs/platform/voltCodeIndex/node/codeIndexEngine.ts` (`findFiles`) |
| Agent tools (`grep`, `glob`, `find_files`, `find_symbol`) | `src/vs/workbench/services/voltRuntime/browser/tools/searchTools.ts` |
| MCP tools for Claude Code / Codex (`instant_grep`, `find_symbol`, `find_files`) | `src/vs/workbench/contrib/voltCodeIntelligence/browser/voltCodeIntelligence.contribution.ts` |
| RTK routing | `src/vs/workbench/services/voltRuntime/common/codeIntelligence.ts` (`wantsRtk`, `RTK_WRAPPER`), `browser/tools/shellTool.ts` |
| Token accounting | `src/vs/workbench/services/voltRuntime/common/harness/runMetrics.ts` |
| Settings page | `src/vs/workbench/contrib/voltSettings/browser/codeIntelligencePage.ts` (Search and Context, Token Efficiency) |

### Routing

| Query | First | Then | Why |
|---|---|---|---|
| Text / regex | Code index: trigram candidates (up to 4,000), all verified in-process against the files as they are now | ripgrep on the candidates, then ripgrep on the tree | `\w \d \s \b` (and negations), and `-w` on literals that start and end with a word character, are translated to the Unicode classes ripgrep means by them (tested line for line against ripgrep). Only patterns with no JavaScript form (`\p{...}`, POSIX classes, `\W` inside a class) go to ripgrep, so results never depend on the engine. |
| Pattern in most files (`return`, `\w+`) | Index reads files in order and stops at the match limit | ripgrep, when 512 files do not fill the limit | A page of matches is in the first few files; ripgrep would read the whole tree. |
| Files over 16 MB (not indexed) | Skipped unless their trigram bitset holds every trigram the query needs | read and matched | One 23 MB header in Linux used to be read by every search. |
| Glob | Index file list | ripgrep | |
| Fuzzy file name (`find_files`) | FFF, filtered to the files the index lists (same ignore files) | Index's fuzzy scorer, then the search service's fuzzy file search | FFF ranks by typos, frecency and git status. The index fallback forgives one typo per word. |
| Symbol declarations | Index (regex extraction, ctags-style) | One ripgrep pass for declaring keywords | |

FFF is not used for content search: in the measurements below its grep is fast when there are
hits but takes 154 ms (Volt repo) to 2.8 s (Linux) to report no match, where the trigram index
takes 0.8 ms and 10 ms. It is never run in parallel with another engine for the same query.

Results always say when they are partial (`limitHit` → "More results exist ...") and which
engine declined and why (`fallback`). An index error or a broken FFF install never hides results;
the next engine answers.

### Caching and invalidation

- `VoltSearch` caches answers keyed by the exact query (root, folder, pattern, flags, limit).
  Any file change the workbench hears of (its file watcher, every agent write, every ACP
  `fs/write_text_file`) moves an epoch and clears the cache; a search that was running when a file
  changed is not stored. Entries also expire after 30 s. Folders under `node_modules` (outside the
  watcher) are never cached.
- The index keeps itself fresh with a file watcher, delta segments and a stat sweep on load, and
  always verifies candidates against the files on disk, so a stale index can only cost speed.
- Posting lists are cached (24 MB budget) and a list wanted by several lookups at once is read
  once. Fixed: re-caching a list counted it twice, the cache drifted past its budget and from then
  on evicted every list as it arrived, so every search decoded every posting list again (the query
  planner's overlapping phrases triggered it on any literal longer than a few characters).
- Symbol tables stay loaded across edits (a changed file's old symbols are skipped and the file is
  read instead; a removed file's are dead); they used to be dropped on every file change, so the
  next `find_symbol` reloaded every segment. Exact and prefix lookups use a hashed typed-array
  index (`symbolNameIndex.ts`, 16 bytes per symbol) instead of a pass over every symbol.
- Files over the 16 MB indexing limit keep a 2 MB trigram bitset (rebuilt when their size or time
  changes, at most 16 files).
- Fixed while testing: on a project opened through a symlinked path (macOS `/var` →
  `/private/var`, or a symlinked projects folder) the watcher reported real paths and the index
  dropped every event, so new and edited files stopped being search candidates. The index now
  matches events against the root's real path too (`rootIndex.ts`, `realRoot`); a test covers
  edits, creates, renames and deletes.

### Reliability

- Every index call from `VoltSearch` is bounded (5 s); a hung or overloaded index process means
  ripgrep answers, with the reason, while the index call keeps warming up.
- An index that failed to build (too many open files, a full disk, a lost watcher) rebuilds itself
  on the next use after a minute; a query that finds the index's own files gone or unreadable
  starts a rebuild. Errors no retry can fix (over a million files) leave the folder to ripgrep.
- FFF's first call waits at most 3 s for its initial scan; the index answers meanwhile.

### Search-to-context pipeline

Before the agent's first step, Volt searches for what the message names and attaches the best
matches. It runs while the turn gets ready (settle wait, prompt hooks, API key), so it adds no
latency unless the searches outlast that.

1. **Classify** (`planRetrieval`): code-shaped identifiers (camelCase, PascalCase with more than one
   word, snake_case, SCREAMING_CASE, `code spans`, `name()` calls), file paths and names (`/` or
   Windows `\`, drive letters dropped), `path:line` locations, quoted text and error lines, and
   plain words (stemmed, English and request stop words removed) for BM25. A message with no code
   shape and fewer than two content words retrieves nothing; conventional-commit prefixes such as
   `feat(agent):` are not calls.
2. **Narrow searches first**: declarations of each identifier, the named files, the quoted
   errors. Four searches in flight at once, cancelled at the deadline (500 ms native, 300 ms for
   CLI agents).
3. **Broaden only where needed**: identifiers with no declaration are searched as whole words,
   plus the uses of the first declared identifier (its callers matter to an edit).
   **BM25 for plain words**: each word is searched in contents (matching lines as term frequency,
   no length normalization) and in paths (worth double), weighted by rarity against the index's
   file count. A file found only by plain words needs two of them, one in its path: contents alone
   (`chat`, `settings`) measured as noise. A message in prose gets at most five files by headline
   (300 tokens), no code.
4. **Rank** (`rankEvidence`): location > named file > declaration > quoted text > use; a term
   found in many files counts less (1/log2(1+files)); different terms meeting in one file multiply
   the score; tests rank up only when the message is about tests; generated and vendored paths
   rank down; files `git status` reports as changed rank up.
5. **Select and budget** (`snippetsFor`, `packRetrieval`): ±3 lines around each hit, merged, at
   most 24 lines per file, for the best 5 files; best files first until the budget (1,500 tokens
   for Volt's own models, 400 for Claude Code / Codex, which get headlines only). A file that does
   not fit with its code is listed by its headline; files already shown in this chat are listed
   without code again.
6. **Guard against stale context**: the block says it was searched for this message, may be
   incomplete, and that a file must be read before it is edited. Snippets are read at turn start
   from disk; nothing is cached across file changes.

Native runs append the block to the model's copy of the user message (never the chat shown to
the user, and never the system prompt, so the prompt cache prefix is unchanged). ACP agents get it
in the lead Volt already prepends.

### Error checks for every agent

Volt's own agent was already sent back when files it changed gained compiler or linter errors.
Claude Code and Codex runs now get the same check: the error counts of each file they change are
recorded at their first change (from `fs/write_text_file` and from tool diffs), and when the agent
wants to stop, new errors in those files send it back with the list, at most twice per run.

### Token accounting

`RunMetrics` now records, per run: tool output tokens by tool and by file (the largest), model
requests and the largest request input, and the retrieval block's size, latency and how many of
its files the agent then read, searched in or edited. The `[volt timing]` log line shows them,
e.g. `tool output ~12.3k tokens (read_file 8.1k, grep 2.2k), requests 9 (max input 41.0k),
retrieval 38ms 900 tokens, 3/5 files used`. That last number is the measure of whether retrieval
helps on real work.

## Installation and configuration

| Setting | Default | |
|---|---|---|
| `volt.codeIntelligence.index.enabled` | `true` | The code index (unchanged). |
| `volt.codeIntelligence.retrieval.enabled` | `true` | Search-to-context before the agent's first step. |
| `volt.codeIntelligence.fff.mode` | `auto` | `auto`: FFF for `find_files` when installed. `off`: the index only. |
| `volt.codeIntelligence.fff.path` | `""` | A specific `fff-mcp` binary. |
| `volt.codeIntelligence.rtk.enabled` | `true` | RTK for the agent's shell commands when installed (POSIX). |
| `volt.codeIntelligence.rtk.exclude` | `[]` | Commands RTK never rewrites, by their first words (`"git log"` keeps `git log --oneline` raw, not `git status`). |

**FFF** (optional, [dmtrKovalenko/fff](https://github.com/dmtrKovalenko/fff), MIT). Settings >
Code Intelligence > Search and Context > Install FFF downloads `fff-mcp` v0.11.0 for this platform
from the GitHub release into `<userData>/volt-tools/fff/0.11.0/` and checks it against a SHA-256
pinned in `common/fff.ts` (macOS arm64/x64, Linux gnu/musl x64/arm64, Windows x64/arm64). Or
install it yourself (`brew install dmtrKovalenko/fff/fff-mcp`) and Volt finds it on PATH, or set
`volt.codeIntelligence.fff.path`. Volt runs it as a separate process over MCP's stdio transport
(no native module is loaded into Volt, which matters for the signed app's library validation),
one process per git root, started on the first `find_files`, stopped when its project is unloaded
or after 20 idle minutes. Arguments are passed as an array, never through a shell. Its frecency
and history databases and logs live in `<userData>/volt-tools/fff/`. Without FFF, the index's own
fuzzy search answers.

**RTK** (optional, [rtk-ai/rtk](https://github.com/rtk-ai/rtk); CLI Apache-2.0, engine BUSL-1.1).
`brew install rtk`, or winget on Windows. Volt asks `rtk rewrite` for the compact form of each
agent shell command and runs the command unchanged when there is none, so commands RTK does not
know and machines without RTK behave exactly as before. On macOS and Linux the command travels in
an environment variable, never interpolated into the shell line; on Windows (`cmd.exe` would
splice a `%VAR%` into its own syntax) Volt asks RTK first through `execFile`, no shell, the command
as one argument, then runs what RTK answers. Already-RTK commands (`rtk proxy <cmd>` is the way to get
one command's raw output) and commands carrying the wrapper's variable are never wrapped again.
When RTK cuts long failing output it prints the path of the full log (its `tee` files); Volt's
shell tool also spills long output to a log file it names in the result.

## Benchmarks

Machine: Apple M4 Pro, macOS 26.5.1, Node 24.11.1, ripgrep 13.0.0 (the one VS Code bundles),
fff-mcp 0.11.0, rtk 0.43.0. Warm page cache; p50 of 7 runs unless stated. "Before" is the index
engine at `56ed7521` (bundled from source), "after" is this change, both driven by the same script
over the same repos and queries. The harness lives outside the repo (it bundles
`codeIndexEngine.ts` with esbuild and drives it from Node), so the numbers are the engine's, not
end-to-end through the app's IPC (one more local round trip, about 1 ms).

Repos: small = a Next.js frontend (2,144 indexed files), medium = this repo (10,035), large =
the Linux kernel, shallow clone (104,239).

### Content search

| Query | Repo | Before | After |
|---|---|---|---|
| Rare literal (`useAccountsFilters`, `IVoltCodeIndexService`, `kmem_cache_alloc_node`) | S / M / L | 1.1 / 1.8 / 57-75 ms (index) | 1.1 / 2.0 / 57-61 ms (index) |
| Common literal (`return`, 100 matches) | S | 70.4 ms (index → ripgrep on candidates) | **1.2 ms** (index, stops at the limit) |
| | M | index declined → full ripgrep scan, p50 **378 ms** | **2.3 ms** (index) |
| | L | index declined → full ripgrep scan, p50 **3.6 s** | **23-29 ms** (index) |
| Regex with Unicode `\w` (`class\s+\w+Service\b`) | M | 163 ms (ripgrep on candidates) | 168 ms (unchanged: `\w` is not the same in JavaScript, so ripgrep must answer) |
| No match | S / M / L | 0.1 / 0.4 / 10 ms | 0.1 / 0.8 / 10-12 ms |
| Symbol declaration | S / M / L | 2.5 / 7.9 / 62-67 ms | 1.8 / 7.7 / 66-68 ms |

For reference, ripgrep spawned per query over the whole tree (what every agent grep cost before
the index, and what a declined query still costs): 45-75 ms small, 294-379 ms medium,
3.2-3.6 s large. Its first output arrives after 4-23 ms (it streams); the index returns complete,
limited results in that time. Large-repo variation between runs was ±10 ms with no code change
(alternating before/after runs: 59.7-75 ms vs 56.9-61.2 ms for the rare literal), so differences
below that are noise.

### Fuzzy file search (new)

| Query | Index fuzzy | FFF | Top result (index / FFF) |
|---|---|---|---|
| `useThemCustomizer` (S) | 0.7 ms | 1.0 ms | `useThemeCustomizer.ts` / same |
| `rootIndx` (M) | 3.7 ms | 1.2 ms | `rootIndex.ts` / same |
| `agent terminals` (M) | 3.3 ms | 2.1 ms | `agentTerminals.css` / `agentTerminals.ts` |
| `sched fair` (L) | 23.9 ms | 10.3 ms | `kernel/sched/fair.c` / same |
| `ext4 inode` (L) | 22.5 ms | 4.7 ms | `fs/ext4/inode.c` / `include/trace/events/ext4.h` |

Before this change there was no fuzzy file search; an agent listed files (`rg --files`, 16 / 48 /
145 ms) and filtered them itself, without typo tolerance.

### Resources

| | Small | Medium | Large |
|---|---|---|---|
| Index cold build | 0.24 s | 2.6 s | 28-30 s |
| Index load from disk | 33 ms | 94-123 ms | 0.66-0.81 s |
| Index on disk | 6 MB | 47 MB | 539 MB |
| Index process RSS above Node, warm | 35-42 MB | 99-119 MB | 676-693 MB |
| FFF start to first answer | 87 ms | 114 ms | 372 ms |
| FFF RSS | 56 MB | 273 MB | 263 MB |

FFF's binary is 7.4 MB (macOS arm64) and is only downloaded on request; nothing is added to
Volt's download. The large repo's index memory is the next thing to optimize (see below).

### Round 2: remaining slow paths and bugs

Same harness, same repos, two alternating runs each (`before` = the engine at `56ed7521`, `after` =
this change). "Declined" means the index handed the query back and the caller ran ripgrep over the
whole tree; the ripgrep cost below was measured separately with the same pattern (spawned, all
files): small 129-347 ms, medium 253-581 ms, large 3.7-7.4 s.

| Query | Repo | Before | After |
|---|---|---|---|
| Rare literal | L | 64-67 ms | **9.9-10.1 ms** (posting cache fixed, phrases deduplicated, the 23 MB file skipped) |
| No match | L | 11-12 ms | **0.1 ms** |
| No match | M | 2-3 ms | 0.4-0.9 ms |
| `return` (100 matches) | S | 87-88 ms (ripgrep on candidates) | **1.6-1.9 ms** |
| | M / L | declined (+ ripgrep scan) | 3.1-4.2 ms / 21-22 ms |
| `\bconst\s+\w+\s*=` (Unicode `\w \s \b`) | S | 92-99 ms (ripgrep) | **1.9-2.2 ms** |
| | M | declined (+ ripgrep 411 ms) | 4.9-16 ms |
| `class\s+\w+Service\b` | M | 195-199 ms (ripgrep on 1,500 candidates) | **46-67 ms** (in-process) |
| `\bstatic\s+\w+\s*\*?\w+\(` | L | declined (+ ripgrep 3.8 s) | 57-67 ms |
| `static\s+int\s+\w+_probe\(` | L | declined (+ ripgrep 3.8 s) | 161-184 ms |
| Symbol, exact | M / L | 20-27 / 69-71 ms | **1.7-2.8 / 1.0-1.4 ms** |
| Symbol, prefix | M / L | 34-39 / 74-76 ms | 4.9-10 / 3-3.9 ms |
| Symbol right after a file edit | L | 364-372 ms (symbols reloaded) | **1.4-2.3 ms** |
| First symbol query after a load | L | 326-381 ms | 518-590 ms (builds the hash index once) |
| Fuzzy file search | L | (did not exist) | 3.4-4.7 ms (was 23 ms with the first version) |

Against ripgrep re-reading the Linux tree for every query (what an agent pays without an index):
a miss is 3.5 s vs 0.1 ms, a rare literal 3.2 s vs 10 ms, `return` 3.6 s vs 22 ms.

Memory on Linux with everything warm (heap after GC, off-heap = ArrayBuffers): the posting cache now
actually holds lists (17 MB of its 24 MB budget; it was stuck empty before), the symbol hash index
46.5 MB while symbols are cached (dropped after 3 idle minutes), the large-file bitset 2 MB, the
fuzzy masks 0.4 MB. The symbol tables themselves (≈215 MB of heap for 3 million symbols) were
already there before this change.

Retrieval (same 174 commits): p50 36 → 27 ms, p90 87 → 77 ms (identifier lookups now stay
in-process); 63 blocks, hit rate 76% (was 78%: one commit, different files picked within the same
match limit), precision 42%, mean 903 tokens.

### RTK

Same commands raw and through Volt's wrapper line, in this repo (tokens = Volt's estimator,
characters / 3.5):

| Command | Raw | RTK | Saved | Exit code |
|---|---|---|---|---|
| `git status` | 500 | 366 | 27% | 0 → 0 |
| `git log -n 20` | 2,728 | 1,702 | 38% | 0 → 0 |
| `git show HEAD --stat` | 477 | 477 | 0% | 0 → 0 |
| `git diff HEAD~1` | 47,019 | 8,146 | 83% | 0 → 0 |
| `git diff` (working tree) | 26,887 | 9,174 | 66% | 0 → 0 |
| `ls -la <dir>` | 418 | 111 | 74% | 0 → 0 |
| `find <dir> -name "*.ts"` | 279 | 104 | 63% | 0 → 0 |
| `grep -rn <symbol> src/vs` | 1,368 | 1,368 | 0% | 0 → 0 |
| `cat <file>` (`rtk read`) | 1,603 | 1,603 | 0% (full content) | 0 → 0 |
| `npx eslint <file>` (clean) | 252 | 7 | 97% | 0 → 0 |
| `git show <missing ref>` | 57 | 57 | 0%, error kept | 128 → 128 |
| `ls <missing dir>` | 14 | 14 | 0%, error kept | 1 → 1 |
| `npx tsc` with 2 type errors | 45 | 54 | -21%, both errors and codes kept | 2 → 2 |
| **Total** | **81,647** | **23,183** | **72%** | all preserved |

Overhead: 10-100 ms per command (the `rtk rewrite` call and RTK's own process). RTK can add a few
tokens to tiny outputs. `rtk git diff` keeps changed lines and drops most context lines; an agent
that needs a full diff can run `rtk proxy git diff`, or `git diff` can be excluded in settings.

### Retrieval quality

Each of the last 174 non-merge commits in this repo that touched `src/`, its message used as the
request, the files it changed as the files retrieval should surface (`retrievalbench.ts`, real
`VoltSearch` + `ContextRetriever` over the real index, budget 1,500 tokens, deadline 500 ms):

| | |
|---|---|
| Messages that produced a block | 63 of 174 (36%); the rest name nothing code-like and cost nothing |
| Blocks with at least one file the commit changed | 78% |
| Share of offered files the commit changed (precision) | 43% |
| Block size | mean 903 tokens, max 1,488 |
| Latency | p50 36 ms, p90 87 ms; none cut short by the deadline |

Caveat: retrieval ran on today's tree, so symbols a commit introduced already existed; that
favours hits. It is a proxy for "the right context", not a measure of task success.

### BM25 for plain-word messages

Same 174 commits, Co-Authored-By trailers removed (a person would not type them):

| | Without BM25 | With BM25 |
|---|---|---|
| Commits where a file it changed was offered | 48 | **78** (+63%) |
| Messages with a block | 63 | 165 |
| Retrieval tokens over all 174 messages | 56.9k | 92.7k (prose blocks: headlines only, at most 300 tokens) |
| Tokens per useful hit | ~1,185 | ~1,190 |
| Latency p50 / p90 | 27 / 77 ms | 72 / 178 ms (inside the 500 ms window, alongside turn setup) |

The first version (contents only, no path requirement, full snippets) offered a right file for no
more commits (48), at 7% precision and 1,415 tokens per block; it was not kept.

### Not measured

- Model input tokens per task and time from request to verified change: these need the same
  tasks run with live models, with and without retrieval; the run metrics above now record what
  is needed (`retrieval ... files used`, tool output tokens, requests), but no such runs were
  made for this change.
- Any comparison with Cursor: no runs against Cursor were made, so no claim is made.

### Tests

`src/vs/platform/voltCodeIndex/test/common/{fuzzyPath,fff}.test.ts`,
`src/vs/platform/voltCodeIndex/test/node/{codeIndexSearch,fffEngine}.test.ts`,
`src/vs/workbench/services/voltRuntime/test/common/search/{contextRetrieval,searchCache}.test.ts`,
and additions to `test/common/harness/runObservability.test.ts`. The node tests compare the
index's answers with ripgrep's line for line (selective literals, the early-exit path, the
in-process + ripgrep path, spaces in paths, ignored and binary files, a malformed regex, a 20,000
character line, a pattern only ripgrep may answer), check that edits, new files, renames and
deletes reach the next search, and drive a fake `fff-mcp` through missing, broken, hung and
crashing cases.

## Known limitations and next steps

- Index memory on very large repos (≈690 MB RSS for Linux): posting lists and path maps are held
  in memory; mmap'd segments or a smaller path table would cut it.
- Symbols come from regex extraction. `@vscode/tree-sitter-wasm` is already a dependency with
  grammars for TS/TSX/JS/Python/Go/Rust/Java/C#/C++/Ruby/CSS; parsing in the index worker would
  give exact declarations and references.
- Patterns with Unicode class names (`\p{Greek}`), POSIX classes or `\W` inside a class still go
  to ripgrep (their spelling differs in JavaScript).
- The first symbol query after a load builds the hash index (Linux: about 150 ms more than
  before); lookups after that are sub-millisecond to a few ms.
- Retrieval ranks by evidence counts, not semantics; no embeddings were added because nothing here
  shows they would pay for their indexing cost. The `files used` metric is the signal to revisit.
- Prose retrieval precision is 22% on the commit benchmark: it finds a right file for 63% more
  requests at the same tokens per useful hit, but most prose blocks point at near misses.
- A one-hop import graph (importers of the declaring file) was built and measured: no additional
  right files on the benchmark, more tokens and latency, so it was removed.
