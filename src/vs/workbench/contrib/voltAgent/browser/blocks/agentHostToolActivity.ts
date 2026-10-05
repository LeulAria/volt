/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASK_QUESTION_TOOL_NAME, AWAIT_ANSWERS_TOOL_NAME, BROWSER_COMPARE_IMAGE_TOOL_NAME, BROWSER_NETWORK_TOOL_NAME, IMAGE_INSPECT_TOOL_NAME, isBrowserToolName, PULL_REQUEST_TOOL_NAMES, voltHostToolName } from '../../../../services/voltRuntime/common/hostTools.js';

/** How one of Volt's own MCP tools reads in the activity trail, the way Cursor words its browser actions. */
export interface IHostToolActivity {
	readonly tool: string;
	readonly label: string;
	readonly detail?: string;
	/** The question tool shows as the tray and the Answers card, not as a row. */
	readonly hidden?: boolean;
}

function parseRecord(input: string | undefined): Record<string, unknown> | undefined {
	if (!input?.trim().startsWith('{')) {
		return undefined;
	}
	try {
		const value = JSON.parse(input) as unknown;
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function text(value: unknown, max = 80): string | undefined {
	const raw = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
	const clean = raw?.replace(/\s+/g, ' ').trim();
	if (!clean) {
		return undefined;
	}
	return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * The host tool behind a tool call and its arguments. Cursor starts the call as a bare "MCP: tool"
 * and later sends `{ providerIdentifier: 'volt', toolName, args }`; Claude names it
 * `mcp__volt__<tool>` and sends the arguments themselves.
 */
export function hostToolCall(name: string | undefined, title: string | undefined, input: string | undefined): { tool: string; args: Record<string, unknown> } | undefined {
	const rec = parseRecord(input);
	const wrapped = rec && typeof rec.toolName === 'string' && (rec.providerIdentifier === 'volt' || rec.args !== undefined);
	const tool = voltHostToolName(name, title) ?? (wrapped ? voltHostToolName(rec.toolName as string) : undefined);
	if (!tool) {
		return undefined;
	}
	const args = wrapped && rec.args && typeof rec.args === 'object' ? rec.args as Record<string, unknown> : (rec && !wrapped ? rec : {});
	return { tool, args };
}

export function describeHostToolActivity(name: string | undefined, title: string | undefined, input: string | undefined): IHostToolActivity | undefined {
	const call = hostToolCall(name, title, input);
	if (!call) {
		return undefined;
	}
	const { tool, args } = call;
	if (tool === ASK_QUESTION_TOOL_NAME || tool === AWAIT_ANSWERS_TOOL_NAME) {
		return { tool, label: 'Asked questions', hidden: true };
	}
	// Design and debugging tools added after the browser actions below.
	if (tool === BROWSER_COMPARE_IMAGE_TOOL_NAME) {
		return { tool, label: 'Compared with design', detail: text(args.reference_path, 120) };
	}
	if (tool === BROWSER_NETWORK_TOOL_NAME) {
		return { tool, label: 'Read network' };
	}
	if ((PULL_REQUEST_TOOL_NAMES as readonly string[]).includes(tool)) {
		const which = typeof args.number === 'number' || (typeof args.number === 'string' && args.number) ? `#${args.number}` : text(args.url, 80);
		switch (tool) {
			case 'link_pull_request': return { tool, label: 'Linked pull request', detail: which };
			case 'unlink_pull_request': return { tool, label: 'Unlinked pull request', detail: which };
			case 'watch_pull_request': return { tool, label: 'Watching pull request', detail: which };
			case 'unwatch_pull_request': return { tool, label: 'Stopped watching', detail: which };
			default: return { tool, label: 'Listed pull requests' };
		}
	}
	if (tool === IMAGE_INSPECT_TOOL_NAME) {
		return { tool, label: 'Inspected image', detail: text(args.path, 120) };
	}
	if (!isBrowserToolName(tool)) {
		return undefined;
	}
	const element = text(args.element);
	switch (tool) {
		case 'browser_navigate':
			return { tool, label: 'Navigated to', detail: text(args.url, 120) };
		case 'browser_snapshot':
			return { tool, label: 'Read page' };
		case 'browser_click':
			return { tool, label: args.doubleClick === true ? 'Double-clicked' : 'Clicked', detail: element ?? text(args.ref) };
		case 'browser_type': {
			const typed = text(args.text, 40);
			return { tool, label: 'Typed', detail: [typed ? `"${typed}"` : undefined, element ? `into ${element}` : undefined].filter(Boolean).join(' ') || undefined };
		}
		case 'browser_press_key':
			return { tool, label: 'Pressed', detail: text(args.key) };
		case 'browser_hover':
			return { tool, label: 'Hovered', detail: element ?? text(args.ref) };
		case 'browser_select_option': {
			const values = Array.isArray(args.values) ? args.values.map(value => String(value)).join(', ') : undefined;
			return { tool, label: 'Selected', detail: [text(values, 40), element ? `in ${element}` : undefined].filter(Boolean).join(' ') || undefined };
		}
		case 'browser_scroll': {
			const dy = typeof args.deltaY === 'number' ? args.deltaY : 0;
			return { tool, label: 'Scrolled', detail: element ?? (dy < 0 ? 'up' : 'down') };
		}
		case 'browser_resize':
			return args.reset === true || !(typeof args.width === 'number' && typeof args.height === 'number')
				? { tool, label: 'Reset viewport' }
				: { tool, label: 'Resized browser to', detail: `${args.width}×${args.height}` };
		case 'browser_wait_for': {
			const target = text(args.text) ?? text(args.textGone);
			if (target) {
				return { tool, label: args.text ? 'Waited for' : 'Waited for removal of', detail: `"${target}"` };
			}
			return { tool, label: 'Waited', detail: typeof args.time === 'number' ? `${args.time}s` : undefined };
		}
		case 'browser_evaluate':
			return { tool, label: 'Evaluated', detail: text(args.expression, 60) };
		case 'browser_console_messages':
			return { tool, label: 'Read console' };
		case 'browser_navigate_back':
			return { tool, label: 'Went back' };
		case 'browser_reload':
			return { tool, label: 'Reloaded page' };
		case 'browser_screenshot':
			return { tool, label: 'Took screenshot' };
	}
}

/** Two argument sets name the same call: the agent's echo of a host call may drop or reorder keys. */
export function sameHostToolArgs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
			return false;
		}
	}
	return true;
}
