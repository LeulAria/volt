/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	/**
	 * Volt's own API: its chats and agents, agent tools, memory, browser, visuals, automations,
	 * usage and pull requests, for any extension running in Volt.
	 *
	 * Use it by adding `"volt"` to `enabledApiProposals` in `package.json`. Unlike the editor's other
	 * proposals it works for every extension, including ones installed from Open VSX, with no flag.
	 *
	 * Every call needs a capability from Volt's catalog, declared in `contributes.voltCapabilities`.
	 * Undeclared, the call fails with a {@link volt.CapabilityError}. Declared `low` capabilities
	 * work while the extension is enabled; `medium` and `high` ones ask the user once (Volt asks, in
	 * its own words; the answer is kept and can be changed on the extension's page). `critical`
	 * capabilities are never granted through this API. Each function below names its capability.
	 *
	 * Outside Volt the `volt` namespace is undefined: check `vscode.volt` first.
	 */
	export namespace volt {

		/** The API version (semver). */
		export const version: string;

		/**
		 * Why Volt refused a call. Thrown errors have the name `VoltCapabilityError`.
		 */
		export interface CapabilityError extends Error {
			readonly capability: string;
			readonly target?: string;
			/**
			 * The layer that refused it: `manifest` (not declared in `voltCapabilities`), `consent`
			 * (the user did not allow it), `critical` (never through the API), `catalog` (not a Volt
			 * capability or tool), `ceiling` (a built-in beyond its first-party ceiling).
			 */
			readonly deniedBy: string;
		}

		/** A picture Volt published (a chart, a page, a Scratch drawing). Opaque: return it from a tool. */
		export interface VisualRef {
			readonly kind: string;
			readonly ref: string;
			readonly title: string;
		}

		/** What a tool returns to the agent. */
		export interface ToolResult {
			readonly text?: string;
			/** A base64 PNG. */
			readonly image?: string;
			readonly error?: string;
			/** From {@link visuals.renderChart}: the chat shows it above the agent's reply. */
			readonly visual?: VisualRef;
		}

		/** Who called a tool. */
		export interface ToolCall {
			/** The chat whose agent called it. */
			readonly chatId?: string;
		}

		export interface ToolOptions {
			/** Used when the `contributes.voltTools` entry has none. */
			readonly title?: string;
			readonly description?: string;
			/** JSON schema of the input. Used when the `contributes.voltTools` entry has none. */
			readonly inputSchema?: object;
		}

		export type ToolHandler = (input: Record<string, unknown>, call: ToolCall, token: CancellationToken) => ToolResult | Thenable<ToolResult>;

		/** Agent tools. */
		export namespace tools {
			/**
			 * Serves a tool that agents in every Volt chat can call. Declare it in
			 * `contributes.voltTools` (name, class, description, input schema) so agents see it before
			 * the extension starts; its first call activates the extension (`onTool:<name>`).
			 * Capability: `tools.register`, plus what the tool's class implies (`reads`:
			 * `files.read:workspace`, `writes`: `files.write`, `network`: `net.connect`, ...).
			 */
			export function registerTool(name: string, handler: ToolHandler, options?: ToolOptions): Disposable;

			/**
			 * Runs one of Volt's own agent tools (`memory_list`, `render_chart`, `browser_snapshot`,
			 * ...), for `chatId` when given. Capability: `agents.send`, plus what the tool's class
			 * implies. Tools that run outside the sandbox (`escapes`) are never allowed.
			 */
			export function invokeTool(name: string, input?: Record<string, unknown>, options?: { readonly chatId?: string }): Thenable<ToolResult>;
		}

		export interface Chat {
			readonly id: string;
			readonly title: string;
			/** `running`, `idle`, `done`, `failed`, ... */
			readonly status: string;
			readonly createdAt: number;
			readonly updatedAt: number;
			readonly turnCount: number;
			/** The project folder. */
			readonly project?: string;
		}

		export interface TurnEvent {
			readonly chatId: string;
			readonly turnId: string;
			/** `prompt`, `notification`, `followup`, ... */
			readonly kind: string;
			/** When it finished: `done`, `failed`, `cancelled` or `interrupted`. */
			readonly outcome?: string;
		}

		/** Volt's chats and their agents. */
		export namespace chats {
			/** Newest first. Capability: `agents.read:any`. */
			export function list(options?: { readonly query?: string; readonly limit?: number }): Thenable<readonly Chat[]>;
			/** The chat the user has in front. Capability: `agents.read:current`. */
			export function current(): Thenable<Chat | undefined>;
			/** A chat's turns, as text. Capability: `agents.read:current` for the chat in front, else `agents.read:any`. */
			export function read(chatId: string): Thenable<ToolResult>;
			/** Sends a message to a chat's agent (the agent sees it comes from your extension). Capability: `agents.send`. */
			export function send(chatId: string, message: string): Thenable<ToolResult>;
			/** Starts a chat. Capability: `agents.create`. */
			export function start(options: { readonly title: string; readonly message?: string; readonly model?: string; readonly project?: string }): Thenable<ToolResult>;
			/**
			 * A chat started a turn. Capability: `agents.read:any`, checked when the first listener is
			 * added (a refusal is logged and no events arrive).
			 */
			export const onDidStartTurn: Event<TurnEvent>;
			/** A chat's turn ended. Capability: `agents.read:any`. */
			export const onDidEndTurn: Event<TurnEvent>;
		}

		/** The extension's own key-value storage in Volt (per profile). Capability: none. */
		export interface Storage {
			get<T = unknown>(key: string): Thenable<T | undefined>;
			/** JSON values. */
			set(key: string, value: unknown): Thenable<void>;
			delete(key: string): Thenable<void>;
			keys(): Thenable<readonly string[]>;
		}

		export const storage: Storage;

		/**
		 * Settings. The extension's own (its `contributes.configuration`) need no capability; Volt
		 * does not hand out other settings through this API.
		 */
		export namespace settings {
			export function get<T = unknown>(key: string): Thenable<T | undefined>;
			export function update(key: string, value: unknown): Thenable<void>;
			export const onDidChange: Event<{ affects(key: string): boolean }>;
		}

		export interface MemoryNote {
			readonly name: string;
			/** One line: when the note matters. */
			readonly description: string;
			/** `user` (about the person), `feedback` (how to work with them), `project` (facts about the work) or `reference` (where to look things up). */
			readonly type: string;
			readonly body: string;
			/** `user`: every project. `project`: this workspace. */
			readonly scope: string;
		}

		/** Volt's memory: notes every later chat recalls, whatever the provider. */
		export interface Memory {
			/** `scope`: `user`, `project` or `all` (default). Capability: `agents.read:any`. */
			list(scope?: string): Thenable<readonly MemoryNote[]>;
			/** Capability: `agents.read:any`. */
			read(name: string, scope?: string): Thenable<MemoryNote | undefined>;
			/** Saves (or overwrites) a note; `type` defaults to `project`, `scope` to `user`. Capability: `agents.context`. */
			write(note: { readonly name: string; readonly description: string; readonly body: string; readonly type?: string; readonly scope?: string }): Thenable<MemoryNote>;
			/** Capability: `agents.context`. */
			delete(name: string, scope?: string): Thenable<boolean>;
		}

		export const memory: Memory;

		/** Volt's in-app browser. */
		export namespace browser {
			/** Opens an http(s) URL in Volt's browser. Capability: `browser.drive`. */
			export function open(url: string): Thenable<void>;
			/** The page in a chat's browser tab (the chat in front by default), as an accessibility snapshot. Capability: `browser.read`. */
			export function readPage(options?: { readonly chatId?: string }): Thenable<{ readonly url?: string; readonly snapshot: ToolResult }>;
		}

		/** Charts and Scratch board drawings. */
		export namespace visuals {
			/**
			 * Renders charts (the specs `render_chart` takes: bar, line, area, pie, scatter, heatmap,
			 * ...). Return the result from a tool and the chat shows the chart above the agent's
			 * reply. Capability: `ui.contribute` (none).
			 */
			export function renderChart(chart: { readonly title?: string; readonly subtitle?: string; readonly charts: readonly object[] }): Thenable<ToolResult>;
			/**
			 * Draws on the user's Scratch board: `title` plus a `mermaid` flowchart, a `diagram`, a
			 * `page`, `elements`, `notes` or `cards` (as `scratch_draw` takes them). Capability: `agents.send`.
			 */
			export function drawOnScratch(drawing: { readonly title: string;[key: string]: unknown }, options?: { readonly chatId?: string }): Thenable<ToolResult>;
		}

		/**
		 * When an automation runs, by `type`: `hourly` (`minute`), `daily` (`time`, local "HH:MM"),
		 * `weekly` (`weekdays`, 0 is Sunday, and `time`), `cron` (`expr`), `interval` (`everyMs`) or
		 * `once` (`at`, epoch ms).
		 */
		export interface AutomationSchedule {
			readonly type: string;
			readonly minute?: number;
			readonly time?: string;
			readonly weekdays?: readonly number[];
			readonly expr?: string;
			readonly everyMs?: number;
			readonly at?: number;
		}

		export interface Automation {
			readonly id: string;
			readonly name: string;
			readonly enabled: boolean;
			readonly schedules: readonly AutomationSchedule[];
			/** Epoch ms. */
			readonly nextRun?: number;
			readonly createdBy: string;
			readonly runCount: number;
		}

		/** Scheduled agent runs. */
		export namespace automations {
			/** Capability: `agents.read:any`. */
			export function list(): Thenable<readonly Automation[]>;
			/** Runs an agent with `instructions` on a schedule (a new chat each run, or `chatId`). Capability: `automations.schedule`. */
			export function schedule(options: { readonly name: string; readonly instructions: string; readonly schedule: AutomationSchedule; readonly chatId?: string; readonly enabled?: boolean }): Thenable<Automation>;
		}

		export interface UsageSummary {
			readonly generatedAt: number;
			/** Epoch ms of the oldest usage counted. */
			readonly since: number;
			readonly sessionCount: number;
			readonly costUsd: number;
			readonly models: readonly { readonly provider: string; readonly model: string; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number }[];
		}

		/** Token use and cost across providers. */
		export namespace usage {
			/** Capability: `usage.report`. */
			export function get(): Thenable<UsageSummary>;
		}

		export interface PullRequestLink {
			readonly url: string;
			readonly number: number;
			/** `owner/name`. */
			readonly repository: string;
			readonly title?: string;
			readonly state?: string;
			readonly watched: boolean;
		}

		/** Pull requests linked to chats. */
		export namespace pullRequests {
			/** Capability: `hosting.read`. */
			export function list(chatId: string): Thenable<readonly PullRequestLink[]>;
			/** Links a pull request to a chat. Capabilities: `hosting.read` and `agents.send`. */
			export function link(chatId: string, url: string): Thenable<ToolResult>;
		}

		export interface GitGraphOpenOptions {
			/** The repository's root folder; the active repository when unset. */
			readonly repositoryRoot?: string;
			/** A search in the graph's query syntax: `author:`, `path:`, `lines:12-40:src/a.ts`, or text. */
			readonly query?: string;
			/** A commit to scroll to and select. */
			readonly revealCommit?: string;
		}

		export interface GitAskAgentOptions {
			/** `explain` or `review` a commit (or lines of a file), or `ask` the `question` about it. Anything else is refused. */
			readonly action: string;
			readonly repositoryRoot?: string;
			/** A commit SHA (hex). */
			readonly commit?: string;
			/** A file in the repository, with `startLine` and `endLine`, for lines instead of a commit. */
			readonly path?: string;
			readonly startLine?: number;
			readonly endLine?: number;
			readonly question?: string;
		}

		/** The Git Graph. Rejects while the user has turned it off (the `volt.git-graph` extension is disabled). */
		export namespace gitGraph {
			/** Opens the Git Graph tab (or brings it forward), then searches or reveals a commit. Capability: `git.read`. */
			export function open(options?: GitGraphOpenOptions): Thenable<void>;
			/** A new side chat explains or reviews a commit (or lines), starting from git's facts. Capability: `agents.send`. */
			export function askAgent(options: GitAskAgentOptions): Thenable<void>;
		}
	}
}
