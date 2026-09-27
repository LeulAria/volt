---
name: volt-transparent-window
description: Rules for any Volt UI change that paints in the agent-layout window (CSS in voltAgent/browser/media, overlays, fixed/absolute layers, browser <webview>s, sidebars, blur, backgrounds, scrolling lists). Load before editing that UI. The agent window is transparent (macOS vibrancy), and some CSS makes Chromium stop clearing old pixels, which turns the left sidebar solid black and leaves ghost trails when lists scroll.
---

# Volt transparent window: no black sidebar, no scroll trails

In agent layout the Volt window is transparent (`setWindowTransparentChrome`, macOS vibrancy). The left sidebar and chat
use translucent fills (`--volt-agent-sidebar-bg`, `--volt-agent-window-bg`) so the desktop shows through.

Some paint setups make Chromium stop clearing the pixels behind see-through areas. Two symptoms, same cause:

- The see-through left sidebar turns **solid black**.
- Scrolling a list (the agent sidebar list) leaves **repeated ghost copies** of the rows.

## Rules

1. **Never use `backdrop-filter`** anywhere in Volt CSS or inline styles. For a real blur, blur a cloned copy with a plain
   `filter: blur()` (see the sticky header backdrop in `src/vs/base/browser/ui/tree/abstractTree.ts`). For a simple
   see-through surface, use a more opaque background instead.
2. **A browser `<webview>` must sit on a solid (opaque) background in its own contained layer.** Never put one inside a
   transparent overlay. The tools area (`.volt-agent-tools-area`) paints `--volt-agent-window-bg-base` and uses
   `isolation: isolate; contain: paint` for this reason. Keep that when changing it. Each browser tab's webview lives in
   a `.volt-browser-view` (solid fill, `isolation`, `contain: paint`) inside `.volt-browser-view-layer`, laid over its
   pane so moving the tab never re-parents the webview (re-parenting restarts the page).
3. **New fixed or absolute layers over the window** (overlays, docks, popovers that stay on screen) get an opaque
   background, or contain nothing that scrolls or embeds a webview. Transparent full-size layers are the risk.
4. **Do not set `background: transparent` on a container that holds a webview, terminal, or scrolling list** unless a
   solid ancestor inside the same layer paints behind it.
5. **Websites inside the browser tab can trigger it too.** A page that renders with `backdrop-filter` (e.g. Tailwind
   `backdrop-blur`) is drawn into the same window. `webview.volt-browser-frame` has `opacity: 0.999` so Chromium draws
   the page in its own compositor pass instead of merging it into the window's root pass; the page's blur then stays
   inside that pass. Keep that opacity. Do not strip the page's blur (pages with frosted sticky headers become
   unreadable) and do not switch the window to solid (the user wants the see-through sidebar kept).

## Before you report a UI change as done

- Grep your diff: `git diff | grep -n "backdrop-filter\|transparent"` and check every hit against the rules above.
- Check the build watcher is running and picked up the change (`ps aux | grep "gulp watch-client"`, and grep the
  compiled file in `out/`). A new `.ts` file needs a watcher restart. Tell the user to reload with Cmd+R.
- Say whether you verified it on screen. Vibrancy does not show in CDP screenshots, so a black sidebar or trails can only
  be confirmed in the real window. If you could not see it, say so.

## History

- Sticky header blur in the sidebar list → trails. Fixed by clipping rows and blurring a copy with `filter: blur()`.
- `backdrop-filter` on the browser dock pill and collapsed prompt → trails with the browser open. Fixed by removing it.
- Black sidebar and trails with the browser open in the rebuilt tools area. The transparent overlay was suspected and got a
  solid fill (rule 2), which did not fix it: the real trigger was the website (next entry).
- A website with `backdrop-filter` (icons.leularia.com) in the browser tab → black sidebar and trails, while google.com was
  fine. A solid-window switch was planned but never wired, and the user rejected losing the see-through sidebar.
  Stripping the page's blur with `insertCSS` was rejected too: sticky headers turned see-through. Current fix: webview
  `opacity: 0.999` (rule 5). If that stops working, the next step is a native `WebContentsView` (its own compositor).
