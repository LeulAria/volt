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
		description: 'List the apps running on the user\'s Mac (name, bundle id, which is in front) and whether Volt may control them (the Accessibility permission).',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'desktop_snapshot',
		title: 'Read desktop app',
		group: 'desktop',
		description: 'Read an app window on the user\'s Mac as an accessibility tree: buttons, fields, checkboxes, rows, menus with their text, states and refs ("d12"). Exact and far cheaper than a screenshot; use it before desktop_act when you do not know the window. The user approves desktop control once per chat.',
		inputSchema: { type: 'object', properties: { app: APP, window: { type: 'string', description: 'Text in the window title, when the app has several.' }, unfold: { type: 'boolean', description: 'Show long lists in full.' } } },
	},
	{
		name: 'desktop_act',
		title: 'Acted on desktop app',
		group: 'desktop',
		description: `Drive a native Mac app in ONE call, by what its controls say instead of pixels. Script, one step per line:
open Notes                   (an app name, bundle id or URL; brings it to the front)
click button "New Note"
type "Search" groceries      (sets the field's value; checked after)
check "Show all accounts"
menu File > Export as PDF…
press cmd+s                  (any chord: cmd/ctrl/alt/shift + key)
scroll down until "Archive"
expect "Saved" and gone "Untitled"
Targets: "text" (for type/check: the field's label), role "name" (button, textbox, checkbox, switch, radio, tab, row, cell, menuitem, link, combobox...), a ref from desktop_snapshot, id "AXIdentifier", "in <target>", "#2", "exact". "=> condition" verifies a step. Buttons and fields are used through accessibility, so it works on a window behind others without moving the user's mouse; keys go to the app in front. Each step waits for its target, re-reads the window and reports what changed; the run stops at the first failure and ends with the window's changes since your last read. save / run / vars work like browser_act's flows. The user approves desktop control once per chat.`,
		inputSchema: {
			type: 'object',
			properties: {
				app: APP,
				script: { type: 'string', description: 'The steps, one per line (see above).' },
				run: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Saved flow(s) to run instead of a script.' },
				vars: { type: 'object', description: 'Values for ${name} placeholders.' },
				save: { type: 'string', description: 'Save this script as a flow when every step passes.' },
				steps: { type: 'array', maxItems: 30, items: { type: 'object' }, description: 'The same steps as JSON objects, if you prefer.' },
				observe: { type: 'string', enum: ['auto', 'on_failure', 'full', 'none'], description: 'Window state at the end: auto (changes since your last read), on_failure, full, or none.' },
			},
		},
	},
];
