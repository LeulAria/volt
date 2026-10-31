/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltHostToolInfo } from './hostTools.js';

export const DESKTOP_TOOL_NAMES = ['desktop_apps', 'desktop_snapshot', 'desktop_act'] as const;

export type VoltDesktopToolName = typeof DESKTOP_TOOL_NAMES[number];

const APP = { type: 'string', description: 'App name or bundle id (e.g. "Notes", "com.apple.Safari"). Default: the app in front of Volt.' };

export const DESKTOP_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: 'desktop_apps',
		title: 'Listed desktop apps',
		group: 'desktop',
		description: 'List the apps running on the user\'s computer (macOS, Windows or Linux: name, bundle id or executable, which is in front) and whether Volt may control them (macOS: the Accessibility permission).',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'desktop_snapshot',
		title: 'Read desktop app',
		group: 'desktop',
		description: 'Read an app window on the user\'s computer as an accessibility tree, one line per control: `d12 button "Save" disabled` (ref, role, name, states, value). Exact and far cheaper than a screenshot; use it before desktop_act when you do not know the window. The user approves desktop control once per chat.',
		inputSchema: { type: 'object', properties: { app: APP, window: { type: 'string', description: 'Text in the window title, when the app has several.' }, unfold: { type: 'boolean', description: 'Show long lists in full.' }, screenshot: { type: 'boolean', description: 'Also attach a screenshot of the window (needs the Screen Recording permission on macOS). Only when the pixels matter: a canvas, an image, a chart.' } } },
	},
	{
		name: 'desktop_act',
		title: 'Acted on desktop app',
		group: 'desktop',
		description: `Drive a native app (macOS, Windows, Linux) in ONE call, by what its controls say instead of pixels. Script, one step per line:
open Notes                   (an app name, bundle id or URL; brings it to the front)
click button "New Note"
type "Search" groceries      (sets the field's value; checked after)
check "Show all accounts"
menu File > Export as PDF…
window "Inbox"               (bring that window to the front; then minimize, restore, close, zoom or fullscreen)
press cmd+s                  (any chord: cmd/ctrl/alt/shift + key)
scroll down until "Archive"
expect "Saved" and gone "Untitled"
hover button "Share"
draw in "Canvas" circle 50,35 15 | line 50,50 50,85 | path "M30 60 Q50 75 70 60"
drag "Report.pdf" to "Archive"       (or drag in "Canvas" 10,10 90,90 for a free path)
draw: shapes line x,y x,y · polyline/polygon x,y … · rect x,y w,h · square x,y s · circle x,y r · ellipse x,y rx,ry · arc x,y r from to · star x,y r [n] · dot x,y · path "<SVG path data>", joined by |. Coordinates are 0-100 across the target's width and height (or the window's), so you need no pixel sizes; radii and sides are hundredths of the width and stay round. A whole picture is one step. Pressing on a line already drawn usually grabs it instead of drawing: draw connected lines as one polyline or path, and start every other stroke in empty space (ending on a line is fine). Pick the app's pen or shape tool first; add screenshot: true to see the result.
Targets: "text" (for type/check: the field's label), role "name" (button, textbox, checkbox, switch, radio, tab, row, cell, menuitem, link, combobox...), a ref from desktop_snapshot, id "AXIdentifier", "in <target>", "#2", "exact". "=> condition" verifies a step. Buttons and fields are used through accessibility, so it works on a window behind others without moving the user's mouse; keys go to the app in front. Each step waits for its target, re-reads the window and reports what changed; the run stops at the first failure and ends with the window's changes since your last read. "open" returns as soon as the app is in front with a window. Open context menus and popups are read with the window. save / run / vars work like browser_act's flows. The user approves desktop control once per chat.`,
		inputSchema: {
			type: 'object',
			properties: {
				app: APP,
				window: { type: 'string', description: 'Text in the title of the window to work in. Default: the focused one.' },
				script: { type: 'string', description: 'The steps, one per line (see above).' },
				run: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Saved flow(s) to run instead of a script.' },
				vars: { type: 'object', description: 'Values for ${name} placeholders.' },
				save: { type: 'string', description: 'Save this script as a flow when every step passes.' },
				steps: { type: 'array', maxItems: 30, items: { type: 'object' }, description: 'The same steps as JSON objects, if you prefer.' },
				observe: { type: 'string', enum: ['auto', 'on_failure', 'full', 'none'], description: 'Window state at the end: auto (changes since your last read), on_failure, full, or none.' },
				screenshot: { type: 'boolean', description: 'Attach a screenshot at the end: of the area the last draw/drag step worked in, else of the window. For checking drawings and other pixels the tree cannot show.' },
			},
		},
	},
];
