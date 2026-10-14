/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CAPTURE_TOOL_NAMES, DEVICE_TOOL_NAMES } from './deviceTools.js';
import { PLAYGROUND_TOOL_NAMES } from './playgroundTools.js';
import { COMPUTER_TOOL_NAMES } from './computerTools.js';
import type { VoltMode } from './modes.js';
import type { AgentQuestionDraft, IAgentQuestionResponse } from './questions.js';
import type { IRgbaImage } from './tools/imageAnalysis.js';
import { MUTATING_RUN_ACTIONS, parseRunSteps } from './tools/browserRun.js';

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
/** `(sessionId, IVoltBrowserPreflightRequest) => IVoltBrowserPreflightResult`: the browser half of the turn primer. */
export const PREFLIGHT_BROWSER_COMMAND_ID = 'volt.browser.preflight';

export interface IVoltBrowserPreflightRequest {
	/** The chat's folder. */
	readonly cwd: string;
	/** The project's start command, if one was detected. */
	readonly start?: string;
	/** Volt may start the app (the mode and policy allow running it). */
	readonly allowStart: boolean;
	readonly a11y: boolean;
	readonly widths: readonly number[];
	readonly perf: boolean;
}

export interface IVoltBrowserPreflightResult {
	/** Lines for the agent's first prompt; empty when there was nothing to report. */
	readonly lines: readonly string[];
	/** The app's URL when it is serving. */
	readonly url?: string;
}

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
export const BROWSER_RUN_TOOL_NAME = 'browser_run';
export const BROWSER_STATUS_TOOL_NAME = 'browser_status';
export const BROWSER_MOCK_TOOL_NAME = 'browser_mock';
export const BROWSER_EMULATE_TOOL_NAME = 'browser_emulate';
export const BROWSER_AUDIT_TOOL_NAME = 'browser_audit';
export const IMAGE_INSPECT_TOOL_NAME = 'image_inspect';

/**
 * `core`: questions. `browser`: the in-app browser. `image`: reading image files. `threads`: other
 * chats, their queues and checkouts (an agent as orchestrator). `pullRequests`:
 * linking and watching the chat's pull requests. `visuals`: charts and pages shown in the reply. `devices`: iOS simulators
 * and Android emulators. `capture`: screenshots and recordings of windows. An agent can be
 * handed a subset (`getMcpServers(sessionId, { groups })`) to keep its tool list short.
 */
export type VoltHostToolGroup = 'core' | 'browser' | 'image' | 'tasks' | 'threads' | 'pullRequests' | 'visuals' | 'devices' | 'capture' | 'computer';

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
	/** Files the call changed (browser_run `edits`), for the chat's change set. Not sent to the agent. */
	readonly changes?: readonly IVoltHostFileChange[];
}

export interface IVoltHostFileChange {
	readonly uri: URI;
	readonly kind: 'edit' | 'create';
	readonly before?: string;
	readonly existed: boolean;
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
	/** The chat's folder (worktree or workspace), to tell its dev servers from others. */
	readonly cwd?: string;
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
const PAGE_STATE_NOTE = 'Returns the page URL and title, new console errors, and what changed on the page (the full snapshot after a navigation).';
const LOCATOR = {
	type: 'object',
	description: 'The element, found by meaning instead of a ref: {"role":"button","name":"Add"}, {"label":"Email"}, {"text":"Sign up"}, {"placeholder":"Search"}, {"testId":"save"}, {"selector":"#id"} or {"ref":"e12"}. Names and text match case-insensitively by "contains"; exact: true for the whole text, nth to pick one of several matches. A string works too: "e12", "role=button[name=Add]", "label=Email", "text=Sign up", "#css".',
	properties: {
		role: { type: 'string' }, name: { type: 'string' }, label: { type: 'string' }, text: { type: 'string' }, placeholder: { type: 'string' },
		testId: { type: 'string' }, selector: { type: 'string' }, ref: { type: 'string' }, exact: { type: 'boolean' }, nth: { type: 'number' },
	},
};
const SNAPSHOT_MODE = { type: 'string', enum: ['diff', 'full', 'none'], description: 'Page state to return: diff (default: only what changed since the last snapshot), full (the whole accessibility snapshot) or none.' };
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

/**
 * Browser tools for design, debugging and testing work, added after the activity trail named the
 * ones above: scripted runs with assertions, status, network mocks, emulation and audits.
 */
export const BROWSER_DESIGN_TOOL_NAMES = [BROWSER_COMPARE_IMAGE_TOOL_NAME, BROWSER_NETWORK_TOOL_NAME, BROWSER_RUN_TOOL_NAME, BROWSER_STATUS_TOOL_NAME, BROWSER_MOCK_TOOL_NAME, BROWSER_EMULATE_TOOL_NAME, BROWSER_AUDIT_TOOL_NAME] as const;

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
		name: 'browser_navigate',
		title: 'Navigated to',
		group: 'browser',
		description: `Open a URL in this chat's Volt in-app browser (the tab beside the chat; it opens if needed) and wait for it to load. Use it to preview and test local dev servers or files (http://localhost:3000, file:///path/index.html); browser_status lists the servers running here. Returns the page URL, title, console errors and the accessibility snapshot with element refs. To act and check in the same call, use browser_run.`,
		inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The URL to open, or a bare port such as "4400" for http://localhost:4400.' }, screenshot: SCREENSHOT_AFTER, snapshot: SNAPSHOT_MODE }, required: ['url'] },
	},
	{
		name: 'browser_snapshot',
		title: 'Read page',
		group: 'browser',
		description: 'Capture an accessibility snapshot (YAML: role, name, ref, states) of the current page in the in-app browser. Better than a screenshot for deciding what to click. Refs stay valid for the life of the page. Usually you can skip it: browser_run and the action tools accept targets by role/name, label or text.',
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
		description: `Click an element in the in-app browser with a real (trusted) mouse click. Name it with target ({"role":"button","name":"Save"}, {"text":"Sign up"}…), a ref from a snapshot, or x/y viewport coordinates. ${PAGE_STATE_NOTE}`,
		inputSchema: {
			type: 'object',
			properties: {
				element: ELEMENT,
				target: LOCATOR,
				ref: REF,
				snapshot: SNAPSHOT_MODE,
				x: { type: 'number', description: 'Viewport x in CSS px (instead of ref).' },
				y: { type: 'number', description: 'Viewport y in CSS px (instead of ref).' },
				doubleClick: { type: 'boolean' },
				button: { type: 'string', enum: ['left', 'right', 'middle'] },
				screenshot: SCREENSHOT_AFTER,
			},
		},
	},
	{
		name: 'browser_type',
		title: 'Typed',
		group: 'browser',
		description: `Type text into an editable element in the in-app browser (target {"label":"Email"}, {"placeholder":"…"} or a ref). ${PAGE_STATE_NOTE}`,
		inputSchema: {
			type: 'object',
			properties: {
				element: ELEMENT,
				target: LOCATOR,
				ref: REF,
				snapshot: SNAPSHOT_MODE,
				text: { type: 'string' },
				submit: { type: 'boolean', description: 'Press Enter after typing.' },
				clear: { type: 'boolean', description: 'Replace the current value instead of appending (default true).' },
				screenshot: SCREENSHOT_AFTER,
			},
			required: ['text'],
		},
	},
	{
		name: 'browser_press_key',
		title: 'Pressed',
		group: 'browser',
		description: `Press a key in the in-app browser, e.g. "Enter", "Escape", "ArrowLeft", "a", "Meta+a". ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { key: { type: 'string' }, screenshot: SCREENSHOT_AFTER, snapshot: SNAPSHOT_MODE }, required: ['key'] },
	},
	{
		name: 'browser_hover',
		title: 'Hovered',
		group: 'browser',
		description: `Move the mouse over an element in the in-app browser. ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { element: ELEMENT, target: LOCATOR, ref: REF, screenshot: SCREENSHOT_AFTER, snapshot: SNAPSHOT_MODE } },
	},
	{
		name: 'browser_select_option',
		title: 'Selected',
		group: 'browser',
		description: `Select option(s) in a <select> in the in-app browser. ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { element: ELEMENT, target: LOCATOR, ref: REF, values: { type: 'array', items: { type: 'string' } }, screenshot: SCREENSHOT_AFTER, snapshot: SNAPSHOT_MODE }, required: ['values'] },
	},
	{
		name: 'browser_scroll',
		title: 'Scrolled',
		group: 'browser',
		description: `Scroll the page (or the element with ref) in the in-app browser by deltaY pixels (negative scrolls up). ${PAGE_STATE_NOTE}`,
		inputSchema: { type: 'object', properties: { element: ELEMENT, target: LOCATOR, ref: REF, deltaY: { type: 'number' }, deltaX: { type: 'number' }, screenshot: SCREENSHOT_AFTER, snapshot: SNAPSHOT_MODE } },
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
		description: 'Take a screenshot of the current page (or one element) in the in-app browser to check how it looks. One image pixel is one CSS pixel up to max_side. widths captures the page at several viewport widths in one image (a responsive contact sheet); full_page captures beyond the viewport. Prefer browser_run assertions for checking behaviour, browser_snapshot for finding elements, and browser_compare_image for matching a design image.',
		inputSchema: {
			type: 'object',
			properties: {
				ref: { ...REF, description: 'Optional element ref: capture only this element.' },
				target: { ...LOCATOR, description: 'Optional element to capture, by meaning (see browser_click).' },
				widths: { type: 'array', items: { type: 'number' }, description: 'Capture at each of these viewport widths (e.g. [375, 768, 1280]) side by side; the viewport is restored afterwards.' },
				full_page: { type: 'boolean', description: 'Capture the whole scrollable page, not just the viewport.' },
				format: { type: 'string', enum: ['jpeg', 'png', 'webp'], description: 'Default jpeg (smallest). png for pixel-exact checks.' },
				max_side: { type: 'number', description: 'Longest side in pixels, 256-2560. Default 1280.' },
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
		name: BROWSER_RUN_TOOL_NAME,
		title: 'Ran browser steps',
		group: 'browser',
		description: 'Fix and verify in ONE call: `edits` (optional) change files first (exact old → new text, all applied or none; the page reloads after), then the steps run in order in this chat\'s in-app browser with real mouse and keyboard input. Actions: navigate, click, dblclick, type, fill, press, select, check, uncheck, hover, scroll, wait, resize, reload, back, evaluate, snapshot, screenshot, assert, mock (fake API responses: {"action":"mock","routes":[{"url":"/api/x","status":500}],"reload":true}; routes [] clears), emulate (network offline/slow-3g, color_scheme, locale, timezone, cpu_slowdown; reset), audit (checks a11y/layout/perf, widths; fails on accessibility errors or overflow). Target elements by meaning ({"role":"button","name":"Add"}, {"label":"Email"}, {"text":"Saved"}, {"placeholder":"…"}, {"testId":"…"}, {"selector":"…"}) or by a snapshot ref; no snapshot is needed first. An assert step waits (timeout_ms, default 5000) until it holds: visible, hidden, text, value, count, checked, unchecked, enabled, disabled, focused, attribute, css, url, title, no_overflow, no_console_errors, no_failed_requests. Returns one ✓/✗ line per step with the actual value on failure (a failed action stops the run, a failed assertion does not), console errors and failed requests during the run, and what changed on the page. Use it instead of one tool call per action whenever you know the next steps, and to prove a fix works end to end.',
		inputSchema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'Open this URL first (same as a first navigate step).' },
				edits: {
					type: 'array',
					description: 'File changes to apply before the steps: [{"path":"src/app.js","old":"exact text","new":"replacement"}] or {"path":"…","content":"whole file"}. Paths are relative to the project. Not allowed in Ask or Plan mode.',
					items: {
						type: 'object',
						properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' }, content: { type: 'string' }, replace_all: { type: 'boolean' } },
						required: ['path'],
					},
				},
				steps: {
					type: 'array',
					description: 'E.g. [{"action":"fill","target":{"label":"Email"},"text":"a@b.co"},{"action":"click","target":{"role":"button","name":"Sign up"}},{"action":"assert","target":{"role":"status"},"expect":"text","value":"Account created"}]',
					items: {
						type: 'object',
						properties: {
							action: { type: 'string', enum: ['navigate', 'click', 'dblclick', 'type', 'fill', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'wait', 'resize', 'reload', 'back', 'evaluate', 'snapshot', 'screenshot', 'assert', 'mock', 'emulate', 'audit'] },
							target: LOCATOR,
							url: { type: 'string' },
							text: { type: 'string', description: 'type/fill: the text. fill replaces the value; type appends unless clear is true.' },
							submit: { type: 'boolean', description: 'type/fill: press Enter afterwards.' },
							key: { type: 'string', description: 'press: e.g. "Enter", "Escape", "Tab", "Meta+a".' },
							values: { type: 'array', items: { type: 'string' }, description: 'select: option values or labels.' },
							expect: { type: 'string', enum: ['visible', 'hidden', 'text', 'value', 'count', 'checked', 'unchecked', 'enabled', 'disabled', 'focused', 'attribute', 'css', 'url', 'title', 'no_overflow', 'no_console_errors', 'no_failed_requests'] },
							value: { description: 'assert: expected text/value/url/title (contains by default), a number for count, or {"min":1,"max":3}.', anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'object' }] },
							match: { type: 'string', enum: ['contains', 'equals', 'regex'] },
							name: { type: 'string', description: 'assert attribute/css: the attribute name or CSS property.' },
							deltaY: { type: 'number' },
							ms: { type: 'number', description: 'wait: milliseconds.' },
							width: { type: 'number' },
							height: { type: 'number' },
							expression: { type: 'string', description: 'evaluate: a JS expression or () => {...}; its JSON result is logged.' },
							timeout_ms: { type: 'number' },
							optional: { type: 'boolean', description: 'Keep going if this step fails.' },
							routes: { type: 'array', items: { type: 'object' }, description: 'mock: [{"url":"/api/stats","status":200,"json":[],"delay_ms":3000,"abort":false,"method":"GET"}]. Replaces earlier mocks.' },
							reload: { type: 'boolean', description: 'mock/emulate: reload the page afterwards so requests made at load see it.' },
							network: { type: 'string', enum: ['none', 'offline', 'slow-3g', 'fast-3g', 'slow-4g'] },
							color_scheme: { type: 'string', enum: ['light', 'dark', 'system'] },
							checks: { type: 'array', items: { type: 'string', enum: ['a11y', 'layout', 'perf'] }, description: 'audit: default a11y.' },
							widths: { type: 'array', items: { type: 'number' }, description: 'audit layout: viewport widths.' },
							scope: { type: 'string', description: 'audit: CSS selector to limit it to.' },
						},
						required: ['action'],
					},
				},
				snapshot: SNAPSHOT_MODE,
				screenshot: { type: 'boolean', description: 'Attach a screenshot of the final state.' },
			},
		},
	},
	{
		name: BROWSER_STATUS_TOOL_NAME,
		title: 'Checked browser',
		group: 'browser',
		description: 'One cheap look at the in-app browser and what is running: the tab\'s URL, title and load state, viewport, focused element and open dialogs, console errors and failed requests so far, active network mocks and emulation, this chat\'s playgrounds, and the dev servers listening on this machine (port, command, folder). Call it first when you do not know what is open or which port the app uses.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: BROWSER_MOCK_TOOL_NAME,
		title: 'Mocked network',
		group: 'browser',
		description: 'Fake the in-app browser page\'s network responses to test loading, empty and error states without touching the backend or its code. Each route answers requests whose URL matches `url` (a substring, or a glob with *) with a status and a json/body, optionally after delay_ms (to see loading states), or fails them like a dropped connection (abort: true). Routes apply to fetch, XHR and every resource until cleared (clear: true) or this turn ends; the first matching route wins. reload: true reloads the page so requests made while loading are mocked too. The result lists which requests each route answered.',
		inputSchema: {
			type: 'object',
			properties: {
				routes: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							url: { type: 'string', description: 'Substring or glob, e.g. "/api/stats" or "*/api/users/*".' },
							method: { type: 'string' },
							status: { type: 'number', description: 'Default 200.' },
							json: { description: 'Response body as JSON.', anyOf: [{ type: 'object' }, { type: 'array' }, { type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
							body: { type: 'string', description: 'Raw response body (instead of json).' },
							content_type: { type: 'string' },
							headers: { type: 'object' },
							delay_ms: { type: 'number' },
							abort: { type: 'boolean', description: 'Fail the request at the network level.' },
							times: { type: 'number', description: 'Only answer this many matching requests.' },
						},
						required: ['url'],
					},
				},
				clear: { type: 'boolean', description: 'Remove all routes (with routes: replace them).' },
				reload: { type: 'boolean', description: 'Reload the page after setting the routes.' },
			},
		},
	},
	{
		name: BROWSER_EMULATE_TOOL_NAME,
		title: 'Emulated conditions',
		group: 'browser',
		description: 'Emulate conditions in the in-app browser page: color_scheme (light, dark, system), reduced_motion, network (offline, slow-3g, fast-3g, slow-4g, none), cpu_slowdown (e.g. 4), timezone (IANA, e.g. "Asia/Tokyo") and locale (e.g. "de-DE"). Use browser_resize or a resize step for the viewport. Everything is cleared when this turn ends, or now with reset: true.',
		inputSchema: {
			type: 'object',
			properties: {
				color_scheme: { type: 'string', enum: ['light', 'dark', 'system'] },
				reduced_motion: { type: 'boolean' },
				network: { type: 'string', enum: ['none', 'offline', 'slow-3g', 'fast-3g', 'slow-4g'] },
				cpu_slowdown: { type: 'number' },
				timezone: { type: 'string' },
				locale: { type: 'string' },
				reset: { type: 'boolean' },
				reload: { type: 'boolean', description: 'Reload the page afterwards (locale and timezone apply to new page loads).' },
			},
		},
	},
	{
		name: BROWSER_AUDIT_TOOL_NAME,
		title: 'Audited page',
		group: 'browser',
		description: 'Audit the in-app browser page in one call and get exact findings with refs and CSS selectors: accessibility (controls without names, fields labelled only by a placeholder, images without alt, text contrast with the measured ratio, status/error messages screen readers will not announce, heading order, small targets), layout at each viewport width (horizontal overflow with the element and the CSS that cause it, clipped text), and performance (TTFB, load, LCP, CLS, long tasks, DOM size, transfer size). Use it to find accessibility, responsive and speed problems, then again to confirm the fix.',
		inputSchema: {
			type: 'object',
			properties: {
				checks: { type: 'array', items: { type: 'string', enum: ['a11y', 'layout', 'perf'] }, description: 'Default: all three.' },
				widths: { type: 'array', items: { type: 'number' }, description: 'Viewport widths for the layout check. Default [375, 768, 1280]; the viewport is restored afterwards.' },
				scope: { type: 'string', description: 'CSS selector: audit only this part of the page.' },
				url: { type: 'string', description: 'Open this URL first.' },
			},
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
export const PULL_REQUEST_TOOL_NAMES = ['link_pull_request', 'unlink_pull_request', 'list_thread_pull_requests', 'watch_pull_request', 'unwatch_pull_request'] as const;

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
			if (VOLT_HOST_TOOLS.some(tool => tool.name === id) || (PULL_REQUEST_TOOL_NAMES as readonly string[]).includes(id) || (VISUAL_TOOL_NAMES as readonly string[]).includes(id) || (SCHEDULE_TOOL_NAMES as readonly string[]).includes(id) || (DEVICE_TOOL_NAMES as readonly string[]).includes(id) || (CAPTURE_TOOL_NAMES as readonly string[]).includes(id) || (THREAD_TOOL_NAMES as readonly string[]).includes(id) || (PLAYGROUND_TOOL_NAMES as readonly string[]).includes(id) || (COMPUTER_TOOL_NAMES as readonly string[]).includes(id)) {
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
		case BROWSER_AUDIT_TOOL_NAME:
			return !target || isLocalBrowserUrl(target) ? ALLOW : { kind: 'ask', reason: `opens ${hostOf(target)}, which is not a local page` };
		case BROWSER_RUN_TOOL_NAME: {
			const { steps } = parseRunSteps(args.steps);
			const urls = [target, ...steps.map(step => step.url)].filter((url): url is string => !!url);
			const offsite = urls.find(url => !isLocalBrowserUrl(url));
			if (offsite) {
				return { kind: 'ask', reason: `opens ${hostOf(offsite)}, which is not a local page` };
			}
			if (steps.some(step => step.action === 'evaluate')) {
				return { kind: 'ask', reason: 'runs JavaScript in the page' };
			}
			const acts = steps.some(step => MUTATING_RUN_ACTIONS.has(step.action));
			return !acts || urls.length || !pageUrl || isLocalBrowserUrl(pageUrl) ? ALLOW : { kind: 'ask', reason: `acts on ${hostOf(pageUrl)}, which is not a local page` };
		}
		case 'browser_click':
		case 'browser_type':
		case 'browser_press_key':
		case 'browser_select_option':
		case BROWSER_MOCK_TOOL_NAME:
		case BROWSER_EMULATE_TOOL_NAME:
			return !pageUrl || isLocalBrowserUrl(pageUrl) ? ALLOW : { kind: 'ask', reason: `acts on ${hostOf(pageUrl)}, which is not a local page` };
	}
	return ALLOW;
}

/** Tools whose verdict depends on the page the browser shows. */
export function browserVerdictNeedsPage(name: string): boolean {
	return name === 'browser_click' || name === 'browser_type' || name === 'browser_press_key' || name === 'browser_select_option' || name === BROWSER_RUN_TOOL_NAME || name === BROWSER_MOCK_TOOL_NAME || name === BROWSER_EMULATE_TOOL_NAME;
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
	/** The browser half of an ACP agent's turn primer (the app serving and open in the chat's browser, audits). */
	preflightBrowser(sessionId: string, request: IVoltBrowserPreflightRequest, token: CancellationToken): Promise<IVoltBrowserPreflightResult>;
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
