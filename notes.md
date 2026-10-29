# Volt Roadmap: Feature Ideas

Collected 2026-10-27 from:
- **Synara**: [PRs](https://github.com/Emanuele-web04/synara/pulls)
- **T3 Code**: [repo](https://github.com/pingdotgg/t3code)
- **pi**: [repo](https://github.com/earendil-works/pi)
- **Cursor**: [docs](https://cursor.com/docs) and changelog

This list leaves out features Volt already has (see the last section). Tags: **[S]** Synara · **[T3]** T3 Code · **[pi]** pi · **[C]** Cursor.

Priority:
- **P1**: high value, fits what Volt already has
- **P2**: valuable, more work
- **P3**: bigger bets

---

## 1. Attention & Inbox

### P1: Priority inbox + "next chat that needs me" shortcut [S] [T3]
A sidebar list that ranks chats by how much they need you, plus one key to jump to the next one.
- Tiers: **Waiting on you** (approval, question, plan ready) → **Unseen finished/failed** → **Running**.
- Rows stay in place while statuses change; "Clear read" tidies the list.
- ⌥⌘A jumps to the next chat that needs attention (Codex uses the same chord).
- T3 variant: a collapsed **Working** section. A chat comes back to the top when it finishes, fails or needs input.
- Sources: Synara #1929, T3 #13926 / #25190

### P1: Snooze, Done-with-undo, draft preview [S]
Small things for managing many chats.
- Snooze ⌥⇧⌘S, Archive ⌥⇧⌘A, Mark unread ⌥⇧⌘U.
- Marking a chat Done shows an 8 s **Undo** toast.
- Hovering a chat that has an unsent draft shows the first ~280 characters of it.
- In the collapsed rail, chats show as provider icons with working/unread counts.
- Sources: Synara #1579, #1567, #1582, #1588

### P1: Live "latest thought" row [T3]
While the agent works, show the first sentence of its latest reasoning as a gray row above the running tool, so it doesn't flash past.
- The client builds it from data it already has; no server change.
- Source: T3 #16284

---

## 2. Search & Context

### P1: Full-text search over all chats [S] [T3] [C]
Cmd+K searches the text of every message, not just titles or the chats that are loaded.
- Server-side SQLite FTS5 trigram index. Every word must match; each result shows an excerpt and the hit count.
- Ranking: title or thread matches first, then message hits. Late results never move the rows above them.
- Each row says why it matched ("Branch: …", "PR: #…").
- Cmd+F inside a chat, with a match counter.
- Sources: Synara #1612, T3 #24343, Cursor Conversation Search (v3.11)

### P1: Context chips for threads, citations, PRs [T3] [S]
Attach things to the composer as chips.
- **Thread chip**: `@` a chat or drag it in. The agent reads it with a thread-read tool.
- **Citation chip**: select text in a reply → "Cite in composer" + an optional comment. Clicking the chip scrolls back to the source.
- Several selections stack into an "N selections" chip, and each can be removed on its own.
- **PR chip**: drag a linked PR into the composer.
- Sources: T3 #12296, #9146, #20102; Synara #1688

### P2: Portable handoff on model/provider switch [T3] [pi]
Switching providers mid-chat carries over a budgeted slice of the real history instead of starting from zero.
- Default budget is 16k tokens. It favours recent turns and the original request; omitted history is referenced so the agent can fetch it.
- A "Context handoff pending" row appears as soon as you pick the new model.
- pi's rule: drop the old model's thinking blocks (their signatures don't carry over) but keep text and tool calls.
- Sources: T3 portable-handoffs.md, #18369; pi `packages/ai` cross-provider handoffs

---

## 3. Conversation Control

### P1: Rewind but keep the file changes [T3] [pi]
Rewinding gets a second option: **"Revert chat, keep files"** next to **"Revert files too"**.
- Later history is removed and the old prompt comes back for editing; files and staging stay as they are.
- pi variant: a **git checkpoint** each turn (`git stash create`). On fork it asks "Restore code state?".
- Sources: T3 #11358; pi `examples/extensions/git-checkpoint.ts`

### P2: Session tree with branch summaries [pi]
Each chat is a tree, not a line. Going back starts a branch; nothing is deleted.
- A `/tree` navigator. Picking an earlier message puts its text back in the editor to edit and resend.
- When you leave a branch, the agent offers a short summary of the abandoned work and attaches it to the branch you enter.
- Bookmarks/labels on entries.
- Source: pi docs/sessions.md, compaction.md

### P2: Steering vs follow-up queue [pi] [T3]
Two clear kinds of queued message.
- **Enter = steer**: delivered after the current tool step and guides the next response.
- **Alt+Enter = follow-up**: waits until the whole task is done.
- Aborting returns queued messages to the editor.
- T3: sending while an approval is pending declines it and steers the message in.
- Sources: pi how-pi-works.md; T3 #21503, #24718

### P2: Native `/goal` with a status row [T3] [S] [C]
A goal that persists across turns, with its status shown in the composer.
- Uses Claude's and Codex's own goal commands where they exist.
- The composer shows a goal row: objective, status, tokens used, **Resume** / **Clear**.
- `/goal …` is sent as a visible user message with a chip, never as a hidden turn.
- Sources: T3 #15592, Synara #1997, Cursor changelog (Aug 19)

### P2: Context edits that don't delete history [pi]
Hide or replace one earlier message (for example a huge tool dump) in what the model sees, while the transcript keeps the original.
- Edits belong to a branch: going back to before the edit brings the original back.
- Overflow recovery uses it to drop a failed attempt before retrying.
- Source: pi docs/session-format.md (ContextEditEntry)

---

## 4. Cost & Cache

### P1: Compact idle Claude chats before the cache expires [T3] [pi]
Large idle chats get compacted just before the prompt cache expires, so coming back is cheap.
- The trigger is about 2 minutes before the TTL Claude reports (1h on subscriptions, 5m on API keys).
- It applies only to chats above ~200k tokens. Archived, snoozed and subagent chats are skipped, as are chats with pending work.
- Modes: *When you return* / *Before cache expires* / *Never*.
- pi variant: **cache warming**. It pings only when the avoided miss cost is estimated at $0.05 or more, records that ping's cost, and notices large cache misses.
- Sources: T3 #21682, #23037; pi docs/settings.md

### P1: Usage-limited chats: snooze until reset, auto-resume [T3]
A chat that hits a provider limit shows as **Limited**.
- "Snooze until reset" and "Resume at reset" are scheduled on the server, so they survive restarts and run with no client connected.
- A newer message, archiving or a provider change cancels the scheduled resume.
- Fits Volt's usage runway and Claude account switching.
- Source: T3 #12677, #12686, #12687

### P3: Virtual "router" models [pi] [C]
One picker entry that picks the real model and thinking level for each request.
- Example: plan on a strong model, then do the work on a cheap one.
- Keeps the same model for continuations so the cache isn't lost.
- The footer shows the route (`auto • high → model • medium`), and the cost breakdown is per real model.
- Cursor Router offers the same as Cost / Balance / Intelligence modes.
- Sources: pi docs/virtual-models.md; Cursor Router (Jul 22)

---

## 5. Agent Modes

### P1: Debug Mode [C]
Fix bugs from runtime evidence, not guesses.
- Steps: form hypotheses → add logs that report to a local debug server → the user reproduces the bug → the agent reads the logs and fixes → it re-verifies and removes the logging.
- Volt's in-app browser and terminals already provide the log capture.
- Source: cursor.com/docs/agent/debug-mode

### P1: Design Mode [C]
Point at the running app's UI to direct edits.
- Click, Shift-drag a box, multi-select, draw or talk.
- The agent gets the xpath, component, computed styles, React props and a frozen screenshot.
- You can queue several edits; hot reload shows them.
- This builds on Volt's browser comments and pins.
- Source: cursor.com/docs/agent/design-mode

### P2: Agent Review (local pre-PR review) [C]
Review the local changes against repo rules and a `REVIEW.md`/`BUGBOT.md`.
- Triggers: after a commit, `/review`, or a button in Source Control.
- Depths: **Quick** or **Deep**.
- Source: cursor.com/docs/agent/agent-review

### P2: Guided PR review tours [T3]
A read-only agent writes a "tour" of a PR: stops in reading order, each with line-anchored excerpts and notes.
- A **Look closely** callout appears only where a reviewer has a decision to make.
- Every changed file must land in some stop.
- Tours are stored per PR and marked stale after a push.
- Source: T3 #18124, #18143

### P2: PR size split [T3]
Hovering `+N −N` breaks a PR into Code / Tests / Mocks / Generated by path conventions.
- Fetched lazily on first hover.
- Source: T3 #22189, #22255

### P1: Auto-link PRs created in the shell [T3]
If an agent's `gh pr create` / `glab mr create` prints a PR URL, link that PR to the chat automatically.
- A PR the user unlinked is never relinked.
- Source: T3 #24813

---

## 6. Orchestration

### P2: Hubs / Projects: a coordinator with worker chats [S] [C]
A long-running workspace: you talk to one coordinator, and it hands work to parallel worker chats.
- All workers share instructions, memory and a **Library** of output files.
- Library search runs on the server and returns paths only; only a small top-level index goes into the context.
- Each task has a stable key, so a retry after a crash reuses the same workers.
- Memory notes are editable, and each shows where it came from: *human-instruction* or *agent-conclusion*.
- Cursor Projects add **subscriptions** to Slack, PRs, CI or schedules, so the coordinator acts without being prompted.
- Sources: Synara #1833, #1967, #1970; Cursor Projects (Sep 10)

### P2: Webhook-triggered automations [T3] [C]
Add a **webhook** trigger to Volt's automations, alongside cron.
- Each automation gets a URL `/hooks/:id/:token` with optional HMAC checking (covers GitHub signing). Rate limit and body cap.
- Prompt templates: `{{body.a.b}}`, `{{headers.x}}`, `{{query.x}}`. Simple event filters (`equals`, `in`, `startsWith`, `exists`).
- Replay dedupe and a delivery log of the last 50 requests.
- Cursor's event list for reference: GitHub PR/push/CI, Slack emoji, Linear, Sentry, PagerDuty.
- Sources: T3 #15085, #22194; cursor.com/docs/cloud-agent/automations

### P2: Agents can add to the user's to-do list [S]
Tools to create, list and update the user's own Inbox/Tasks items (separate from the agent's Tasks card).
- Ids come from the chat and a request id, so a retried create doesn't duplicate.
- Agents can't delete to-dos.
- Source: Synara #1774

### P3: Crash-safe runs (durable) [pi]
Save each turn and tool call before showing it, and resume unfinished work after a crash.
- A request id stops a retried submission from being sent twice.
- A task that crashes 5 times is parked and can be retried later.
- Subagents belong to the tool call that started them: aborting the parent aborts the child.
- Source: pi packages/durable

---

## 7. Tools & Extensibility

### P1: `request_secret`: private credential card [T3]
When the agent needs an API key, it asks on a private card instead of in chat.
- The agent gets back a one-use `secretRef`, never the value. The ref only works in that project and expires after 24h.
- The chat shows "needs input" while the card is open.
- Source: T3 #15907, #24809

### P2: Connectors: hosted MCP servers with OAuth [S] [C]
Settings → Connectors with one-click presets (Supabase, Vercel, Linear, Notion…), a custom URL, or your own OAuth app.
- Volt holds the tokens and proxies the servers per session, so providers never see vendor tokens.
- Connectors can be `@`-mentioned; tool rows show the vendor icon.
- Sources: Synara #1921, #2002; cursor.com/docs/mcp

### P2: Tool exposure levels + tool search [pi]
Choose per tool (with globs) how the model reaches it: `direct` / `deferred` (hidden until a tool search finds it) / `hidden`.
- Keeps big MCP servers from flooding the context.
- Volt's own MCP server has 150+ tools, so this matters here.
- Source: pi docs/extensions.md "Tool exposure", docs/mcp.md

### P3: Codemode [pi]
The model writes a short JS script in a sandbox that calls tools in parallel and filters the results. Only the script's output reaches the model.
- Saves many tool round trips; Volt's subagent slowness comes from serial Bash calls.
- Source: pi docs/codemode.md

### P2: Hooks parity [C]
Expose Cursor-style hooks across all providers, not just Claude.
- Events: `beforeSubmitPrompt`, `preToolUse` (can rewrite or block), `afterFileEdit`, `stop` (with a `followup_message` to keep going, loop limit 5), `preCompact`.
- Levels: project, user and team. When they disagree, deny wins.
- Source: cursor.com/docs/hooks

### P2: Plugins / marketplace [C]
Bundle rules, skills, subagents, commands, MCP servers and hooks into one installable plugin.
- Team marketplace with Default Off / Default On / Required install policies.
- Source: cursor.com/docs/plugins

---

## 8. Sharing & Links

### P2: Prompt links [T3]
A URL that opens Volt with a draft ready and never runs anything on its own: `volt://new?prompt=…&repo=…&model=…&pr=…`.
- `pr=` opens or drafts on that PR's branch in a worktree, after you confirm.
- Invisible characters are stripped with a "may be malicious" warning.
- Source: T3 docs/user/prompt-links.md

### P3: Guest links [T3] [C]
Share one live chat with a guest who has no account; every message they send waits until you approve it.
- Guests see messages, plans and command output, but not diffs. The link works in one browser and expires after 24h.
- Cursor variant: **Shared Transcripts** (read-only link + "Fork to Cursor", with best-effort secret redaction).
- Sources: T3 #24104; Cursor shared transcripts

---

## 9. Worktrees & Environment

### P1: `.worktreelink` for shared heavy folders [S]
A file listing gitignored paths that new worktrees **symlink** to instead of copying, for example a 5 GB toolchain or `node_modules` caches.
- Removing a worktree unlinks first, so the link target survives.
- Source: Synara #1837

### P1: Reclaim disk from old worktrees [S] [T3] [C]
Free up worktree disk space automatically.
- Delete gitignored build output in archived worktrees. Synara's case: 22 GB across 9 worktrees, 9.8 GB of it one build folder.
- Optional: remove clean worktrees whose branch is merged at the exact head, after taking a snapshot.
- `runOnSettle` project action (for example `cargo clean`) when a chat settles.
- Cursor defaults: cleanup every 6h, max 25 worktrees.
- Sources: Synara #1838, #1810; T3 #16290, #15208

### P2: Multi-folder projects [S]
One project with a **Primary** folder plus extra folders.
- The extra folders are passed to Claude as `additionalDirectories` and to Codex as `writableRoots`.
- Source: Synara #1595

### P2: "Stop agent process" (keep chat resumable) [S]
Free memory from an idle agent process while the conversation stays resumable.
- Source: Synara #1757

### P3: Run Modes + sandbox [C]
- **Auto-review**: an LLM classifier reviews risky calls.
- **Allowlist**: only allowlisted actions run without asking.
- **Run everything**: no checks.
- The shell sandbox limits writes to the workspace, protects `.git`, and blocks network by default.
- Source: cursor.com/docs/agent/security/run-modes

---

## 10. Browser

### P2: Import sign-ins and passkeys [S] [T3]
- Import cookies/sessions from Chrome, Arc, Safari, Firefox and Zen.
- Use passkeys, including from a phone via QR code.
- "Clear data for <host>" / "All browsing data", keeping saved passwords.
- Sources: Synara #1830, #1938, #1675; T3 #16952

### P2: Volt as the default macOS browser [T3]
Links from other apps open in Volt's browser, or start a project-free chat with the browser maximized.
- Source: T3 #17587

### P2: Images in browser comments [S]
Paste or drop an image into a page comment. The prompt says which image belongs to which comment.
- Source: Synara #1683

### P3: SnapShot capture [T3]
A global shortcut (both Shift keys) captures the window in front, with its accessibility tree, into the draft.
- Source: T3 docs/user/snap-shot.md

---

## 11. Remote / Bigger Bets

### P3: Remote Control: phone drives local agents [C] [T3]
Start and steer desktop agents from the phone or web, with push notifications and Live Activities.
- Volt already has a server, web and mobile clients. What's missing is the tunnel (T3 Connect) and a "keep awake while remote" setting.
- Sources: Cursor Remote Control (Oct 6); T3 Connect

### P3: Outside agents over MCP + `volt thread` CLI [T3] [S]
Expose Volt chats through MCP with OAuth and access levels, so Claude Code, Codex or scripts can start, send to and read chats.
- `volt thread start|send|show --wait`, with exit codes for reply, failure and "waiting for answer".
- Sources: T3 #16336, #22732; Synara #1734

### P3: Rollouts / post-merge watch [C]
After deploy, check telemetry (deploy, 20m, 1h, 1d, 3d). On a regression, name the suspect PR and notify its author.
- Source: cursor.com/docs/rollouts (Sep 23)

---

## Already in Volt (skipped)
- Run groups (Best-of-N)
- Orchestrator and subagent capsule
- Tasks card
- Side chats
- PR links and watch
- Stacked branches
- Agent's own browser tab
- Browser comments
- Visuals: charts, html, canvas
- Scratch board
- Lid-closed awake
- Compaction meter
- Session and project usage
- Claude accounts and auto switch
- Tab prediction
- Dictation
- Git Graph and blame
- Web and mobile clients
- Window scopes
- Automations (cron)
- `ask_question`, `propose_plan`
- Memory and skills tools

Some may still be worth matching to the other apps' versions. Examples: Synara's subagent dock pane, with live tokens and last tool per agent; and Synara's answered-question bubbles (#1589) that stay in the transcript.
