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
	/**
	 * `_meta` goes only into a full listing (a top-level chat). A listing for a subset (`?groups=`, a
	 * Volt subagent) has the tool without it: e.g. delegate_task is always loaded for the chat that
	 * delegates, and stays behind the tool search for subagents, which rarely delegate.
	 */
	readonly metaInFullListOnly?: boolean;
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
 * description carries the rest (all parts: 5.3k characters, 1,342 tokens in a request until 2026-11-13;
 * 1,950 characters, 693 tokens until 2026-11-14; now 1,731, 608). The deferred-tools reminder names
 * every tool, so a part says what a tool is for and its one rule rather than listing its family.
 */
const HOST_MCP_INSTRUCTIONS: readonly { readonly groups: readonly string[]; readonly text: string; readonly onlyWithout?: string }[] = [
	{ groups: ['core'], text: 'Volt tools (deferred: load with ToolSearch). Code: find_symbol (declarations), code_nav (references, callers, implementations), instant_grep (indexed rg), find_files: one call for several Grep/Read rounds. workspace_status: what the user has open (tabs, simulator, browser, terminals, git). ask_question: multiple-choice questions to the user.' },
	{ groups: ['ide'], text: 'tests runs tests with structured failures; debug sets breakpoints and reads variables; ide does http, db, docker, profiling and more.' },
	{ groups: ['browser'], text: 'In-app browser: browser_act runs a multi-step check in one call, browser_run edits files then checks; playground_create serves throwaway pages. Not Playwright, headless Chrome or `python -m http.server`.' },
	{ groups: ['devices'], text: 'device_snapshot/device_act drive iOS simulators and Android emulators.' },
	{ groups: ['desktop'], text: 'desktop_snapshot/desktop_act drive Mac apps (the user approves once per chat).' },
	{ groups: ['browser'], text: 'Design image: image_inspect reads it, browser_compare_image diffs the page against it.' },
	{ groups: ['image'], onlyWithout: 'browser', text: 'image_inspect reads colours, blocks and text from an image file (no image-decoding scripts).' },
	{ groups: ['pullRequests'], text: 'Pull requests: link_pull_request each one you open or work on; to monitor one, watch_pull_request and end your turn. Commit with git (Conventional Commits); propose_commits only if the user asks to review commits first. Before pushing a placeholder branch (volt/ + 8 hex), ask_question for a name, then rename_branch.' },
	{ groups: ['visuals'], text: 'Data charts: render_chart (or a ```volt-chart fence with its JSON), never mermaid xychart/pie or ASCII bars; mermaid only for diagrams. Pages and dashboards: self-contained HTML, html_preview, then html_render. Show visuals before your final text; do not restate them.' },
	{ groups: ['threads'], text: 'Other chats: thread_* (thread_send wait=true returns the reply; thread_launch: any model, own worktree, several models) and queue_*; delegate_task runs a subagent that reports back. Link chats as [title](volt://session/<id>).' },
	{ groups: ['tasks'], onlyWithout: 'threads', text: 'delegate_task runs a subagent (one level down) whose report comes back to you; wait_tasks and task_status follow it. In a team, team_board claims and completes board items and team_send messages a teammate.' },
];

export function hostMcpInstructions(groups?: ReadonlySet<string>): string {
	return HOST_MCP_INSTRUCTIONS
		.filter(part => !groups || (part.groups.some(group => groups.has(group)) && !(part.onlyWithout && groups.has(part.onlyWithout))))
		.filter(part => groups || !part.onlyWithout)
		.map(part => part.text)
		.join(' ');
}
