# Changelog

All notable changes to Volt are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Volt uses [semantic versioning](https://semver.org/)
while it is below 1.0: expect the minor version to carry breaking changes.

Volt is built on VS Code (Code - OSS 1.105). Changes to that base come from upstream and are not listed here.
Download a build from [Releases](https://github.com/LeulAria/volt/releases). On a Mac, read the
[macOS install guide](docs/install/macos.md) first: the builds are not signed with an Apple Developer ID.

## [0.0.2] - 2026-10-18

The first build you can download from GitHub Releases for macOS, Windows and Linux. It covers the eleven days of work
since the `0.0.1` tag: multi-agent work (subagents, plan mode, forks, worktrees, sandboxes), a code index that
agents search, an in-app browser with a design mode, Git views for branches and worktrees, several Claude
accounts, and a good deal of speed work.

### Highlights

- **Design mode in the in-app browser.** Click an element or drag an area and tell the agent what to change. A pick is named
  after its React or Vue component and goes with a picture of what you chose. *Batch edits* holds several annotations as
  numbered pins and sends them together.
- **Subagents you can steer.** Resume a stopped subagent, retry a failed one, read a harness subagent's chat, and see what each one
  changed in the turn's review.
- **Plan mode with a plan card.** An agent proposes a plan you approve, revise, edit or save, and can carry it out in a new worktree chat.
- **A code index for agents.** Volt indexes your open projects in the background, so `grep`, `glob`, `find_symbol` and
  `instant_grep` answer from an index and agents spend less time searching.
- **Several Claude accounts.** Sign in to more than one Claude login and switch by hand, or let Volt move to another account near a limit.
- **Git views.** Branches, Remotes, Tags and Worktrees sit in Source Control beside Commits and Stashes.
- **Faster.** Switching chats is near-instant, chat memory is bounded, and small requests take a shorter loop.

### Added

**Agents and orchestration**
- Plan mode proposes a plan card you approve, revise, edit or save; approve it into a new worktree chat.
- Fork a chat from any turn and merge its changes back. Move a live chat to another worktree from the branch menu or the command palette.
- Multitask agents in the side toolbar, *Start Multitasking*, read-only chats for harness subagents (Claude, Codex, Cursor) and
  Cursor-style subagent rows.
- Resume a Volt subagent that failed, was stopped or was cut off; Retry a harness subagent that failed.
- Per-chat sandbox level and network (macOS Seatbelt, Linux Landlock), blocked writes and hosts shown in the transcript with retry actions.
- Chats park at a usage limit and resume when the provider is back, and survive sleep. A usage-limit chip sits at the top of the chat and a
  countdown shows in the sidebar.
- Durable agents and durable schedules (wall-clock timer, exactly-once slots, retries), self-healing turns, and *keep working*
  rescue for long runs.
- Automations with more triggers, including webhooks (through Volt Relay), GitLab, Jira and Atlassian.
- Volt's orchestrator is available to outside agents as an OAuth MCP server, and agents can run other chats.
- Memory: saved notes in user and project scope, *Remember* on a reply, and import from `CLAUDE.md`, `AGENTS.md` and Claude Code notes.
- Search chats by title instantly and by message content with ranked results; recall past chats and save learned skills.
- Lock files across tool batches so parallel tool calls don't collide.
- Hooks and file-defined subagents for Volt's own agent, and a slash menu for skills, commands, subagents and rules.
- A *Customize* page that finds skills, subagents, rules, hooks, MCP servers and plugins across your agents, with a marketplace
  (including skills.sh) and a preview and source editor.
- Budgeted context handoff when a chat switches models, and warm sessions to switch back to. *Compact first* appears only when a summary would help.
- OpenCode 2 and Pi agents; Grok models; limit detection for their wording.

**Code intelligence**
- A code index built in its own worker process (symbols, trigram regex search, ripgrep fallback), served to the app and the agent server.
- `grep` and `glob` answer from the index, `code_nav` falls back to it when language servers are off, and CLI agents get `instant_grep`
  and `find_symbol`.
- A language server budget across projects, optional RTK for common dev commands, and a *Code Intelligence* settings page.

**Browser, canvas and devices**
- Design mode in the in-app browser: pick elements or draw an area, climb to parents with Up and Down, hold Fn to use the page,
  and annotate with images, videos and files.
- *Batch edits* for annotations in the browser and on the canvas, with a numbered pin per annotation and a *Send* button that lists them.
- A design canvas: a board of live screens for agents, with versioned history, a Designs list, one agent chat per canvas, and a built-in
  UI kit for rendered pages (devices, flows, prototypes).
- Computer use for agents: `browser_run`, act scripts, headless pages, a CDP console, a devtools tool, desktop control and
  playgrounds. Screenshots come with an element list of refs and boxes.
- Devices: live simulator streaming, the Duo viewer, an Android UI reader, device UI tools, and Device Studio 3D frames.
- Screen and mockup galleries, with *Open on Canvas*.

**Git and pull requests**
- Branches, Remotes, Tags and Worktrees views in Source Control. Checkout, merge, rebase, rename, delete, publish, fetch, push tags and
  open or remove worktrees from the views; Commits gain checkout, branch here, tag here and cherry-pick.
- Pull requests on GitLab, Bitbucket, Gitea, Forgejo and Azure DevOps, and sign-in to those hosts.
- Stacked pull request branches with restack and retargeting.
- Automatic pull request review in a hidden review chat, with review markers in the Code diff and findings posted as review comments.
- Settings for the branch prefix, attribution on agent commits and PRs, PR link behaviour, and worktree cleanup limits
  (Volt now trims checkouts under `~/.volt/worktrees` in the background).
- One Cursor-style branch dropdown for every branch picker; the branch menu sits under the changes header.

**Accounts and usage**
- Several Claude logins, switched by hand or near a limit; the account in use reads the same limits as the Usage page.
- Pooled limits across accounts and machines, limit resets, OpenCode Go and Grok usage, custom prices, and a *Session Usage* panel.
- Usage-limit warnings once per window, and billed tokens that include subagents.

**Writing and prediction**
- Live on-device dictation in the composer with a waveform mic button, in the browser's design prompt too.
- A Cursor-style *Tab* settings page: partial accepts, comments, whitespace-only edits and auto imports. Tab and composer ghost text are
  faster and more aware of your codebase.

**Settings and look**
- New pages: *Appearance* (conversations, colors, typography, high contrast, motion), *Git & PRs*, *Worktrees*, *Code Intelligence*,
  *Beta*, and a Cursor-style *Tab* page.
- Tool call density (compact, standard, detailed), code block word wrap and themed diff backgrounds in chats.
- New lightning-bolt app icons for each channel, and the VOLT wordmark in the agent title bar.

**Web, mobile and relay (early)**
- An agent server that runs agents in the background (`volt.agentServer.enabled`), with one-time pairing codes for phones and browsers.
- Volt's workbench in a browser tab, and mobile and web apps on a shared client core, with Live Activities and widgets on iOS.
- Volt Relay: self-hosted cloud tasks and runners, with Auto placement that picks the least loaded machine.
- Volt Govern, an enterprise control plane.

**Releases and updates**
- Stable, Beta and Nightly channels, each its own app that installs next to the others. Volt can offer another channel's app to install
  beside the running one on macOS and Windows.

### Changed

- The chat list is a set of panes like Source Control's: each group (Pinned, Today, Working, Done, Settled, projects, Cloud) folds on its own,
  and open groups share the height.
- Each file edit in a reply is its own card with a peek of its diff. Tools read in words (*Started terminal*) rather than raw MCP names.
- The Tasks, subagents, Context and Session Usage cards open over the chat like a popover instead of pushing it.
- The agent toolbar shrinks to its rail beside open tools instead of hiding.
- Undo All and Keep All appear in the Changes header, and the turns view lists what each subagent changed.
- Claude Code sessions start with Volt's working rules (batch independent tool calls, use the file tools, wait without polling),
  and each subagent gets the same rules.
- Smaller macOS and Linux packages, and a faster build (product compiles with `tsgo`, lint runs in parallel with a content cache).

### Performance

- Instant chat switching with a keyboard-driven agent list, bounded chat memory, and a chat's agent started only after a short dwell.
- Native transcripts stay on disk until a chat runs, a sent prompt is written after the frame that shows it, and switching to the IDE layout no
  longer waits on the folder move.
- A shorter loop for small native requests, and verification in proportion to the task.
- One prewarmed agent at a time, cached ACP adapters launched without `npx`, and CLI probes run once at startup.
- A streaming reply is redrawn in place, code cards get a Monaco editor only when they come on screen, and a hidden refresh spinner no longer
  keeps an idle window drawing.
- Subagents that edit code start editing sooner, and a running subagent no longer shows its parent as stalled.
- Claude's thinking stays valid and compacts from the prompt cache.

### Fixed

- `cursor-agent` can reach Volt's host MCP server again.
- The multi-file diff no longer ends a row short of a file's trailing blank line.
- Claude account switching: a manual switch onto a full account no longer blocks automatic switching, and logins changed outside Volt are noticed.
- A canvas with no project no longer fails every turn with "`cwd` must be an absolute path".
- Inline code in a long run of words no longer takes seconds to classify.
- A stale Git `.lock` file is treated as a locked repository, and Volt offers to remove it.
- The first-run setup opens once per machine, not once per profile, and shows on fresh installs.
- Ollama native tool-call messages and a real context window; oversized host MCP bodies no longer break the client with `EPIPE`.
- Forks leave nothing half-made, merge-back waits for a busy parent, and a model switch-back cancels cleanly.
- The usage scan no longer keeps every transcript's text in memory, and dropped chats' DOM no longer stays alive through their replies.

### Known limitations

- **macOS builds are not signed with an Apple Developer ID or notarized.** macOS asks you to approve the first launch, and Volt cannot
  install updates by itself on macOS; it offers the new download instead. See the [macOS install guide](docs/install/macos.md).
- Windows installers are not code-signed, so SmartScreen shows a warning.
- macOS is the platform Volt is developed and tested on. Windows and Linux builds are produced by CI but have had little testing.
- The agent server, web, mobile, Relay and Govern pieces are early and may change.

## [0.0.1] - 2026-10-06

The first tagged build of Volt, which added the release pipeline with Stable, Beta and Nightly channels. It was never published to
GitHub Releases.

[0.0.2]: https://github.com/LeulAria/volt/releases/tag/v0.0.2
[0.0.1]: https://github.com/LeulAria/volt/commit/7cc39172
