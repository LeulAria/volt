/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { FIND_FILES_TOOL_NAME, FIND_SYMBOL_TOOL_NAME, INSTANT_GREP_TOOL_NAME } from '../../voltRuntime/common/codeIntelligence.js';
import { IVoltHostToolInfo, IVoltHostToolOwner, IVoltHostToolResult } from '../../voltRuntime/common/hostTools.js';
import { HOST_TOOL_SANDBOX_CLASSES, hostToolSandboxUse } from '../../voltRuntime/common/hostToolSandbox.js';
import { ICapabilityReporter, ICapabilityRequest, IVoltPluginPrincipal, toolClassCapability, VoltCapabilityError } from './capabilities.js';
import { IVoltContributes, IVoltPluginManifest, IVoltToolContribution } from './voltContributions.js';

/**
 * The `volt.*` API a Volt feature or plugin gets through its `IVoltPluginContext` (spec H.11: a
 * feature imports only `base/`, its broker interfaces, this facade and the UI kit).
 *
 * Every method names the capability it uses (G.8) and asks the context's `ICapabilityReporter`
 * first. In report mode the call then runs as it does today; a call the manifest doesn't cover is
 * only logged. When the Policy Authority replaces the reporter, a refused call throws
 * `VoltCapabilityError` instead. The capability is decided here, from the method and its target,
 * never from anything the plugin passes as its identity.
 */

/** `engines.volt` ranges are checked against this (H.4). */
export const VOLT_API_VERSION = '1.0.0';

export type VoltToolHandler = (args: Record<string, unknown>, call: { readonly sessionId?: string }) => Promise<IVoltHostToolResult> | IVoltHostToolResult;
export type VoltCommandHandler = (...args: unknown[]) => unknown;

/** What a registration may add when the manifest entry leaves it out. */
export interface IVoltToolRegistrationOptions {
	readonly title?: string;
	readonly description?: string;
	/** JSON schema of the tool's input. */
	readonly inputSchema?: object;
}

export interface IVoltToolsApi {
	/**
	 * Serves a tool the manifest declares in `contributes.voltTools` (`tools.register`, plus the
	 * capability its class implies). A third party can't serve a tool name Volt serves itself.
	 */
	register(name: string, handler: VoltToolHandler, options?: IVoltToolRegistrationOptions): IDisposable;
	/**
	 * Runs one of Volt's own agent tools, for `chatId` when given: `agents.send` (it acts in a chat
	 * the way the chat's agent would) plus what the call's class implies (G.8).
	 */
	invoke(name: string, args: Record<string, unknown>, options?: { readonly chatId?: string }): Promise<IVoltHostToolResult>;
	/** The tools this plugin declares. */
	readonly declared: readonly IVoltToolContribution[];
}

/** The plugin's own key-value storage (`storage.own`), kept per profile. */
export interface IVoltStorageApi {
	get<T = unknown>(key: string): T | undefined;
	set(key: string, value: unknown): void;
	delete(key: string): void;
	keys(): readonly string[];
}

/** One chat, as the chats list shows it. */
export interface IVoltChatSummary {
	readonly id: string;
	readonly title: string;
	/** `running`, `idle`, `done`, `failed`, ... (the history's status). */
	readonly status: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly turnCount: number;
	/** The project folder it runs in. */
	readonly project?: string;
}

/** A turn of a chat started or ended. */
export interface IVoltTurnEvent {
	readonly chatId: string;
	readonly turnId: string;
	/** `prompt`, `notification`, `followup`, ... */
	readonly kind: string;
	/** Set when it ended: `done`, `failed`, `cancelled` or `interrupted`. */
	readonly outcome?: string;
}

/** Other chats, through the same tools agents use (`thread_*`) and the chats list. */
export interface IVoltAgentsApi {
	/** `agents.read:any`. */
	list(options?: { readonly project?: string; readonly query?: string }): Promise<IVoltHostToolResult>;
	/** `agents.read:any`: the chats list, newest first. */
	chats(options?: { readonly query?: string; readonly limit?: number }): Promise<readonly IVoltChatSummary[]>;
	/** `agents.read:current`: the chat the user has in front. */
	current(): IVoltChatSummary | undefined;
	/** A chat's turns: `agents.read:current` for the chat in front, `agents.read:any` for another. */
	read(chatId: string): Promise<IVoltHostToolResult>;
	/** `agents.send`. */
	send(chatId: string, message: string): Promise<IVoltHostToolResult>;
	/** `agents.create`. */
	create(options: { readonly title: string; readonly message?: string; readonly model?: string; readonly project?: string }): Promise<IVoltHostToolResult>;
	/** `agents.read:any`, checked when a listener is added. */
	readonly onDidStartTurn: Event<IVoltTurnEvent>;
	readonly onDidFinishTurn: Event<IVoltTurnEvent>;
}

export type VoltMemoryType = 'user' | 'feedback' | 'project' | 'reference';
export type VoltMemoryScope = 'user' | 'project';

/** A note Volt keeps across chats and providers (`IVoltMemoryService`). */
export interface IVoltMemoryNote {
	readonly name: string;
	readonly description: string;
	readonly type: VoltMemoryType;
	readonly body: string;
	readonly scope: VoltMemoryScope;
}

/**
 * Volt's memory: notes every later chat recalls. Reading is `agents.read:any` (it is what agents
 * remembered from chats); writing and deleting is `agents.context` (later chats read it).
 */
export interface IVoltMemoryApi {
	list(scope?: VoltMemoryScope | 'all'): Promise<readonly IVoltMemoryNote[]>;
	read(name: string, scope?: VoltMemoryScope): Promise<IVoltMemoryNote | undefined>;
	write(note: { readonly name: string; readonly description: string; readonly body: string; readonly type?: VoltMemoryType; readonly scope?: VoltMemoryScope }): Promise<IVoltMemoryNote>;
	delete(name: string, scope?: VoltMemoryScope): Promise<boolean>;
}

/** Volt's in-app browser. */
export interface IVoltBrowserApi {
	/** `browser.drive`: opens an http(s) URL in Volt's browser, beside the chat. */
	open(url: string): Promise<void>;
	/** `browser.read`: the page in a chat's browser tab (the chat in front by default), as an accessibility snapshot. */
	readPage(options?: { readonly chatId?: string }): Promise<{ readonly url?: string; readonly snapshot: IVoltHostToolResult }>;
}

/** Charts and Scratch board drawings. */
export interface IVoltVisualsApi {
	/**
	 * `ui.contribute`: renders charts (`render_chart` specs) and returns the result with its
	 * `visual`; a tool that returns it shows the chart in the chat, above the agent's reply.
	 */
	renderChart(chart: { readonly title?: string; readonly subtitle?: string; readonly charts: readonly object[] }): Promise<IVoltHostToolResult>;
	/** `agents.send`: draws on the user's Scratch board (`scratch_draw` input: `title` plus `mermaid`, `diagram`, `page`, `elements`, `notes` or `cards`). */
	drawOnScratch(drawing: { readonly title: string } & Record<string, unknown>, options?: { readonly chatId?: string }): Promise<IVoltHostToolResult>;
}

export type VoltAutomationSchedule =
	| { readonly type: 'hourly'; readonly minute: number }
	| { readonly type: 'daily'; readonly time: string }
	| { readonly type: 'weekly'; readonly weekdays: readonly number[]; readonly time: string }
	| { readonly type: 'cron'; readonly expr: string }
	| { readonly type: 'interval'; readonly everyMs: number }
	| { readonly type: 'once'; readonly at: number };

export interface IVoltAutomationSummary {
	readonly id: string;
	readonly name: string;
	readonly enabled: boolean;
	readonly schedules: readonly VoltAutomationSchedule[];
	/** The earliest next run (epoch ms). */
	readonly nextRun?: number;
	readonly createdBy: string;
	readonly runCount: number;
}

/** One run an automation started. */
export interface IVoltAutomationRun {
	readonly id: string;
	/** `queued`, `running`, `succeeded`, `failed`, ... */
	readonly status: string;
	/** The chat the run went to. */
	readonly chatId?: string;
}

export interface IVoltAutomationsApi {
	/** `agents.read:any`: automations run agents with prompts the user wrote. */
	list(): Promise<readonly IVoltAutomationSummary[]>;
	/** `automations.schedule`: a scheduled agent run (a new chat each time, or `chatId`'s chat). */
	schedule(options: { readonly name: string; readonly instructions: string; readonly schedule: VoltAutomationSchedule; readonly chatId?: string; readonly enabled?: boolean }): Promise<IVoltAutomationSummary>;
	/** `ui.contribute`: shows the Automations page, or one automation's. Nothing comes back. */
	show(automationId?: string): Promise<void>;
	/** `automations.schedule`: runs now an automation this plugin scheduled (anyone else's is refused). */
	run(automationId: string): Promise<readonly IVoltAutomationRun[]>;
	/** `automations.schedule`: deletes an automation this plugin scheduled (anyone else's is refused). */
	remove(automationId: string): Promise<void>;
}

/** A skill, subagent, rule, command, hook, MCP server or plugin agents load here (its name and what it says it does; no file contents). */
export interface IVoltSkillSummary {
	/** `skill`, `subagent`, `rule`, `command`, `hook`, `mcp` or `plugin`. */
	readonly kind: string;
	readonly name: string;
	readonly description: string;
	/** `user` (the home folder) or `workspace`. */
	readonly scope: string;
	/** Whose folder layout it came from: `volt`, `claude`, `cursor`, `codex`, `agents`, `builtin`. */
	readonly origin?: string;
	/** The plugin that ships it. */
	readonly plugin?: string;
}

export interface IVoltSkillsApi {
	/** `agents.read:any`: what agents load here, optionally of one `kind` (memories are `memory`'s). */
	list(kind?: string): Promise<readonly IVoltSkillSummary[]>;
	/** `ui.contribute`: shows Skills & Plugins, or its marketplace. Nothing comes back. */
	show(options?: { readonly marketplace?: boolean }): Promise<void>;
}

/** Phones and browsers paired with this computer's agent server. Pairing itself stays with the user. */
export interface IVoltRemoteDevicesApi {
	/** `ui.contribute`: shows Settings > Devices, or Add Device on it. Nothing comes back. */
	show(options?: { readonly addDevice?: boolean }): Promise<void>;
}

export interface IVoltUsageModelTotal {
	readonly provider: string;
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly costUsd: number;
}

export interface IVoltUsageSummary {
	readonly generatedAt: number;
	readonly since: number;
	readonly sessionCount: number;
	readonly costUsd: number;
	readonly models: readonly IVoltUsageModelTotal[];
}

/** One agent file of the open project (an instruction file, a skill, a subagent, an MCP config...). */
export interface IVoltAgentResource {
	/** `instructions`, `skills`, `subagents`, `commands`, `hooks`, `integrations` or `config`. */
	readonly group: string;
	/** Whose format it is: `claude`, `cursor`, `codex`, `agents` (AGENTS.md), ... */
	readonly ecosystem: string;
	/** What it is, e.g. "Skill", "MCP config". */
	readonly kind: string;
	/** From the project root, `/`-separated. */
	readonly path: string;
	/** `project` (at the root, shared), `nested` (in a subfolder) or `local` (personal). */
	readonly scope: string;
	readonly name?: string;
	readonly description?: string;
}

/**
 * `files.read:workspace`: what each agent harness loads from the open project (the Agent Resources
 * feature's scan). Only the project's own files: what lives in the home folder stays in Volt.
 */
export interface IVoltAgentResourcesApi {
	list(): Promise<readonly IVoltAgentResource[]>;
}

/** One window of a subscription's limits (a session, a week). */
export interface IVoltUsageLimitWindow {
	/** The provider's own name for it, e.g. "Current session". */
	readonly label: string;
	/** 0-100. */
	readonly usedPercent: number;
	/** Epoch ms; absent when the window has not started. */
	readonly resetsAt?: number;
}

/** A subscription's limits as last read. No account identity: which login it is stays in Volt. */
export interface IVoltUsageLimit {
	readonly provider: string;
	/** Subscription name, e.g. "Max 5x". */
	readonly plan?: string;
	readonly windows: readonly IVoltUsageLimitWindow[];
	/** Why the windows could not be read. */
	readonly error?: string;
	/** Epoch ms the numbers were read. */
	readonly checkedAt: number;
}

export interface IVoltGrepOptions {
	/** A folder under the project root (relative). */
	readonly path?: string;
	/** File filter, e.g. `src/**\/*.ts`. */
	readonly glob?: string;
	/** File type shortcut: `ts`, `py`, `go`, ... */
	readonly type?: string;
	/** `pattern` is plain text, not a regular expression. */
	readonly literal?: boolean;
	readonly caseSensitive?: boolean;
	readonly outputMode?: 'content' | 'files' | 'count';
	/** Lines around each match, 0-5. */
	readonly context?: number;
	readonly limit?: number;
}

export interface IVoltFindSymbolOptions {
	readonly match?: 'exact' | 'prefix' | 'fuzzy';
	/** `function`, `class`, `interface`, ... */
	readonly kind?: string;
	readonly path?: string;
	readonly limit?: number;
}

export interface IVoltFindFilesOptions {
	readonly path?: string;
	readonly limit?: number;
}

/**
 * `files.read:workspace`: Volt's code index over the open project (the Code Intelligence feature's
 * instant_grep, find_symbol and find_files). Each answer is the text an agent gets.
 */
export interface IVoltCodeApi {
	grep(pattern: string, options?: IVoltGrepOptions): Promise<string>;
	findSymbol(name: string, options?: IVoltFindSymbolOptions): Promise<string>;
	findFiles(query: string, options?: IVoltFindFilesOptions): Promise<string>;
}

/** `usage.report`: token use and cost across providers, and each subscription's limits (Settings > Usage). */
export interface IVoltUsageApi {
	get(): Promise<IVoltUsageSummary>;
	limits(): Promise<readonly IVoltUsageLimit[]>;
}

export interface IVoltPullRequestLink {
	readonly url: string;
	readonly number: number;
	readonly repository: string;
	readonly title?: string;
	readonly state?: string;
	readonly watched: boolean;
}

export interface IVoltPullRequestsApi {
	/** `hosting.read`: the pull requests linked to a chat. */
	list(chatId: string): Promise<readonly IVoltPullRequestLink[]>;
	/** `hosting.read` and `agents.send`: links a pull request to a chat (Volt then shows and syncs it). */
	link(chatId: string, url: string): Promise<IVoltHostToolResult>;
}

export interface IVoltGitGraphOpenOptions {
	/** The repository's root folder; the active repository when unset. */
	readonly repositoryRoot?: string;
	/** A search in the graph's query syntax (`author:`, `path:`, `lines:12-40:src/a.ts`, text). */
	readonly query?: string;
	/** A commit to scroll to and select. */
	readonly revealCommit?: string;
}

export interface IVoltGitAskAgentOptions {
	/** `explain` or `review` a commit (or lines), or `ask` the `question` about it. */
	readonly action: 'explain' | 'review' | 'ask';
	readonly repositoryRoot?: string;
	/** A commit SHA (hex). */
	readonly commit?: string;
	/** A file in the repository, with `startLine`/`endLine`, for lines instead of a commit. */
	readonly path?: string;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly question?: string;
}

/** The Git Graph (the `volt.git-graph` feature). */
export interface IVoltGitGraphApi {
	/** `git.read`: opens the Git Graph tab (or brings it forward), then searches or reveals a commit. */
	open(options?: IVoltGitGraphOpenOptions): Promise<void>;
	/** `agents.send`: a new side chat explains or reviews a commit (or lines), starting from git's facts. */
	askAgent(options: IVoltGitAskAgentOptions): Promise<void>;
}

/** What the plugin shows (`ui.contribute`): its manifest entries, and whether each is on. */
export interface IVoltUiApi {
	readonly contributions: Pick<IVoltContributes, 'voltSlotItems' | 'voltSettingsPages' | 'voltSurfaces' | 'voltDock'>;
	isOn(part: 'item' | 'section' | 'surface' | 'dock', id: string): boolean;
}

/** Settings. Its own (`config.own`: keys its `voltModule.settings` name) need nothing; others are reported. */
export interface IVoltSettingsApi {
	get<T = unknown>(key: string): T | undefined;
	update(key: string, value: unknown): Promise<void>;
	readonly onDidChange: Event<{ affects(key: string): boolean }>;
}

export interface IVoltCommandsApi {
	/** Its own commands (`commands.own`) need nothing; another's is `commands.execute:<id>`. */
	execute<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined>;
	/** Registers one of its own commands (`voltModule.commands`). */
	register(id: string, handler: VoltCommandHandler): IDisposable;
}

/**
 * A reference to a secret the plugin may use but never read (`secrets.use:<service>`). The value
 * stays in the secrets broker; a request names the ref and the broker adds the credential.
 */
export interface IVoltSecretRef {
	readonly service: string;
}

export interface IVoltNetRequest {
	readonly url: string;
	readonly method?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	/** The broker authenticates the request with it. */
	readonly secret?: IVoltSecretRef;
}

export interface IVoltNetResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/** Network through the broker (`net.connect` per host). Interface only until the network broker (P3). */
export interface IVoltNetApi {
	fetch(request: IVoltNetRequest): Promise<IVoltNetResponse>;
}

/** Secrets by reference. Interface only until the secrets broker (P3). */
export interface IVoltSecretsApi {
	ref(service: string): IVoltSecretRef;
}

export interface IVoltApi {
	readonly version: string;
	readonly tools: IVoltToolsApi;
	readonly storage: IVoltStorageApi;
	readonly agents: IVoltAgentsApi;
	readonly ui: IVoltUiApi;
	readonly settings: IVoltSettingsApi;
	readonly commands: IVoltCommandsApi;
	readonly net: IVoltNetApi;
	readonly secrets: IVoltSecretsApi;
	readonly memory: IVoltMemoryApi;
	readonly browser: IVoltBrowserApi;
	readonly visuals: IVoltVisualsApi;
	readonly automations: IVoltAutomationsApi;
	readonly skills: IVoltSkillsApi;
	readonly remoteDevices: IVoltRemoteDevicesApi;
	readonly usage: IVoltUsageApi;
	readonly pullRequests: IVoltPullRequestsApi;
	readonly gitGraph: IVoltGitGraphApi;
	readonly code: IVoltCodeApi;
	readonly agentResources: IVoltAgentResourcesApi;
}

/** Who a backend call is for, set by core from the principal (never from a payload). */
export interface IVoltApiCaller {
	readonly extensionId: string;
	/** The extension's display name, for what the user sees ("Message from ..."). */
	readonly label: string;
	/** The chat the call acts in, when the method names one. */
	readonly chatId?: string;
}

/** What a feature or plugin gets when it activates. Disposing `subscriptions` unloads what it registered. */
export interface IVoltPluginContext {
	/** Set by core from the manifest it loaded, never by the plugin. */
	readonly extensionId: string;
	/** The `voltModule.feature` it carries, for a built-in feature. */
	readonly featureId?: string;
	readonly manifest: IVoltPluginManifest;
	readonly volt: IVoltApi;
	readonly subscriptions: DisposableStore;
}

/**
 * What the facade calls once a call is allowed: Volt's services as they are today. The window binds
 * it to workbench services (`voltPluginService.ts`); the brokers replace parts of it later.
 */
export interface IVoltApiBackend {
	/** `owner`: core's record of who serves the tool and the class it is held to, for the sandbox gate (G.6). */
	registerTool(info: IVoltHostToolInfo, invoke: (args: Record<string, unknown>, sessionId: string | undefined) => Promise<IVoltHostToolResult>, owner?: IVoltHostToolOwner): IDisposable;
	invokeTool(name: string, args: Record<string, unknown>, caller?: IVoltApiCaller): Promise<IVoltHostToolResult>;
	storageGet(key: string): string | undefined;
	storageSet(key: string, value: string | undefined): void;
	storageKeys(prefix: string): readonly string[];
	getSetting(key: string): unknown;
	updateSetting(key: string, value: unknown): Promise<void>;
	readonly onDidChangeSettings: Event<{ affects(key: string): boolean }>;
	executeCommand(id: string, args: readonly unknown[]): Promise<unknown>;
	registerCommand(id: string, handler: VoltCommandHandler): IDisposable;
	isOn(part: 'item' | 'section' | 'surface' | 'dock', id: string): boolean;

	// The feature APIs. A window that has the feature binds them; without one the method throws
	// `VoltApiUnavailableError` (after its capability check, so a refusal is still a refusal).
	listChats?(options: { readonly query?: string; readonly limit?: number }): Promise<readonly IVoltChatSummary[]>;
	currentChat?(): IVoltChatSummary | undefined;
	readonly onDidStartTurn?: Event<IVoltTurnEvent>;
	readonly onDidFinishTurn?: Event<IVoltTurnEvent>;
	listMemories?(scope: VoltMemoryScope | 'all'): Promise<readonly IVoltMemoryNote[]>;
	readMemory?(name: string, scope: VoltMemoryScope | undefined): Promise<IVoltMemoryNote | undefined>;
	writeMemory?(note: { readonly name: string; readonly description: string; readonly body: string; readonly type?: VoltMemoryType; readonly scope?: VoltMemoryScope }): Promise<IVoltMemoryNote>;
	deleteMemory?(name: string, scope: VoltMemoryScope | undefined): Promise<boolean>;
	openBrowser?(url: string): Promise<void>;
	browserPageUrl?(chatId: string): Promise<string | undefined>;
	listAutomations?(): Promise<readonly IVoltAutomationSummary[]>;
	scheduleAutomation?(options: { readonly name: string; readonly instructions: string; readonly schedule: VoltAutomationSchedule; readonly chatId?: string; readonly enabled: boolean }, caller: IVoltApiCaller): Promise<IVoltAutomationSummary>;
	showAutomations?(automationId: string | undefined): Promise<void>;
	/** Refuses an automation `caller` didn't schedule. */
	runAutomation?(automationId: string, caller: IVoltApiCaller): Promise<readonly IVoltAutomationRun[]>;
	/** Refuses an automation `caller` didn't schedule. */
	deleteAutomation?(automationId: string, caller: IVoltApiCaller): Promise<void>;
	listSkills?(): Promise<readonly IVoltSkillSummary[]>;
	showSkills?(marketplace: boolean): Promise<void>;
	showRemoteDevices?(addDevice: boolean): Promise<void>;
	readUsage?(): Promise<IVoltUsageSummary>;
	readUsageLimits?(): Promise<readonly IVoltUsageLimit[]>;
	listAgentResources?(): Promise<readonly IVoltAgentResource[]>;
	listPullRequests?(chatId: string): Promise<readonly IVoltPullRequestLink[]>;
	openGitGraph?(options: IVoltGitGraphOpenOptions): Promise<void>;
	askGitAgent?(options: IVoltGitAskAgentOptions): Promise<void>;
}

/** The facade could not do this yet: the broker behind it isn't built. */
export class VoltApiUnavailableError extends Error {
	constructor(api: string, until: string) {
		super(`volt.${api} is not available yet (it arrives with ${until}).`);
		this.name = 'VoltApiUnavailableError';
	}
}

function matchesSetting(declared: readonly string[], key: string): boolean {
	return declared.some(setting => setting.endsWith('.') ? key.startsWith(setting) : key === setting);
}

/**
 * Builds the `volt` object for one plugin. `principal` comes from core's own record of the
 * manifest; every method checks with `reporter` before it calls `backend`.
 */
export function createVoltApi(principal: IVoltPluginPrincipal, manifest: IVoltPluginManifest, backend: IVoltApiBackend, reporter: ICapabilityReporter, subscriptions: DisposableStore): IVoltApi {
	const contributes = manifest.contributes ?? {};
	const ownCommands = contributes.voltModule?.commands ?? [];
	const ownSettings = [...contributes.voltModule?.settings ?? [], ...principal.ownSettings ?? []];
	const declaredTools = contributes.voltTools ?? [];
	const storagePrefix = `volt.plugin.${principal.extensionId}.`;
	const caller = (chatId?: string): IVoltApiCaller => ({ extensionId: principal.extensionId, label: principal.label ?? principal.extensionId, ...(chatId ? { chatId } : {}) });

	const check = (request: ICapabilityRequest): void => {
		const verdict = reporter.check(principal, request);
		if (!verdict.allowed) {
			const denial = verdict.denial;
			throw new VoltCapabilityError(request.capability, request.target, denial?.deniedBy ?? 'manifest', denial?.reason ?? `${request.capability} was denied`, !!denial?.promptable);
		}
	};
	/** The backend method, or a refusal that says the window has no such feature. */
	const bound = <T>(method: T | undefined, api: string): T => {
		if (method === undefined) {
			throw new VoltApiUnavailableError(api, 'a window that serves this feature');
		}
		return method;
	};

	const tools: IVoltToolsApi = {
		declared: declaredTools,
		register(name, handler, options) {
			check({ api: 'tools.register', capability: 'tools.register', target: name });
			const declared = declaredTools.find(tool => tool.name === name);
			const volts = Object.prototype.hasOwnProperty.call(HOST_TOOL_SANDBOX_CLASSES, name);
			// The class Volt knows for the name wins over a lower one; an undeclared tool is treated as
			// escaping, and so is a third party serving a name Volt serves itself (it would shadow it).
			const toolClass = volts ? HOST_TOOL_SANDBOX_CLASSES[name] : declared?.class ?? 'escapes';
			if (!declared || (volts && !principal.firstParty)) {
				check({ api: 'tools.register', capability: 'full', target: declared ? `Volt's own tool ${name}` : `undeclared tool ${name}` });
			}
			const implied = toolClassCapability(toolClass);
			if (implied !== 'tools.register') {
				check({ api: 'tools.register', capability: implied, target: name });
			}
			const info: IVoltHostToolInfo = {
				name,
				title: declared?.title ?? options?.title ?? name,
				description: declared?.description ?? options?.description ?? '',
				inputSchema: declared?.inputSchema ?? options?.inputSchema ?? { type: 'object', properties: {} },
				...(declared?.approvalInReadOnlyModes ? { approvalInReadOnlyModes: declared.approvalInReadOnlyModes } : {}),
			};
			const owner: IVoltHostToolOwner = {
				extensionId: principal.extensionId,
				label: principal.label ?? principal.extensionId,
				firstParty: principal.firstParty,
				toolClass,
				declared: [...principal.capabilities.required ?? [], ...principal.capabilities.optional ?? []].map(entry => ({ id: entry.id, ...(entry.targets?.length ? { targets: entry.targets } : {}) })),
			};
			const registration = backend.registerTool(info, async (args, sessionId) => handler(args, { sessionId }), owner);
			subscriptions.add(registration);
			return registration;
		},
		invoke(name, args, options) {
			const use = hostToolSandboxUse(name, args);
			if (!use) {
				// Only Volt's own tools: another plugin's tool is that plugin's to call (H.5).
				check({ api: 'tools.invoke', capability: 'full', target: `not a Volt tool: ${name}` });
				throw new VoltCapabilityError('full', name, 'catalog', `${name} is not one of Volt's tools`);
			}
			check({ api: 'tools.invoke', capability: 'agents.send', target: options?.chatId ?? name });
			const implied = toolClassCapability(use.kind);
			if (implied !== 'tools.register') {
				check({ api: 'tools.invoke', capability: implied, target: name });
			}
			return backend.invokeTool(name, args, caller(options?.chatId));
		},
	};

	const storage: IVoltStorageApi = {
		get<T>(key: string): T | undefined {
			check({ api: 'storage.get', capability: 'storage.own', target: key });
			const raw = backend.storageGet(storagePrefix + key);
			if (raw === undefined) {
				return undefined;
			}
			try {
				return JSON.parse(raw) as T;
			} catch {
				return undefined;
			}
		},
		set(key, value) {
			check({ api: 'storage.set', capability: 'storage.own', target: key });
			backend.storageSet(storagePrefix + key, value === undefined ? undefined : JSON.stringify(value));
		},
		delete(key) {
			check({ api: 'storage.delete', capability: 'storage.own', target: key });
			backend.storageSet(storagePrefix + key, undefined);
		},
		keys() {
			check({ api: 'storage.keys', capability: 'storage.own' });
			return backend.storageKeys(storagePrefix).map(key => key.slice(storagePrefix.length));
		},
	};

	/** An event whose listener is added only after its capability check. */
	const checkedEvent = <T>(event: () => Event<T> | undefined, api: string, capability: string): Event<T> => (listener, thisArgs, disposables) => {
		check({ api, capability });
		return bound(event(), api)(listener, thisArgs, disposables);
	};

	const agents: IVoltAgentsApi = {
		list(options) {
			check({ api: 'agents.list', capability: 'agents.read:any' });
			return backend.invokeTool('thread_list', { ...(options?.project ? { project: options.project } : {}), ...(options?.query ? { query: options.query } : {}) }, caller());
		},
		chats(options) {
			check({ api: 'agents.chats', capability: 'agents.read:any' });
			return bound(backend.listChats, 'agents.chats').call(backend, { ...(options?.query ? { query: options.query } : {}), ...(options?.limit ? { limit: options.limit } : {}) });
		},
		current() {
			check({ api: 'agents.current', capability: 'agents.read:current' });
			return bound(backend.currentChat, 'agents.current').call(backend);
		},
		read(chatId) {
			// The chat in front is `agents.read:current`; any other is `agents.read:any`.
			const current = backend.currentChat?.()?.id;
			check({ api: 'agents.read', capability: current !== undefined && current === chatId ? 'agents.read:current' : 'agents.read:any', target: chatId });
			return backend.invokeTool('thread_read', { thread_id: chatId }, caller());
		},
		send(chatId, message) {
			check({ api: 'agents.send', capability: 'agents.send', target: chatId });
			return backend.invokeTool('thread_send', { thread_id: chatId, message }, caller());
		},
		create(options) {
			check({ api: 'agents.create', capability: 'agents.create' });
			return backend.invokeTool('thread_launch', { title: options.title, ...(options.message ? { message: options.message } : {}), ...(options.model ? { model: options.model } : {}), ...(options.project ? { project: options.project } : {}) }, caller());
		},
		onDidStartTurn: checkedEvent(() => backend.onDidStartTurn, 'agents.onDidStartTurn', 'agents.read:any'),
		onDidFinishTurn: checkedEvent(() => backend.onDidFinishTurn, 'agents.onDidFinishTurn', 'agents.read:any'),
	};

	const ui: IVoltUiApi = {
		contributions: {
			...(contributes.voltSlotItems ? { voltSlotItems: contributes.voltSlotItems } : {}),
			...(contributes.voltSettingsPages ? { voltSettingsPages: contributes.voltSettingsPages } : {}),
			...(contributes.voltSurfaces ? { voltSurfaces: contributes.voltSurfaces } : {}),
			...(contributes.voltDock ? { voltDock: contributes.voltDock } : {}),
		},
		isOn(part, id) {
			check({ api: 'ui.isOn', capability: 'ui.contribute', target: `${part}:${id}` });
			return backend.isOn(part, id);
		},
	};

	// A setting outside its own is not something the catalog grants: reported as `full` until the
	// Authority has a config capability.
	const settingCapability = (key: string) => matchesSetting(ownSettings, key) ? 'config.own' : 'full';
	const settings: IVoltSettingsApi = {
		get<T>(key: string): T | undefined {
			check({ api: 'settings.get', capability: settingCapability(key), target: key });
			return backend.getSetting(key) as T | undefined;
		},
		update(key, value) {
			check({ api: 'settings.update', capability: settingCapability(key), target: key });
			return backend.updateSetting(key, value);
		},
		onDidChange: backend.onDidChangeSettings,
	};

	const commands: IVoltCommandsApi = {
		async execute<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
			check({ api: 'commands.execute', capability: ownCommands.includes(id) ? 'commands.own' : `commands.execute:${id}`, target: id });
			return await backend.executeCommand(id, args) as T | undefined;
		},
		register(id, handler) {
			check({ api: 'commands.register', capability: ownCommands.includes(id) ? 'commands.own' : 'full', target: id });
			const registration = backend.registerCommand(id, handler);
			subscriptions.add(registration);
			return registration;
		},
	};

	const net: IVoltNetApi = {
		async fetch(request) {
			let host: string;
			try {
				host = new URL(request.url).host;
			} catch {
				host = request.url;
			}
			check({ api: 'net.fetch', capability: 'net.connect', target: host });
			if (request.secret) {
				check({ api: 'net.fetch', capability: `secrets.use:${request.secret.service}`, target: host });
			}
			throw new VoltApiUnavailableError('net.fetch', 'the network broker');
		},
	};

	const secrets: IVoltSecretsApi = {
		ref(service) {
			check({ api: 'secrets.ref', capability: `secrets.use:${service}`, target: service });
			return Object.freeze({ service });
		},
	};

	const memory: IVoltMemoryApi = {
		list(scope) {
			check({ api: 'memory.list', capability: 'agents.read:any', target: scope ?? 'all' });
			return bound(backend.listMemories, 'memory.list').call(backend, scope ?? 'all');
		},
		read(name, scope) {
			check({ api: 'memory.read', capability: 'agents.read:any', target: name });
			return bound(backend.readMemory, 'memory.read').call(backend, name, scope);
		},
		write(note) {
			check({ api: 'memory.write', capability: 'agents.context', target: note.name });
			return bound(backend.writeMemory, 'memory.write').call(backend, note);
		},
		delete(name, scope) {
			check({ api: 'memory.delete', capability: 'agents.context', target: name });
			return bound(backend.deleteMemory, 'memory.delete').call(backend, name, scope);
		},
	};

	const browser: IVoltBrowserApi = {
		async open(url) {
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw new Error(`volt.browser.open needs an absolute http(s) URL, not ${JSON.stringify(url)}.`);
			}
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				throw new Error(`volt.browser.open opens http(s) pages only, not ${parsed.protocol} URLs.`);
			}
			check({ api: 'browser.open', capability: 'browser.drive', target: parsed.host });
			return bound(backend.openBrowser, 'browser.open').call(backend, parsed.href);
		},
		async readPage(options) {
			const chatId = options?.chatId ?? backend.currentChat?.()?.id;
			check({ api: 'browser.readPage', capability: 'browser.read', target: chatId });
			if (!chatId) {
				return { snapshot: { error: 'No chat is open: pass the chat whose browser tab to read.' } };
			}
			const url = await bound(backend.browserPageUrl, 'browser.readPage').call(backend, chatId);
			const snapshot = await backend.invokeTool('browser_snapshot', {}, caller(chatId));
			return { ...(url ? { url } : {}), snapshot };
		},
	};

	const visuals: IVoltVisualsApi = {
		renderChart(chart) {
			check({ api: 'visuals.renderChart', capability: 'ui.contribute' });
			return backend.invokeTool('render_chart', { ...(chart.title ? { title: chart.title } : {}), ...(chart.subtitle ? { subtitle: chart.subtitle } : {}), charts: chart.charts }, caller());
		},
		drawOnScratch(drawing, options) {
			check({ api: 'visuals.drawOnScratch', capability: 'agents.send', target: options?.chatId ?? 'scratch' });
			return backend.invokeTool('scratch_draw', { ...drawing }, caller(options?.chatId));
		},
	};

	const automations: IVoltAutomationsApi = {
		list() {
			check({ api: 'automations.list', capability: 'agents.read:any' });
			return bound(backend.listAutomations, 'automations.list').call(backend);
		},
		schedule(options) {
			check({ api: 'automations.schedule', capability: 'automations.schedule', target: options.name });
			if (options.chatId) {
				check({ api: 'automations.schedule', capability: 'agents.send', target: options.chatId });
			}
			return bound(backend.scheduleAutomation, 'automations.schedule').call(backend, { ...options, enabled: options.enabled !== false }, caller(options.chatId));
		},
		async show(automationId) {
			check({ api: 'automations.show', capability: 'ui.contribute', ...(automationId ? { target: automationId } : {}) });
			return bound(backend.showAutomations, 'automations.show').call(backend, automationId);
		},
		async run(automationId) {
			check({ api: 'automations.run', capability: 'automations.schedule', target: automationId });
			return bound(backend.runAutomation, 'automations.run').call(backend, automationId, caller());
		},
		async remove(automationId) {
			check({ api: 'automations.remove', capability: 'automations.schedule', target: automationId });
			return bound(backend.deleteAutomation, 'automations.remove').call(backend, automationId, caller());
		},
	};

	const skills: IVoltSkillsApi = {
		async list(kind) {
			check({ api: 'skills.list', capability: 'agents.read:any', ...(kind ? { target: kind } : {}) });
			const items = await bound(backend.listSkills, 'skills.list').call(backend);
			return kind ? items.filter(item => item.kind === kind) : items;
		},
		async show(options) {
			check({ api: 'skills.show', capability: 'ui.contribute' });
			return bound(backend.showSkills, 'skills.show').call(backend, options?.marketplace === true);
		},
	};

	const remoteDevices: IVoltRemoteDevicesApi = {
		async show(options) {
			check({ api: 'remoteDevices.show', capability: 'ui.contribute' });
			return bound(backend.showRemoteDevices, 'remoteDevices.show').call(backend, options?.addDevice === true);
		},
	};

	const usage: IVoltUsageApi = {
		get() {
			check({ api: 'usage.get', capability: 'usage.report' });
			return bound(backend.readUsage, 'usage.get').call(backend);
		},
		limits() {
			check({ api: 'usage.limits', capability: 'usage.report' });
			return bound(backend.readUsageLimits, 'usage.limits').call(backend);
		},
	};

	const pullRequests: IVoltPullRequestsApi = {
		list(chatId) {
			check({ api: 'pullRequests.list', capability: 'hosting.read', target: chatId });
			return bound(backend.listPullRequests, 'pullRequests.list').call(backend, chatId);
		},
		link(chatId, url) {
			check({ api: 'pullRequests.link', capability: 'hosting.read', target: chatId });
			check({ api: 'pullRequests.link', capability: 'agents.send', target: chatId });
			return backend.invokeTool('link_pull_request', { url }, caller(chatId));
		},
	};

	const gitGraph: IVoltGitGraphApi = {
		open(options) {
			check({ api: 'gitGraph.open', capability: 'git.read', ...(options?.repositoryRoot ? { target: options.repositoryRoot } : {}) });
			return bound(backend.openGitGraph, 'gitGraph.open').call(backend, options ?? {});
		},
		askAgent(options) {
			check({ api: 'gitGraph.askAgent', capability: 'agents.send', ...(options.commit ? { target: options.commit } : {}) });
			return bound(backend.askGitAgent, 'gitGraph.askAgent').call(backend, options);
		},
	};

	/** Runs one of the index's tools over the open project; a `path` must stay under its root. */
	const search = async (api: string, tool: string, args: Record<string, unknown>): Promise<string> => {
		const path = args.path;
		if (typeof path === 'string' && (/^([\\/]|[a-zA-Z]:|~)/.test(path) || path.split(/[\\/]/).includes('..'))) {
			throw new VoltCapabilityError('files.read:workspace', path, 'workspace', `${api}: ${path} is outside the project`);
		}
		const result = await backend.invokeTool(tool, Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)), caller());
		if (result.error !== undefined) {
			throw new Error(result.error);
		}
		return result.text ?? '';
	};

	const code: IVoltCodeApi = {
		grep(pattern, options) {
			check({ api: 'code.grep', capability: 'files.read:workspace', target: INSTANT_GREP_TOOL_NAME });
			return search('code.grep', INSTANT_GREP_TOOL_NAME, {
				pattern, path: options?.path, glob: options?.glob, type: options?.type, literal: options?.literal, case_sensitive: options?.caseSensitive,
				output_mode: options?.outputMode, context: options?.context, head_limit: options?.limit,
			});
		},
		findSymbol(name, options) {
			check({ api: 'code.findSymbol', capability: 'files.read:workspace', target: FIND_SYMBOL_TOOL_NAME });
			return search('code.findSymbol', FIND_SYMBOL_TOOL_NAME, { name, match: options?.match, kind: options?.kind, path: options?.path, limit: options?.limit });
		},
		findFiles(query, options) {
			check({ api: 'code.findFiles', capability: 'files.read:workspace', target: FIND_FILES_TOOL_NAME });
			return search('code.findFiles', FIND_FILES_TOOL_NAME, { query, path: options?.path, limit: options?.limit });
		},
	};

	const agentResources: IVoltAgentResourcesApi = {
		list() {
			check({ api: 'agentResources.list', capability: 'files.read:workspace' });
			return bound(backend.listAgentResources, 'agentResources.list').call(backend);
		},
	};

	return Object.freeze({ version: VOLT_API_VERSION, tools, storage, agents, ui, settings, commands, net, secrets, memory, browser, visuals, automations, skills, remoteDevices, usage, pullRequests, gitGraph, code, agentResources });
}

/** One extension's validated Volt contributions, as the window loaded them. */
export interface IVoltPluginEntry {
	readonly extensionId: string;
	readonly firstParty: boolean;
	readonly manifest: IVoltPluginManifest;
	/** Problems found in its Volt contribution points (those entries were left out). */
	readonly problems: readonly string[];
}

export const IVoltPluginService = createDecorator<IVoltPluginService>('voltPluginService');

/** Volt contributions of every enabled extension, and the contexts plugins activate with. */
export interface IVoltPluginService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	readonly reporter: ICapabilityReporter;
	plugins(): readonly IVoltPluginEntry[];
	plugin(extensionId: string): IVoltPluginEntry | undefined;
	/**
	 * The context an enabled extension activates with; undefined when it isn't loaded. One per
	 * extension: its `subscriptions` are disposed when the extension goes away (disabled or removed).
	 */
	getContext(extensionId: string): IVoltPluginContext | undefined;
	/**
	 * The context of a built-in feature from the manifest compiled into core, for a build that
	 * doesn't ship its extension (the feature then stays on, like `IVoltFeatureService` says).
	 * Undefined when the extension is loaded but disabled.
	 */
	getBuiltinContext?(manifest: IVoltPluginManifest): IVoltPluginContext | undefined;
}
