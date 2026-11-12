/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltHostMcpService = createDecorator<IVoltHostMcpService>('voltHostMcpService');
export const VOLT_HOST_MCP_CHANNEL_NAME = 'voltHostMcp';

export interface IVoltHostMcpToolInfo {
	readonly name: string;
	readonly title?: string;
	readonly description: string;
	readonly inputSchema: object;
	/** Lets a URL ask for a subset: `/mcp/<sessionId>?groups=core,image` (the session's token covers the groups). */
	readonly group?: string;
	/** Earlier names still accepted in `tools/call` (never listed). */
	readonly aliases?: readonly string[];
}

/** Where agents reach a window's server, and the secret their bearer tokens derive from. */
export interface IVoltHostMcpEndpoint {
	/** `http://127.0.0.1:<port>/mcp` */
	readonly url: string;
	/**
	 * The server secret. Random per server; never logged and never handed to an agent: an agent
	 * gets `hostMcpSessionToken(token, sessionId, groups, lease)` for `/mcp/<sessionId>` (see
	 * `voltHostMcpAuth.ts`). A request without a session needs this secret itself.
	 */
	readonly token: string;
}

/** An agent called a tool on the server a window registered. The window answers with `respond`. */
export interface IVoltHostMcpCall {
	readonly id: string;
	readonly serverId: string;
	/** From the URL path `/mcp/<sessionId>`, verified against the session's token: the Volt chat the agent serves. */
	readonly sessionId?: string;
	readonly name: string;
	readonly args: unknown;
}

export interface IVoltHostMcpResult {
	readonly content: readonly unknown[];
	readonly isError?: boolean;
}

/**
 * Volt's own MCP server (questions, the in-app browser) for agents it launches. It runs in the
 * main process because the workbench renderer is sandboxed; each window registers a server and
 * answers the tool calls that come in on it.
 */
export interface IVoltHostMcpService {
	readonly _serviceBrand: undefined;
	readonly onDidCall: Event<IVoltHostMcpCall>;
	/** The agent dropped the HTTP request (timeout, cancelled turn) before an answer came. */
	readonly onDidCancel: Event<{ readonly id: string; readonly serverId: string }>;
	/**
	 * Starts (or updates the tools of) the server `serverId`. It listens on loopback only and answers
	 * only requests with its bearer token, a loopback Host and no browser Origin.
	 */
	start(serverId: string, tools: readonly IVoltHostMcpToolInfo[]): Promise<IVoltHostMcpEndpoint>;
	respond(id: string, result: IVoltHostMcpResult): Promise<void>;
	/**
	 * The chat was closed or released: server `serverId` refuses its tokens with key epoch `epoch`
	 * or below from now on (`voltHostMcpAuth.ts`). Tokens issued after carry a larger epoch.
	 */
	revokeSession(serverId: string, sessionId: string, epoch: number): Promise<void>;
	stop(serverId: string): Promise<void>;
}

/**
 * The volt server's `initialize` instructions, one part per tool group: an agent handed a subset
 * (`?groups=`) reads only about the tools it has. A read-only Volt subagent (core, tasks, image) reads ~240
 * tokens instead of ~1.3k. Without groups: every part, as before.
 */
const HOST_MCP_INSTRUCTIONS: readonly { readonly groups: readonly string[]; readonly text: string; readonly onlyWithout?: string }[] = [
	{ groups: ['core'], text: 'Volt tools: for questions about the project\'s code, find_symbol (where a name is declared), instant_grep (indexed rg), find_files (fuzzy path) and code_nav (references, callers, callees, implementations, inspect, from the editor\'s language servers) answer in one call each what takes several Grep and Read rounds. workspace_status says what the user has open beside this chat (right-panel tabs, the simulator and its app in front, browser URLs, terminals with their output, git changes); prompts may carry a short <volt_workspace> summary of it. ask_question asks the user multiple-choice questions in Volt.' },
	{ groups: ['browser'], text: 'browser_* tools drive the in-app browser beside this chat (navigate, snapshot, act, click by ref, type, resize, screenshot, console, network) to preview and test web pages. For anything past a single click, use browser_act: it runs a whole flow (type, click, select, check, wait) in one call with elements targeted by role/name/label/text, verifies each step with expect, and reports only what changed on the page. browser_run applies file edits (exact old to new text) and then runs steps with waiting assertions in one call, to fix and verify together; browser_status shows the open page and the dev servers running here; browser_mock fakes API responses (errors, empty, slow); browser_emulate sets offline/slow network, dark mode, locale; browser_audit finds accessibility, contrast, overflow and performance problems with the exact element and CSS. playground_create serves throwaway draft pages and mock UIs from outside the project (playground_delete when done). Use these instead of writing Playwright, puppeteer or headless-Chrome scripts, preview files in the repo, or `python -m http.server`.' },
	{ groups: ['devices'], text: 'On iOS simulators and Android emulators, device_snapshot reads the screen\'s accessibility tree and device_act taps, types, scrolls and verifies by visible text instead of screenshot coordinates.' },
	{ groups: ['desktop'], text: 'On the user\'s Mac, desktop_snapshot and desktop_act read and drive native apps the same way (buttons, fields, menus by name, through accessibility); the user approves desktop control once per chat.' },
	{ groups: ['browser', 'devices', 'desktop'], text: 'Every *_act tool takes a short step script (one step per line) and can save a passing run as a flow to re-run with one call.' },
	{ groups: ['browser'], text: 'To build a page from a design image: image_inspect reads exact colours, block bounds and text bands from the image; browser_compare_image renders the page at the image size and returns the mismatch and the regions to fix. Use them instead of writing image-decoding or headless-Chrome scripts.' },
	{ groups: ['image'], onlyWithout: 'browser', text: 'image_inspect reads exact colours, block bounds and text bands from an image file; use it instead of writing image-decoding scripts.' },
	{ groups: ['pullRequests'], text: 'Pull requests: when you create or work on a pull request, call link_pull_request so it shows on this chat (for a stack, every layer). Stacked pull requests: stack_branch makes a layer on the checked out branch, stack_status shows the stack, and restack_stack moves the layers above a changed or merged parent and pushes them (follow its prompt when it stops on a conflict). When asked to monitor, watch or babysit a pull request, call watch_pull_request and end your turn: Volt wakes you when checks fail or pass, a review or comment comes in, or the branch conflicts. Commits: when asked to commit, split the changes into meaningful commits with Conventional Commits messages (type(scope): summary) and run git commit. Call propose_commits (the user reviews the commits and Volt makes them) only when the user asks to review them first: draft commits, /draft-commit, or "split them for me to review"; a plain "commit and push" or "commit and open a PR" is not that. A worktree chat starts on a placeholder branch (volt/ and 8 hex characters): before pushing it or opening a pull request from it, ask the user what to call it with ask_question (4 names you suggest as type/short-kebab-summary, e.g. feat/cart-discounts; they can type their own), then call rename_branch.' },
	{ groups: ['visuals'], text: 'Visual replies: when a chart, dashboard, table, diagram or mockup would say more than prose, show it in the reply. For data, call render_chart with a JSON spec: Volt draws it natively in the user\'s theme with hover, tooltips and keyboard reading, and it takes seconds. Every data chart (bar, line, pie, scatter, ...) goes through render_chart (or, in plain markdown, a ```volt-chart fence holding the same JSON spec); never draw data with mermaid xychart-beta or pie, or with ASCII bars. Mermaid fences are for diagrams only (flowcharts, sequence, state). For anything else (dashboards, mockups, reports, diagrams, interactive explainers), write a self-contained HTML page, check it with html_preview, then publish it with html_render. Call these before your final text; the reader already sees the visual, so do not describe or restate it.' },
	{ groups: ['threads'], text: 'Orchestration: you can run other Volt chats. orchestrator_capabilities lists models and what you may do; thread_list / thread_search / thread_read read any chat; thread_send messages one (wait=true returns its reply); thread_wait waits for chats to finish; thread_launch starts a new top-level chat (any model, its own worktree with workspace.type=worktree, several models at once with models); thread_fork copies a chat\'s conversation into a new chat to try another direction or model; queue_* manage a chat\'s queued messages; delegate_task runs a subagent whose report comes back to you. Link chats you mention as [title](volt://session/<id>).' },
	{ groups: ['tasks'], onlyWithout: 'threads', text: 'delegate_task runs a subagent (one level down) whose report comes back to you; wait_tasks and task_status follow it. In a team, team_board claims and completes board items and team_send messages a teammate.' },
];

export function hostMcpInstructions(groups?: ReadonlySet<string>): string {
	return HOST_MCP_INSTRUCTIONS
		.filter(part => !groups || (part.groups.some(group => groups.has(group)) && !(part.onlyWithout && groups.has(part.onlyWithout))))
		.filter(part => groups || !part.onlyWithout)
		.map(part => part.text)
		.join(' ');
}
