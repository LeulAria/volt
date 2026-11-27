# Plugin UI: where an extension shows up in Volt

A Volt plugin is a VS Code extension with `"enabledApiProposals": ["volt"]` (see [extension-api.md](extension-api.md)). On top of the `vscode.volt` API, it can put UI anywhere in the agent window, and **the user decides where it sits**:

- **Views**: webviews the extension fills with VS Code's own `vscode.window.registerWebviewViewProvider`. Any web UI works: plain HTML, React, Svelte.
- **Items**: buttons, chips and menus in the window's *slots*. A click opens a view, runs a command or shows a menu.
- **Settings pages**: the extension's `contributes.configuration` drawn as Volt's own rows in Volt Settings, under **Plugins**.

The user can drag any item (Volt's own too) to another slot, right-click it to move it, open its view somewhere else or hide it, or arrange everything in **Settings > Plugin Layout**. Their choices are saved in `volt.layout.slots`, `volt.layout.views` and `volt.layout.icons` (user settings), and they beat both the plugin's defaults and the active layout's `slots`.

The full example is [`examples/volt-pr-pilot/`](examples/volt-pr-pilot/). It links a chat to its pull request and CI with a live chip, a PR & CI panel, a checks popover, per-chat notes, the model picker and a settings page.

## 1. Slots (where items go)

| Slot | Where |
|---|---|
| `sidebar.header` | The icon row at the top of the agent list, right of Search |
| `sidebar.footer` | The icon row at the bottom-left (Settings, Usage, ...) |
| `activityBar.top`, `activityBar.bottom` | VS Code's icon column at the left edge (shows once it holds something) |
| `titlebar.left` | Top-left, after VOLT and the back/forward arrows |
| `titlebar.center` | The chat's title bar, left of IDE ↗ |
| `titlebar.right` | Top-right corner, after the files sidebar and right panel toggles |
| `filesSidebar.header` | The files sidebar's tab row (Explorer, Source Control, Pull Requests, Search) |
| `chat.toolbar` | The icon column at the chat's right edge |
| `chat.dock` | That toolbar's menu, under **Plugins** |
| `composer.chips` | The chips row above the composer (Worked for, Compact, Push & Create PR) |
| `rightPanel.launcher` | The list the empty right panel shows (File, Terminal, Browser, ...) |

## 2. Views (where a view opens)

| `location` | What the user sees |
|---|---|
| `rightPanel` | A tab in the chat's right panel |
| `filesSidebar` | The files sidebar on the right, in place of Explorer |
| `page` | A page over the chat, like Pull Requests |
| `popover` | A popover under the button that opened it |
| `aboveComposer` | A card above the composer, in every chat |
| `sidebarSection` | A folding section in the left sidebar, above its footer |

`locations` limits where the user may move it (default: everywhere). A view placed above the composer or in the left sidebar shows until its button (or its ×) hides it.

**Sizes.** The placement sizes the view, so it sits like Volt's own UI there:

| `location` | Width | Height |
|---|---|---|
| `rightPanel`, `page`, `filesSidebar` | what the user gives it | what the user gives it |
| `aboveComposer` | the chat's column (728px, or the user's chat width; 560px on a new chat) | 160px (72–320) |
| `popover` | 360px (280–480) | 420px (160–560) |
| `sidebarSection` | the sidebar's | 200px (96–400) |

A view asks for another size with `"size": { "width": 360, "height": 240 }`; Volt keeps it inside the bounds in brackets. Where a size isn't the view's to choose, `size` is ignored.

## 3. `package.json`

```jsonc
{
  "enabledApiProposals": ["volt"],
  "contributes": {
    "configuration": { "properties": { "prPilot.pollSeconds": { "type": "number", "default": 30, "description": "..." } } },
    "voltViews": [
      { "id": "prPilot.panel", "title": "PR & CI", "icon": "aria:lucide:git-pull-request", "location": "rightPanel", "size": { "height": 260 } },
      { "id": "prPilot.checks", "title": "Checks", "icon": "aria:lucide:list-checks", "location": "popover", "size": { "width": 360, "height": 360 } }
    ],
    "voltSlotItems": [
      // A chip whose text the extension keeps current; a click opens the checks popover.
      { "id": "prPilot.chip", "label": "PR", "kind": "chip", "slot": "composer.chips", "view": "prPilot.checks", "icon": "aria:lucide:git-pull-request" },
      // A button in the chat's title bar.
      { "id": "prPilot.open", "label": "PR & CI", "slot": "titlebar.center", "view": "prPilot.panel", "icon": "aria:lucide:git-pull-request-arrow" },
      // A menu in the chat's side toolbar.
      { "id": "prPilot.menu", "label": "PR Pilot", "kind": "menu", "slot": "chat.dock", "icon": "aria:lucide:rocket",
        "menu": [{ "label": "Open PR & CI", "view": "prPilot.panel" }, { "label": "Link a Pull Request...", "command": "prPilot.linkPr" }] }
    ],
    "voltSettingsPages": [{ "id": "prPilot", "label": "PR Pilot", "icon": "aria:lucide:git-pull-request", "settings": ["prPilot."] }]
  }
}
```

- **`kind`**: `button` (an icon; the label is its tooltip), `chip` (icon and label), `menu` (a chip with a ▾ that lists `menu`).
- **A click** toggles `view` where the user placed it, else runs `command` with `{ chatId }` (the chat in front), else shows `menu`.
- **Icons**: `aria:<set>:<name>` from [Aria Icons](https://icons.leularia.com) (1.4M icons: lucide, tabler, heroicons, brand logos), `codicon:<id>`, or an `.svg` in the extension. Pick outline icons: Volt draws them exactly like its own, with its 1px line (0.9px, non-scaling, in place of lucide's 2px) and at the size of the bar they sit in (15px in the title bars, sidebar header and footer and files sidebar tabs; 14px in chips, menus and the launcher; 16px in the chat's side toolbar), so a plugin's button lines up with Volt's. Volt fetches an Aria icon once and keeps it. Icons are drawn in the theme's text color. The user can pick another icon from Aria Icons in Settings.
- **A view's extension activates** when Volt first shows it (`onView:<id>` is added for you).
- **Settings pages** list the keys in `settings` (exact keys, or prefixes ending in `.`). Without `voltSettingsPages`, a plugin with UI and settings gets a page named after it. Values are written to the user's `settings.json`, so `vscode.workspace.getConfiguration` reads them. The page also shows where the plugin's buttons and views sit, and `view` adds one of its views below that.

## 4. Code

```js
const volt = vscode.volt;
// Fill a view. It is a normal WebviewView: html, postMessage, onDidReceiveMessage, getState/setState.
vscode.window.registerWebviewViewProvider('prPilot.panel', { resolveWebviewView(view) { view.webview.options = { enableScripts: true }; view.webview.html = '...'; } });

// Keep a chip current: text, badge, a tint (error | warning | success), or hidden.
await volt.ui.update('prPilot.chip', { label: '#12 · 2 failing', tone: 'error' });
// Open one of your views where the user put it.
await volt.ui.showView('prPilot.panel');

// The chat in front, with the model it runs on; and when it changes.
const chat = await volt.chats.current();            // { id, title, model?: { id, label, provider }, project?, ... }
volt.chats.onDidChangeCurrent(() => refresh());
// Volt's own model picker: the user picks; you learn only the pick.
const model = await volt.chats.pickModel({ placeHolder: 'Model for reviews' });
// Your own storage (JSON, per profile) and settings.
await volt.storage.set(`notes:${chat.id}`, text);
```

Capabilities: `ui.update`, `ui.showView` and `pickModel` need none (`ui.contribute`). `chats.current` and `onDidChangeCurrent` need `agents.read:current` (low). What Volt asks for the rest is in [extension-api.md](extension-api.md) §2.

## 5. Look and feel: the Volt kit

Every plugin webview gets the **Volt kit**: Volt's type, spacing, buttons and lists as CSS classes, in the theme's colours (`--vscode-*`). Volt puts it first in the page's `<head>`, before your Content-Security-Policy, so it needs no CSP change. Build from it and the view looks like the rest of Volt in every theme and placement.

```html
<main class="volt-view">
  <section class="volt-section">
    <header class="volt-section-header">
      <span class="volt-title">Checks · 3 of 4 passed</span>
      <div class="volt-toolbar"><button class="volt-icon-button" title="Refresh"><svg>…</svg></button></div>
    </header>
    <ul class="volt-list">
      <li><button class="volt-row"><span class="volt-dot error"></span><span class="volt-row-label volt-row-main">CI / test</span><span class="volt-row-meta volt-tone-error">failure</span></button></li>
    </ul>
    <div class="volt-section-body"><div class="volt-actions"><button class="volt-button primary small">Ask the agent to fix it</button></div></div>
  </section>
</main>
```

**The rules** (the Playground's AGENTS.md gives an agent the same ones):

| Part | Do | Kit |
|---|---|---|
| Frame | Volt draws the title, icon, close button and the card or panel. Don't repeat the title; no bordered or rounded boxes inside the view. | — |
| Groups | A header line, then content; one line between groups. | `volt-section`, `volt-section-header` (30px), `volt-title`, `volt-section-body` |
| Lists | Rows edge to edge, square, no gaps or margins, 12px side padding. 26px, or 40px with a second line. | `ul.volt-list > li > .volt-row` (`button.volt-row` when clickable, `two-line`), `volt-row-main`, `volt-row-label`, `volt-row-description`, `volt-row-meta`, `volt-row-actions` (on hover) |
| Buttons | 28px, 6px radius. At most one primary per view. Labels say what happens, with no "…". | `volt-button` + `primary` / `ghost` / `danger` / `small` (24px); `volt-actions` |
| Icon buttons | A 16px icon in a 24px square, a fill only on hover, always a `title`. | `volt-icon-button` in `volt-toolbar` |
| Icons | Outline icons in `currentColor` (inline SVG from [Aria Icons](https://icons.leularia.com), lucide), with Volt's line and sizes exactly so they line up: a **1px** line drawn as Volt draws it (`stroke-width: 0.9px; vector-effect: non-scaling-stroke`), never the sets' 2px; **16px** in list rows, **15px** in toolbars and icon buttons, **14px** in buttons; centred, no margins of their own. | `volt-icon`, `--volt-icon-size` (16), `--volt-toolbar-icon-size` (15), `--volt-button-icon-size` (14); the kit applies the line |
| Text | 13px body, 12px secondary, 11px captions, 600 for emphasis, no uppercase labels. | `volt-small`, `volt-muted`, `volt-caption`, `volt-strong`, `volt-mono`, `volt-ellipsis` |
| Spacing | 4 / 8 / 12 / 16px. The side gutter is 12px (16px in the right panel and a page). A page keeps a 728px column. | `--volt-space-1`…`4`, `--volt-gutter`, `volt-content` |
| Status | Theme colours only, never hex. | `volt-dot`, `volt-badge` + `error` / `warning` / `success` / `info`, `volt-tone-*` |
| Fields | No native `<select>`: offer rows or buttons, or Volt's pickers (`chats.pickModel`, `showQuickPick`). | `volt-input`, `volt-textarea` |
| Empty, loading | A muted line and at most one action, never a blank view. | `volt-empty` (`center` to centre it) |
| Other | Key/value lines, a divider. | `volt-kv`, `volt-divider` |

Tokens you can use in your own CSS: `--volt-font-size` (13px), `--volt-font-size-small` (12px), `--volt-font-size-caption` (11px), `--volt-space-1`…`4`, `--volt-gutter`, `--volt-row-height`, `--volt-button-height`, `--volt-icon-button-size`, `--volt-icon-size`, `--volt-radius` (6px), `--volt-radius-large` (10px), `--volt-border`, `--volt-muted`, `--volt-hover`, `--volt-tone-error` / `warning` / `success` / `info`.

**Overriding, on purpose.** The kit is one CSS cascade layer (`@layer volt-kit`), so any rule in your own CSS beats it: change a token (`:root { --volt-gutter: 20px }`) or restyle a class. `<meta name="volt-kit" content="off">` in the page's `<head>` turns the kit off for that page. `<html data-volt-placement="…">` says where the view is (`rightPanel`, `popover`, `aboveComposer`, …), for a page that must differ per placement. What you can't change from the page is its size: ask for one with `size` (§2).

## 6. Building and trying one

1. Copy `examples/volt-pr-pilot/` and rename it (`name`, `publisher`, ids).
2. In Volt: **Extensions > Install from VSIX** (`npx @vscode/vsce package`), or **Customize Volt > Playground**, where an agent builds and installs the draft. The Playground's AGENTS.md lists the slots and APIs.
3. Volt shows the extension's permissions once. Then drag its buttons where you want them.

## 7. How it is built

| Part | File |
|---|---|
| Contribution points and schemas | `services/voltPlugins/common/voltContributions.ts` (`voltViews`, `voltSlotItems`, `voltSettingsPages`) |
| Slots and placement | `contrib/voltCustomize/common/voltSlots.ts` (`resolveVoltSlotPlacement`, `moveVoltSlotItem`, `IVoltSlotService`) |
| Plugin UI service | `contrib/voltCustomize/browser/voltPluginUiService.ts`: items, views, the user's layout, drag and drop, menus |
| Views | `contrib/voltCustomize/browser/voltPluginViews.ts`: the webview host (`IWebviewViewService.resolve`), right panel and page editor, popover |
| Kit and sizes | `contrib/voltCustomize/common/voltPluginDesign.ts`: `VOLT_WEBVIEW_KIT_CSS`, `injectVoltWebviewKit` (into each page the host sets), `VOLT_VIEW_SIZE_BOUNDS`, `resolveVoltViewSize` |
| Composer cards | `contrib/voltCustomize/browser/voltPluginUi.contribution.ts` (composer tray `volt.pluginViews`) |
| Icons | `contrib/voltCustomize/browser/voltIconService.ts` (Aria Icons API, cached, drawn as a CSS mask) |
| Settings | `contrib/voltSettings/browser/pluginSettingsPages.ts` (plugin pages, Plugin Layout, the Aria icon picker) |
| Where slots render | `agentHomePane.ts` (sidebar, sections), `agentNav.contribution.ts` (`titlebar.left`), `agentViewSidebars.ts` (title bar, side toolbar, menu), `agentFilesSidebar.ts`, `agentComposerChips.ts`, `agentSurfaceHost.ts` (launcher) |
| API | `vscode.proposed.volt.d.ts` (`volt.ui`, `Chat.model`, `chats.onDidChangeCurrent`), `extHostVolt.ts`, `mainThreadVolt.ts`, `voltApi.ts` |
