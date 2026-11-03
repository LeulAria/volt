/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VOLT_BUILTIN_LAYOUTS, VOLT_BUILTIN_LOOKS, VOLT_BUILTIN_SOURCE, VOLT_CUSTOMIZE_LAYOUT_SETTING, VOLT_CUSTOMIZE_LOOK_SETTING, voltCustomizeId, voltCustomizeSlug } from './voltCustomizeModel.js';
import { VOLT_LOOK_ALIASES, VOLT_LOOK_TOKENS, voltLookCssVariable, voltLookSettingId } from './voltLookTokens.js';
import { VOLT_SLOT_ITEMS, VOLT_SLOTS, VOLT_VSCODE_ACTIVITY_BAR } from './voltSlots.js';
import { IVoltFeature, VOLT_FEATURES } from './voltFeatures.js';

/**
 * The customize folder (`~/.volt/customize` on the machine the agent server runs on) and the files
 * Volt writes into it. Everything here is text an agent can read: AGENTS.md says what may change
 * and how; reference/ holds the exact token list and JSON schemas.
 */
export const VOLT_CUSTOMIZE_DIR = ['.volt', 'customize'] as const;
export const VOLT_LOOKS_DIR = 'looks';
export const VOLT_LAYOUTS_DIR = 'layouts';
export const VOLT_PLAYGROUND_DIR = 'playground';
export const VOLT_REFERENCE_DIR = 'reference';

export const VOLT_LOOK_SCHEMA_URI = 'vscode://schemas/volt-look';
export const VOLT_LAYOUT_SCHEMA_URI = 'vscode://schemas/volt-layout';

/** The extension contribution points. */
export const VOLT_LOOKS_EXTENSION_POINT = 'voltLooks';
export const VOLT_LAYOUTS_EXTENSION_POINT = 'voltLayouts';

/** Marks a draft folder's package.json; the playground window looks for it. */
export const VOLT_PLAYGROUND_MARKER = 'voltPlayground';

/** The right panel's tabs, as `workbench.action.voltAgentTools.open.<id>` (agentSurfaceMenu.ts). */
const VOLT_RIGHT_PANEL_SURFACES: readonly [string, string][] = [
	['terminal', 'a terminal'],
	['browser', 'the in-app browser'],
	['file', 'the Explorer in the files sidebar'],
	['changes', 'the chat\'s changes'],
	['gitGraph', 'the Git Graph'],
	['device', 'the phone simulator'],
	['scratch', 'the Scratch board'],
	['canvas', 'the design canvas'],
	['automations', 'Automations'],
	['sideChat', 'a second chat beside this one'],
];

export interface IVoltCustomizePaths {
	/** Absolute path of the customize folder. */
	readonly home: string;
	/** The user's settings.json and keybindings.json, absolute. */
	readonly settings: string;
	readonly keybindings: string;
}

const table = (head: string[], rows: string[][]) => [
	`| ${head.join(' | ')} |`,
	`|${head.map(() => '---').join('|')}|`,
	...rows.map(row => `| ${row.map(cell => cell.replace(/\|/g, '\\|')).join(' | ')} |`),
].join('\n');

/** AGENTS.md for the customize folder, rewritten on every start. */
export function voltCustomizeAgentsMd(paths: IVoltCustomizePaths): string {
	const tokens = table(
		['Token', 'Default', 'Range', 'Setting', 'CSS variable', 'Changes'],
		// allow-any-unicode-next-line
		VOLT_LOOK_TOKENS.map(entry => [`\`${entry.id}\``, `${entry.default}${entry.unit === 'px' ? 'px' : ''}`, `${entry.minimum}–${entry.maximum}`, `\`${voltLookSettingId(entry.id)}\``, `\`${voltLookCssVariable(entry.id)}\``, entry.description]),
	);
	const aliases = table(['Token', 'Setting', 'Changes'], VOLT_LOOK_ALIASES.map(alias => [`\`${alias.id}\``, `\`${alias.setting}\``, alias.description]));
	const layouts = VOLT_BUILTIN_LAYOUTS.map(entry => `- \`${voltCustomizeId(VOLT_BUILTIN_SOURCE, entry.name)}\` (${entry.value.label}): ${entry.value.description}`).join('\n');
	const looks = VOLT_BUILTIN_LOOKS.map(entry => `- \`${voltCustomizeId(VOLT_BUILTIN_SOURCE, entry.name)}\` (${entry.value.label}): ${entry.value.description}`).join('\n');

	return `# Customize Volt

<!-- Written by Volt on every start. Edits here are overwritten. -->

This folder is how Volt's look and the agent window's layout are changed **as files**. Volt reads
them while it runs: save a file and every window follows within a second. When someone asks for a
change ("make the left sidebar blue", "rounder chat input", "hide the sidebar", "put Source Control
beside the chat"), do it by editing the files below. **Never edit Volt's own source or app bundle
for something these files can do.**

## The files

| Path | What it decides | Who writes it |
|---|---|---|
| \`${paths.settings}\` | the person's settings, including every \`volt.look.*\` token, \`${VOLT_CUSTOMIZE_LAYOUT_SETTING}\` and \`${VOLT_CUSTOMIZE_LOOK_SETTING}\` | you or the person (JSON with comments) |
| \`${paths.keybindings}\` | keyboard shortcuts (VS Code format) | you or the person |
| \`looks/<name>.json\` | a look: tokens, theme colors and window settings, picked as \`home/<name>\` | you |
| \`layouts/<name>.json\` | a layout: how the agent window is arranged, plus its own look, picked as \`home/<name>\` | you |
| \`playground/<name>/\` | Playground drafts, each one an extension folder (see Playground) | you, inside a Playground window |
| \`reference/tokens.json\` | every token: id, setting, default, range, CSS variable | Volt (read only) |
| \`reference/look.schema.json\`, \`reference/layout.schema.json\` | JSON schemas for the two file kinds | Volt (read only) |
| \`reference/layouts/\`, \`reference/looks/\` | Volt's own layouts and looks, to read and copy | Volt (read only) |
| \`reference/sdk/volt-ui.css\` | the Volt UI kit for extension webviews (buttons, inputs, cards, rows) | Volt (read only) |
| \`<file>.error\` | why a file you wrote was rejected | Volt |

**A bad file never breaks the window.** Volt keeps using the last good version and writes the reason
next to it as \`<file>.error\` (deleted again once the file is fine). Check for it after every edit.

## How values combine

Lowest to highest; a later layer wins key by key:

1. Volt's defaults (Volt as it ships; every token's default below).
2. Extensions' \`contributes.configurationDefaults\`.
3. The active layout (\`${VOLT_CUSTOMIZE_LAYOUT_SETTING}\`): its \`extends\` chain, its \`look\`, then its own \`tokens\` / \`colors\` / \`settings\`.
4. The active look (\`${VOLT_CUSTOMIZE_LOOK_SETTING}\`), through its \`extends\` chain.
5. settings.json (user), then a project's \`.vscode/settings.json\`.
6. A Playground draft, only in its Playground window.

So a value the person set in settings.json always wins over a look or layout. To change something
for good, prefer a look or layout file over settings.json; to change one value fast, settings.json.

## Looks: \`looks/<name>.json\`

\`\`\`jsonc
{
	"$schema": "${VOLT_LOOK_SCHEMA_URI}",
	"label": "Ocean",
	"description": "Blue sidebar, rounder chat.",
	"extends": "volt/soft",                 // optional: start from another look and change only what differs
	"tokens": { "composer.radius": 24, "chat.cardRadius": 16, "chat.width": "wide" },
	"colors": { "voltAgent.sidebarBackground": "#0b2a57", "editor.background": "#0f172a" },
	"settings": { "workbench.tree.indent": 12 }   // any window-scoped setting
}
\`\`\`

- \`tokens\`: the table below. Numbers are pixels unless said otherwise; out-of-range values are clamped.
- \`colors\`: VS Code theme color ids (\`sideBar.background\`, \`editor.background\`, \`titleBar.activeBackground\`,
	\`button.background\`, \`focusBorder\` …) as \`#rrggbb\` or \`#rrggbbaa\`, same as \`workbench.colorCustomizations\`.
	The agent window has two colors of its own: \`voltAgent.sidebarBackground\` (only the chat list on the
	left: "make the left sidebar blue") and \`voltAgent.background\` (the whole window: chat, title bar, tools).
	Unset, both follow \`sideBar.background\`, so setting that one tints the whole agent window.
- \`settings\`: only settings a window may change; app-wide ones (updates, telemetry, proxies) are refused.
- \`null\` removes a value the parent set.
- Activate it: set \`"${VOLT_CUSTOMIZE_LOOK_SETTING}": "home/ocean"\` in settings.json, or pick it in Settings > Customize Volt.

Volt's own looks:
${looks}

### Tokens

${tokens}

Other settings you can set as tokens:

${aliases}

## Layouts: \`layouts/<name>.json\`

\`\`\`jsonc
{
	"$schema": "${VOLT_LAYOUT_SCHEMA_URI}",
	"label": "Desk",
	"description": "Chat and its changes side by side.",
	"extends": "volt/default",
	"look": "volt/compact",                  // optional look this layout brings; the picked look wins over it
	"sidebar": { "visible": true, "width": 260, "rail": false },
	"chat": { "width": "wide" },             // narrow (600) | default (728) | wide (960) | full | pixels
	"filesSidebar": { "open": true, "view": "scm" },   // explorer | scm | search | pullRequests | debug | extensions
	"rightPanel": { "open": true, "commands": ["myext.openBoard"] },
	"tokens": { "chat.gutter": 28 },
	"colors": { "sideBar.background": "#14161b" }
}
\`\`\`

- \`slots\` moves Volt's buttons (see below); it applies live like a value.
- \`sidebar\`, \`filesSidebar\` and \`rightPanel\` are window state: they apply when the layout is picked and
	whenever its file changes. After that the person's clicks (resizing, closing) stay until the file changes again.
- \`rightPanel.commands\` run when the layout applies: use them to open an extension's tab (a webview panel
	opened over a chat lands in the right panel).
- \`chat\`, \`tokens\`, \`colors\` and \`settings\` are values (see How values combine).
- Activate it: \`"${VOLT_CUSTOMIZE_LAYOUT_SETTING}": "home/desk"\`. Volt's own:
${layouts}

### Moving Volt's buttons: \`slots\`

Volt's own buttons are items in slots. A layout's \`slots\` moves, reorders or hides them; items it
doesn't name stay where Volt puts them. "Move the bottom-left gear next to New Chat":

\`\`\`jsonc
"slots": { "sidebar.header": ["volt.filter", "volt.openWorkspace", "volt.newChat", "volt.settings"] }
\`\`\`

"Hide Automations": \`"slots": { "hidden": ["volt.automations"] }\`. A moved button takes the look of
the slot it lands in.

**Activity bar.** VS Code's icon column, at the left edge of the agent sidebar. It is off until
\`activityBar.top\` or \`activityBar.bottom\` holds an item. Its view items (Explorer, Search, Source
Control, Run and Debug, Pull Requests, Extensions) open that view in the files sidebar on the right; a
second click closes it. Any of Volt's buttons can go there too. "Give me VS Code's activity bar":

\`\`\`jsonc
"slots": {
	"activityBar.top": ${JSON.stringify(VOLT_VSCODE_ACTIVITY_BAR['activityBar.top'])},
	"activityBar.bottom": ${JSON.stringify(VOLT_VSCODE_ACTIVITY_BAR['activityBar.bottom'])}
}
\`\`\`

Volt's own \`volt/vscode\` layout is exactly that; \`"extends": "volt/vscode"\` starts from it. Its width
is the \`activityBar.width\` token.

${table(['Slot', 'Where'], VOLT_SLOTS.map(slot => [`\`${slot.id}\``, slot.description]))}

${table(['Item', 'Button', 'Starts in'], VOLT_SLOT_ITEMS.map(item => [`\`${item.id}\``, `${item.label}: ${item.description}`, item.defaultSlot ? `\`${item.defaultSlot}\`` : 'nowhere (place it)']))}

Commands for \`rightPanel.commands\` (each opens that tab in the right panel beside the chat on screen):

| Command | Opens |
|---|---|
${VOLT_RIGHT_PANEL_SURFACES.map(([id, what]) => `| \`workbench.action.voltAgentTools.open.${id}\` | ${what} |`).join('\n')}

Any other command works too, e.g. an extension's own (\`myext.openBoard\`). Commands run in order.

To change one of Volt's or an extension's layouts, never edit its file: write your own with
\`"extends": "<its id>"\` and only the fields that differ. When it updates, your changes stay.

## Playground

Settings > Customize Volt > Open Playground creates \`playground/<name>/\` and opens a **Playground
window** on it. That window shows Volt with the draft applied, live, on top of everything (even
settings.json), while every other window stays as it was. Its chat runs in the draft folder: edit
\`look.json\` and \`layout.json\` there (same formats as above) and the window updates on save.

- Edit only files inside the draft folder.
- The Playground bar has **Apply** (copy the draft into \`looks/\` and \`layouts/\` and switch to it),
	**Install** (install the draft as an extension) and **Discard**.
- Volt keeps the draft's per-message changes like any project, so a change can be undone from the chat.

## Extensions: what needs code

A draft folder is already an extension: \`package.json\` names it and contributes its look and layout:

\`\`\`json
{
	"name": "ocean", "publisher": "local", "version": "0.0.1", "engines": { "vscode": "*" },
	"categories": ["Themes"], "keywords": ["volt-look", "volt-layout"],
	"contributes": {
		"${VOLT_LOOKS_EXTENSION_POINT}": [{ "id": "ocean", "label": "Ocean", "path": "./look.json" }],
		"${VOLT_LAYOUTS_EXTENSION_POINT}": [{ "id": "ocean", "label": "Ocean", "path": "./layout.json" }]
	}
}
\`\`\`

Installed, it shows up in the pickers as \`local.ocean/ocean\`. For **new functionality** (a Linear
issues tab, a usage meter, a task board, a git graph) write a normal VS Code extension in the same
folder: \`"main": "./extension.js"\`, \`activate(context)\`, \`vscode.commands.registerCommand\`, and
\`vscode.window.createWebviewPanel\` for a tab (it opens in the agent window's right panel). Use
\`reference/sdk/volt-ui.css\` in the webview (copy it into the extension) so it matches Volt: every
token is a CSS variable there (\`var(--volt-look-composer-radius)\`) next to VS Code's colors
(\`var(--vscode-editor-background)\`). Open a tab when a layout applies with \`rightPanel.commands\`.
Package with \`npx @vscode/vsce package\`, publish with \`npx ovsx publish\` (Open VSX is Volt's gallery).

Prefer files over code: a look or layout before an extension, an extension before anything else.

## Features: built-in extensions

Volt's optional features come with it as built-in extensions (publisher \`volt\`). Disabling one in
Extensions, or **Turn Off** in the Playground devtools' Capabilities tab, takes away everything it
brings: its buttons, Volt Settings pages, side toolbar sections, "+" menu entries, model providers
and agent tools. When someone asks to drop a whole feature ("I never use Automations", "no Grok in
the picker"), tell them which extension to disable; don't hide its pieces one by one with layout
\`slots\`. Features with no extension are Volt's core and always on.

${featureTable()}

The Capabilities tab lists all of this live, plus everything VS Code registers (views, editors,
commands, settings, shortcuts, languages, themes) and every extension's contributions. A row
dragged into the chat arrives as a \`<volt_capability>\` block.

## Escape hatch

**Volt: Reset Customizations** (Command Palette, or ⌘⌥⇧Escape / Ctrl+Alt+Shift+Escape) switches back to
\`volt/default\` with no look. Your files stay where they are.
`;
}

/** Every optional feature, its extension and what turning it off takes away. */
function featureTable(): string {
	const owned = (feature: IVoltFeature) => [
		feature.items?.length ? `buttons ${feature.items.map(id => `\`${id}\``).join(', ')}` : '',
		feature.sections?.length ? `Settings ${feature.sections.map(id => `\`${id}\``).join(', ')}` : '',
		feature.surfaces?.length ? `"+" menu ${feature.surfaces.map(id => `\`${id}\``).join(', ')}` : '',
		feature.dock?.length ? `side toolbar ${feature.dock.map(id => `\`${id}\``).join(', ')}` : '',
		feature.providers?.length ? `providers ${feature.providers.map(id => `\`${id}\``).join(', ')}` : '',
		feature.tools?.length ? `${feature.tools.length} agent tools` : '',
	].filter(Boolean).join('; ');
	return table(['Feature', 'Extension', 'Turning it off removes'], VOLT_FEATURES.filter(feature => feature.extensionId).map(feature => [feature.label, `\`${feature.extensionId}\``, owned(feature) || feature.description]));
}

/** CLAUDE.md beside it: Claude Code reads AGENTS.md through this import. */
export const VOLT_CUSTOMIZE_CLAUDE_MD = '@AGENTS.md\n';

/** reference/sdk/volt-ui.css: Volt's controls for extension webviews, built on the tokens. */
export const VOLT_UI_SDK_CSS = `/* Volt UI kit for webviews. Copy into your extension. Every value follows the person's look:
 * --volt-look-* tokens and --vscode-* theme colors are set on the webview by Volt. */
.volt-ui { font-family: var(--vscode-font-family); font-size: var(--volt-look-chat-font-size, 14px); line-height: var(--volt-look-chat-line-height, 1.55); color: var(--vscode-foreground); }
.volt-button { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border: 1px solid transparent; border-radius: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; font-size: 13px; cursor: pointer; }
.volt-button:hover { background: var(--vscode-button-hoverBackground); }
.volt-button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.volt-button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.volt-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.volt-input { box-sizing: border-box; height: 28px; padding: 0 10px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; font-size: 13px; }
.volt-input:focus { outline: 1px solid var(--vscode-focusBorder); }
.volt-card { border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.2)); border-radius: var(--volt-look-chat-card-radius, 12px); background: color-mix(in srgb, var(--vscode-foreground) 4%, var(--vscode-editor-background)); padding: 12px; }
.volt-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
.volt-row { display: flex; align-items: center; gap: var(--volt-look-sidebar-row-gap, 8px); height: 28px; padding: 0 8px; font-size: var(--volt-look-sidebar-font-size, 13px); cursor: pointer; }
.volt-row:hover { background: var(--vscode-list-hoverBackground); }
.volt-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.volt-muted { color: var(--vscode-descriptionForeground); }
.volt-status { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
.volt-status.working { background: var(--vscode-progressBar-background); }
.volt-status.blocked { background: var(--vscode-editorWarning-foreground); }
.volt-status.done { background: var(--vscode-testing-iconPassed, #3fb950); }
.volt-status.failed { background: var(--vscode-errorForeground); }
`;

// --- Playground drafts -------------------------------------------------------------------------

export interface IVoltDraftFiles {
	readonly [relativePath: string]: string;
}

/**
 * A new draft: an extension folder with an empty look and a layout that extends the one in use,
 * so the Playground starts as the person's Volt.
 */
export function voltPlaygroundDraft(label: string, baseLayout: string, baseLook: string | undefined): IVoltDraftFiles {
	const name = voltCustomizeSlug(label);
	const json = (value: unknown) => JSON.stringify(value, undefined, '\t') + '\n';
	return {
		'package.json': json({
			name,
			displayName: label,
			description: `A Volt look and layout made in the Playground.`,
			publisher: 'local',
			version: '0.0.1',
			engines: { vscode: '*' },
			categories: ['Themes'],
			keywords: ['volt-look', 'volt-layout'],
			contributes: {
				[VOLT_LOOKS_EXTENSION_POINT]: [{ id: name, label, path: './look.json' }],
				[VOLT_LAYOUTS_EXTENSION_POINT]: [{ id: name, label, path: './layout.json' }],
			},
			[VOLT_PLAYGROUND_MARKER]: { baseLayout, baseLook: baseLook ?? '' },
		}),
		'look.json': json({ $schema: VOLT_LOOK_SCHEMA_URI, label, ...(baseLook ? { extends: baseLook } : {}), tokens: {}, colors: {} }),
		'layout.json': json({ $schema: VOLT_LAYOUT_SCHEMA_URI, label, extends: baseLayout }),
		'AGENTS.md': `# Playground draft: ${label}

This folder is a Volt Playground draft. The Playground window shows Volt with these files applied and
updates within a second of every save. Other windows are not affected until the person presses Apply
or Install in the Playground bar.

- \`look.json\`: tokens, theme colors and window settings ("make the sidebar blue", "rounder input").
- \`layout.json\`: how the agent window is arranged ("hide the sidebar", "open Source Control beside the chat")
	and where Volt's buttons sit (\`slots\`: "move the bottom-left gear to the top", "hide Automations").
	It \`extends\` the layout the person uses, so change only what differs.
- \`package.json\`: this draft as an extension. Add \`main\`, commands and a webview only for new functionality.
- \`RECIPE.md\` (write it before sharing): what the person sees, how it behaves, what it is built from.

The full reference (every token with its default, both file formats, how values combine, extensions)
is in \`../../AGENTS.md\`; exact values in \`../../reference/tokens.json\`. A rejected file gets a
\`<file>.error\` beside it: read it after each edit. Only edit files in this folder.
`,
		'CLAUDE.md': VOLT_CUSTOMIZE_CLAUDE_MD,
		'README.md': `# ${label}\n\nA Volt look and layout. Install it and pick it in Settings > Customize Volt.\n`,
	};
}
