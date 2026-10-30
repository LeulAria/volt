# Changelog

All notable changes to Volt are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Volt uses [semantic versioning](https://semver.org/)
while it is below 1.0: expect the minor version to carry breaking changes.

Volt is built on VS Code (Code - OSS 1.105). Changes to that base come from upstream and are not listed here.
Download a build from [Releases](https://github.com/LeulAria/volt/releases). From 0.0.4, Mac builds are signed with an Apple
Developer ID and notarized.

## [0.0.4] - 2026-10-30

Signed on Mac, lighter, and agents that prove they are done. Volt for Mac is now signed with an Apple Developer ID and
notarized, so it opens like any other app and updates itself. This release also brings Agent Resources, Claude's plugin
marketplace, a Git Graph, commit review and proof of done.

### Highlights

- **Signed, notarized and self-updating on Mac.** No Open Anyway step. Updates download in the background and install with
  Restart to Update.
- **Lighter and faster to start.** Agents, the Tab predictor and the code index start when first used instead of at launch.
- **Agent Resources.** One page for every agent's instructions, skills, MCP servers and Volt's own harness settings.
- **Proof of done.** An agent's "done" is checked against what ran after its last edit, with a receipt under the answer.
- **Git Graph** with agent attribution, and inline blame on by default.

### Added

**Agents**
- Proof of done: each native run gets a short contract from its request (your criteria, the project's own check, the change
  itself). Substantial runs that finish with a gap go back with the command that closes it (`volt.agent.evidenceGate`), an
  optional second opinion settles what nothing could run (`volt.agent.proofReview`), and a receipt card shows each item on
  desktop, web and mobile.
- Commit review: the agent splits changes into Conventional Commits with `propose_commits`. Check, rename or regenerate each
  one and open its diff before Commit, Commit & Push, or Commit, Push & PR. Placeholder worktree branches get a real name
  first (`rename_branch`).
- Send a queued message to a new chat: it starts in the same project, checkout, model and mode with a condensed handoff of
  this conversation, and a "Continued from" pill links back.
- Trajectory panel next to the Terminal: each model request of a native run on a waterfall, with what was sent and returned,
  usage, cache hits, time to first token and why a prompt-cache prefix broke.
- Vercel fx as an agent provider (Early Access), with its own tab in the model picker.
- Agents can run outside the main window.

**Agent Resources**
- An Agent Resources page and side toolbar section for instructions, skills, MCP servers and plugins across every scope and
  harness, found by what they are and where they live. Also under Manage.
- Harness control center for Volt's own agent settings.
- Claude's official plugin marketplace, built in.

**Git**
- Git Graph tab (Ctrl+Option+G): VS Code's graph in a table with branch, message, agent, changes, author, date and SHA;
  filters, search (`author:`, `path:`, `after:`, `before:`), and an activity strip you can drag to pick a date range.
- Agent logos from `Co-authored-by` trailers in the graph and blame. Inline blame is on by default.
- Pull requests view: search ranked by match as you type, a sort menu and keyboard navigation.
- Find Issues in the Changes header, and exact edit counts.

**Workbench**
- Settings lists VS Code's own settings categories beside Volt's pages, and Appearance lists installed themes.
- The title bar shows an available update: Downloading over a progress line, then Restart to Update.
- Ctrl+Option+1 to 4 open Explorer, Source Control, Pull Requests and Search in the files sidebar.
- Drag a chat into Settled, Working, Pinned or Snoozed in the sidebar. Open in New Window shows only that chat's project.

### Changed

- Mac builds are signed with an Apple Developer ID and notarized, and install updates by themselves.
- Agents, the Tab and dictation predictor, the code index, the usage scan and the spare window start when first needed. The
  file watcher runs in the shared process and window transparency is opt-in, so Volt runs far fewer processes and uses much
  less memory and CPU at startup and idle.
- Light, Midnight and Abyss themes polished, with theme dropdowns in Appearance.
- The dot loader draws crisp 2px dots and animates by brightness only.
- The website and docs drop the step-by-step Mac install guide.

### Fixed

- Two agent server crashes.
- A message sent into a running turn carries its pictures to the agent.
- Editing a prompt while its reply streams no longer stops scrolling; annotation chips scroll to their element.
- Checking out a branch a chat worktree holds moves that worktree to its own branch.
- Model picker compare toggle, Providers scrollbar and question-card input.
- Scratch copy and paste, steered image chips, and page picks that stay in their chat.

### Known limitations

- Volt 0.0.3 and older were not signed, so they cannot install 0.0.4 by themselves: they offer the download. Replace the app
  once; settings and chats stay.
- Windows installers are not code-signed yet.

## [0.0.3] - 2026-10-25

Scratch, subagent budgets and a calmer right panel. This release brings Scratch, a whiteboard that agents draw on; budgets
and handoff contracts for subagents; agents that keep out of a browser tab you are using; windows with their own chats; and
the web and mobile apps catching up with the desktop.

### Highlights

- **Scratch, a whiteboard for you and your agents.** Sketch, write and diagram on an infinite board, then ask an agent about
  what you selected. The agent draws its answer back as a diagram beside your drawing, and its chat opens in a dock at the
  bottom of the board.
- **Subagents with budgets and contracts.** Each delegated task carries a goal, constraints, the files it owns and when it is
  done. A request has a spending cap, tasks can wait for each other, and a task can fall back to another model.
- **Agents keep out of your browser tab.** If you are typing, commenting or designing in a tab, an agent opens its own
  *Agent* tab beside it instead of taking yours over.
- **A New Window with its own chats.** A second window lists only the chats and projects started in it and hands them back
  to the main window when it closes.
- **Web and mobile catch up.** The mobile app is laid out like the GitHub app, with source control and pull requests, and the
  workbench in a browser fits phones, tablets and touch screens.

### Added

**Scratch**
- A full-page whiteboard opened from the notebook icon before New Chat: shapes, arrows, freehand, text, sticky notes, images,
  frames and a shape library, in a hand-drawn style with a board theme that follows light or dark.
- Diagrams from Mermaid, with elbow connectors that route around each other and swimlanes for subgraphs.
- *Ask Agent* on a selection (or Cmd+Enter). Agents read the board and draw back into a titled frame with `scratch_read` and
  `scratch_draw`, and a dashed outline with a chip marks each run. Drag a chip to move the whole diagram; click it to open the
  run's chat in the dock.
- Each run is its own chat thread, and every chat from one board shares one project.
- The agent dock opens with only the text box. *Worked for…* shows the transcript, *Collapse to Chip* folds it away, and a
  press on the board closes the dock.
- Comments on the board, numbered pins sent together, as on the design canvas.
- Hovering a shape greys out everything not connected to it, toggled from the toolbar.
- One properties row for colours, stroke, arrows, text, opacity and arrange.
- Boards save on their own across windows, with snapshots every ten minutes and a 30-day trash.
- A *Canvas & Scratch* settings page.

**Agents and chats**
- Subagent handoff contracts (goal, constraints, files, done when) with fixed report headings, a summary of the parent's
  context, `after` dependencies, `fallback_models`, `model: "auto"`, and a spending budget per request
  (`volt.agent.multitask.budgetUsd`, `budgetTokens`).
- *Start Multitasking* is a toggle: tick which queued messages start as parallel agents.
- Copy a prompt with its chips (images and files included) and paste it into any composer.
- *Next Agent Tab* and *Previous Agent Tab* commands, `@` mentions for Scratch boards and design canvases, and a row in the
  chat toolbar that opens the chat's board.
- Links in replies lead with their site's logo, and the composer styles inline markdown as you type.
- The model button's hover card shows the picked effort, speed and context.
- Retries show in the live status line (*Reconnecting to Claude, attempt 3 of 10*) instead of stacking rows.

**Right panel**
- Opening the right panel with no tabs lists what can open there (File, Terminal, Browser, Device, Changes, Scratch, Canvas,
  Automations, New Side Chat) with their shortcuts, instead of opening a browser. Each opens as a tab; File opens the Explorer.
  The empty panel is see-through like the chat, and closing its last tab leaves it open on that list. With the files
  sidebar open, *Open Right Panel* brings the panel back beside it.
- In the agent layout, ⌃⌥ and the first letter opens each of them in the right panel: ⌃⌥F File, ⌃⌥T Terminal, ⌃⌥B Browser,
  ⌃⌥D Device, ⌃⌥C Changes, ⌃⌥S Scratch, ⌃⌥V Canvas, ⌃⌥A Automations, ⌃⌥N New Side Chat (Ctrl+Alt+Shift on Windows and Linux).
- Automations can open as a right-panel tab, from that list or the + menu.

**Browser and canvas**
- An agent that finds you busy in a tab works in its own *Agent · …* tab underneath, with a notice to view it, and a *Refresh*
  when it changed the app.
- A browser floating over the chat lays pages out at desktop width and scales them down, so sites show their desktop layout.
- The design canvas gets a shared comment composer and more room.

**Usage and accounts**
- The Usage page lists every saved Claude account's limits, then the other accounts whose limits Volt read (Codex, Cursor…).
- A limits card on the Usage button, with account names blurred until you reveal them.

**Windows, home and look**
- A New Window keeps its own chats, projects and layout until it closes.
- A simpler Open Workspace menu: recents, folders, New project, On This Mac and Git Repo.
- A Volt About sheet in place of the stock dialog, and a laptop icon for *This Mac*.
- The empty editor's watermark and the small app mark are the app icon's folded bolt on its own, in grey, without the
  square around it. The right panel's list and + menu draw every icon in the same line style.
- Text is smoothed by default (*Font Smoothing: antialiased*).
- The setup wizard can be skipped from any step.
- Marks in the image viewer can be moved and resized.
- The iPhone Duo's hinge folds while it streams live.

**Web, mobile and the agent server**
- Mobile: Home, Inbox, Projects and You tabs; project pages; source control with Commit, Pull and Push; pull requests with
  checks, Merge and comments; dictation, attachments, `@` and `/` pickers, chat tabs and subagents in the chat screen.
- Web: the browser workbench fits phones, tablets and touch screens, and dictates with the browser's speech recognition.
- The agent server serves git, pull requests and the `/` menu to the web and mobile apps, which now use Volt's app icon.

### Changed

- Source Control shows only the chat's own repository, not the parent checkout, nested repositories or other worktrees.
- MCP tools read in words in the transcript, whatever name the agent gives them.
- The install script (`install.sh`) exists and works on macOS and Linux, checking each download's SHA-256.

### Fixed

- The agent server starts again: no browser-only imports, and hooks and folder trust are registered. It never trusts a folder,
  so a repository's own hooks never run unattended, and its timed jobs run without a window.
- Stopping terminals show the row's loader.
- The title bar reads the computer's name in a way that also works in the web build.

### Known limitations

- macOS builds are still not signed with an Apple Developer ID or notarized, and Windows installers are not code-signed. See
  the [install guide](docs/install/README.md).
- Windows and Linux builds have had little testing. Scratch, the web and mobile apps and the agent server are new and may change.

## [0.0.2] - 2026-10-18

The first build you can download from GitHub Releases for macOS, Windows and Linux. It brings multi-agent work
(subagents, plan mode, forks, worktrees, sandboxes), a code index that agents search, an in-app browser with a design
mode, Git views for branches and worktrees, several Claude accounts, and a good deal of speed work.

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
  install updates by itself on macOS; it offers the new download instead. See the [install guide](docs/install/README.md).
- Windows installers are not code-signed, so SmartScreen shows a warning.
- macOS is the platform Volt is developed and tested on. Windows and Linux builds are produced by CI but have had little testing.
- The agent server, web, mobile, Relay and Govern pieces are early and may change.

## [0.0.1] - 2026-10-06

The first tagged build of Volt, which added the release pipeline with Stable, Beta and Nightly channels. It was never published to
GitHub Releases.

[0.0.3]: https://github.com/LeulAria/volt/releases/tag/v0.0.3
[0.0.2]: https://github.com/LeulAria/volt/releases/tag/v0.0.2
[0.0.1]: https://github.com/LeulAria/volt/commit/7cc39172
