# Contributing to Volt

Thanks for wanting to make Volt better. This guide covers how to get a working checkout, how the code is organized, the standards a change is held to, and how to get it merged.

If you only want to report a bug or suggest an idea, you don't need any of the setup below. Jump to [Reporting bugs](#reporting-bugs) or [Suggesting features](#suggesting-features).

**On this page**

- [Ways to contribute](#ways-to-contribute)
- [Before you write code](#before-you-write-code)
- [Set up your machine](#set-up-your-machine)
- [Day-to-day development](#day-to-day-development)
- [How the code is organized](#how-the-code-is-organized)
- [Coding standards](#coding-standards)
- [Checks before you push](#checks-before-you-push)
- [Testing](#testing)
- [Commits and pull requests](#commits-and-pull-requests)
- [AI-assisted contributions](#ai-assisted-contributions)
- [Working on the docs site](#working-on-the-docs-site)
- [Licensing](#licensing)

## Ways to contribute

- **Report a bug** with steps someone else can follow.
- **Fix one.** Small, focused fixes with a test are the easiest thing to review and merge.
- **Improve the agent experience**: the composer, the transcript, review tools, the in-app browser.
- **Add or harden a provider or agent integration** (an ACP bridge, a model catalog, a bug in how a CLI's permissions map onto Volt's).
- **Write tests.** Replay tests for agent protocol edge cases are especially valuable.
- **Improve the docs**, in this repository or on the docs site.
- **Triage**: reproduce reports, narrow them down, and point at the cause.

Everyone taking part is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you write code

1. **Search first.** Check [open issues](https://github.com/LeulAria/VOLT/issues) and recent pull requests. If someone is already on it, join in instead of duplicating the work.
2. **Talk before you build anything big.** For a new feature, a change to default behavior, or anything that touches the access broker, the runtime's public contracts, or the window chrome, open an issue describing the problem and your proposed approach. Agreeing on the shape up front saves you from a large pull request we can't take.
3. **Keep it to one problem.** A pull request should do one thing. Unrelated cleanups, renames, and reformatting belong in their own PRs, where they can be reviewed (and reverted) on their own.
4. **Security issues are different.** Don't open a public issue. Follow [SECURITY.md](SECURITY.md).

Changes most likely to be merged quickly: bug fixes with a regression test, reliability and performance work backed by a measurement, and improvements that make an existing feature behave the way it already claims to.

## Set up your machine

### Requirements

| Tool | Version |
| --- | --- |
| Node.js | **22.19.0** (see [`.nvmrc`](.nvmrc); the install fails below 22.15.1) |
| npm | the one bundled with Node 22 (Yarn and pnpm are not supported) |
| Git | any recent version |
| Python | 3.x, for `node-gyp` |
| A C/C++ toolchain | see below |
| [nvm](https://github.com/nvm-sh/nvm) | needed by the `make` targets |

Plan for several GB of free disk and at least 8 GB of RAM for a full build.

**macOS.** Install the Xcode Command Line Tools: `xcode-select --install`.

**Debian and Ubuntu.**

```bash
sudo apt-get install build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev python-is-python3
```

**Fedora and RHEL.**

```bash
sudo dnf install @development-tools gcc gcc-c++ make libsecret-devel krb5-devel libX11-devel libxkbfile-devel
```

**Windows.** Install Visual Studio 2022 (or the Build Tools) with the *Desktop development with C++* workload, including the Spectre-mitigated libraries. The install script checks for it and tells you what's missing.

> Volt is developed and tested on macOS. Linux and Windows builds follow VS Code's, but the agent window's transparency and vibrancy work has only been verified on macOS. Reports from other platforms are welcome.

### Get the code

Fork the repository on GitHub, then:

```bash
git clone https://github.com/<you>/VOLT.git
cd VOLT
git remote add upstream https://github.com/LeulAria/VOLT.git
```

### Install and run

```bash
nvm install                          # picks up Node from .nvmrc
npm install                          # installs dependencies and builds native modules
npm run electron                     # downloads the Electron runtime into .build/
node build/lib/builtInExtensions.js  # fetches the pinned built-in extensions

make start                           # compile, watch, and launch Volt
```

The first compile takes a few minutes. After that, rebuilds are incremental, and **saving a file reloads the window**.

| Command | What it does |
| --- | --- |
| `make start` (or `make run`) | Start the file watcher and launch Volt |
| `make watch` | Recompile `src/` into `out/` on save, without launching |
| `make extensions` | Compile built-in extensions that have no `out/` yet |
| `make reload` | Relaunch Volt and keep the watcher |
| `make stop` | Stop Volt and the watcher |
| `make restart` | Stop everything, then start |

Logs from the watcher go to `.build/volt-watch.log`. Open the developer tools from the Help menu to see renderer errors.

## Day-to-day development

A few things about the dev loop that have cost people an afternoon:

- **A new file may not be picked up.** The watcher can miss `.ts` files created after it started. If your change has no effect, check that the matching `.js` appeared under `out/`, and run `make restart`.
- **Hot reload can interrupt a running chat.** Saving a file swaps changed modules into every open window. If an agent run was in flight, it can get stuck half-updated. Reload the window (<kbd>⌘</kbd><kbd>R</kbd>) before you test, and don't trust a run that was live while you saved. CSS reloads cleanly, so you can end up with new styles over old script until you reload.
- **Language features missing?** Go to References, Format Document, and the Git view all come from built-in extensions that must be compiled. `make start` does this for you. If something is gone anyway, look in the extension host log for `entry point is missing` and run `make extensions`.
- **Use a separate profile for risky experiments.** Launch a second instance with `--user-data-dir /tmp/volt-test` so you don't touch your real chats and settings.
- **Don't test on a window you're also typing in.** If you drive the UI with scripts or the DevTools protocol, use a fresh profile and say clearly which window is the test one.

## How the code is organized

Volt is a fork of VS Code and keeps its layered architecture. Most of what's ours lives in a handful of `volt*` directories; everything else is upstream.

```text
src/vs/
├── base/ platform/ editor/ workbench/ code/   VS Code core
├── platform/
│   ├── voltStdio/        agent and shell child processes
│   ├── voltGit/          snapshots, diffs, restore, clone
│   ├── voltHostMcp/      loopback MCP server for browser and question tools
│   ├── voltBrowser/      session for the in-app browser
│   ├── voltUsage/        usage and cost tracking
│   └── voltFsBrowse/     folder browsing for the project picker
└── workbench/
    ├── services/voltRuntime/   providers, ACP bridges, native loop, access broker, tools, history
    └── contrib/
        ├── voltAgent/          the agent window: chat, composer, review, browser, history
        ├── voltProjects/       project registry and add-project flow
        ├── voltSettings/       the Volt settings editor
        └── voltPrediction/     inline completions and AI edit
```

### Rules that keep it maintainable

- **Respect the layers.** Code in `common/` runs anywhere and may not touch the DOM or Node. `browser/` may use the DOM but not Node. `node/` and `electron-main/` are the reverse. `npm run valid-layers-check` enforces this, and it will fail your build if you cross a boundary.
- **The UI talks to the runtime through a service.** Don't import a provider SDK, spawn a process, or read credentials from `contrib/`. Put it behind an interface in `voltRuntime` or a `platform/volt*` service.
- **Put logic where it can be tested.** Prefer pure logic in `common/` with a unit test, and keep the DOM code thin. The runtime has far better test coverage than the views, and we'd like to keep it that way.
- **Everything the agent can do goes through the access broker.** A new tool declares what kind of action it is (read, edit, shell, network, and so on) so the policy can gate it. A tool that bypasses the broker will not be merged.
- **Use the services VS Code gives you**: files, storage, secret storage, requests, configuration, workspace trust. Don't invent parallel ones.
- **Keep changes to upstream files small.** Every line we change outside the `volt*` directories is a line that may conflict the next time we merge VS Code. Prefer extending through a contribution or a service over patching a core file, and leave a short comment explaining why a core change is needed.

For the reasoning behind these, and a candid list of known weak spots, read [VOLT-ARCHITECTURE-REVIEW.md](VOLT-ARCHITECTURE-REVIEW.md). For where the agent window is going, read [VOLT-MULTI-PROJECT-AGENT-WORKSPACE-PLAN.md](VOLT-MULTI-PROJECT-AGENT-WORKSPACE-PLAN.md).

## Coding standards

We follow the [VS Code coding guidelines](https://github.com/microsoft/vscode/wiki/Coding-Guidelines), with these highlights:

- **Formatting.** Tabs for indentation, no trailing whitespace. [`.editorconfig`](.editorconfig) covers it.
- **Naming.** `PascalCase` for types, classes, and enums; `camelCase` for functions, methods, properties, and variables. Interfaces start with `I`. Use whole words.
- **Strings.** Anything the user reads goes through `localize` with a double-quoted string. Everything else uses single quotes.
- **Types.** No `any`. Prefer `readonly`, `const`, and narrow types.
- **Disposables.** Anything that allocates something to clean up (a listener, a timer, a child process) must be registered with `this._register(...)` or returned as an `IDisposable`. Leaks in a long-running chat window are bugs.
- **Async.** Support cancellation (`CancellationToken`) for anything that can take a while, and make sure a cancelled run really stops its work.
- **Comments.** Explain *why*, not *what*. Delete commented-out code.

### File headers

Every source file starts with a license header, and the build checks it (`npm run hygiene`). Files in a directory whose name contains `volt` use ours:

```ts
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
```

Files elsewhere keep the Microsoft Corporation header they came with.

### CSS in the agent window

The agent window is transparent (macOS vibrancy), and some CSS makes Chromium stop clearing old pixels, which turns the sidebar solid black and leaves ghost trails when lists scroll. If your change paints anything in that window, read [`.claude/skills/volt-transparent-window/SKILL.md`](.claude/skills/volt-transparent-window/SKILL.md) first. The short version:

- **Never use `backdrop-filter`.** Not in CSS, not inline.
- A `<webview>` must sit on an opaque background, in its own contained layer.
- New fixed or absolute layers over the window need an opaque background.
- Vibrancy doesn't appear in screenshots taken through the DevTools protocol, so a UI change here has to be checked on screen, in a real window.

## Checks before you push

Run these from the repository root, with Node 22:

```bash
npm run compile-check-ts-native   # type-check src/ (fast, native)
npm run eslint                    # lint
npm run stylelint                 # CSS lint
npm run hygiene                   # license headers, formatting, file rules
npm run valid-layers-check        # layering rules
```

> **Known baseline.** As of October 2026 the type check reports about 43 diagnostics, mostly fallout from the move to TypeScript 6 (`module` vs `namespace`, stale test fixtures). They're tracked and being cleaned up. **Your change must not add new ones.** Run the check before and after, and compare.

Because of that baseline, a strict release build fails. For local packaging only, `VOLT_BUILD_IGNORE_TYPE_ERRORS=1` reports the errors and still builds. Never use it to hide an error you introduced.

## Testing

Tests live next to the code they cover, in a `test/` folder, and end in `.test.ts`.

| Area | Where | Runner |
| --- | --- | --- |
| Runtime logic (`common/`, `node/`) | `src/vs/workbench/services/voltRuntime/test` | Node |
| Platform services | `src/vs/platform/volt*/test` | Node |
| UI and DOM code | `src/vs/workbench/contrib/voltAgent/test/browser` and `electron-browser` | Electron or browser runner |

Tests run against compiled output, so keep `make watch` running (or run `npm run compile`) first.

```bash
# every Node-runnable unit test
npm run test-node

# a single file
npm run test-node -- --run src/vs/workbench/services/voltRuntime/test/common/accessBroker.test.ts

# the Electron runner, for tests that need a DOM
./scripts/test.sh --run src/vs/workbench/contrib/voltAgent/test/browser/agentBlocks.test.ts

# the browser runner (installs Playwright browsers on first use)
npm run test-browser
```

What we expect:

- **A bug fix includes a test that fails without it.**
- **New runtime behavior includes unit tests**, including the unhappy paths: cancellation, timeouts, malformed provider output, and partial streams.
- **Agent protocol handling** should be covered by replay tests with a recorded transcript (see `acpReplay.test.ts`) instead of a hand-written mock where you can.
- **UI changes** can't always be unit tested. Say how you checked them, and attach a screenshot or a short recording (see below).

## Commits and pull requests

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org). The subject is imperative, lowercase after the prefix, and under about 72 characters:

```text
feat: let users keep or undo pending agent edits
fix: lay out the agent pane once when switching chats
style: tighten the table copy menu
```

Common prefixes are `feat`, `fix`, `perf`, `refactor`, `style` (visual only), `test`, `docs`, `build`, and `chore`. Add a scope in parentheses when it helps, for example `fix(docs):`. Put the *why* in the body when it isn't obvious.

### Pull requests

1. Branch from `main`. Keep your branch up to date with `main` by rebasing.
2. Keep the change small and on one topic. If a PR needs a long explanation of why its parts belong together, it probably needs to be two PRs.
3. Fill in the PR description:
   - **What and why**: the problem, and how your change solves it
   - **How you tested it**: commands you ran, and what you saw
   - **Linked issue**, if there is one
   - **Anything you couldn't check**, such as another OS or a provider you don't have access to
4. **For UI changes, include before-and-after screenshots**, and a short recording if timing or interaction matters. Attach them to the PR; don't commit them.
5. Make sure the [checks above](#checks-before-you-push) pass, and that you haven't added type errors.
6. Mark the PR ready when it is. Draft PRs are welcome for early feedback, and a draft is held to the same standards when it's marked ready.

### What reviewers look for

- Does it solve the stated problem, and only that problem?
- Does it keep the layering and the access-broker contract intact?
- Is there a test, and does it cover failure paths?
- Does it clean up after itself (disposables, processes, timers, listeners)?
- Is it safe to ship to someone who didn't read the PR? That means sensible defaults, no new network calls to unexpected hosts, and no secrets or personal paths in logs.
- Is it as small as it can be, especially where it touches upstream VS Code files?

Volt is maintained by a small team, so reviews take as long as they take. If you haven't heard back after two weeks, a polite nudge on the PR is welcome. Not every PR can be merged, even good ones, because a change can be right in isolation and wrong for the project's direction. When we decline, we'll tell you why.

## AI-assisted contributions

Using an AI tool to write code, tests, or a PR description is fine, and given what Volt is, we'd be a little surprised if you didn't. The standard doesn't change:

- **You are the author.** You have read every line, you understand it, and you have run it. "The model wrote it" is not an answer to a review comment.
- **Verify, don't assume.** Agents invent APIs, skip failure paths, and report success on checks they didn't run. Run the checks yourself.
- **Keep the scope tight.** Agents tend to refactor adjacent code. Revert that before you push.
- **Never paste secrets or other people's data** into a prompt, a commit, or a PR.
- **Mention it** if it's relevant to how a reviewer should read the change, such as a large generated diff. You don't need to disclose tool use otherwise.

We judge contributions on what they do, not on how they were written.

## Reporting bugs

Search [existing issues](https://github.com/LeulAria/VOLT/issues) first. If you find the same problem, add a reaction and any new detail instead of a new issue. If not, open one with:

- **What you did, what you expected, and what happened**, as numbered steps someone else can follow
- **Your Volt version or commit**, operating system, and Node version if you built from source
- **Which agent or model** was involved, and whether the problem happens with another
- **The access preset and mode** (for example Supervised, Agent mode)
- **Screenshots or a short recording** for anything visual
- **Logs or errors** from the developer tools console or the watcher log

Redact file paths you'd rather not share, and never include API keys, tokens, or transcripts containing private code. File one issue per problem.

## Suggesting features

Open an issue that starts from the problem rather than the solution: what are you trying to do, what's in your way, and what have you tried? Sketches and screenshots of the workflow you want are welcome. It helps to say who benefits and what you'd be willing to build yourself. We'd rather talk about it first than turn down a finished pull request.

## Working on the docs site

The documentation site lives in [`apps/docs`](apps/docs). It's a separate project with its own dependencies (TanStack Start, Fumadocs, and Tailwind), and it doesn't affect the desktop build.

```bash
cd apps/docs
npm install
npm run dev          # http://localhost:3000
```

Page content is MDX under `apps/docs/content/docs`. Before you open a PR, run:

```bash
npm run types:check
npm run lint         # Biome
```

If you change how Volt behaves, update the docs in the same pull request.

## Licensing

Volt is released under the [MIT License](LICENSE.txt). By submitting a contribution you agree that it may be distributed under that license. There is no separate contributor license agreement to sign.

Only submit work you have the right to share. If you add a dependency, say in the PR why it's needed, and check that its license is compatible with MIT. Don't copy code from projects under licenses that aren't.

## Thank you

Volt is better because people file the clear bug report, write the failing test first, and keep a pull request small enough to review. We appreciate it.
