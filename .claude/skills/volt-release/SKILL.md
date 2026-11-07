---
name: volt-release
description: Cut a Volt release (stable or beta) - version bumps, the CHANGELOG entry, docs/release-notes/<version>.md in the summary + divider + details format that Volt's release notes page draws, a preview in a dev build, the release PR and the tag. Load before preparing a Volt release, writing release notes or changing how release notes look.
---

# Volt release

A release is one PR (`chore(release): Volt <version>`) that bumps the version and adds the notes, then a `v<version>` tag on
its merge commit that starts `volt-stable.yml` (or `v<version>-beta.N` for `volt-beta.yml`). The user publishes: ask
before you push a tag or edit a published GitHub Release.

## Where the notes show up

- `docs/release-notes/<version>.md` is the GitHub Release body. `build/volt/release/publish.mjs` puts
  `Volt 0.0.6 | Nov 4, 2026 | \`abcdef12\`` above it and the mobile and Downloads lines under it, and GitHub appends its
  generated "What's Changed" list.
- Volt shows that body in its release notes page (`src/vs/workbench/contrib/update/browser/voltReleaseNotes.ts`): the
  version drawn as a blueprint (hatched outline digits, guide lines, nodes and dimensions), then `Volt <version> | <date>`,
  the summary, a `DETAILS` divider and the details. It opens as a right-pane tab beside the chat on the first launch after
  the version changes (`releaseNotes/lastVoltVersion`), and from Help > Show Release Notes.
- `CHANGELOG.md` keeps the full entry; the notes repeat its sections after the divider.

## 1. Collect what changed

- `git fetch origin && git log --oneline v<previous>..origin/main`, then read each PR body:
  `gh pr view <n> --repo LeulAria/volt --json title,body,baseRefName`.
- Only count PRs whose change is in `origin/main`. A stacked PR merged into its base branch after the base itself merged
  never reached main (check that its files are on `origin/main`).
- Squash PRs often carry commits an earlier release already shipped. Compare with the previous CHANGELOG entry and leave out
  what it already lists.
- Note what users see. CI, tests and repo tooling go in one line at most, under Changed.

## 2. Files to change

1. `package.json` `version`, and both places at the top of `package-lock.json`.
2. `CHANGELOG.md`: a new `## [<version>] - <YYYY-MM-DD>` entry at the top, in the shape of the previous ones (a short
   summary paragraph, Highlights, Added grouped under bold area labels, Changed, Fixed, Known limitations), plus the link
   reference at the bottom: `[<version>]: https://github.com/LeulAria/volt/releases/tag/v<version>`.
3. `docs/release-notes/<version>.md` in the format below.
4. `apps/docs/content/docs/install.mdx`: `VERSION=<version>`.
5. Anything else that names the previous version: `git grep -n '<previous version>' -- ':!CHANGELOG.md' ':!docs/release-notes'`
   (the `apps/volt-run` tests pin a release on purpose; its npm version comes from `volt-run:release -- --version`).

## 3. Release notes format

```md
Volt 0.0.6 is released: <the release in one sentence>.

✦ https://github.com/LeulAria/volt

+ <short win, plain words, a real number when there is one: 42x faster New Window>
+ <6 to 12 lines, most important first>
+ and much more

---

## Highlights
- **<Feature>.** <what it does for the user>

## Added
## Changed
## Fixed
## Known limitations

The same list is in the [changelog](https://github.com/LeulAria/volt/blob/v<version>/CHANGELOG.md#<anchor>).

## Install
<the download table and install steps for this version, as in the previous notes>
```

Rules the page relies on (`parseVoltReleaseNotes`):
- No `# Title` and no `Volt <version> (sha)` line: the release title and `publish.mjs` add them.
- Everything before the first `---` is the summary: the first paragraph is the headline, `✦ <url>` lines become links
  under it, `+ ` lines become the plus list. Leave a blank line before the `---` (right under text it is a heading).
- After the `---` comes every detail, as normal Markdown. Image links must be absolute and pinned to the tag
  (`https://raw.githubusercontent.com/LeulAria/volt/v<version>/docs/<folder>/<image>.png`).
- Notes without a `---` still render: the page shows them all as details.

## 4. Preview it in Volt

Run a dev build of the release branch (its `package.json` already says the new version):
- Help > Show Release Notes (or the palette's "Show Release Notes") reads `docs/release-notes/<package version>.md` in a
  dev build, so you see the page before anything is published. The date reads "Draft" until the GitHub Release exists.
- "Developer: Open Current File as Release Notes" previews the notes file open in the editor.
- To see the after-update path: a fresh `--user-data-dir`, seed
  `sqlite3 <ud>/User/globalStorage/state.vscdb "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); INSERT INTO ItemTable VALUES ('releaseNotes/lastVoltVersion', '<previous version>');"`,
  then launch. The notes open as a right-pane tab beside the New Agent chat.
- The right pane belongs to a chat. If the agent server is down there is no chat session, and the notes take the whole
  window instead. Check `<ud>/logs/agent-server.log` first.

Check the page at a narrow width (the right pane is often ~500px) and in the light theme.

## 5. Checks before the PR

- `npx tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck` and `node build/hygiene.js <changed files>`.
- `node --test build/volt/release/*.test.mjs` and the release notes tests:
  `./scripts/test.sh --run src/vs/workbench/contrib/update/test/browser/voltReleaseNotes.test.ts`.
- The agent server must start: anything it imports that reaches `vs/base/browser/*` (for example `mainWindow`) crashes it
  in Node with `window is not defined`, and then no chat can run. A dev window that shows "Connect a model" with
  providers installed is the symptom.
- CI on the PR: `Check` must be green, and so must `Unit Tests (Electron)`.

## 6. Ship

1. Open the PR `chore(release): Volt <version>` listing the changes and the files; the user merges it.
2. After the merge, the user tags it (or asks you to): `git tag -a v<version> -m "Volt <version>" <merge commit> && git push origin v<version>`.
3. Watch `volt-stable.yml` (`gh run watch`). Then check that the release has every asset, that the notes read well on GitHub
   and in Volt, that `volt-update-feed` has `stable/latest.json` for the new version, and that `volt-npm.yml` published
   `volt-run` (it warns instead when `NPM_TOKEN` is missing).
