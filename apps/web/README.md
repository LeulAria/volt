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

Signing in:

- On the computer Volt runs on, the page signs itself in over loopback (`POST /api/auth/local`).
  In Volt, run **Volt: Open Volt in the Browser**.
- From another device, open the pairing link or enter the code from **Settings › Devices** (or
  **Volt: Pair a Phone or Browser…** in Volt). The code is spent once for a device token.

## The IDE

On a wide window the app is laid out like Volt on the desktop: a title bar with the command
center, an activity bar (Chats, Explorer, Search, Source Control), editor tabs, the agent panel on
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

Files are read and written through the server's `files.*` methods
(`src/vs/server/node/voltAgent/serverFiles.ts`), limited to Volt's projects and chat worktrees.

Everything protocol-related (connection, pairing, state, markdown, diffs) lives in
`../client-core`, shared with the phone app.
