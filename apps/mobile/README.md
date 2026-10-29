# volt-mobile

Volt for iPhone, iPad and Android (Expo SDK 57, expo-router). Pair it with Volt on your computer
and follow every chat live, answer questions, approve commands, queue or steer prompts, stop runs
and start new chats in any project, from anywhere on your network or Tailscale.

```sh
npm install                 # also installs ../mobile-widgets' build dependency
npx expo start              # Expo Go works for everything but Live Activities
npx expo run:ios            # a dev build: adds the Live Activity / widget extension
npm run typecheck
```

## Pairing

1. In Volt on the computer, run **Volt: Pair a Phone or Browser…** (Command Palette). It turns on
   the agent server and network access if needed and opens **Settings › Devices**, which shows a
   QR code and a one-time code (10 minutes, one device).
2. In the app, scan the QR (or type the address and code).
3. The app checks the address with `GET /.well-known/volt/environment`, trades the code for its
   own device token (`POST /api/auth/pair`, kept in the keychain / keystore) and connects to `/ws`.

Each saved computer keeps every address it was paired over (LAN, Tailscale); the app probes them
all and uses the best one that answers with the same environment id, so a token is never sent to
a different machine. Devices can be removed from either side; a removed device is disconnected at
once.

## What it does

Laid out like the GitHub app, in Volt's themes: four tabs.

- **Home**: My work (Needs you, Working, Unread, Pinned, All chats, Archived), your projects
  and recent chats. **Inbox**: chats that need you, finished unread, failed or are working, with
  filters and Mark all read. **Projects**: every project; a project page shows its branch, chats,
  source control, pull requests, files and README. **You**: the computer, then settings.
- **Source control**: a project's uncommitted changes with diffs against HEAD, Commit, Pull, Push
  and a new branch. **Pull requests**: the branch's pull request (checks, Ready), every open or
  closed one, and a pull request's conversation, checks and files, with Merge (squash, merge,
  rebase), Ready for review, comments and re-running failed checks. Opening one for the branch
  pushes it first. All of it goes through `gh` and git on the computer.
- **Theme**: System, or any of the desktop's Volt themes (Dark, Dark Midnight, Dark High
  Contrast, Light, Light Colorblind). **MCP servers**: yours and a project's, with their state.
- Every chat live, with approvals, questions, the queue, usage-limit pauses and subagents.
- **The transcript is the desktop's** (client-core `rows.ts`, `src/chat/Rows.tsx`): work folds into
  22px group lines ("Explored 3 files, 2 searches") whose live verbs shimmer, each edit is a card
  over a fading peek of its diff, commands are `$` cards in the shell colours, subagents and
  compaction get rows, a finished turn folds its work behind "Worked for 3m 3s" (open for turns
  you watched run), and a card lists the files the turn changed. Replies are 14/22 in the light
  face, code is Geist Mono, a long prompt shows two lines and Read more, the running prompt holds
  Stop. While a reply streams, only the row that grew re-renders.
- **Plans**: a plan waiting for approval reads as the plan, with **Build** (back to Agent mode)
  and **Keep planning**.
- **Terminals**: the chat's dev servers, tests and background commands (header button while it has
  any), with live output, Stop, Restart, Copy and their URLs. Typing into one stays with Volt on
  the computer.
- New chats in any project (the **New chat** button), with mode, model and access.
- Images: **+** in the composer picks photos or takes one; they are downscaled to 2048 px JPEG,
  uploaded to Volt's attachment store and sent to the model like images pasted on the desktop.
- Sent messages (long-press, or **…**): **Edit** (the composer switches to edit mode; sending
  replaces the message and everything after it, optionally reverting files), **Retry**, **Copy**,
  **Rewind to here** and **Restore checkpoint** (with **Redo checkpoint** until the next send).
- **Changes**: every file the chat's agent changed (whole chat or last turn), each with a
  diff: line numbers, hunk headers, word-level highlights, wrap or scroll sideways.
- **Files**: browse projects and chat worktrees, fuzzy-search every file, read code with line
  numbers and colours, see git status, compare a file with its last commit. File paths in replies
  open here.

## How it is built

- `../client-core`: connection (resume from the last event, hole detection, heartbeat, jittered
  backoff), pairing, the state store, transcript rows, the incremental markdown parser and the
  syntax highlighter, design tokens and icons. Shared with the web app.
- `app/`: screens. `(tabs)/` holds Home, Inbox, Projects and You; the rest stack on top (chat,
  chats, project, scm, pulls, pull, pull-new, details sheet, new chat, changes, diff, files, file,
  connect, settings).
- `src/git`: the branch and pull request control and pull request rows; `src/ui/rows.tsx`: the
  GitHub-style list pieces (section titles, tiles, rows, chips, project avatars).
- `npx expo start --web` runs a browser preview of the app (react-native-web; tokens kept in
  AsyncStorage there, since a browser has no keychain).
- `src/chat`: the transcript (inverted list, rows and cells memoized by message identity),
  native-text markdown (only the block being written re-renders while a reply streams), composer
  (images, edit mode) and trays, and `Diff.tsx` (diffs from `client-core/diff.ts`).
- `src/state/liveActivities.ts`: drives Live Activities and the Dynamic Island with the planner
  from `../mobile-widgets` (iOS builds that include the widget extension only).
