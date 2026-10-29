# volt-web

Volt in the browser: follow, steer and approve the agents running on your computer. The Volt agent
server serves the built app (`out-volt-web` at the repository root) on the same port as its
WebSocket, so the page is always same-origin with the server it talks to.

```sh
npm install
npm run build        # → ../../out-volt-web (packaged builds include it)
npm run typecheck
VOLT_SERVER=http://127.0.0.1:<port> npm run dev   # proxies the server's routes for development
```

Signing in (then, on a computer, on to Volt's workbench; see below):

- On the computer Volt runs on, the page signs itself in over loopback (`POST /api/auth/local`).
  In Volt, run **Volt: Open Volt in the Browser**.
- From another device, open the pairing link or enter the code from **Settings › Devices** (or
  **Volt: Pair a Phone or Browser…** in Volt). The code is spent once for a device token.

## Volt's workbench (VS Code in the browser)

A signed-in page moves on to `/code/`: Volt's own workbench, the desktop's UI running in the tab,
the way code-server serves VS Code. The agent server runs VS Code's server inside itself
(`src/vs/server/node/voltAgent/serverWorkbench.ts`):
the remote extension host with the desktop's extensions, terminals, files, search and git on this
computer. It starts with the first page load. The agent UI is the desktop's with the agent server
on, opening in the Agent layout with the desktop's settings (theme, fonts, editor) as defaults.

- **Signing in**: this app signs the browser in as before, then `POST /api/workbench/session` (with
  the device token) sets an http-only cookie the server checks on every workbench request and
  socket, so removing a device locks it out at once. `/code/` without it comes back here first.
- **Files**: `file:` paths are the computer's, as on the desktop (`voltServerDiskFileSystemProvider.ts`).
- **Looks like the desktop**: the agent window paints solid, as the desktop does in full screen
  (a tab has no macOS material behind it), with no room kept for traffic lights; the page and the
  browser's bar take the theme's colours (`contrib/voltAgent/browser/web/media/voltWorkbenchWeb.css`).
- **Any width**: the agent layout's own responsive rules apply (the agents list becomes a drawer
  when the chat would be too narrow; a phone is about the desktop's smallest window). Touch screens
  keep hover-only buttons visible, and the on-screen keyboard resizes the layout (iOS through the
  visual viewport, Android through `interactive-widget=resizes-content`).
- **Desktop only**: Lid-Closed Mode, dictation, the in-app browser, Claude account sign-in, the
  relay and connecting other agents say so when used. A few shortcuts the browser keeps for itself
  (⌘L, ⌘N, ⌘W, ⌘T) reach the browser, not Volt.
- **The lightweight app** stays the fallback (a build without the workbench) and the Devices page;
  `/?lite=1` keeps it (`/?lite=0` goes back) and **Volt: Open the Lightweight Web App** opens it.

## The lightweight app

On a wide window the lightweight app is laid out like Volt on the desktop: a title bar with the
command center, an activity bar (Chats, Explorer, Search, Source Control), editor tabs, the agent panel on
the right and a status bar. Narrow windows and phones get one pane at a time.

- **Chats** open as editor tabs; the agent panel keeps one beside the files you're editing
  (`⌘L`, or `⌘L` in the editor to send the selected lines). Sent prompts can be edited and resent,
  rewound, or their checkpoint restored (and redone); replies can be retried. Images attach by
  paste, drop or the paperclip (downscaled to 2048px); `@` completes project files.
- **Editor**: Monaco (VS Code's editor) with the desktop's Volt Dark and Light themes, loaded only
  when a file opens. Files save through the agent server (`⌘S`; a file changed on disk since it
  was read asks before overwriting) and follow the agent's edits while unchanged here.
- **Explorer** (Seti icons, git colours, create, rename, delete, drag into the composer),
  **Search** (ripgrep on the computer), **Source Control** (changes, diffs against HEAD, commit,
  and what the chat's agent changed), **Review changes** for a whole chat, and the diff editor.
- **Quick input**: `⌘P` files, `⇧⌘P` commands, `#` chats, `:` line.
- **The chat reads like the desktop's**: `src/styles/transcript.css` ports agentTranscript.css (work
  rows, edit cards, `$` command cards, subagents, compaction, "Worked for", the turn's files), and
  plans waiting for approval offer Build / Keep planning. The header's terminal button opens the
  chat's terminals with their live output.

Files are read and written through the server's `files.*` methods
(`src/vs/server/node/voltAgent/serverFiles.ts`), limited to Volt's projects and chat worktrees.

Everything protocol-related (connection, pairing, state, markdown, diffs) lives in
`../client-core`, shared with the phone app.
