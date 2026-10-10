# Volt render suite

A fixed set of prompts that exercise how an agent chat renders responses: markdown, code,
diagrams, tables, structured data, tool calls, diffs, errors, cancellation and long output.
Every scenario is sent unchanged to Cursor (Agents Window) and to Volt, so the two can be
compared side by side, during streaming and after completion.

There are two kinds of scenarios:

- **Render scenarios (`R*`)** ask the model to echo a fixed payload verbatim. Both apps then
  render the same markdown, so differences come from the renderer, not the model. The payloads
  live in `payloads/`. Volt also replays them offline at a fixed token rate through the fake ACP
  agent (`build/volt/renderSuite/fakeAcpAgent.mjs`), which makes its performance runs reproducible and free.
- **Task scenarios (`T*`)** make the agent work in a scratch copy of the fixture repo (`node build/volt/renderSuite/makeFixture.mjs <dir>`): tool calls, edits, diffs, failing commands, questions, cancellation.

## Echo prompt

For `R*` scenarios send exactly this, with the payload pasted between the markers:

```text
Reply with exactly the text between <<<BEGIN>>> and <<<END>>>, verbatim, as your entire answer.
Do not add anything before or after it, do not wrap it in a code block, and do not use any tools.
<<<BEGIN>>>
…payload…
<<<END>>>
```

## Scenarios

| ID | Scenario | Prompt / payload | What to look for |
|---|---|---|---|
| R01 | Rich markdown | `payloads/r01-markdown-rich.md` | heading scale, nested list indent and markers, task markers, nested quotes, hr, footnotes, image, kbd, emoji |
| R02 | Code blocks | `payloads/r02-code-blocks.md` | highlighting per language, plain fence, long line scroll, copy button, header/language label, streaming partial fence |
| R03 | Mermaid architecture | `payloads/r03-mermaid-architecture.md` | subgraphs, shapes, edge labels, size/fit, streaming placeholder, expand |
| R04 | Mermaid sequence | `payloads/r04-mermaid-sequence.md` | autonumber, alt/else, loop, notes |
| R05 | Tables | `payloads/r05-tables.md` | column alignment, horizontal scroll, inline code/links in cells, dense numbers, streaming partial rows |
| R06 | JSON / YAML / terminal / stack trace | `payloads/r06-structured-data.md` | highlighting, console fence, error lines |
| R07 | Math | `payloads/r07-math.md` | inline and display KaTeX, matrices |
| R08 | Malformed markdown | `payloads/r08-malformed.md` | unclosed emphasis, broken table, raw HTML sanitised, unterminated fences (mermaid and code) |
| R09 | Long mixed response | `payloads/r09-long-mixed.md` | everything above in one reply; streaming smoothness, scroll follow |
| R10 | File references and citations | `payloads/r10-file-refs.md` | path pills, `line:line:path` citation fences, links |
| R11 | Unified diff | `payloads/r11-diff.md` | diff fence colouring, multi-file headers |
| T01 | Multi-step coding task | "In this repo, make `average([])` return 0 instead of NaN and make `divide` throw on division by zero. Add a test for the throw. Then run `npm test` and show me the result." | tool rows, edit rows with +/-, inline diffs, terminal card, final summary, changed-files card |
| T02 | Failing command | "Run `npm run does-not-exist` and explain the error." | failed terminal state, error styling |
| T03 | Multi-file change | "Rename `loadUser` to `fetchUser` everywhere in this repo and summarise what changed." | multi-file edits, changed files card, expandable diffs |
| T04 | Parallel tools | "Read every file under src/ and give me a one-line summary of each." | grouped exploration rows, counts, concurrency |
| T05 | Cancel and restart | "Write a 2000-word essay about the history of compilers." → stop after ~5 s → immediately send "Say hi in one word." | stopped state, partial reply kept, second turn streams cleanly |
| T06 | Thinking | "Think carefully: how many weekdays are there between 2026-01-01 and 2026-03-31 inclusive? Show your reasoning briefly." | thinking row, shimmer, duration label |
| T07 | To-do plan | "Make a short to-do plan (3 items) for adding a `multiply` function with a test, then do it." | to-do card / checklist updates |
| T08 | Question to the user | "Before changing anything, ask me whether `divide` by zero should throw or return Infinity, then do what I pick." | interactive question UI |
| T09 | Follow-up | After T01: "Now also make `add` reject non-numbers." | follow-up turn layout, history above unchanged |
| S01 | Long conversation | 30+ turns mixing R01–R11 (Volt: seeded chat) | scroll responsiveness, re-render cost of history |

## Recording results

Per scenario and app, capture: a screenshot mid-stream, a screenshot after completion, time to
first visible text, time to completion, and anything broken or missing. Results go in
`docs/volt-render-parity/` (capability matrix, baseline, after).
