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
	/** MCP tool `_meta`, listed as is (e.g. `anthropic/alwaysLoad`). */
	readonly _meta?: Readonly<Record<string, unknown>>;
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
 * (`?groups=`) reads only about the tools it has. Claude Code puts them in every request of every
 * chat, so each part names the tool for a job and the one rule that matters, and the tool's own
 * description carries the rest (all parts: 5.3k characters until 2026-11-13, now 2.9k, ~950 tokens in a request).
 */
const HOST_MCP_INSTRUCTIONS: readonly { readonly groups: readonly string[]; readonly text: string; readonly onlyWithout?: string }[] = [
	{ groups: ['core'], text: 'Volt tools (load deferred ones with ToolSearch). Code questions: find_symbol (where a name is declared), code_nav (references, callers, implementations, inspect), instant_grep (indexed rg) and find_files answer in one call what takes several Grep and Read rounds. workspace_status: what the user has open beside this chat (tabs, simulator, browser, terminals, git). ask_question: multiple-choice questions to the user.' },
	{ groups: ['ide'], text: 'tests runs the project\'s tests with structured failures; debug sets breakpoints, steps and reads variables; ide reaches http, db, docker, profiling and more.' },
	{ groups: ['browser'], text: 'browser_* drive the in-app browser beside this chat. For any multi-step check use browser_act (steps by role/name/text, each verified, reports what changed); browser_run applies file edits then checks; browser_status lists the page and dev servers; browser_mock, browser_emulate and browser_audit fake APIs, set network/theme/locale and find accessibility, layout and performance problems. playground_create serves throwaway pages outside the project. Use these, not Playwright or headless-Chrome scripts, preview files or `python -m http.server`.' },
	{ groups: ['devices'], text: 'device_snapshot and device_act read and drive iOS simulators and Android emulators by visible text.' },
	{ groups: ['desktop'], text: 'desktop_snapshot and desktop_act drive native Mac apps through accessibility; the user approves once per chat.' },
	{ groups: ['browser', 'devices', 'desktop'], text: '*_act tools take a step script, one step per line.' },
	{ groups: ['browser'], text: 'From a design image: image_inspect reads its colours, blocks and text; browser_compare_image diffs the page against it.' },
	{ groups: ['image'], onlyWithout: 'browser', text: 'image_inspect reads exact colours, block bounds and text bands from an image file; use it instead of image-decoding scripts.' },
	{ groups: ['pullRequests'], text: 'Pull requests: call link_pull_request for every pull request you open or work on; stack_branch, stack_status and restack_stack manage stacked ones; to monitor one, call watch_pull_request and end your turn (Volt wakes you). Commit with Conventional Commits messages via git; propose_commits only when the user asks to review the commits first. A worktree chat on a placeholder branch (volt/ and 8 hex characters): before pushing or opening a pull request, ask_question for a name (4 suggestions like feat/cart-discounts), then rename_branch.' },
	{ groups: ['visuals'], text: 'Visual replies: chart data with render_chart (a JSON spec Volt draws natively; in plain markdown a ```volt-chart fence holding the same spec), never mermaid xychart/pie or ASCII bars; mermaid only for diagrams. Dashboards, mockups and reports: a self-contained HTML page, checked with html_preview, published with html_render. Show it before your final text and do not restate it.' },
	{ groups: ['threads'], text: 'Orchestration: orchestrator_capabilities lists models and what you may do; thread_list, thread_search and thread_read read chats; thread_send messages one (wait=true returns its reply); thread_wait waits; thread_launch starts a chat (any model, own worktree, several models); thread_fork copies one; queue_* manage queued messages; delegate_task runs a subagent that reports back. Link chats as [title](volt://session/<id>).' },
	{ groups: ['tasks'], onlyWithout: 'threads', text: 'delegate_task runs a subagent (one level down) whose report comes back to you; wait_tasks and task_status follow it. In a team, team_board claims and completes board items and team_send messages a teammate.' },
];

export function hostMcpInstructions(groups?: ReadonlySet<string>): string {
	return HOST_MCP_INSTRUCTIONS
		.filter(part => !groups || (part.groups.some(group => groups.has(group)) && !(part.onlyWithout && groups.has(part.onlyWithout))))
		.filter(part => groups || !part.onlyWithout)
		.map(part => part.text)
		.join(' ');
}
