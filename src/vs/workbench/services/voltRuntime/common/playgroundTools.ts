/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltHostToolInfo } from './hostTools.js';

/**
 * Playgrounds: throwaway pages an agent drafts, opens and tests in the in-app browser without
 * writing into the project. Benchmarks caught agents (Cursor's included) leaving preview files and
 * `python -m http.server` processes behind after "make a quick draft"; a playground lives in the
 * OS temp folder on its own loopback origin and goes away with one call.
 */
export const PLAYGROUND_TOOL_NAMES = ['playground_create', 'playground_update', 'playground_list', 'playground_delete'] as const;

export type VoltPlaygroundToolName = typeof PLAYGROUND_TOOL_NAMES[number];

const FILES = {
	type: 'object',
	description: 'Relative path → file content, e.g. {"index.html": "<!doctype html>…", "app.js": "…", "data/items.json": "[…]"}. Absolute URLs in the page ("/app.js", "/api/x") resolve on the playground\'s own origin.',
	additionalProperties: { type: 'string' },
};

const STEPS = {
	type: 'array',
	description: 'browser_run steps to run on the page right after it opens (same format as browser_run: actions plus waiting asserts), so building and testing a draft is one call.',
	items: { type: 'object' },
};

const MOCKS = {
	type: 'array',
	description: 'Fake API endpoints on the playground origin, e.g. [{"path":"/api/stats","json":[{"label":"Open","value":3}]},{"path":"/api/fail","status":500,"json":{"error":"boom"},"delay_ms":800}]. A path ending in * matches a prefix.',
	items: {
		type: 'object',
		properties: {
			path: { type: 'string' },
			method: { type: 'string' },
			status: { type: 'number' },
			json: { description: 'Response body as JSON.', anyOf: [{ type: 'object' }, { type: 'array' }, { type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
			body: { type: 'string' },
			content_type: { type: 'string' },
			delay_ms: { type: 'number' },
		},
		required: ['path'],
	},
};

export const PLAYGROUND_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: 'playground_create',
		title: 'Created playground',
		group: 'browser',
		description: 'Create a throwaway web page or mini-site (a draft, prototype, mock UI, component sandbox, or a repro of a bug) and open it in this chat\'s in-app browser, without writing anything into the project. Files live in a temp folder served on their own http://127.0.0.1 origin, so modules, fetch and absolute paths work; mocks fake API endpoints. Pass `steps` to test it in the same call (browser_run format), and keep: false to delete it right after the steps (draft, check, clean up: one call). Otherwise test it with browser_run, iterate with playground_update, and call playground_delete when done (Volt also removes leftovers after a day). Use this instead of creating preview files or starting `python -m http.server` for drafts.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				html: { type: 'string', description: 'Shorthand for files["index.html"].' },
				files: FILES,
				mocks: MOCKS,
				open: { type: 'boolean', description: 'Open it in the in-app browser (default true).' },
				steps: STEPS,
				keep: { type: 'boolean', description: 'false: delete the playground after the steps run (default true).' },
				screenshot: { type: 'boolean', description: 'With steps: attach a screenshot of the final state.' },
				width: { type: 'number', description: 'Viewport width to open it at (e.g. 375 for a phone); default fills the pane.' },
				height: { type: 'number' },
			},
		},
	},
	{
		name: 'playground_update',
		title: 'Updated playground',
		group: 'browser',
		description: 'Change a playground\'s files or mocks (only the files you pass are written; remove deletes paths) and reload it in the in-app browser. Returns the page state.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'From playground_create or playground_list.' },
				html: { type: 'string', description: 'Shorthand for files["index.html"].' },
				files: FILES,
				remove: { type: 'array', items: { type: 'string' } },
				mocks: { ...MOCKS, description: `${MOCKS.description} Replaces the playground's mocks.` },
				reload: { type: 'boolean', description: 'Reload it in the browser (default true).' },
				steps: { ...STEPS, description: 'browser_run steps to run after the reload.' },
			},
			required: ['id'],
		},
	},
	{
		name: 'playground_list',
		title: 'Listed playgrounds',
		group: 'browser',
		description: 'List this chat\'s playgrounds: id, title, URL, files, mocks and how many requests they served.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'playground_delete',
		title: 'Deleted playground',
		group: 'browser',
		description: 'Delete a playground (or all of this chat\'s with all: true): stops its server and removes its files. Do this when a draft has served its purpose.',
		inputSchema: { type: 'object', properties: { id: { type: 'string' }, all: { type: 'boolean' } } },
	},
];
