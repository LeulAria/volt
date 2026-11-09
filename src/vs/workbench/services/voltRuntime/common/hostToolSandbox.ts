/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { chatCovers } from '../../../../platform/voltSandbox/common/authority.js';
import { chatSubject } from '../../../../platform/voltSandbox/common/principals.js';
import { domainAllowed, isPathInside, IVoltSandboxSettings, SandboxStrategy, strategyAtLeast, VoltSandboxLevel } from '../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { threadIdArg } from './orchestration/agentThreadTools.js';
import { parseActScript } from './tools/actScript.js';
import { localImagePaths } from './tools/localImages.js';

/**
 * Volt's host tools run in Volt's own processes, outside the OS sandbox a chat's agent runs in.
 * Every tool says what it would do there, and a sandboxed chat gets only what its sandbox allows:
 *
 * - `safe`: changes or reads only Volt's own state (questions, plans, charts, pull request links,
 *   the chat list), or looks at a simulator or the in-app UI. Runs.
 * - `browser`: the in-app browser. Runs, but the pages it opens and ends on are judged: no
 *   `file:` pages (a local page can frame any local file), and with the network off only the
 *   allowed hosts and local pages on ports the user granted. A sandboxed chat's browser is its own
 *   signed-out profile whose traffic follows the same rules (B-16).
 * - `reads`: reads files the agent names. Only inside the chat's workspace, its allowed folders
 *   or temp, and never in the user's credential folders.
 * - `network`: reaches a service on the internet for the agent (Slack, GitHub comments). Only
 *   while the chat's network is on.
 * - `writes`: writes files in the project. Only where the OS sandbox would let the agent write
 *   (any tool can add writes for a call: browser_run `edits`, a flow `save`).
 * - `persists`: memory and skills, which later chats read, sandboxed or not. Refused.
 * - `delegates`: prompts another chat, which runs with its own sandbox. Only when that chat is
 *   sandboxed at least as strictly as the caller.
 * - `spawns`: starts a new chat or subagent. Refused until new chats inherit the caller's
 *   sandbox (`SPAWNED_CHATS_INHERIT_SANDBOX`).
 * - `sandboxed`: runs a process for the chat inside the chat's own OS sandbox, with its rules
 *   (managed terminals on a PTY, see sandboxPty.ts). Runs; the tool carries the chat's sandbox and
 *   refuses when it cannot be set up, never running the process without it.
 * - `reads-other`: reads another chat (its transcript, or chats in general). Needs
 *   `agents.read:other` (spec INV-26, G.8), which sandboxed chats do not have: refused, except
 *   for the caller's own chat.
 * - `escapes`: runs code, git, apps or screen capture on the user's machine. Refused.
 *
 * A tool that is not listed is refused for sandboxed chats: a new tool must be classified here.
 */
export type HostToolSandboxClass = 'safe' | 'browser' | 'reads' | 'network' | 'writes' | 'persists' | 'delegates' | 'spawns' | 'sandboxed' | 'reads-other' | 'escapes';

/**
 * A chat that a sandboxed chat starts (thread_launch, thread_fork, delegate_task, message_task's
 * subagent) runs in a sandbox at least as strict as its parent's: `confineChatSandbox` applies
 * `inheritedSandboxSettings` before the child's first turn (sandboxInheritance.ts). Starts that
 * create a worktree stay refused: Volt runs the project's setup scripts for it, outside the
 * sandbox.
 */
export const SPAWNED_CHATS_INHERIT_SANDBOX = true;

/** Every host tool Volt serves, window and agent server. The tests check the list is complete. */
export const HOST_TOOL_SANDBOX_CLASSES: Readonly<Record<string, HostToolSandboxClass>> = {
	// Questions and plans: Volt's own UI. workspace_status reads the chat's folder (`git status`, file names).
	ask_question: 'safe',
	await_answers: 'safe',
	propose_plan: 'safe',
	workspace_status: 'reads',

	// The in-app browser. browser_run `edits` and browser_act `save` add writes.
	browser_navigate: 'browser',
	browser_snapshot: 'browser',
	browser_act: 'browser',
	browser_click: 'browser',
	browser_type: 'browser',
	browser_press_key: 'browser',
	browser_hover: 'browser',
	browser_select_option: 'browser',
	browser_scroll: 'browser',
	browser_resize: 'browser',
	browser_wait_for: 'browser',
	browser_evaluate: 'browser',
	browser_console_messages: 'browser',
	browser_navigate_back: 'browser',
	browser_reload: 'browser',
	browser_screenshot: 'browser',
	browser_network: 'browser',
	browser_devtools: 'browser',
	browser_run: 'browser',
	browser_status: 'browser',
	browser_mock: 'browser',
	browser_emulate: 'browser',
	browser_audit: 'browser',
	// Reads `reference_path`, then drives the browser (its `url` is judged too).
	browser_compare_image: 'reads',
	image_inspect: 'reads',

	// Visuals in the reply. Local images in pages and canvas frames are read and inlined.
	render_chart: 'safe',
	html_render: 'reads',
	html_preview: 'reads',
	mockups_render: 'safe',
	canvas_render: 'reads',
	canvas_update: 'reads',
	canvas_read: 'safe',
	// Files are read; web pages open signed in like the browser; windows go through desktop_act and window_capture (judged when called).
	screens_capture: 'reads',
	scratch_draw: 'safe',
	scratch_read: 'safe',
	// Temp folders Volt serves over loopback.
	playground_create: 'safe',
	playground_update: 'safe',
	playground_list: 'safe',
	playground_delete: 'safe',

	// Code search in the chat's folder: its `path` is judged, and for a sandboxed chat the search runs
	// on the chat's confined index and returns only what the chat may read (B-15).
	instant_grep: 'reads',
	find_symbol: 'reads',
	find_files: 'reads',

	// Pull requests: Volt's links and watches (gh reads). The stack tools run git checkout, rebase and push here.
	link_pull_request: 'safe',
	unlink_pull_request: 'safe',
	list_thread_pull_requests: 'safe',
	watch_pull_request: 'safe',
	unwatch_pull_request: 'safe',
	stack_status: 'safe',
	stack_branch: 'escapes',
	restack_stack: 'escapes',

	// Commit review: Volt commits only after the user approves the commits. rename_branch runs git (and its hooks) at once.
	propose_commits: 'safe',
	await_commits: 'safe',
	rename_branch: 'escapes',

	// Automations: by action (see `hostToolSandboxUse`).
	manage_automations: 'escapes',
	automation: 'escapes',

	// Memory and skills: read by later chats.
	memory_list: 'safe',
	memory_read: 'safe',
	memory_write: 'persists',
	skill_write: 'persists',
	memory_delete: 'persists',

	// The chat's terminals run in its own sandbox (on a PTY, sandboxPty.ts); one that started
	// outside it (before the sandbox was on) cannot be typed into. Reading them is reading Volt's
	// UI, and the tools serve only the caller's own terminals.
	terminal_start: 'sandboxed',
	terminal_send: 'sandboxed',
	terminal_stop: 'sandboxed',
	terminal_list: 'safe',
	terminal_output: 'safe',
	terminal_wait: 'safe',
	// Asks Docker in the chat's sandbox (which does not reach Docker's socket); starting Docker is refused for it.
	docker_ensure: 'sandboxed',
	// The app it opens runs outside any sandbox.
	app_open: 'escapes',
	task_watch: 'escapes',
	task_watch_status: 'safe',
	task_watch_stop: 'safe',

	// Simulators and emulators. Installing or launching an app runs the agent's build outside the
	// sandbox; device_act and screens_capture steps that open an app count as launching.
	device_list: 'safe',
	device_boot: 'safe',
	device_shutdown: 'safe',
	device_snapshot: 'safe',
	device_act: 'safe',
	device_screenshot: 'safe',
	device_tap: 'safe',
	device_swipe: 'safe',
	device_type: 'safe',
	device_press_button: 'safe',
	device_set_posture: 'safe',
	device_install_app: 'escapes',
	device_launch_app: 'escapes',

	// Screen capture sees every app on screen, which the sandbox never could.
	window_list: 'safe',
	window_capture: 'escapes',
	window_record_start: 'escapes',
	window_record_stop: 'safe',

	// Desktop control drives the user's apps.
	desktop_apps: 'escapes',
	desktop_snapshot: 'escapes',
	desktop_act: 'escapes',

	// Subagents. A handoff changes this chat's model; the chat keeps its sandbox.
	list_models: 'safe',
	delegate_task: 'spawns',
	task_status: 'safe',
	wait_tasks: 'safe',
	cancel_task: 'safe',
	message_task: 'spawns',
	handoff: 'safe',

	// Orchestration: other chats. Renaming, stopping and picking their model is Volt's state; reading
	// what other chats said (their transcripts) needs agents.read:other.
	orchestrator_capabilities: 'safe',
	thread_list: 'safe',
	thread_search: 'reads-other',
	thread_read: 'reads-other',
	thread_send: 'delegates',
	// Its answer carries the waited-on chat's last reply.
	thread_wait: 'reads-other',
	thread_interrupt: 'safe',
	thread_fork: 'spawns',
	// git add, commit and merge in both checkouts.
	thread_merge_back: 'escapes',
	thread_launch: 'spawns',
	thread_update: 'safe',
	thread_configure: 'safe',
	// Another chat's queued prompts, word for word.
	queue_list: 'reads-other',
	queue_edit: 'delegates',
	queue_cancel: 'safe',
	queue_reorder: 'safe',
	queue_send_now: 'delegates',
	queue_resume: 'delegates',
	// The status of another chat's checkout (its changed files).
	worktree_status: 'reads-other',
	worktree_list: 'safe',
	worktree_handoff: 'escapes',
};

/** What one call would do outside the sandbox. */
export interface IHostToolSandboxUse {
	readonly kind: HostToolSandboxClass;
	/** Files it reads, as the agent named them: absolute, `file://`, or relative to the chat's folder. */
	readonly reads?: readonly string[];
	/** Files it writes, relative to the chat's folder or absolute. */
	readonly writes?: readonly string[];
	/** Pages it opens. */
	readonly urls?: readonly string[];
	/**
	 * `delegates`: the chat it prompts; undefined for the caller itself. `reads-other`: the chat it
	 * reads; undefined when it reads the caller's own chat (thread_read) or many chats (thread_search,
	 * see `readsAnyChat`).
	 */
	readonly target?: string;
	/** `reads-other`: it reads chats in general, never only the caller's own. */
	readonly readsAnyChat?: boolean;
	/** `reads-other`: more chats it reads (thread_wait's list), besides `target`. */
	readonly targets?: readonly string[];
}

const MANAGE_AUTOMATION_SAFE = new Set(['list', 'delete']);
const AUTOMATION_ACTIONS: Readonly<Record<string, HostToolSandboxClass>> = {
	memory_read: 'safe',
	memory_write: 'persists',
	memory_append: 'persists',
	send_slack: 'network',
	read_slack: 'network',
	send_teams: 'network',
	read_teams: 'network',
	pr_comment: 'network',
	request_reviewers: 'network',
	// git push from the user's checkout.
	open_pr: 'escapes',
};

/** What this call of `name` would do; undefined for a tool the sandbox does not know (refused when sandboxed). */
export function hostToolSandboxUse(name: string, args: Readonly<Record<string, unknown>>): IHostToolSandboxUse | undefined {
	if (!Object.prototype.hasOwnProperty.call(HOST_TOOL_SANDBOX_CLASSES, name)) {
		return undefined;
	}
	const kind = HOST_TOOL_SANDBOX_CLASSES[name];
	const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
	switch (name) {
		case 'manage_automations':
			return { kind: MANAGE_AUTOMATION_SAFE.has(action) ? 'safe' : 'escapes' };
		case 'automation':
			return { kind: AUTOMATION_ACTIONS[action] ?? 'escapes' };
		case 'image_inspect':
			return { kind, reads: strings([args.path]) };
		case 'instant_grep':
		case 'find_symbol':
		case 'find_files':
			// The folder searched: `path`, else the chat's own.
			return { kind, reads: strings([args.path]).length ? strings([args.path]) : ['.'] };
		case 'workspace_status':
			return { kind, reads: ['.'] };
		case 'browser_compare_image':
			return { kind, reads: strings([args.reference_path]), urls: strings([args.url]) };
		case 'html_render':
		case 'html_preview':
			return { kind, reads: typeof args.html === 'string' ? localImagePaths(args.html) : [] };
		case 'canvas_render':
		case 'canvas_update':
			return { kind, reads: canvasImagePaths(args) };
		case 'screens_capture':
			return screensUse(args);
		case 'browser_run':
			return { kind, urls: browserCallUrls(args), writes: editPaths(args.edits) };
		case 'browser_act':
			return { kind, urls: browserCallUrls(args), writes: flowWrites(args.save) };
		case 'device_act':
			return opensApp(args) ? { kind: 'escapes' } : { kind, writes: flowWrites(args.save) };
		case 'delegate_task':
			return { kind: spawnKind(asList(args.tasks).some(task => task.isolation === 'worktree') || args.isolation === 'worktree') };
		case 'thread_launch':
			return { kind: spawnKind(args.workspace === 'worktree' || (isRecord(args.workspace) && args.workspace.type === 'worktree')) };
		case 'thread_fork':
			return { kind: spawnKind(args.workspace === 'worktree' || (isRecord(args.workspace) && args.workspace.type === 'worktree')) };
		case 'message_task':
			return { kind: spawnKind(false) };
		case 'thread_send':
		case 'queue_edit':
		case 'queue_send_now':
		case 'queue_resume':
		case 'thread_read':
		case 'queue_list':
		case 'worktree_status':
			return { kind, target: threadIdArg(args.thread_id) };
		case 'thread_wait': {
			const targets = [...(Array.isArray(args.thread_ids) ? args.thread_ids : []).map(threadIdArg), threadIdArg(args.thread_id)].filter((id): id is string => !!id);
			return { kind, ...(targets.length ? { targets } : { readsAnyChat: true }) };
		}
		case 'thread_search':
			return { kind, readsAnyChat: true };
	}
	if (kind === 'browser') {
		return { kind, urls: browserCallUrls(args) };
	}
	return { kind };
}

/** A start of a new chat: refused until spawned chats inherit the sandbox; one in a new worktree runs setup scripts outside it. */
function spawnKind(worktree: boolean): HostToolSandboxClass {
	return SPAWNED_CHATS_INHERIT_SANDBOX ? (worktree ? 'escapes' : 'safe') : 'spawns';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asList(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(values: readonly unknown[]): string[] {
	return values.filter((value): value is string => typeof value === 'string' && !!value.trim()).map(value => value.trim());
}

/** browser_run `edits`: each `path` it changes. */
function editPaths(edits: unknown): string[] {
	if (edits === undefined) {
		return [];
	}
	return strings((Array.isArray(edits) ? edits : [edits]).map(edit => isRecord(edit) ? edit.path : undefined));
}

/** A flow `save` writes `.volt/flows/<name>.flow` in the chat's folder. */
function flowWrites(save: unknown): string[] {
	return typeof save === 'string' && save.trim() ? [`.volt/flows/${save.trim()}.flow`] : [];
}

const OPEN_ACTIONS = new Set(['navigate', 'goto', 'open', 'visit', 'launch']);
const OPEN_LINE = /^\s*(?:\?\s*)?(?:goto|open|navigate|visit|launch)\b\s*(?:"([^"]*)"|'([^']*)'|(\S*))/i;

/**
 * What the steps of an act call open (`goto` lines, navigate steps): URLs in a browser, deep links
 * and app ids on a device. The script is parsed as the tools parse it, `${vars}` filled; one that
 * does not parse (the tool refuses it too) is judged by the lines that look like opening something.
 */
function openedTargets(args: Readonly<Record<string, unknown>>): string[] {
	const out: string[] = [];
	if (typeof args.script === 'string') {
		const vars = isRecord(args.vars) ? Object.fromEntries(Object.entries(args.vars).filter(([, value]) => typeof value === 'string')) as Record<string, string> : undefined;
		const parsed = parseActScript(args.script, vars);
		if ('steps' in parsed) {
			out.push(...parsed.steps.filter(step => step.action === 'navigate').map(step => step.url ?? ''));
		} else {
			for (const line of args.script.split('\n')) {
				const match = OPEN_LINE.exec(line);
				if (match) {
					out.push(match[1] ?? match[2] ?? match[3] ?? '');
				}
			}
		}
	}
	for (const step of asList(args.steps)) {
		const action = typeof step.action === 'string' ? step.action.trim().toLowerCase() : '';
		if (OPEN_ACTIONS.has(action) || typeof step.url === 'string') {
			out.push(typeof step.url === 'string' ? step.url : typeof step.target === 'string' ? step.target : '');
		}
	}
	return out;
}

/** Every URL a browser call opens: `url`, navigate steps and `goto` lines of a script. */
export function browserCallUrls(args: Readonly<Record<string, unknown>>): string[] {
	return [...new Set([...strings([args.url]), ...strings(openedTargets(args))])];
}

/** device_act (and a device screen's steps) that open a deep link or launch an app; saved flows (`run`) may. */
function opensApp(args: Readonly<Record<string, unknown>>): boolean {
	return openedTargets(args).length > 0 || (args.run !== undefined && args.run !== null && args.run !== '');
}

/** Canvas frames: an `image` path, or local images in a frame's `html`, anywhere in the call. */
function canvasImagePaths(value: unknown, depth = 0, out: string[] = []): string[] {
	if (depth > 6) {
		return out;
	}
	if (Array.isArray(value)) {
		for (const item of value.slice(0, 200)) {
			canvasImagePaths(item, depth + 1, out);
		}
	} else if (isRecord(value)) {
		if (typeof value.image === 'string' && !/^(data:|https?:)/i.test(value.image.trim())) {
			out.push(value.image.trim());
		}
		if (typeof value.html === 'string') {
			out.push(...localImagePaths(value.html));
		}
		for (const [key, item] of Object.entries(value)) {
			if (key !== 'image' && key !== 'html' && item && typeof item === 'object') {
				canvasImagePaths(item, depth + 1, out);
			}
		}
	}
	return out;
}

/**
 * screens_capture: the image files it reads and the pages it opens (web). On a device, a screen's
 * `open` or steps that open something launch an app. Window captures run desktop_act and
 * window_capture, which are judged when they are called.
 */
function screensUse(args: Readonly<Record<string, unknown>>): IHostToolSandboxUse {
	const screens = asList(args.screens);
	const scripts = strings([args.setup, ...screens.map(screen => screen.act)]);
	const web = strings([args.url]).length > 0;
	const windowed = strings([args.window]).length > 0;
	if (!web && !windowed && (strings(screens.map(screen => screen.open)).length > 0 || scripts.some(script => opensApp({ script })))) {
		return { kind: 'escapes' };
	}
	const urls = [
		...strings([args.url]),
		// A screen's `url` is a path on the base URL, or a URL of its own.
		...strings(screens.map(screen => screen.url)).filter(url => /^[a-z][a-z0-9+.-]*:/i.test(url)),
		...scripts.flatMap(script => browserCallUrls({ script })),
	];
	return { kind: 'reads', reads: strings(screens.map(screen => screen.path)), urls };
}

/** A chat whose agent runs in Volt's OS sandbox. */
export function isSandboxed(settings: IVoltSandboxSettings | undefined): settings is IVoltSandboxSettings & { readonly level: Exclude<VoltSandboxLevel, 'off'> } {
	return !!settings && settings.level !== 'off';
}

const LEVEL_RANK: Readonly<Record<VoltSandboxLevel, number>> = { 'off': 0, 'workspace-write': 1, 'read-only': 2 };

/** Where two chats work and how their agents are sandboxed, for `sandboxCovers`. */
export interface ISandboxCoverScopes {
	/** The target's folder (as a real path when the caller could resolve it). */
	readonly target?: string;
	/** The caller's folder (as a real path when the caller could resolve it). */
	readonly caller?: string;
	/** The target agent's strategy; unknown: `wrap`. */
	readonly targetStrategy?: SandboxStrategy;
	readonly callerStrategy?: SandboxStrategy;
}

/**
 * Whether a chat with `target` settings is confined at least as much as `caller` (INV-11): its level
 * is as strict, its agent's sandbox no weaker (`native` < `wrap`, B-10), its network no wider, its
 * extra folders, hosts and listen ports within the caller's, and (when it may write its workspace)
 * its workspace is one the caller may write too (B-11). Pass real paths: a symlinked folder
 * compared by its name could point anywhere. The Policy Authority decides (`chatCovers`).
 */
export function sandboxCovers(target: IVoltSandboxSettings | undefined, caller: IVoltSandboxSettings | undefined, cwds?: ISandboxCoverScopes): boolean {
	if (!isSandboxed(caller)) {
		return true;
	}
	const targetView = target ? { subject: chatSubject('target'), settings: target, ...(cwds?.targetStrategy ? { strategy: cwds.targetStrategy } : {}), ...(cwds?.target ? { folder: cwds.target } : {}) } : undefined;
	return chatCovers(targetView, { subject: chatSubject('caller'), settings: caller, ...(cwds?.callerStrategy ? { strategy: cwds.callerStrategy } : {}), ...(cwds?.caller ? { folder: cwds.caller } : {}) });
}

/**
 * The capability a host tool class needs (G.8: tool classes map onto capabilities). `tools.register`
 * alone covers tools that only change or read Volt's own state.
 */
export function hostToolClassCapability(toolClass: HostToolSandboxClass): string {
	switch (toolClass) {
		case 'safe': return 'tools.register';
		case 'browser': return 'browser.drive';
		case 'reads': return 'files.read:workspace';
		case 'network': return 'net.connect';
		case 'writes': return 'files.write';
		case 'sandboxed': return 'terminals.run';
		case 'reads-other': return 'agents.read:other';
		case 'persists': return 'agents.context';
		case 'delegates': return 'agents.send';
		case 'spawns': return 'agents.create';
		case 'escapes': return 'spawn.unsandboxed';
	}
}

/**
 * The gate's rules before the Policy Authority (C2), kept for shadow mode for one release (M.3):
 * the class of a sandboxed chat's call that is refused, or undefined when the class allows it.
 * `covers`: whether the chat a `delegates` call prompts is confined at least as much.
 */
export function legacyHostToolRefusal(use: IHostToolSandboxUse | undefined, callerSessionId: string | undefined, sandbox: IVoltSandboxSettings, covers: boolean): boolean {
	if (!use) {
		return true;
	}
	switch (use.kind) {
		case 'escapes':
		case 'persists':
		case 'spawns':
			return true;
		case 'network':
			return !sandbox.network;
		case 'delegates':
			return !!use.target && use.target !== callerSessionId && !covers;
		case 'reads-other':
			return !!use.readsAnyChat || readTargets(use).some(target => target !== callerSessionId);
	}
	return false;
}

/** The chats a `reads-other` call names (`target` and `targets`). */
export function readTargets(use: IHostToolSandboxUse): string[] {
	return [...use.target !== undefined ? [use.target] : [], ...use.targets ?? []];
}

/**
 * Whether `target` is `caller` or one of its children (its subagents and the side chats started
 * from it, at any depth), by `parentOf`. A sandboxed chat reads only those.
 */
export function chatInSubtree(caller: string, target: string, parentOf: (id: string) => string | undefined): boolean {
	let current: string | undefined = target;
	for (let depth = 0; current !== undefined && depth < 32; depth++) {
		if (current === caller) {
			return true;
		}
		current = parentOf(current);
	}
	return false;
}

/** `sandboxCovers` before the Policy Authority, kept for shadow mode for one release (M.3). */
export function legacySandboxCovers(target: IVoltSandboxSettings | undefined, caller: IVoltSandboxSettings | undefined, cwds?: ISandboxCoverScopes): boolean {
	if (!isSandboxed(caller)) {
		return true;
	}
	if (!target || LEVEL_RANK[target.level] < LEVEL_RANK[caller.level]) {
		return false;
	}
	if (!strategyAtLeast(cwds?.targetStrategy ?? (isSandboxed(target) ? 'wrap' : 'none'), cwds?.callerStrategy ?? 'wrap')) {
		return false;
	}
	if (!caller.network && target.network) {
		return false;
	}
	if ((target.listenPorts ?? []).some(port => !(caller.listenPorts ?? []).includes(port))) {
		return false;
	}
	const callerRoots = [...(caller.extraWritableRoots ?? []), ...(caller.level === 'workspace-write' && cwds?.caller ? [cwds.caller] : [])];
	if ((target.extraWritableRoots ?? []).some(root => !callerRoots.some(allowed => isPathInside(root, allowed)))) {
		return false;
	}
	if (!caller.network && (target.allowedDomains ?? []).some(host => !domainAllowed(host, caller.allowedDomains ?? []))) {
		return false;
	}
	// The target writes its own workspace: only where the caller could write too.
	if (target.level === 'workspace-write' && (!cwds?.target || !callerRoots.some(allowed => isPathInside(cwds.target!, allowed)))) {
		return false;
	}
	return true;
}

/**
 * The path rules for a sandboxed chat's host tool calls: the files broker's (`voltFiles/common/
 * filesBroker.ts`), so the gate and the broker judge a path alike. Kept under these names for the
 * gate's callers and tests.
 */
export type { ISandboxPathContext } from '../../../../platform/voltFiles/common/filesBroker.js';
export { brokerReadRefusal as sandboxReadRefusal, brokerWriteRefusal as sandboxWriteRefusal } from '../../../../platform/voltFiles/common/filesBroker.js';

/** Why a sandboxed chat may not open (or read) the page at `url` in the in-app browser, or undefined when it may. */
export function sandboxBrowserUrlRefusal(settings: IVoltSandboxSettings | undefined, url: string | undefined): string | undefined {
	const raw = url?.trim();
	if (!isSandboxed(settings) || !raw || /^[/.?#]/.test(raw) && !raw.startsWith('//')) {
		return undefined; // a path on the page's own site, which the page check judges
	}
	let parsed: URL;
	try {
		parsed = new URL(/^\d+$/.test(raw) ? `http://localhost:${raw}` : /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^localhost:/i.test(raw) ? raw : `http://${raw}`);
	} catch {
		return undefined; // not a URL: a path on the current site, which the page check judges
	}
	switch (parsed.protocol) {
		case 'about:':
		case 'data:':
			return undefined;
		case 'file:':
			// A local page may frame or link any local file; serve it with playground_create or a dev server instead.
			return `${raw} is a local file page, which a sandboxed chat does not open; serve it with playground_create or the project's dev server instead`;
		case 'http:':
		case 'https:':
		case 'ws:':
		case 'wss:': {
			if (settings.network) {
				return undefined;
			}
			const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
			if (isLoopbackHost(host)) {
				// A local page is a server something on this machine runs, maybe the agent itself, and its
				// script could send what it reads anywhere: only on a port the user granted (B-16).
				const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : 80;
				return (settings.listenPorts ?? []).includes(port) ? undefined : `${parsed.host} is a local server on a port this chat's sandbox was not granted (its network is off)`;
			}
			return domainAllowed(host, settings.allowedDomains ?? []) ? undefined : `${parsed.host} is not reachable: this chat's network is off`;
		}
	}
	return `${parsed.protocol} pages are not opened from a sandboxed chat`;
}

/** `localhost`, `*.localhost`, `0.0.0.0`, `::1` and 127/8 (a hostname, lower case, without brackets). */
export function isLoopbackHost(host: string): boolean {
	return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** What the model reads when a tool is refused for a sandboxed chat: what happened and what to do instead. */
export function sandboxRefusalMessage(name: string, kind: HostToolSandboxClass | undefined, settings: IVoltSandboxSettings): string {
	const head = `${name} was not run: this chat runs in Volt's ${settings.level === 'read-only' ? 'read-only ' : ''}sandbox`;
	switch (kind) {
		case 'escapes':
			return `${head}, and ${name} would run outside it. ${INSTEAD[name] ?? 'Do it with your own tools inside the sandbox, or ask the user to turn the sandbox off for this chat.'}`;
		case 'persists':
			return `${head}, and ${name} would save something later chats read outside the sandbox. Put what matters in your reply instead, or ask the user to save it.`;
		case 'spawns':
			return `${head}, and ${name} would start a chat that does not run in it. Do the work in this chat, or ask the user to start the other chat.`;
		case 'delegates':
			return `${head}, and ${name} would have a chat that is less confined act on your message. Do the work in this chat, or ask the user.`;
		case 'network':
			return `${head} with the network off, and ${name} would reach the internet for you. Ask the user to do it, or to turn the network on for this chat.`;
		case 'reads-other':
			return `${head}, and ${name} would read other chats, which needs the agents.read:other permission that sandboxed chats do not have. Work from this chat's own context, or ask the user for what the other chat said.`;
		default:
			return `${head}, and ${name} is not cleared to run from a sandboxed chat. Continue without it, or ask the user to turn the sandbox off for this chat.`;
	}
}

const SHELL_INSTEAD = 'Run the command with your own shell tool instead: it runs inside the sandbox.';
const GIT_INSTEAD = 'Run git with your own shell tool instead: it runs inside the sandbox.';
const ASK_USER = 'Ask the user to do it, or to turn the sandbox off for this chat.';
const INSTEAD: Readonly<Record<string, string>> = {
	terminal_start: SHELL_INSTEAD,
	terminal_send: SHELL_INSTEAD,
	terminal_stop: 'Stop processes you started with your own shell tool.',
	task_watch: SHELL_INSTEAD,
	docker_ensure: 'Run docker with your own shell tool, or ask the user to start Docker.',
	app_open: 'Ask the user to open it.',
	device_install_app: 'Ask the user to install and launch the app, or to turn the sandbox off for this chat.',
	device_launch_app: 'Ask the user to launch the app, or to turn the sandbox off for this chat.',
	device_act: 'Steps that open a deep link or an app, and saved flows (which may), count as launching it. Ask the user to open the app, then act with plain steps.',
	screens_capture: 'Opening an app on a device counts as launching it. Ask the user to open it, or capture web pages or image files instead.',
	desktop_apps: ASK_USER,
	desktop_snapshot: ASK_USER,
	desktop_act: ASK_USER,
	window_capture: 'Ask the user for a screenshot.',
	window_record_start: 'Ask the user for a recording.',
	worktree_handoff: GIT_INSTEAD,
	stack_branch: GIT_INSTEAD,
	restack_stack: GIT_INSTEAD,
	thread_merge_back: 'Ask the user to merge it back.',
	rename_branch: 'Run `git branch -m <new name>` with your own shell tool instead.',
	manage_automations: 'Ask the user to create, change or run the automation.',
	automation: 'Ask the user to do it.',
	delegate_task: 'Do the work in this chat instead.',
	thread_launch: 'Do the work in this chat, or ask the user to start the chat.',
	thread_fork: 'Do the work in this chat, or ask the user to fork it.',
};
