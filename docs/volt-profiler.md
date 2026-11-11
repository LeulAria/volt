# Volt Profiler

Agents and the user profile together. The agent records, reads and compares profiles through the
`ide` tool's `profile` capability; the Profiler tab beside the chat shows the same profile, and both
sides steer it: the agent focuses the view and pins notes, the user selects and zooms, and each
reads what the other did. Data that is not a profile (bundle size by folder, latency by endpoint,
memory over time) goes into the same tab with `profile show`, so agents show findings instead of
drawing an HTML page each time.

## What it reads

| Source | How to get it | Shown as |
| --- | --- | --- |
| V8 CPU profile (`.cpuprofile`) | `profile cpu` (runs the command with `--cpu-prof`), Chrome DevTools, js-debug | flame chart, flame graph, heat map, table |
| V8 sampling heap profile (`.heapprofile`) | `profile heap` (`--heap-prof`) | flame graph and table in bytes |
| Memory and CPU of any process tree | `profile sample` (macOS, Linux; `ps` every 200 ms) | counter lines |
| speedscope JSON | `py-spy record --format speedscope`, rbspy, `perf` through speedscope | chart (evented: exact; sampled: in sample order), graph |
| Chrome trace events | `chrome://tracing`, Perfetto JSON, `--trace-event` | chart of the busiest thread, counters |
| Folded stacks (`a;b;c 42` per line) | `perf script` + stackcollapse, async-profiler, `go tool pprof -raw` + collapse, inferno | flame graph, table |
| Volt profile JSON (`$volt: "profile"`) | `profile show`, or written by any tool | graph (`stacks`), lines (`series`), heat map (`matrix`) |

## Agent ops (`ide` capability `profile`)

| Op | Does |
| --- | --- |
| `cpu`, `heap` | Run a Node command under the V8 profiler, open the largest process's profile, return a summary |
| `sample` | Run any command and record memory (RSS) and CPU of its process tree over time |
| `open` | Open a profile file (`compare_with` opens a diff) |
| `analyze` | Read a profile again: a time `window`, one `function` (callers, callees, cost), a `filter` |
| `compare` | What got slower and faster by function; opens the differential flame graph |
| `focus` | Point the user's view at a function, a window, a view or a search |
| `annotate`, `clear_notes` | Pin notes on a function or a stretch of time; the user sees them on the canvas and in the side panel |
| `selection` | What the user is looking at: the selected function, window, view, search |
| `show` | Any data as a flame graph, lines or a heat map |
| `list`, `bench`, `summary` | Profiles of the chat; timing runs (hyperfine when installed); the old summary op |

Summaries are compact on purpose (a few hundred tokens): what was measured, where the value goes by
source (app, each package, the runtime, GC), the hottest functions by self and by total time with
`file:line` (runtime wrappers left out), the hottest stacks from the first frame the program owns,
and notes on patterns worth acting on: GC pressure, a mostly idle process (wall time is waiting,
not CPU), a single hotspot, a flat profile, one package dominating, memory that keeps growing.
`compare` warns when two runs are under 3% apart.

## The tab

- **Flame chart**: calls over time, depth down, like Chrome's Performance panel. Sub-pixel calls
  draw once per pixel, and each lane is binary-searched to its first visible call, so large
  profiles stay fast.
- **Flame graph**: every path merged, widest first. Double-click zooms into a call; its callers
  stay on top as context. In a comparison the same graph is colored red where the new run is
  slower and blue where it is faster.
- **Heat map**: the 40 costliest functions by when they run (self time per time bucket), or any
  matrix from `show`. Double-click a cell to open that moment in the chart.
- **Functions**: a VS Code list with self and total time, sortable, filtered by the search.
- **Counters**: memory, CPU and other series as lines, one band each.
- **Overview strip** above time views: how busy each moment is, colored by the source that took
  most of it, with the first counter as a line. Drag it to pick a window.
- **Side panel**: the selected function (self, total, before and after in a comparison, open the
  source), its callers and callees, and the agent's notes. **Ask Agent** adds the selection (or
  the whole profile) to the chat as a context chip.

Navigation: drag or Shift+scroll to pan, Ctrl/Cmd+scroll or pinch to zoom, W/S to zoom, A/D to pan,
double-click to zoom in, Escape to zoom out, 0 to reset. Colors follow the theme (light, dark,
high contrast); by source or by heat.

Profiles open from the command palette (**Profiler: Open in Profiler**), from the Explorer and
editor tab menus for profile files, and on their own when an agent profiles
(`volt.agent.ide.autoOpenTabs`). Tabs survive a reload: profiles are files, read again on open.

## Code

| Piece | Files |
| --- | --- |
| Model, formats, analysis (pure, tested) | `services/voltRuntime/common/profiler/{profile,profileFormats,profileAnalysis,usageSampler}.ts`, `test/common/profiler.test.ts` |
| Tab | `contrib/voltAgent/browser/profiler/{profilerEditor,profilerViews,profilerInput,voltProfilerService,profiler.contribution}.ts`, `media/voltProfiler.css`, `test/browser/profilerViews.test.ts` |
| Agent ops | `contrib/voltAgent/browser/ide/capabilities/profileCapability.ts`, spec in `common/ide/ideCapabilities.ts` |
| Model guidance | `common/deepseek/prompt.ts` (native loop), `common/harness/contextPack.ts` (`IDE_TOOLS_GUIDE`) |

In a sandboxed chat, `cpu`, `heap`, `sample` and `bench` run in the chat's OS sandbox with the
recording folder writable (`IdeCli`), like every other program an IDE capability starts.

## Not verified at runtime

The parsers, analysis, summaries, the sampler script and the canvas drawing and hit testing are
covered by tests (the canvas against a recording 2D context). The tab itself has not run in the
app yet. The first pass should check: a real `profile cpu` opening beside a chat, zoom and pan
in each view, a comparison, a note from the agent, Ask Agent's chip, light and dark themes.
