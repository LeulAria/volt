# Review guidelines

The AI review (`.github/workflows/volt-pr-review.yml`) reads this file on every pull request, along with the
coding guidelines in `copilot-instructions.md`, `instructions/*.instructions.md` and the Volt UI skills in
`.claude/skills/` when the change touches the code they cover. Keep it short: every line costs tokens on every review.

## Correctness first

- Listeners, widgets, timers and child processes are disposed: `this._register(...)`, a `DisposableStore`, or an
  explicit `dispose()`. A listener added in a method that runs more than once without a matching dispose is a leak.
- Promises are awaited or deliberately handled; an `async` callback passed to an event or `forEach` loses its errors.
- Errors are not swallowed silently: a `catch` that hides a failure the user should see is a bug.
- State that belongs to one chat, window or project is not shared across them (module-level caches keyed wrongly,
  a singleton holding the last chat's data).

## Security

- Processes are started with an argument array (`spawn(cmd, args)`), never a shell string built from paths, branch
  names, model output or anything else a user or agent controls.
- File paths from agents, MCP tools or the network are resolved and checked against the allowed root before use.
- Tokens, API keys and account data never reach logs, telemetry, error messages or the renderer.
- The renderer is sandboxed: Node APIs belong in `node/` and `electron-main/` code behind a service or IPC channel.

## Architecture

- Layers: `common` imports no `browser`, `node` or `electron-*` code; `browser` imports no `node` or `electron-*` code.
- Services come in through constructor injection (`@IFooService`), not by reaching into another part's internals.
- User-visible strings use `localize()` with a stable key; no concatenated sentences.
- Settings, persisted state and agent protocol messages stay readable by the previous release, or are migrated.

## Volt UI

- Choices use `createVoltDropdown` and actions `createVoltButton`; never a native `<select>` or `SelectBox`.
- Lists of rows are `WorkbenchList` or tree widgets with rows edge to edge, never hand-built divs.
- No `backdrop-filter` anywhere, and a `<webview>` sits on an opaque layer: the agent window is transparent and
  these turn its sidebar black and leave ghost trails.
- No broad `:has()` or `[class*=...]` selectors on large containers, and no SVG animations in rows that repeat:
  they restyle or repaint the whole window on every frame. Toggle a class from TypeScript, animate an HTML element.

## Tests

- New logic in `voltRuntime`, `platform/volt*` or the agent server comes with a test next to it in `test/common`
  or `test/node`.
- A change must not weaken an existing assertion, skip a test, or special-case test environments to pass.
