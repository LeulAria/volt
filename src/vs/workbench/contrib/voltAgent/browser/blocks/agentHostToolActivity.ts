/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMemoryToolName } from '../../../../services/voltRuntime/common/memory/voltMemory.js';
import { AGENT_TASK_TOOLS, bareTaskToolName } from '../../../../services/voltRuntime/common/orchestration/agentTasks.js';
import { describeLocator, parseLocator } from '../../../../services/voltRuntime/common/tools/browserRun.js';
import { TERMINAL_START_TOOL_NAME, TERMINAL_TOOLS, TERMINAL_SEND_TOOL_NAME, APP_OPEN_TOOL_NAME } from '../../../../services/voltRuntime/common/terminalTools.js';
import { ASK_QUESTION_TOOL_NAME, AWAIT_ANSWERS_TOOL_NAME, BROWSER_COMPARE_IMAGE_TOOL_NAME, COMMIT_PLAN_TOOL_NAMES, BROWSER_DEVTOOLS_TOOL_NAME, CANVAS_READ_TOOL_NAME, CANVAS_RENDER_TOOL_NAME, CANVAS_UPDATE_TOOL_NAME, BROWSER_NETWORK_TOOL_NAME, humanizeToolName, IMAGE_INSPECT_TOOL_NAME, isBrowserToolName, isRawToolName, MOCKUPS_TOOL_NAME, PREVIEW_HTML_TOOL_NAME, PULL_REQUEST_TOOL_NAMES, RENDER_CHART_TOOL_NAME, RENDER_HTML_TOOL_NAME, SCREENS_TOOL_NAME, splitMcpToolName, THREAD_TOOL_NAMES, VOLT_HOST_TOOLS, voltHostToolName } from '../../../../services/voltRuntime/common/hostTools.js';

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
	// Codex titles an MCP call with the call itself: `{"server":"volt","tool":"…","arguments":{…}}`.
	const codex = [parseRecord(title), parseRecord(name), rec].find(candidate => candidate?.server === 'volt' && typeof candidate.tool === 'string');
	if (codex) {
		const tool = voltHostToolName(codex.tool as string);
		const args = codex.arguments && typeof codex.arguments === 'object' && !Array.isArray(codex.arguments) ? codex.arguments as Record<string, unknown> : {};
		return tool ? { tool, args } : undefined;
	}
	const wrapped = rec && typeof rec.toolName === 'string' && (rec.providerIdentifier === 'volt' || rec.args !== undefined);
	const tool = voltHostToolName(name, title) ?? (wrapped ? voltHostToolName(rec.toolName as string) : undefined);
	if (!tool) {
		return undefined;
	}
	const args = wrapped && rec.args && typeof rec.args === 'object' ? rec.args as Record<string, unknown> : (rec && !wrapped ? rec : {});
	return { tool, args };
}

/** Volt's own tool behind a raw name (`mcp__volt__terminal_start`, `volt__terminal_start`, `volt: terminal_start`, `terminal_start`), if it is one. */
function terminalToolName(raw: string | undefined): string | undefined {
	const value = (raw ?? '').trim();
	const tail = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1).trim() : value;
	const id = tail.replace(/^(?:mcp__volt__|volt__)/i, '').toLowerCase();
	return TERMINAL_TOOLS.some(tool => tool.name === id) ? id : undefined;
}

/**
 * A tool's raw name in words, so the transcript never shows `mcp__volt__wait_tasks`,
 * `volt__wait_tasks` or `list_dir`: Volt's tools read as their own title ("Waited for tasks",
 * "Started terminal"), others as their name spelled out ("mcp__aws-docs__search_docs" reads
 * "Search docs"). Undefined for a title that is already words ("Read file").
 */
export function friendlyToolTitle(raw: string | undefined): string | undefined {
	const value = (raw ?? '').trim();
	if (!value) {
		return undefined;
	}
	const terminal = terminalToolName(value);
	if (terminal) {
		return TERMINAL_TOOLS.find(tool => tool.name === terminal)?.title;
	}
	const split = splitMcpToolName(value);
	if (!split && !isRawToolName(value)) {
		return undefined;
	}
	const tool = split?.tool ?? value;
	const task = bareTaskToolName(tool);
	if (task) {
		return AGENT_TASK_TOOLS.find(info => info.name === task)?.title;
	}
	const host = voltHostToolName(tool);
	return (host ? VOLT_HOST_TOOLS.find(info => info.name === host)?.title : undefined) ?? humanizeToolName(tool);
}

/** The managed terminal tools as rows: what started, what was typed, which app opened. */
export function describeTerminalToolActivity(name: string | undefined, title: string | undefined, input: string | undefined): { label: string; detail?: string } | undefined {
	const tool = terminalToolName(name) ?? terminalToolName(title);
	const label = tool && TERMINAL_TOOLS.find(info => info.name === tool)?.title;
	if (!tool || !label) {
		return undefined;
	}
	const args = parseRecord(input) ?? {};
	switch (tool) {
		case TERMINAL_START_TOOL_NAME: return { label, detail: text(args.command, 80) };
		case TERMINAL_SEND_TOOL_NAME: return { label, detail: text(args.text, 60) };
		case APP_OPEN_TOOL_NAME: return { label, detail: text(args.target, 80) };
		default: return { label };
	}
}

/**
 * How a Volt tool that is no browser action counts in the trail: the commit review is waiting on
 * the user (`wait`), pull request, thread and memory tools are plain steps (`tool`). Undefined for
 * the browser, device and design tools, which count as browser actions.
 */
export function hostToolStepKind(tool: string | undefined): 'wait' | 'tool' | undefined {
	if (!tool) {
		return undefined;
	}
	if ((COMMIT_PLAN_TOOL_NAMES as readonly string[]).includes(tool)) {
		return tool === 'rename_branch' ? 'tool' : 'wait';
	}
	if ((PULL_REQUEST_TOOL_NAMES as readonly string[]).includes(tool) || (THREAD_TOOL_NAMES as readonly string[]).includes(tool) || isMemoryToolName(tool)) {
		return 'tool';
	}
	return undefined;
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
	if (tool === BROWSER_DEVTOOLS_TOOL_NAME) {
		switch (args.action) {
			case 'storage': return { tool, label: 'Read site storage', detail: text(args.filter, 60) };
			case 'clear': return { tool, label: 'Cleared site data', detail: Array.isArray(args.what) ? args.what.filter((item): item is string => typeof item === 'string').join(', ') : undefined };
			case 'set_storage': return { tool, label: args.value === undefined ? 'Removed storage key' : 'Set storage key', detail: text(args.key, 60) };
			case 'hard_reload': return { tool, label: 'Hard reloaded page' };
			case 'inspect': return { tool, label: 'Inspected element', detail: text(args.selector, 60) ?? text(args.ref, 20) };
			case 'performance': return { tool, label: 'Measured performance' };
			default: return { tool, label: 'Opened DevTools' };
		}
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
	if ((COMMIT_PLAN_TOOL_NAMES as readonly string[]).includes(tool)) {
		switch (tool) {
			case 'propose_commits': {
				const count = Array.isArray(args.commits) ? args.commits.length : 0;
				return { tool, label: 'Proposed commits', detail: count ? `${count} commit${count === 1 ? '' : 's'}` : undefined };
			}
			case 'await_commits': return { tool, label: 'Waiting for commit review' };
			default: return { tool, label: 'Renamed branch', detail: text(args.name, 80) };
		}
	}
	if ((THREAD_TOOL_NAMES as readonly string[]).includes(tool)) {
		return describeThreadActivity(tool, args);
	}
	if (isMemoryToolName(tool)) {
		switch (tool) {
			case 'memory_list': return { tool, label: 'Checked memories' };
			case 'memory_read': return { tool, label: 'Recalled memory', detail: text(args.name, 80) };
			case 'memory_write': return { tool, label: 'Saved memory', detail: text(args.name, 80) };
			case 'skill_write': return { tool, label: 'Saved skill', detail: text(args.name, 80) };
			default: return { tool, label: 'Deleted memory', detail: text(args.name, 80) };
		}
	}
	const device = describeDeviceActivity(tool, args);
	if (device) {
		return device;
	}
	if (tool === IMAGE_INSPECT_TOOL_NAME) {
		return { tool, label: 'Inspected image', detail: text(args.path, 120) };
	}
	// The visual itself shows above the reply; the row only records that it was made.
	if (tool === RENDER_CHART_TOOL_NAME) {
		return { tool, label: 'Rendered chart', detail: text(args.title, 80) };
	}
	if (tool === RENDER_HTML_TOOL_NAME) {
		return { tool, label: 'Rendered page', detail: text(args.title, 80) };
	}
	if (tool === PREVIEW_HTML_TOOL_NAME) {
		return { tool, label: 'Previewed page', detail: typeof args.width === 'number' ? `${args.width}px` : undefined };
	}
	if (tool === MOCKUPS_TOOL_NAME) {
		const count = Array.isArray(args.options) ? args.options.length : 0;
		return { tool, label: count ? `Showed ${count} mockup${count === 1 ? '' : 's'}` : 'Showed mockups', detail: text(args.title, 80) };
	}
	if (tool === CANVAS_RENDER_TOOL_NAME) {
		const count = Array.isArray(args.frames) ? args.frames.length : 0;
		return { tool, label: count ? `Designed ${count} screen${count === 1 ? '' : 's'}` : 'Designed canvas', detail: text(args.title, 80) };
	}
	if (tool === CANVAS_UPDATE_TOOL_NAME) {
		return { tool, label: 'Updated canvas', detail: text(args.title, 80) };
	}
	if (tool === CANVAS_READ_TOOL_NAME) {
		return { tool, label: 'Read canvas', detail: Array.isArray(args.frames) ? args.frames.filter(frame => typeof frame === 'string').slice(0, 4).join(', ') : undefined };
	}
	if (tool === SCREENS_TOOL_NAME) {
		if (typeof args.job === 'string' && !args.title) {
			return { tool, label: 'Capturing screens' };
		}
		const count = Array.isArray(args.screens) ? args.screens.length : 0;
		return { tool, label: count > 1 ? `Captured ${count} screens` : 'Captured screens', detail: text(args.title, 80) ?? text(args.url, 80) ?? text(args.device, 60) };
	}
	const agentBrowser = describeAgentBrowserTool(tool, args);
	if (agentBrowser) {
		return agentBrowser;
	}
	if (!isBrowserToolName(tool)) {
		return undefined;
	}
	const target = parseLocator(args.target);
	const element = text(args.element) ?? (target ? describeLocator(target) : undefined);
	switch (tool) {
		case 'browser_navigate':
			return { tool, label: 'Navigated to', detail: text(args.url, 120) };
		case 'browser_snapshot':
			return { tool, label: 'Read page' };
		case 'browser_act': {
			const steps = stepCount(args);
			return { tool, label: args.run ? 'Ran saved flows' : 'Acted on page', detail: args.run ? [args.run].flat().join(', ') : steps ? `${steps} step${steps === 1 ? '' : 's'}` : undefined };
		}
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

/** Scripted runs, mocks, emulation, audits and playgrounds, in the words a reader would use. */
function describeAgentBrowserTool(tool: string, args: Record<string, unknown>): IHostToolActivity | undefined {
	switch (tool) {
		case 'browser_run': {
			const steps = Array.isArray(args.steps) ? args.steps.length : 0;
			const asserts = Array.isArray(args.steps) ? args.steps.filter(step => step && typeof step === 'object' && /^(assert|expect|verify)$/i.test(String((step as Record<string, unknown>).action ?? ''))).length : 0;
			return { tool, label: 'Ran browser test', detail: `${steps} step${steps === 1 ? '' : 's'}${asserts ? `, ${asserts} check${asserts === 1 ? '' : 's'}` : ''}` };
		}
		case 'browser_status': return { tool, label: 'Checked browser' };
		case 'browser_mock': {
			const routes = Array.isArray(args.routes) ? args.routes.map(route => text((route as Record<string, unknown>)?.url, 40)).filter(Boolean) : [];
			return args.clear === true && !routes.length ? { tool, label: 'Cleared network mocks' } : { tool, label: 'Mocked', detail: routes.join(', ') || undefined };
		}
		case 'browser_emulate': return { tool, label: args.reset === true ? 'Reset emulation' : 'Emulated', detail: ['color_scheme', 'network', 'timezone', 'locale'].map(key => text(args[key])).filter(Boolean).join(', ') || (args.reduced_motion === true ? 'reduced motion' : undefined) };
		case 'browser_audit': return { tool, label: 'Audited page', detail: Array.isArray(args.checks) ? args.checks.join(', ') : undefined };
		case 'playground_create': return { tool, label: 'Created playground', detail: text(args.title, 60) };
		case 'playground_update': return { tool, label: 'Updated playground', detail: text(args.id) };
		case 'playground_list': return { tool, label: 'Listed playgrounds' };
		case 'playground_delete': return { tool, label: 'Deleted playground', detail: args.all === true ? 'all' : text(args.id) };
	}
	return undefined;
}

/** A chat id as a short tag (`…3f9a1c`); the row's result names the chat in full. */
function chatTag(value: unknown): string | undefined {
	const id = typeof value === 'string' ? value.replace(/^volt:\/\/session\//i, '').trim() : '';
	return id ? (id.length > 10 ? `…${id.slice(-6)}` : id) : undefined;
}

/** The orchestration tools: what the agent did to other chats, in the words of the sidebar. */
function describeThreadActivity(tool: string, args: Record<string, unknown>): IHostToolActivity {
	const chat = chatTag(args.thread_id);
	switch (tool) {
		case 'orchestrator_capabilities':
			return { tool, label: 'Read orchestration options' };
		case 'thread_list':
			return { tool, label: 'Listed chats', detail: text(args.query, 60) ?? (Array.isArray(args.status) ? args.status.join(', ') : undefined) };
		case 'thread_search':
			return { tool, label: 'Searched chats', detail: text(args.query, 60) ? `"${text(args.query, 60)}"` : undefined };
		case 'thread_read':
			return { tool, label: chat ? 'Read chat' : 'Read this chat', detail: chat };
		case 'thread_send':
			return { tool, label: args.mode === 'interrupt' || args.mode === 'restart' ? 'Interrupted chat with' : args.wait === true ? 'Asked chat' : 'Messaged chat', detail: text(args.message, 80) };
		case 'thread_wait': {
			const count = (Array.isArray(args.thread_ids) ? args.thread_ids.length : 0) + (args.thread_id ? 1 : 0);
			return { tool, label: count > 1 ? `Waited for ${count} chats` : 'Waited for chat', detail: count > 1 ? undefined : chatTag(args.thread_id ?? (Array.isArray(args.thread_ids) ? args.thread_ids[0] : undefined)) };
		}
		case 'thread_interrupt':
			return { tool, label: 'Stopped chat', detail: text(args.reason, 60) ?? chat };
		case 'thread_fork':
			return { tool, label: chat ? 'Forked chat' : 'Forked this chat', detail: [text(args.title, 50), text(args.model, 40)].filter(Boolean).join(' · ') || undefined };
		case 'thread_merge_back':
			return { tool, label: args.apply === true ? 'Merged chat back' : 'Sent fork summary', detail: chat };
		case 'thread_launch': {
			const models = Array.isArray(args.models) ? args.models.length : 0;
			return { tool, label: models > 1 ? `Launched ${models} chats` : 'Launched chat', detail: text(args.title, 60) };
		}
		case 'thread_update': {
			const labels: Record<string, string> = { rename: 'Renamed chat', pin: 'Pinned chat', unpin: 'Unpinned chat', archive: 'Archived chat', unarchive: 'Unarchived chat', settle: 'Settled chat', unsettle: 'Unsettled chat', snooze: 'Snoozed chat', unsnooze: 'Woke chat', mark_unread: 'Marked chat unread', mark_read: 'Marked chat read' };
			return { tool, label: labels[String(args.action)] ?? 'Updated chat', detail: args.action === 'rename' ? text(args.title, 60) : chat };
		}
		case 'thread_configure':
			return { tool, label: 'Switched chat model', detail: text(args.model, 60) };
		case 'queue_list':
			return { tool, label: 'Read queue', detail: chat };
		case 'queue_edit':
			return { tool, label: 'Edited queued message', detail: text(args.text, 60) };
		case 'queue_cancel':
			return { tool, label: args.all === true ? 'Cleared queue' : 'Removed queued message', detail: chat };
		case 'queue_reorder':
			return { tool, label: 'Reordered queue', detail: chat };
		case 'queue_send_now':
			return { tool, label: 'Sent queued message now', detail: chat };
		case 'queue_resume':
			return { tool, label: 'Resumed queue', detail: chat };
		case 'worktree_status':
			return { tool, label: 'Read checkout', detail: chat };
		case 'worktree_list':
			return { tool, label: 'Listed worktrees' };
		case 'worktree_handoff':
			return { tool, label: 'Moved chat', detail: chat };
	}
	return { tool, label: tool };
}

/** Steps in an act call: script lines (not comments) or JSON steps. */
function stepCount(args: Record<string, unknown>): number {
	if (typeof args.script === 'string') {
		return args.script.split('\n').filter(line => line.trim() && !/^\s*(#|\/\/)/.test(line)).length;
	}
	return Array.isArray(args.steps) ? args.steps.length : 0;
}

/** Simulator, emulator and window capture tools. */
function describeDeviceActivity(tool: string, args: Record<string, unknown>): IHostToolActivity | undefined {
	const device = text(args.device);
	const at = typeof args.x === 'number' && typeof args.y === 'number' ? `${Math.round(args.x)}, ${Math.round(args.y)}` : undefined;
	switch (tool) {
		case 'device_list': return { tool, label: 'Listed devices', detail: text(args.host) };
		case 'device_boot': return { tool, label: 'Booted', detail: device };
		case 'device_shutdown': return { tool, label: 'Shut down', detail: device };
		case 'device_screenshot': return { tool, label: 'Took device screenshot', detail: device };
		case 'device_snapshot': return { tool, label: 'Read device screen', detail: device };
		case 'device_act': {
			const steps = stepCount(args);
			return { tool, label: 'Acted on device', detail: [steps ? `${steps} step${steps === 1 ? '' : 's'}` : undefined, device ? `on ${device}` : undefined].filter(Boolean).join(' ') || undefined };
		}
		case 'device_tap': return { tool, label: 'Tapped', detail: [at, device ? `on ${device}` : undefined].filter(Boolean).join(' ') || undefined };
		case 'device_swipe': return { tool, label: 'Swiped', detail: device };
		case 'device_type': {
			const typed = text(args.text, 40);
			return { tool, label: 'Typed', detail: typed ? `"${typed}"` : undefined };
		}
		case 'device_press_button': return { tool, label: 'Pressed', detail: text(args.button) };
		case 'device_install_app': return { tool, label: 'Installed', detail: text(args.path, 120) };
		case 'device_launch_app': return { tool, label: 'Launched', detail: text(args.app, 120) };
		case 'device_set_posture': return { tool, label: 'Changed posture to', detail: args.posture === 'halfOpen' ? 'half open' : text(args.posture) };
		case 'desktop_apps': return { tool, label: 'Listed desktop apps' };
		case 'desktop_snapshot': return { tool, label: 'Read desktop app', detail: text(args.app) };
		case 'desktop_act': {
			const lines = stepCount(args);
			return { tool, label: 'Acted on desktop app', detail: [text(args.app), lines ? `${lines} step${lines === 1 ? '' : 's'}` : undefined].filter(Boolean).join(' · ') || undefined };
		}
		case 'window_list': return { tool, label: 'Listed windows' };
		case 'window_capture': return { tool, label: 'Captured window', detail: text(args.window) };
		case 'window_record_start': return { tool, label: 'Started recording', detail: text(args.window) };
		case 'window_record_stop': return { tool, label: 'Stopped recording' };
	}
	return undefined;
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
