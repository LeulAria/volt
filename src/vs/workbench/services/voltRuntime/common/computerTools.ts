/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltHostToolInfo } from './hostTools.js';

/**
 * Desktop computer use (macOS): native apps outside the in-app browser. Agents read an app's
 * accessibility tree and act on its elements in the background (no cursor jump, no focus theft),
 * and fall back to batched mouse and keyboard input for what the tree does not expose. Off until
 * the user enables `volt.computerUse.enabled`; macOS also asks them for Accessibility access.
 */
export const COMPUTER_USE_SETTING = 'volt.computerUse.enabled';

export const COMPUTER_TOOL_NAMES = ['computer_status', 'computer_apps', 'computer_ui', 'computer_act', 'computer_input'] as const;
export type VoltComputerToolName = typeof COMPUTER_TOOL_NAMES[number];

const APP = { type: 'string', description: 'App name ("Notes"), bundle id ("com.apple.Notes") or pid from computer_apps. Default: the frontmost app.' };

export const COMPUTER_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: 'computer_status',
		title: 'Checked computer access',
		group: 'computer',
		description: 'Whether Volt may control this Mac\'s apps (Accessibility) and see its screen (Screen Recording), the frontmost app and the screen size. With request: true, macOS asks the user to grant what is missing. Call it before the other computer_* tools if one fails with a permission error.',
		inputSchema: { type: 'object', properties: { request: { type: 'boolean' } } },
	},
	{
		name: 'computer_apps',
		title: 'Listed apps',
		group: 'computer',
		description: 'List the running apps (name, bundle id, pid, active, hidden).',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'computer_ui',
		title: 'Read app UI',
		group: 'computer',
		description: 'Read the accessibility tree of an app\'s front window, one line per element: [id] role "name" value=… actions=[press,…] at x,y w×h. Act on elements with computer_act by id (background, reliable) before falling back to computer_input coordinates. Ids are paths and change when the UI changes; read again after big changes. Use window_capture to see the window.',
		inputSchema: { type: 'object', properties: { app: APP, max_depth: { type: 'number', description: 'Default 12.' }, filter: { type: 'string', description: 'Only lines containing this text (case-insensitive), with their ids.' } } },
	},
	{
		name: 'computer_act',
		title: 'Acted in app',
		group: 'computer',
		approvalInReadOnlyModes: 'acts in another app',
		description: 'Act on one element from computer_ui without moving the mouse: press (buttons, menu items, checkboxes), set_value (text fields: replaces the text), focus, show_menu, raise (windows), confirm, cancel, increment, decrement. Returns the element afterwards. Never enter passwords or payment details, and ask the user before deleting, sending or buying anything.',
		inputSchema: {
			type: 'object',
			properties: { app: APP, id: { type: 'string', description: 'Element id from computer_ui, e.g. "w.0.3.1".' }, action: { type: 'string', enum: ['press', 'set_value', 'focus', 'show_menu', 'raise', 'confirm', 'cancel', 'increment', 'decrement'] }, value: { type: 'string' } },
			required: ['id', 'action'],
		},
	},
	{
		name: 'computer_input',
		title: 'Used mouse and keyboard',
		group: 'computer',
		approvalInReadOnlyModes: 'controls the mouse and keyboard',
		description: 'Run several mouse/keyboard steps in one call, in order, on the real cursor and keyboard (the app comes to the front first): {"click":{"x":100,"y":200,"button":"right","count":2}}, {"move":{…}}, {"drag":{"from":{x,y},"to":{x,y}}}, {"type":"text"}, {"key":"cmd+s"}, {"scroll":{"x":…,"y":…,"dy":300}}, {"wait":500}. Coordinates are screen points, the frame values computer_ui reports. Prefer computer_act; the user cannot use the computer while this runs. Never enter passwords, and ask before destructive or irreversible actions.',
		inputSchema: {
			type: 'object',
			properties: { app: APP, actions: { type: 'array', items: { type: 'object' } } },
			required: ['actions'],
		},
	},
];

export interface IComputerNode {
	readonly id: string;
	readonly role: string;
	readonly depth: number;
	readonly name?: string;
	readonly value?: string;
	readonly actions?: readonly string[];
	readonly disabled?: boolean;
	readonly focused?: boolean;
	readonly frame?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export function formatComputerNode(node: IComputerNode): string {
	const parts = [`${'  '.repeat(Math.min(node.depth, 12))}[${node.id}] ${node.role}`];
	if (node.name) {
		parts.push(JSON.stringify(node.name));
	}
	if (node.value !== undefined) {
		parts.push(`value=${JSON.stringify(node.value.length > 80 ? `${node.value.slice(0, 77)}…` : node.value)}`);
	}
	if (node.actions?.length) {
		parts.push(`actions=[${node.actions.join(',')}]`);
	}
	if (node.disabled) {
		parts.push('disabled');
	}
	if (node.focused) {
		parts.push('focused');
	}
	if (node.frame) {
		parts.push(`at ${node.frame.x},${node.frame.y} ${node.frame.w}×${node.frame.h}`);
	}
	return parts.join(' ');
}

export function formatComputerTree(title: string, nodes: readonly IComputerNode[], truncated: boolean, filter?: string): string {
	const wanted = filter?.trim().toLowerCase();
	const lines = nodes.map(formatComputerNode).filter(line => !wanted || line.toLowerCase().includes(wanted));
	return [`### ${title || 'Window'}: ${nodes.length} element(s)${wanted ? `, ${lines.length} matching "${filter}"` : ''}${truncated ? ' (cut at the limit; pass filter or a lower max_depth)' : ''}`, ...lines].join('\n');
}

/** Validates computer_input steps before anything moves. */
export function parseComputerActions(input: unknown): { actions: object[]; errors: string[] } {
	const errors: string[] = [];
	const actions: object[] = [];
	const list = Array.isArray(input) ? input : [];
	if (!list.length) {
		return { actions, errors: ['`actions` must be a non-empty array'] };
	}
	const pointOk = (p: unknown) => !!p && typeof p === 'object' && Number.isFinite((p as { x?: unknown }).x) && Number.isFinite((p as { y?: unknown }).y);
	list.slice(0, 40).forEach((raw, index) => {
		const step = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
		const where = `step ${index + 1}`;
		if ('click' in step || 'move' in step) {
			if (!pointOk(step.click ?? step.move)) { errors.push(`${where}: needs {x, y}`); return; }
		} else if ('drag' in step) {
			const d = step.drag as Record<string, unknown> | undefined;
			if (!d || !pointOk(d.from) || !pointOk(d.to)) { errors.push(`${where}: drag needs from and to {x, y}`); return; }
		} else if ('type' in step) {
			if (typeof step.type !== 'string') { errors.push(`${where}: type needs text`); return; }
		} else if ('key' in step) {
			if (typeof step.key !== 'string' || !/^((cmd|command|meta|shift|alt|option|opt|ctrl|control|fn)\+)*[^+]+$/i.test(step.key)) { errors.push(`${where}: key like "cmd+s" or "return"`); return; }
		} else if ('scroll' in step) {
			if (!step.scroll || typeof step.scroll !== 'object') { errors.push(`${where}: scroll needs {dy}`); return; }
		} else if ('wait' in step) {
			if (typeof step.wait !== 'number') { errors.push(`${where}: wait needs milliseconds`); return; }
		} else {
			errors.push(`${where}: use one of click, move, drag, type, key, scroll, wait`);
			return;
		}
		actions.push(step);
	});
	if (list.length > 40) {
		errors.push('At most 40 steps per call.');
	}
	return { actions, errors };
}

/** Finds an app by pid, bundle id or (case-insensitive, then partial) name. */
export function pickApp<T extends { readonly name: string; readonly bundleId: string; readonly pid: number; readonly active?: boolean }>(apps: readonly T[], query: string | undefined): T | undefined {
	const q = query?.trim();
	if (!q) {
		return apps.find(app => app.active);
	}
	if (/^\d+$/.test(q)) {
		return apps.find(app => app.pid === Number(q));
	}
	const lower = q.toLowerCase();
	return apps.find(app => app.bundleId.toLowerCase() === lower) ?? apps.find(app => app.name.toLowerCase() === lower) ?? apps.find(app => app.name.toLowerCase().includes(lower));
}
