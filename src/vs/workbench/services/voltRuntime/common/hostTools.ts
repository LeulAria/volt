/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CAPTURE_TOOL_NAMES, DEVICE_TOOL_NAMES } from './deviceTools.js';
import { isMemoryToolName } from './memory/voltMemory.js';
import type { VoltMode } from './modes.js';
import type { AgentQuestionDraft, IAgentQuestionResponse } from './questions.js';
import { PROPOSE_PLAN_TOOL_NAME } from './plans.js';
import type { IRgbaImage } from './tools/imageAnalysis.js';

export const IVoltHostToolService = createDecorator<IVoltHostToolService>('voltHostToolService');

export const ASK_QUESTION_TOOL_NAME = 'ask_question';
export const BROWSER_SCREENSHOT_TOOL_NAME = 'browser_screenshot';
export const BROWSER_SNAPSHOT_TOOL_NAME = 'browser_snapshot';
export const CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID = 'volt.browser.captureSnapshot';
/**
 * Runs one `browser_*` tool against a chat's own browser tab:
 * `(sessionId, action, args, options?: IVoltBrowserAutomationOptions) => IVoltHostToolResult`.
 * Calls for one chat run one at a time, in order.
 */
export const AUTOMATE_BROWSER_COMMAND_ID = 'volt.browser.automate';
/** `(sessionId) => string | undefined`: the URL of the page in the chat's browser tab, if it has one. */
export const BROWSER_PAGE_URL_COMMAND_ID = 'volt.browser.pageUrl';

export const BROWSER_COMPARE_IMAGE_TOOL_NAME = 'browser_compare_image';

/**
 * Visual replies: a native chart from a JSON spec, a sandboxed HTML page, and a screenshot check of
 * a page. The page tools carry T3 Code's names (`html_render`, `html_preview`), which agents and
 * users already know; Volt's first names for them still work (see `LEGACY_TOOL_NAMES`).
 */
export const RENDER_CHART_TOOL_NAME = 'render_chart';
export const RENDER_HTML_TOOL_NAME = 'html_render';
export const PREVIEW_HTML_TOOL_NAME = 'html_preview';
export const VISUAL_TOOL_NAMES = [RENDER_CHART_TOOL_NAME, RENDER_HTML_TOOL_NAME, PREVIEW_HTML_TOOL_NAME, 'render_html', 'preview_html'] as const;

/** Earlier names of host tools, still accepted from agents and read in stored transcripts. */
export const LEGACY_TOOL_NAMES: Readonly<Record<string, string>> = {
	render_html: RENDER_HTML_TOOL_NAME,
	preview_html: PREVIEW_HTML_TOOL_NAME,
};

/** The current name of a host tool an agent may call by an earlier one. */
export function canonicalHostToolName(name: string): string {
	return LEGACY_TOOL_NAMES[name] ?? name;
}

/** A visual a render tool published: where its spec or page is stored, for the transcript to draw. */
export interface IVoltVisualRef {
	readonly kind: 'chart' | 'html';
	/** `volt-attachment:<hash>.json` (chart spec) or `.html` (page). */
	readonly ref: string;
	readonly title: string;
	/** Pages: the height the page needed at the reply column's width, so the frame opens at its size. */
	readonly height?: number;
	/** Pages: `[width, height]` measured at several reader widths, so a narrower chat opens at the right size too. */
	readonly heights?: readonly (readonly [number, number])[];
	/** Pages: the agent's cap on the frame height; taller content scrolls inside. */
	readonly cap?: number;
}
export const BROWSER_NETWORK_TOOL_NAME = 'browser_network';
export const IMAGE_INSPECT_TOOL_NAME = 'image_inspect';

/**
 * `core`: questions. `browser`: the in-app browser. `image`: reading image files. `threads`: other
 * chats, their queues and checkouts (an agent as orchestrator). `pullRequests`:
 * linking and watching the chat's pull requests. `visuals`: charts and pages shown in the reply. `devices`: iOS simulators
 * and Android emulators. `capture`: screenshots and recordings of windows. An agent can be
 * handed a subset (`getMcpServers(sessionId, { groups })`) to keep its tool list short.
 */
export type VoltHostToolGroup = 'core' | 'browser' | 'image' | 'tasks' | 'threads' | 'pullRequests' | 'visuals' | 'devices' | 'capture' | 'memory';

export interface IVoltHostToolInfo {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: object;
	readonly group?: VoltHostToolGroup;
	/**
	 * Why Ask and Plan modes (read-only) need the user's approval to run it, e.g. "taps on the
	 * simulator". Unset: it runs in every mode.
	 */
	readonly approvalInReadOnlyModes?: string;
}

export interface IVoltHostToolResult {
	readonly text?: string;
	readonly image?: string;
	readonly error?: string;
	/** Set by the render tools: the transcript draws it above the reply. */
	readonly visual?: IVoltVisualRef;
}

export interface IVoltMcpServer {
	readonly type: 'http';
	readonly name: string;
	readonly url: string;
	readonly headers: readonly { readonly name: string; readonly value: string }[];
}

export interface IVoltHostToolCall {
	/** The Volt chat whose agent made the call (from the MCP URL, or the native loop's context), if known. */
	readonly sessionId?: string;
	readonly token?: CancellationToken;
	/** The chat's mode, when the caller knows it (native loop). Otherwise the session resolver answers. */
	readonly mode?: VoltMode;
	/** Folder relative paths resolve against (native loop). Otherwise the chat's worktree or the workspace. */
	readonly cwd?: string;
	/** `native`: Volt's own loop, which draws its own tool rows, so no `onDidInvokeTool` event. Default `mcp`. */
	readonly source?: 'mcp' | 'native';
	/** An agent outside Volt called it over the OAuth MCP server (no chat; `sessionId` is unset). */
	readonly external?: IVoltExternalCaller;
}

/** Who an outside agent is, from the grant the user approved. */
export interface IVoltExternalCaller {
	readonly grantId: string;
	readonly clientId: string;
	/** The name it registered with (unverified), e.g. "Claude Code". */
	readonly name: string;
	readonly scopes: readonly string[];
}

/** What the host tools need to know about a chat they serve. */
export interface IVoltHostSessionResolver {
	/** The mode of the chat's latest run, or undefined when no run was seen. */
	mode(sessionId: string): VoltMode | undefined;
	/** The folder the chat's agent works in (its worktree), when it differs from the workspace. */
	cwd(sessionId: string): string | undefined;
}

export interface IVoltHostToolApproval {
	readonly sessionId: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly mode: VoltMode;
	/** Why the mode does not allow it on its own, e.g. "runs JavaScript in the page". */
	readonly reason: string;
}

/** Asks the user to allow one host tool call that the chat's mode would not run on its own. */
export interface IVoltHostToolApprover {
	approve(request: IVoltHostToolApproval, token: CancellationToken): Promise<boolean>;
}

/** Extra inputs for `AUTOMATE_BROWSER_COMMAND_ID`. */
export interface IVoltBrowserAutomationOptions {
	/** Cancels the call (agent dropped the request, run cancelled). */
	readonly token?: CancellationToken;
	/** `browser_compare_image`: the decoded reference image and how to name it in the result. */
	readonly reference?: IRgbaImage;
	readonly referenceLabel?: string;
}

/** A host tool ran for a chat; the transcript attaches the result to the agent's matching tool row. */
export interface IVoltHostToolInvocation {
	readonly sessionId: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly result: IVoltHostToolResult;
}

export interface IVoltQuestionHandler {
	/** Opens the tray in `sessionId` and returns the request id. */
	ask(sessionId: string, draft: AgentQuestionDraft): string;
	/** Resolves with the answers, or undefined after `ms` (the agent polls again with `await_answers`). */
	wait(requestId: string, ms: number, token: CancellationToken): Promise<IAgentQuestionResponse | undefined>;
}

export const AWAIT_ANSWERS_TOOL_NAME = 'await_answers';

const REF = { type: 'string', description: 'Exact target element reference from the latest page snapshot (e.g. "e12").' };
const ELEMENT = { type: 'string', description: 'Human-readable element description used to obtain permission to interact with the element, shown to the user (e.g. "Top-left cell").' };
const PAGE_STATE_NOTE = 'Returns the page URL, title and an accessibility snapshot with element refs.';
const SCREENSHOT_AFTER = { type: 'boolean', description: 'Also return a screenshot after the action (saves a browser_screenshot call).' };
const RECT = {
	type: 'object',
	properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
	required: ['x', 'y', 'w', 'h'],
};

export const BROWSER_TOOL_NAMES = [
	'browser_navigate',
	'browser_snapshot',
	'browser_click',
	'browser_type',
	'browser_press_key',
	'browser_hover',
	'browser_select_option',
	'browser_scroll',
	'browser_resize',
	'browser_wait_for',
	'browser_evaluate',
	'browser_console_messages',
	'browser_navigate_back',
	'browser_reload',
	BROWSER_SCREENSHOT_TOOL_NAME,
] as const;

export type VoltBrowserToolName = typeof BROWSER_TOOL_NAMES[number];

/** Browser tools for design and debugging work, added after the activity trail named the ones above. */
export const BROWSER_DESIGN_TOOL_NAMES = [BROWSER_COMPARE_IMAGE_TOOL_NAME, BROWSER_NETWORK_TOOL_NAME] as const;

/** Every tool the chat's browser tab runs (`AUTOMATE_BROWSER_COMMAND_ID`). */
export type VoltBrowserAutomationToolName = VoltBrowserToolName | typeof BROWSER_DESIGN_TOOL_NAMES[number];

export const VOLT_HOST_TOOLS: readonly IVoltHostToolInfo[] = [
	{
		name: ASK_QUESTION_TOOL_NAME,
		title: 'Asked questions',
		group: 'core',
		description: 'Ask the user one or more multiple-choice questions in Volt and wait for the answers. Use it to clarify requirements, preferences or trade-offs before doing work, instead of writing the options into your reply. Every question automatically gets an "Other" free-text choice, and the user can add extra details, so do not add an "Other" option yourself. Keep options short (under ~10 words) and mutually exclusive; set allow_multiple for pick-any questions. The call waits for the user; if it returns STILL WAITING, immediately call await_answers with the request_id and keep calling it until the answers arrive. Never end your turn while questions are open.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Optional short heading for the set of questions.' },
				questions: {
					type: 'array',
					minItems: 1,
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', description: 'Stable id for the question, e.g. "game_mode".' },
							prompt: { type: 'string', description: 'The question text.' },
							options: {
								type: 'array',
								minItems: 2,
								items: {
									type: 'object',
									properties: {
										id: { type: 'string' },
										label: { type: 'string' },
									},
									required: ['id', 'label'],
								},
							},
							allow_multiple: { type: 'boolean', description: 'True when the user may pick several options.' },
						},
						required: ['id', 'prompt', 'options'],
					},
				},
			},
			required: ['questions'],
		},
	},
	{
		name: AWAIT_ANSWERS_TOOL_NAME,
		title: 'Waited for answers',
		group: 'core',
		description: 'Keep waiting for the user\'s answers to an ask_question call that returned "still answering". Call it right away with the request_id it gave; do nothing else meanwhile.',
		inputSchema: { type: 'object', properties: { request_id: { type: 'string' } }, required: ['request_id'] },
	},
	{
		name: PROPOSE_PLAN_TOOL_NAME,
		title: 'Proposed plan',
		group: 'core',
		description: 'Present an implementation plan for the user to approve, revise or edit in Volt. Use it in Plan mode, after you have investigated, instead of writing the plan into your reply or using a built-in plan tool. Give a short title and the plan in Markdown: the approach, the files to change, ordered steps, risks, and how to verify. Put anything only the user can decide in open_questions. Then stop and wait: do not implement the plan until the user approves it.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Short title, e.g. "Add dark mode toggle".' },
				plan: { type: 'string', description: 'The plan in Markdown: approach, files to change, steps, risks, how to verify.' },
				open_questions: { type: 'array', items: { type: 'string' }, description: 'Decisions the user must make before building.' },
			},
			required: ['title', 'plan'],
		},
	},
	{
		name: 'browser_navigate',
		title: 'Navigated to',
		group: 'browser',
		description: `Open a URL in this chat's Volt in-app browser (the tab beside the chat; it opens if needed) and wait for it to load. Use it to preview and test local dev servers or files (http://localhost:3000, file:///path/index.html). ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The URL to open.' }, screenshot: SCREENSHOT_AFTER }, required: ['url'] },
	},
	{
		name: 'browser_snapshot',
		title: 'Read page',
		group: 'browser',
		description: `Capture an accessibility snapshot of the current page in the in-app browser. Better than a screenshot for deciding what to click. ${PAGE_STATE_NOTE}`,
		inputSchema: {
			type: 'object',
			properties: {
				selector: { type: 'string', description: 'Optional CSS selector: snapshot only this subtree.' },
				interactive: { type: 'boolean', description: 'Only list interactive elements (buttons, links, inputs). Much shorter.' },
			},
		},
	},
	{
		name: 'browser_click',
		title: 'Clicked',
		group: 'browser',
		description: `Click an element in the in-app browser with a real (trusted) mouse click. Take a snapshot first to get refs; or pass x/y viewport coordinates instead of a ref. ${PAGE_STATE_NOTE}`,
		inputSchema: {
			type: 'object',
			properties: {
				element: ELEMENT,
				ref: REF,
				x: { type: 'number', description: 'Viewport x in CSS px (instead of ref).' },
				y: { type: 'number', description: 'Viewport y in CSS px (instead of ref).' },
				doubleClick: { type: 'boolean' },
				button: { type: 'string', enum: ['left', 'right', 'middle'] },
				screenshot: SCREENSHOT_AFTER,
			},
			required: ['element'],
		},
	},
	{
		name: 'browser_type',
		title: 'Typed',
		group: 'browser',
		description: `Type text into an editable element in the in-app browser. ${PAGE_STATE_NOTE}`,
		inputSchema: {
			type: 'object',
			properties: {
				element: ELEMENT,
				ref: REF,
				text: { type: 'string' },
				submit: { type: 'boolean', description: 'Press Enter after typing.' },
				clear: { type: 'boolean', description: 'Replace the current value instead of appending (default true).' },
				screenshot: SCREENSHOT_AFTER,
			},
			required: ['element', 'ref', 'text'],
		},
	},
	{
		name: 'browser_press_key',
		title: 'Pressed',
		group: 'browser',
		description: `Press a key in the in-app browser, e.g. "Enter", "Escape", "ArrowLeft", "a", "Meta+a". ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { key: { type: 'string' }, screenshot: SCREENSHOT_AFTER }, required: ['key'] },
	},
	{
		name: 'browser_hover',
		title: 'Hovered',
		group: 'browser',
		description: `Move the mouse over an element in the in-app browser. ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { element: ELEMENT, ref: REF, screenshot: SCREENSHOT_AFTER }, required: ['element', 'ref'] },
	},
	{
		name: 'browser_select_option',
		title: 'Selected',
		group: 'browser',
		description: `Select option(s) in a <select> in the in-app browser. ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { element: ELEMENT, ref: REF, values: { type: 'array', items: { type: 'string' } }, screenshot: SCREENSHOT_AFTER }, required: ['element', 'ref', 'values'] },
	},
	{
		name: 'browser_scroll',
		title: 'Scrolled',
		group: 'browser',
		description: `Scroll the page (or the element with ref) in the in-app browser by deltaY pixels (negative scrolls up). ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { element: ELEMENT, ref: REF, deltaY: { type: 'number' }, deltaX: { type: 'number' }, screenshot: SCREENSHOT_AFTER } },
	},
	{
		name: 'browser_resize',
		title: 'Resized browser',
		group: 'browser',
		description: `Set the in-app browser viewport to width x height CSS pixels to test responsive layouts (e.g. 390x844 for a phone). Pass reset: true to fill the pane again. ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, reset: { type: 'boolean' }, screenshot: SCREENSHOT_AFTER } },
	},
	{
		name: 'browser_wait_for',
		title: 'Waited',
		group: 'browser',
		description: `Wait until text appears or disappears on the page, or for a number of seconds (max 30). ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { text: { type: 'string' }, textGone: { type: 'string' }, time: { type: 'number', description: 'Seconds' }, screenshot: SCREENSHOT_AFTER } },
	},
	{
		name: 'browser_evaluate',
		title: 'Evaluated',
		group: 'browser',
		description: 'Evaluate a JavaScript expression (or `() => {...}` function) in the page and return its JSON result. Use for measurements the snapshot does not show (sizes, scroll width, computed styles). Needs approval in Ask and Plan modes.',
		inputSchema: { type: 'object', properties: { expression: { type: 'string' }, element: ELEMENT, ref: { ...REF, description: 'Optional element ref; the function receives the element as its argument.' } }, required: ['expression'] },
	},
	{
		name: 'browser_console_messages',
		title: 'Read console',
		group: 'browser',
		description: 'Return the in-app browser page\'s console messages and uncaught errors since the last navigation.',
		inputSchema: { type: 'object', properties: { errorsOnly: { type: 'boolean', description: 'Only errors and warnings.' } } },
	},
	{
		name: BROWSER_NETWORK_TOOL_NAME,
		title: 'Read network',
		group: 'browser',
		description: 'List the page\'s network requests since it loaded, failed ones first (HTTP 4xx/5xx, connection and CORS errors), then the slowest and largest. Use it when assets, fonts or API calls do not show up.',
		inputSchema: {
			type: 'object',
			properties: {
				filter: { type: 'string', description: 'Only requests whose URL contains this text.' },
				all: { type: 'boolean', description: 'List every request (up to 100), not just failures and outliers.' },
			},
		},
	},
	{
		name: 'browser_navigate_back',
		title: 'Went back',
		group: 'browser',
		description: `Go back in the in-app browser history. ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { screenshot: SCREENSHOT_AFTER } },
	},
	{
		name: 'browser_reload',
		title: 'Reloaded',
		group: 'browser',
		description: `Reload the current page in the in-app browser (after editing files). ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { screenshot: SCREENSHOT_AFTER } },
	},
	{
		name: BROWSER_SCREENSHOT_TOOL_NAME,
		title: 'Took screenshot',
		group: 'browser',
		description: 'Take a screenshot of the current page (or one element) in the in-app browser to check how it looks. One image pixel is one CSS pixel up to max_side. The result lists the interactive elements in the image with refs and their boxes in image pixels, so you can act on what you see by ref; a follow-up screenshot of the same page lists only the changes. Use browser_compare_image to check a page against a design image.',
		inputSchema: {
			type: 'object',
			properties: {
				ref: { ...REF, description: 'Optional element ref: capture only this element.' },
				format: { type: 'string', enum: ['jpeg', 'png', 'webp'], description: 'Default jpeg (smallest). png for pixel-exact checks.' },
				max_side: { type: 'number', description: 'Longest side in pixels, 256-2560. Default 1280.' },
				ax: { type: 'string', enum: ['auto', 'full', 'off'], description: 'Element list: auto (default: full on the first capture of a page, changes after that), full, or off.' },
				max_elements: { type: 'number', description: 'Most elements to list, 5-200. Default 60.' },
				marks: { type: 'boolean', description: 'Draw a red outline and its ref on each listed element in the image.' },
			},
		},
	},
	{
		name: BROWSER_COMPARE_IMAGE_TOOL_NAME,
		title: 'Compared with design',
		group: 'browser',
		description: 'Check the page against a reference image (a design or mockup) in one call: reloads the page, renders it at the image\'s size, pixel-diffs the two and returns the mismatch %, the largest differing regions with their likely cause (shifted by N px, missing or extra content, colour A vs B), blocks and text lines that moved or changed size (exact px), and a small heatmap. Repeat after each fix until the mismatch is low. Leaves the viewport at the image size.',
		inputSchema: {
			type: 'object',
			properties: {
				reference_path: { type: 'string', description: 'Reference image (PNG, JPEG, WebP), absolute or relative to the workspace.' },
				url: { type: 'string', description: 'Open this URL first (otherwise the current page).' },
				width: { type: 'number', description: 'Viewport width in CSS px. Default: image width / scale.' },
				height: { type: 'number', description: 'Viewport height in CSS px. Default: image height / scale.' },
				scale: { type: 'number', description: 'Image pixels per CSS pixel: 2 for an @2x export. Default 1.' },
				region: { ...RECT, description: 'Only compare this rectangle (reference pixels).' },
				threshold: { type: 'number', description: 'Per-channel difference (0-255) above which a pixel counts as different. Default 16.' },
				reload: { type: 'boolean', description: 'Reload before capturing (default true). false keeps the current page state.' },
				image: { type: 'string', enum: ['heatmap', 'side_by_side', 'none'], description: 'heatmap (default): differences in red; side_by_side: reference | page | heatmap; none: text only.' },
			},
			required: ['reference_path'],
		},
	},
	{
		name: IMAGE_INSPECT_TOOL_NAME,
		title: 'Inspected image',
		group: 'image',
		description: 'Read exact values from an image file (a design, mockup or screenshot) instead of guessing or writing decode scripts: size, background and palette colours, solid blocks (cards, bars, buttons) with exact pixel bounds and fill, text-like bands (line positions and heights), colours at points, region stats, and an optional zoomed crop for reading small text.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Image file (PNG, JPEG, WebP, GIF, BMP), absolute or relative to the workspace.' },
				points: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }, description: 'Pixels to sample exact colours at.' },
				regions: { type: 'array', items: RECT, description: 'Rectangles to summarise (average colour, palette, content box).' },
				crop: { ...RECT, description: 'Return this rectangle as a zoomed image.' },
			},
			required: ['path'],
		},
	},
];

const TOOL_PREFIX_RE = /^(?:mcp__volt__|volt[-_:]\s*|volt\.)/i;

/**
 * The bare host tool behind an agent's name for it: `browser_click`, `mcp__volt__browser_click`
 * (Claude), `volt: browser_click` or `volt-browser_click: browser_click` (Cursor).
 */
/** Pull request tools (registered by the pull request service): safe, they only change Volt's own state. */
export const PULL_REQUEST_TOOL_NAMES = ['link_pull_request', 'unlink_pull_request', 'list_thread_pull_requests', 'watch_pull_request', 'unwatch_pull_request', 'stack_status', 'stack_branch', 'restack_stack'] as const;

/** Scheduled task tools (registered by the schedule service): they only change Volt's own state. */
export const SCHEDULE_TOOL_NAMES = ['schedule_task', 'list_scheduled_tasks', 'update_scheduled_task', 'delete_scheduled_task', 'run_scheduled_task_now'] as const;

/**
 * Orchestration tools (registered by the thread tool service): an agent reads, messages, forks and
 * launches other chats, and manages their queues. They change Volt's own state; mode and caller
 * checks live in the service.
 */
export const THREAD_TOOL_NAMES = [
	'orchestrator_capabilities',
	'thread_list',
	'thread_search',
	'thread_read',
	'thread_send',
	'thread_wait',
	'thread_interrupt',
	'thread_fork',
	'thread_merge_back',
	'thread_launch',
	'thread_update',
	'thread_configure',
	'queue_list',
	'queue_edit',
	'queue_cancel',
	'queue_reorder',
	'queue_send_now',
	'queue_resume',
	'worktree_status',
	'worktree_list',
	'worktree_handoff',
] as const;

export type VoltThreadToolName = typeof THREAD_TOOL_NAMES[number];

export function voltHostToolName(name?: string, title?: string): string | undefined {
	for (const raw of [name, title]) {
		const value = (raw ?? '').trim();
		if (!value) {
			continue;
		}
		const tail = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1).trim() : value;
		for (const candidate of [value.replace(TOOL_PREFIX_RE, '').trim(), tail.replace(TOOL_PREFIX_RE, '').trim()]) {
			const id = candidate.toLowerCase();
			if (VOLT_HOST_TOOLS.some(tool => tool.name === id) || (PULL_REQUEST_TOOL_NAMES as readonly string[]).includes(id) || (VISUAL_TOOL_NAMES as readonly string[]).includes(id) || (SCHEDULE_TOOL_NAMES as readonly string[]).includes(id) || (DEVICE_TOOL_NAMES as readonly string[]).includes(id) || (CAPTURE_TOOL_NAMES as readonly string[]).includes(id) || (THREAD_TOOL_NAMES as readonly string[]).includes(id) || isMemoryToolName(id)) {
				return canonicalHostToolName(id);
			}
		}
	}
	return undefined;
}

export function isVoltHostTool(name?: string, title?: string): boolean {
	return !!voltHostToolName(name, title);
}

export function isBrowserToolName(name: string | undefined): name is VoltBrowserToolName {
	return !!name && (BROWSER_TOOL_NAMES as readonly string[]).includes(name);
}

export function isBrowserAutomationTool(name: string | undefined): name is VoltBrowserAutomationToolName {
	return isBrowserToolName(name) || (!!name && (BROWSER_DESIGN_TOOL_NAMES as readonly string[]).includes(name));
}

/**
 * Pages an agent may open and drive in read-only modes without asking: loopback dev servers
 * (localhost, *.localhost, 127.0.0.0/8, [::1], 0.0.0.0) and local documents (file:, about:, data:).
 * LAN addresses are not local: they can be a router or another person's device.
 */
export function isLocalBrowserUrl(value: string | undefined): boolean {
	const raw = value?.trim();
	if (!raw) {
		return false;
	}
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^localhost:/i.test(raw) ? raw : `http://${raw}`);
	} catch {
		return false;
	}
	if (url.protocol === 'file:' || url.protocol === 'about:' || url.protocol === 'data:') {
		return true;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return false;
	}
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(host);
}

export type BrowserToolVerdict =
	| { readonly kind: 'allow' }
	| { readonly kind: 'ask'; readonly reason: string };

const ALLOW: BrowserToolVerdict = { kind: 'allow' };

function hostOf(value: string | undefined): string {
	try {
		return new URL(value ?? '').host || (value ?? '');
	} catch {
		return value ?? '';
	}
}

/**
 * Whether a browser tool may run in `mode` on its own. Ask and Plan are read-only: looking at
 * local pages is fine, but running script, opening other sites, or clicking and typing on a
 * non-local page (where the user may be signed in) needs the user's approval.
 * `pageUrl` is the page the chat's browser shows now; interactions are judged by it.
 */
export function browserToolVerdict(name: string, args: Record<string, unknown>, mode: VoltMode | undefined, pageUrl?: string): BrowserToolVerdict {
	if (mode !== 'ask' && mode !== 'plan') {
		return ALLOW;
	}
	const target = typeof args.url === 'string' ? args.url : undefined;
	switch (name) {
		case 'browser_evaluate':
			return { kind: 'ask', reason: 'runs JavaScript in the page' };
		case 'browser_navigate':
		case BROWSER_COMPARE_IMAGE_TOOL_NAME:
			if (name === BROWSER_COMPARE_IMAGE_TOOL_NAME && !target) {
				return ALLOW;
			}
			return isLocalBrowserUrl(target) ? ALLOW : { kind: 'ask', reason: `opens ${hostOf(target) || 'a site'}, which is not a local page` };
		case 'browser_click':
		case 'browser_type':
		case 'browser_press_key':
		case 'browser_select_option':
			return !pageUrl || isLocalBrowserUrl(pageUrl) ? ALLOW : { kind: 'ask', reason: `acts on ${hostOf(pageUrl)}, which is not a local page` };
	}
	return ALLOW;
}

/** Tools whose verdict depends on the page the browser shows. */
export function browserVerdictNeedsPage(name: string): boolean {
	return name === 'browser_click' || name === 'browser_type' || name === 'browser_press_key' || name === 'browser_select_option';
}

/** Another part of Volt that serves tools on the host MCP server (the orchestrator's task tools). */
export interface IVoltHostToolProvider {
	readonly tools: readonly IVoltHostToolInfo[];
	invoke(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult>;
}

export interface IVoltHostToolService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeMcp: Event<void>;
	readonly onDidInvokeTool: Event<IVoltHostToolInvocation>;
	/** The tool list changed (a provider was added or removed); the MCP server re-reads it. */
	readonly onDidChangeTools: Event<void>;
	listTools(): readonly IVoltHostToolInfo[];
	registerToolProvider(provider: IVoltHostToolProvider): IDisposable;
	invokeTool(name: string, input?: unknown, call?: IVoltHostToolCall): Promise<IVoltHostToolResult>;
	/**
	 * The MCP server to hand a chat's agent; tool calls through it are tied to `sessionId` and carry
	 * the server's bearer token. `groups` limits the tools it lists (default: all).
	 */
	getMcpServers(sessionId?: string, options?: { readonly groups?: readonly VoltHostToolGroup[] }): readonly IVoltMcpServer[];
	/** The window's MCP server address and the bearer token agents must send. */
	setMcpEndpoint(url: string | undefined, token?: string): void;
	setQuestionHandler(handler: IVoltQuestionHandler | undefined): void;
	/** Mode and folder per chat, for the mode gate and relative image paths. */
	setSessionResolver(resolver: IVoltHostSessionResolver | undefined): void;
	/** Asks the user when a chat's mode does not allow a call. Without one, such calls are refused. */
	setApprover(approver: IVoltHostToolApprover | undefined): void;
}
