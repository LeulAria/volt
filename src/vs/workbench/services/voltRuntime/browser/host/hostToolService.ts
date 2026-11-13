/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAdminPolicy } from '../../../../../platform/voltSandbox/common/authority.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { isAbsolute } from '../../../../../base/common/path.js';
import { isLinux, isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { env } from '../../../../../base/common/process.js';
import { basename, dirname, isEqualOrParent, joinPath, normalizePath, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { HOST_MCP_TOKEN_RENEW_MS, hostMcpSessionToken, IHostMcpLease, newHostMcpLease } from '../../../../../platform/voltHostMcp/common/voltHostMcpAuth.js';
import { IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ASK_QUESTION_TOOL_NAME, AUTOMATE_BROWSER_COMMAND_ID, AWAIT_ANSWERS_TOOL_NAME, BROWSER_COMPARE_IMAGE_TOOL_NAME, BROWSER_PAGE_URL_COMMAND_ID, BROWSER_RUN_TOOL_NAME, BROWSER_SCREENSHOT_TOOL_NAME, browserToolVerdict, browserVerdictNeedsPage, canonicalHostToolName, CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID, IMAGE_INSPECT_TOOL_NAME, isBrowserAutomationTool, IVoltBrowserAutomationOptions, IVoltBrowserPreflightRequest, IVoltBrowserPreflightResult, IVoltFlowGrantStore, IVoltHostFileChange, IVoltHostSandboxResolver, IVoltHostSessionResolver, IVoltHostToolApprover, IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolInvocation, IVoltHostToolOwner, IVoltHostToolProvider, IVoltHostToolResult, IVoltHostToolService, IVoltMcpServer, IVoltQuestionHandler, PREFLIGHT_BROWSER_COMMAND_ID, VOLT_HOST_TOOLS, VoltHostToolGroup } from '../../common/hostTools.js';
import { hostToolSandboxUse, IHostToolSandboxUse, isSandboxed, ISandboxPathContext, legacyHostToolRefusal, legacySandboxCovers, readTargets, sandboxBrowserUrlRefusal, sandboxReachRefusal, sandboxRefusalMessage } from '../../common/hostToolSandbox.js';
import { HostToolAuthority, IGateChat, IPolicyShadowDiff, PolicyAuthorityMode } from '../../common/hostToolAuthority.js';
import { IGrant } from '../../../../../platform/voltSandbox/common/grants.js';
import { chatSubject } from '../../../../../platform/voltSandbox/common/principals.js';
import { browserBlockedMessage, IVoltBrowserAccessService } from '../../common/browserAccess.js';
import { PROPOSE_PLAN_TOOL_NAME } from '../../common/plans.js';
import { VoltMode } from '../../common/modes.js';
import '../browserAccessService.js';
import { AgentQuestionDraft, IAgentQuestionResponse, parseQuestionDraft, questionResponseText } from '../../common/questions.js';
import { cropImage, describeInspection, flattenAlpha, IImagePoint, IImageRect, inspectImage, IRgbaImage, MAX_ANALYSIS_PIXELS, parseRect } from '../../common/tools/imageAnalysis.js';
import { applyFileEdits, groupFileEdits, parseFileEdits, safeEditPath } from '../../common/tools/fileEdits.js';
import { decodeImage, ImageFormat, MAX_IMAGE_BYTES, scaleScreenshot, zoomImage } from './imageCodec.js';

/** Under the 60s default MCP request timeout of the agents' SDK clients. */
const QUESTION_POLL_MS = 45_000;

const MODE_LABEL: Record<VoltMode, string> = { agent: 'Agent', plan: 'Plan', ask: 'Ask', debug: 'Debug', multitask: 'Multitask' };

/** The machine the sandbox plan is resolved for: this process runs on it (window or agent server). */
const SANDBOX_PLATFORM = isMacintosh ? 'darwin' : isLinux ? 'linux' : isWindows ? 'win32' : 'unknown';

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parsePoints(value: unknown): IImagePoint[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.slice(0, 64).flatMap(item => {
		const point = item as Record<string, unknown> | undefined;
		const x = num(point?.x), y = num(point?.y);
		return x !== undefined && y !== undefined ? [{ x, y }] : [];
	});
}

export class VoltHostToolService extends Disposable implements IVoltHostToolService {

	declare readonly _serviceBrand: undefined;

	private mcpUrl: string | undefined;
	private mcpToken: string | undefined;
	/** Per chat, the lease its agents' host MCP tokens carry. */
	private readonly mcpLeases = new Map<string, IHostMcpLease>();
	private lastMcpEpoch = 0;
	private readonly _onDidRevokeMcpSession = this._register(new Emitter<{ readonly sessionId: string; readonly epoch: number }>());
	readonly onDidRevokeMcpSession: Event<{ readonly sessionId: string; readonly epoch: number }> = this._onDidRevokeMcpSession.event;
	private readonly drafts = new Map<string, AgentQuestionDraft>();
	private questionHandler: IVoltQuestionHandler | undefined;
	private sessions: IVoltHostSessionResolver | undefined;
	private approver: IVoltHostToolApprover | undefined;
	private sandboxes: IVoltHostSandboxResolver | undefined;
	private readonly _onDidChangeMcp = this._register(new Emitter<void>());
	readonly onDidChangeMcp: Event<void> = this._onDidChangeMcp.event;
	private readonly _onDidInvokeTool = this._register(new Emitter<IVoltHostToolInvocation>());
	readonly onDidInvokeTool: Event<IVoltHostToolInvocation> = this._onDidInvokeTool.event;
	private readonly _onDidChangeTools = this._register(new Emitter<void>());
	readonly onDidChangeTools: Event<void> = this._onDidChangeTools.event;
	private readonly providers = new Set<IVoltHostToolProvider>();
	private disabledTools = new Set<string>();
	/** The gate's class decisions go through the Policy Authority (C2); exposed for tests and the shadow log. */
	readonly authority = this._register(new HostToolAuthority());
	readonly onDidShadowDiff: Event<IPolicyShadowDiff> = this.authority.onDidDiff;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IVoltBrowserAccessService private readonly browserAccess: IVoltBrowserAccessService,
	) {
		super();
	}

	setManagedPolicy(policy: IAdminPolicy | undefined): void {
		this.authority.setManagedPolicy(policy);
	}

	listTools(): readonly IVoltHostToolInfo[] {
		const tools = this.providers.size ? [...VOLT_HOST_TOOLS, ...[...this.providers].flatMap(provider => provider.tools)] : VOLT_HOST_TOOLS;
		return this.disabledTools.size ? tools.filter(tool => !this.disabledTools.has(tool.name)) : tools;
	}

	setDisabledTools(names: Iterable<string>): void {
		const next = new Set(names);
		if (next.size === this.disabledTools.size && [...next].every(name => this.disabledTools.has(name))) {
			return;
		}
		this.disabledTools = next;
		this._onDidChangeTools.fire();
	}

	/** The agents run in this process: `setDisabledTools` already took their tools away. */
	mirrorFeatureEnablement(): void { }

	registerToolProvider(provider: IVoltHostToolProvider): IDisposable {
		this.providers.add(provider);
		this._onDidChangeTools.fire();
		return toDisposable(() => {
			if (this.providers.delete(provider)) {
				this._onDidChangeTools.fire();
			}
		});
	}

	async preflightBrowser(sessionId: string, request: IVoltBrowserPreflightRequest, token: CancellationToken): Promise<IVoltBrowserPreflightResult> {
		if (this.browserAccess.blockReason(sessionId)) {
			return { lines: [] };
		}
		const result = await this.commandService.executeCommand<IVoltBrowserPreflightResult>(PREFLIGHT_BROWSER_COMMAND_ID, sessionId, request, token).catch(() => undefined);
		return result ?? { lines: [] };
	}

	async invokeTool(requested: string, input?: unknown, call?: IVoltHostToolCall): Promise<IVoltHostToolResult> {
		// An agent may still use a tool's earlier name (render_html); it runs, and is recorded, as the current one.
		const name = canonicalHostToolName(requested);
		const args = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
		const result = await this.run(name, args, call).catch((err): IVoltHostToolResult => ({ error: err instanceof Error ? err.message : String(err) }));
		if (call?.sessionId && call.source !== 'native') {
			this._onDidInvokeTool.fire({ sessionId: call.sessionId, name, args, result });
		}
		return result;
	}

	private async run(name: string, args: Record<string, unknown>, requested: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		// Calls over MCP carry no folder: a chat's tools work in its worktree or project.
		const located = requested?.sessionId && !requested.cwd ? { ...requested, cwd: this.sessions?.cwd(requested.sessionId) } : requested;
		// The native loop's calls carry no sandbox (MCP calls carry the one their session token names): Volt's record of the chat's counts.
		const sandboxed = located?.source === 'native' && located.sessionId && !located.sandbox && this.sandboxes ? { ...located, sandbox: this.sandboxes.settings(located.sessionId) } : located;
		// A sandboxed chat's providers get the gate's read and write rules, for files they find rather than files named (search results, a rename's other files).
		const call = sandboxed && isSandboxed(sandboxed.sandbox) ? await this.withPathRules(sandboxed, sandboxed.sandbox) : sandboxed;
		if (this.disabledTools.has(name)) {
			return { error: `${name} belongs to a Volt feature the user turned off (Capabilities or Extensions). Do not call it again in this chat.` };
		}
		const confined = await this.checkSandbox(name, args, call);
		if (confined) {
			return confined;
		}
		for (const provider of this.providers) {
			const tool = provider.tools.find(candidate => candidate.name === name);
			if (tool) {
				const always = await provider.needsApproval?.(name, args, call);
				if (always) {
					const refusal = await this.checkAlways(name, args, call, always);
					if (refusal) {
						return refusal;
					}
					provider.approved?.(name, args, call!);
					return provider.invoke(name, args, call);
				}
				const refusal = tool.approvalInReadOnlyModes && call?.sessionId ? await this.checkReadOnly(call.sessionId, name, args, call, tool.approvalInReadOnlyModes) : undefined;
				return refusal ?? provider.invoke(name, args, call);
			}
		}
		if (name === ASK_QUESTION_TOOL_NAME) {
			return this.askQuestions(args, call);
		}
		if (name === PROPOSE_PLAN_TOOL_NAME) {
			// The editor draws the plan as a card with Approve, Revise and Edit; the agent waits for the user.
			return { text: 'The plan is shown to the user for approval. Stop here: do not implement it until the user approves it. If they ask for changes, call propose_plan again with the revised plan.' };
		}
		if (name === AWAIT_ANSWERS_TOOL_NAME) {
			const requestId = typeof args.request_id === 'string' ? args.request_id : '';
			return this.awaitAnswers(requestId, call);
		}
		if (name === IMAGE_INSPECT_TOOL_NAME) {
			return this.inspect(args, call);
		}
		if (isBrowserAutomationTool(name)) {
			const blocked = this.browserAccess.blockReason(call?.sessionId);
			if (blocked) {
				return { error: browserBlockedMessage(name, blocked) };
			}
			if (!call?.sessionId) {
				// No chat binding: the only thing to look at is the visible browser pane.
				return name === BROWSER_SCREENSHOT_TOOL_NAME ? this.captureBrowser(args) : { error: 'The in-app browser tools need a Volt chat.' };
			}
			const token = call.token ?? CancellationToken.None;
			const mode = call.mode ?? this.sessions?.mode(call.sessionId);
			if (name === BROWSER_RUN_TOOL_NAME && args.edits !== undefined && (mode === 'ask' || mode === 'plan')) {
				return { error: `browser_run did not start: \`edits\` change files, which ${MODE_LABEL[mode]} mode does not allow. Run the steps without edits.` };
			}
			const refusal = await this.checkMode(call.sessionId, name, args, call);
			if (refusal) {
				return refusal;
			}
			// A sandboxed chat reads only pages its sandbox allows: the one shown before the call (unless it opens another first)…
			const sandbox = isSandboxed(call.sandbox) ? call.sandbox : undefined;
			if (sandbox && name !== 'browser_navigate' && typeof args.url !== 'string') {
				const shown = await this.pageUrl(call.sessionId);
				const why = sandboxBrowserUrlRefusal(sandbox, shown);
				if (why) {
					return { error: `${name} was not run: the page this chat's browser shows is not one its sandbox allows (${why}). Open another page with browser_navigate first.` };
				}
			}
			const cwd = call.cwd ?? this.sessions?.cwd(call.sessionId) ?? this.workspace.getWorkspace().folders[0]?.uri.fsPath;
			const options: IVoltBrowserAutomationOptions = name === BROWSER_COMPARE_IMAGE_TOOL_NAME
				? { token, cwd, ...await this.loadReference(args, call) }
				: { token, cwd };
			if (token.isCancellationRequested) {
				return { error: 'Cancelled.' };
			}
			const result = name === BROWSER_RUN_TOOL_NAME && args.edits !== undefined
				? await this.editThenRun(call.sessionId, args, options)
				: await this.commandService.executeCommand<IVoltHostToolResult>(AUTOMATE_BROWSER_COMMAND_ID, call.sessionId, name, args, options) ?? { error: 'The in-app browser is not available in this window.' };
			// …and the one it ends on: links, scripts and saved flows can go anywhere.
			return sandbox ? this.withheldUnlessAllowed(name, call.sessionId, sandbox, result) : result;
		}
		return { error: `Unknown tool ${name}` };
	}

	private pageUrl(sessionId: string): Promise<string | undefined> {
		return this.commandService.executeCommand<string | undefined>(BROWSER_PAGE_URL_COMMAND_ID, sessionId).catch(() => undefined);
	}

	/** A browser call that left the page on one the chat's sandbox does not allow: what it read stays with Volt (file changes are still reported). */
	private async withheldUnlessAllowed(name: string, sessionId: string, sandbox: IVoltSandboxSettings, result: IVoltHostToolResult): Promise<IVoltHostToolResult> {
		const url = await this.pageUrl(sessionId);
		const why = sandboxBrowserUrlRefusal(sandbox, url);
		if (!why) {
			return result;
		}
		return { error: `${name} ran, but the page ended on ${url}, which this chat's sandbox does not allow (${why}). What the page showed was not returned. Open another page with browser_navigate.`, ...(result.changes ? { changes: result.changes } : {}) };
	}

	/**
	 * The sandbox gate. Every call passes here before any tool runs; for a chat whose agent runs in
	 * Volt's OS sandbox, what the tool would do outside it (`hostToolSandbox.ts`) is refused, or
	 * held to the rule the OS enforces on the agent itself. Fails closed: a tool the gate does not
	 * know, a path it cannot place, or another chat it cannot judge is refused.
	 */
	private async checkSandbox(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult | undefined> {
		const sandbox = call?.sandbox;
		if (!call || !isSandboxed(sandbox)) {
			return undefined;
		}
		const use = this.ownReads(hostToolSandboxUse(name, args), call);
		const owner = use ? undefined : this.toolOwner(name);
		if (owner) {
			return this.checkExtensionTool(name, args, owner, call, sandbox);
		}
		if (use?.chatsByProvider) {
			const reach = await this.checkChatReach(name, args, use, call, sandbox);
			if (reach) {
				return reach;
			}
		}
		// The class decision: the Policy Authority's, compared with the earlier rules (shadow mode, M.3).
		// escapes, persists and spawns are refused; network needs the chat's network; a delegate must be
		// confined at least as much (INV-11); another chat's transcript needs agents.read:other (INV-26).
		const other = use?.kind === 'delegates' && use.target && use.target !== call.sessionId ? use.target : undefined;
		const chats = other ? await this.gateChats(other, sandbox, call) : { caller: this.gateChat(call, sandbox) };
		const covers = chats.target ? legacySandboxCovers(chats.target.settings, sandbox, { targetStrategy: chats.target.strategy, callerStrategy: chats.caller.strategy, target: chats.target.folder, caller: chats.caller.folder }) : !other;
		const decision = this.authority.classDecision(use, chats.caller, chats.target);
		if (this.authority.compare(name, chatSubject(call.sessionId ?? '(none)'), legacyHostToolRefusal(use, call.sessionId, sandbox, covers), decision)) {
			return { error: sandboxRefusalMessage(name, use?.kind, sandbox, args) };
		}
		if (!use) {
			return undefined;
		}
		for (const url of use.urls ?? []) {
			const why = sandboxBrowserUrlRefusal(sandbox, url);
			if (why) {
				return { error: `${name} was not run: ${why}.` };
			}
		}
		if (!use.reads?.length && !use.writes?.length) {
			return undefined;
		}
		const context = call.sandboxPaths ?? await this.sandboxContext(call);
		// Relative paths resolve where the tools resolve them: the chat's folder, else the window's.
		const base = call.cwd ?? this.workspace.getWorkspace().folders[0]?.uri.fsPath;
		// The files broker's rules (I.15): its plan on the real path, then the Authority on the capability.
		const chat = this.gateChat(call, sandbox);
		for (const raw of use.reads ?? []) {
			for (const path of await this.realPaths(raw, base)) {
				const why = path === undefined ? `${raw} is relative and this chat has no folder` : this.authority.filesRefusal(chat, path, 'read', context);
				if (why) {
					return { error: `${name} was not run: ${why}. A sandboxed chat reads files only in its workspace, the folders the user allowed, and temp folders.` };
				}
			}
		}
		for (const raw of use.writes ?? []) {
			for (const path of await this.realPaths(raw, base)) {
				const why = path === undefined ? `${raw} is relative and this chat has no folder` : this.authority.filesRefusal(chat, path, 'write', context);
				if (why) {
					return { error: `${name} did not start: no file was changed. ${why[0].toUpperCase()}${why.slice(1)} (this chat runs in Volt's sandbox). Change files only where the sandbox allows, with your own tools.` };
				}
			}
		}
		return undefined;
	}

	/**
	 * A sandboxed chat reads its own thread, its subagents and the side chats started from it (their
	 * transcripts, waits, queues, checkouts): those reads are its own (`agents.read:current`). Any
	 * other chat stays `agents.read:other`, which a sandboxed chat is refused.
	 */
	private ownReads(use: IHostToolSandboxUse | undefined, call: IVoltHostToolCall): IHostToolSandboxUse | undefined {
		const caller = call.sessionId;
		if (use?.kind !== 'reads-other' || use.readsAnyChat || !caller) {
			return use;
		}
		const targets = readTargets(use);
		const own = (target: string) => target === caller || !!this.sandboxes?.inSubtree?.(caller, target);
		return targets.length && targets.every(own) ? { kind: 'reads-other' } : use;
	}

	/**
	 * A sandboxed chat's call with the gate's rules for files its provider finds or computes rather
	 * than files the agent named: `readRefusal` (B-15), `writeRefusal`, and the folders they judge by
	 * (`sandboxPaths`, which a window serving the call for the agent server applies the same way).
	 */
	private async withPathRules(call: IVoltHostToolCall, sandbox: IVoltSandboxSettings): Promise<IVoltHostToolCall> {
		const context = await this.sandboxContext(call);
		return { ...call, readRefusal: this.pathRule(call, sandbox, 'read', context), writeRefusal: this.pathRule(call, sandbox, 'write', context), sandboxPaths: context };
	}

	/** The gate's rule for one call: an absolute path, through its symlinks, against the chat's sandbox. */
	private pathRule(call: IVoltHostToolCall, sandbox: IVoltSandboxSettings, access: 'read' | 'write', context: ISandboxPathContext): (path: string) => Promise<string | undefined> {
		return async path => {
			if (!isAbsolute(path)) {
				return `${path} is not an absolute path`;
			}
			return this.authority.filesRefusal(this.gateChat(call, sandbox), await this.realPath(URI.file(path)), access, context);
		};
	}

	/** The calling chat as the gate knows it: the sandbox its call carries and its agent's strategy. */
	private gateChat(call: IVoltHostToolCall, sandbox: IVoltSandboxSettings): IGateChat {
		const strategy = call.sessionId ? this.sandboxes?.strategy?.(call.sessionId) : undefined;
		return { id: call.sessionId, settings: sandbox, ...(strategy ? { strategy } : {}) };
	}

	/**
	 * The caller and the chat a `delegates` call prompts, for INV-11. Folders matter only when the
	 * target may write its workspace, compared as real paths (a symlinked checkout named inside the
	 * caller's could point anywhere). Without a resolver or the target's settings, the target is
	 * unknown and the call is refused.
	 */
	private async gateChats(target: string, sandbox: IVoltSandboxSettings, call: IVoltHostToolCall): Promise<{ readonly caller: IGateChat; readonly target?: IGateChat }> {
		const caller = this.gateChat(call, sandbox);
		const resolver = this.sandboxes;
		const settings = resolver?.settings(target);
		if (!resolver || !settings) {
			return { caller };
		}
		const strategy = resolver.strategy?.(target);
		const other: IGateChat = { id: target, settings, ...(strategy ? { strategy } : {}) };
		if (settings.level !== 'workspace-write') {
			return { caller, target: other };
		}
		const named = { target: resolver.folder(target), caller: (call.sessionId ? resolver.folder(call.sessionId) : undefined) ?? call.cwd };
		const real = async (folder: string | undefined) => folder && isAbsolute(folder) ? this.realPath(URI.file(folder)) : folder;
		const [targetFolder, callerFolder] = await Promise.all([real(named.target), real(named.caller)]);
		return {
			caller: { ...caller, ...(callerFolder ? { folder: callerFolder } : {}) },
			target: { ...other, ...(targetFolder ? { folder: targetFolder } : {}) },
		};
	}

	/**
	 * A call that names the chats it reaches in its provider's terms (`chatsByProvider`: team members
	 * by name, "all", a team). The provider says which chats; each one it prompts or posts to must be
	 * confined at least as strictly as the caller (INV-11, judged like thread_send's target), and each
	 * one whose content it returns must be the caller's own or in its subtree (INV-26). Fails closed:
	 * a provider that cannot say gets the call refused. The class decision follows (no target left).
	 */
	private async checkChatReach(name: string, args: Record<string, unknown>, use: IHostToolSandboxUse, call: IVoltHostToolCall, sandbox: IVoltSandboxSettings): Promise<IVoltHostToolResult | undefined> {
		const provider = [...this.providers].find(candidate => candidate.tools.some(tool => tool.name === name));
		const reach = provider?.chatReach ? await provider.chatReach(name, args, call).catch(() => undefined) : undefined;
		if (!reach) {
			return { error: sandboxRefusalMessage(name, use.kind, sandbox) };
		}
		const subject = chatSubject(call.sessionId ?? '(none)');
		const less: string[] = [];
		for (const chat of reach.prompts ?? []) {
			if (chat.id === call.sessionId) {
				continue;
			}
			const prompt: IHostToolSandboxUse = { kind: 'delegates', target: chat.id };
			const chats = await this.gateChats(chat.id, sandbox, call);
			const covers = !!chats.target && legacySandboxCovers(chats.target.settings, sandbox, { targetStrategy: chats.target.strategy, callerStrategy: chats.caller.strategy, target: chats.target.folder, caller: chats.caller.folder });
			if (this.authority.compare(name, subject, legacyHostToolRefusal(prompt, call.sessionId, sandbox, covers), this.authority.classDecision(prompt, chats.caller, chats.target))) {
				less.push(chat.label);
			}
		}
		if (less.length) {
			return { error: sandboxReachRefusal(name, 'delegates', less, sandbox) };
		}
		const reads = (reach.reads ?? []).filter(chat => chat.id !== call.sessionId);
		if (!reads.length) {
			return undefined;
		}
		const read = this.ownReads({ kind: 'reads-other', targets: reads.map(chat => chat.id) }, call);
		if (!this.authority.compare(name, subject, legacyHostToolRefusal(read, call.sessionId, sandbox, false), this.authority.classDecision(read, this.gateChat(call, sandbox)))) {
			return undefined;
		}
		const own = (id: string) => !!call.sessionId && !!this.sandboxes?.inSubtree?.(call.sessionId, id);
		return { error: sandboxReachRefusal(name, 'reads-other', reads.filter(chat => !own(chat.id)).map(chat => chat.label), sandbox) };
	}

	/** The extension that registered `name` through the `volt` API, if one did. */
	private toolOwner(name: string): IVoltHostToolOwner | undefined {
		for (const provider of this.providers) {
			if (provider.owner && provider.tools.some(tool => tool.name === name)) {
				return provider.owner;
			}
		}
		return undefined;
	}

	/**
	 * A sandboxed chat calls an extension's tool (G.6, PERM-FLOW-1). The earlier rule refused every
	 * tool the gate did not know. Now: a tool whose class the gate can't judge without its arguments
	 * (reads, writes, pages, processes, other chats) is still refused; a `safe` or `network` tool goes
	 * to the Authority, which also checks that the extension can't send the chat's content anywhere
	 * the chat couldn't. If it can, the user is asked with the flow card (Allow once / for this chat).
	 */
	private async checkExtensionTool(name: string, args: Record<string, unknown>, owner: IVoltHostToolOwner, call: IVoltHostToolCall, sandbox: IVoltSandboxSettings): Promise<IVoltHostToolResult | undefined> {
		const chat = this.gateChat(call, sandbox);
		const subject = chatSubject(call.sessionId ?? '(none)');
		if (owner.toolClass !== 'safe' && owner.toolClass !== 'network') {
			// Refused under both rules: no shadow difference.
			return { error: sandboxRefusalMessage(name, undefined, sandbox) };
		}
		let decision = this.authority.extensionToolDecision(name, owner, chat);
		// The earlier rule refused every such tool: an allow here is the spec's change (G.6), recorded as a shadow difference.
		this.authority.compare(name, subject, true, decision);
		if (this.authority.mode === 'shadow') {
			return { error: sandboxRefusalMessage(name, undefined, sandbox) };
		}
		if (decision.allow) {
			return undefined;
		}
		const offer = decision.promptable?.flow;
		if (!offer) {
			return { error: decision.deniedBy === 'caller' ? sandboxRefusalMessage(name, owner.toolClass, sandbox) : `${name} was not run: ${decision.reason}.` };
		}
		const where = offer.hosts === 'all' ? 'any host (it runs outside Volt\'s sandbox)' : offer.hosts.join(', ');
		if (!call.sessionId || !this.approver?.approveFlow) {
			return { error: `${name} was not run: it belongs to ${owner.label}, which can send what it is given to ${where}, and this chat's network does not reach there. Sending this chat's content there needs the user's approval in a Volt chat.` };
		}
		const choice = await this.approver.approveFlow({ sessionId: call.sessionId, name, args, extension: owner.label, hosts: offer.hosts }, call.token ?? CancellationToken.None).catch(() => undefined);
		if (!choice) {
			return { error: `The user did not allow sending this chat's content to ${where} through ${owner.label}, so ${name} was not run. Continue without it.` };
		}
		const grant = this.authority.approveFlow(call.sessionId, offer.to, offer.hosts, choice === 'chat' ? 'session' : 'once');
		if (grant.kind === 'session') {
			void this.flowStore?.persist(grant).catch(() => undefined);
		}
		decision = this.authority.extensionToolDecision(name, owner, chat);
		this.authority.consume(grant);
		return decision.allow ? undefined : { error: `${name} was not run: ${decision.reason}.` };
	}

	setPolicyAuthorityMode(mode: PolicyAuthorityMode): void {
		this.authority.mode = mode;
	}

	flowApprovals(sessionId: string): readonly IGrant[] {
		return this.authority.flowApprovals(sessionId);
	}

	revokeFlowApprovals(sessionId: string): number {
		const stored = this.authority.flowApprovals(sessionId).filter(grant => grant.kind === 'session').map(grant => grant.id);
		if (stored.length) {
			void this.flowStore?.revoke(stored).catch(() => undefined);
		}
		return this.authority.revokeFlowApprovals(sessionId);
	}

	private flowStore: IVoltFlowGrantStore | undefined;

	setFlowGrantStore(store: IVoltFlowGrantStore | undefined): void {
		this.flowStore = store;
	}

	setStoredFlowGrants(grants: readonly IGrant[]): void {
		this.authority.setStoredFlowGrants(grants);
	}

	setStoredHostGrants(grants: readonly IGrant[]): void {
		this.authority.setStoredHostGrants(grants);
	}

	/** Where the chat may work (its folder as named and resolved through symlinks), and the machine facts the rules need. */
	private async sandboxContext(call: IVoltHostToolCall): Promise<ISandboxPathContext> {
		const named = [...new Set([call.sessionId ? this.sandboxes?.folder(call.sessionId) : undefined, call.cwd].filter((folder): folder is string => !!folder && isAbsolute(folder)))];
		const resolved = await Promise.all(named.map(folder => this.realPath(URI.file(folder))));
		return {
			roots: [...new Set([...named, ...resolved])],
			home: env['HOME'] || env['USERPROFILE'] || undefined,
			tmpdir: env['TMPDIR'] || undefined,
			platform: SANDBOX_PLATFORM,
		};
	}

	/**
	 * A path an agent named, as the file it reaches: relative to `base`, `file://` decoded, and through
	 * symlinks. Tools decode `%xx` in some paths, so both readings are returned. Undefined for a
	 * relative path without a base.
	 */
	private async realPaths(raw: string, base: string | undefined): Promise<(string | undefined)[]> {
		const value = raw.trim();
		let decoded = value;
		try {
			decoded = decodeURIComponent(value);
		} catch {
			// not percent-encoded
		}
		const readings = [...new Set([value, decoded])];
		return Promise.all(readings.map(async reading => {
			const uri = /^file:\/\//i.test(reading) ? URI.parse(reading) : isAbsolute(reading) ? URI.file(reading) : base ? joinPath(URI.file(base), reading) : undefined;
			return uri ? this.realPath(normalizePath(uri)) : undefined;
		}));
	}

	/** `uri` through symlinks: its own real path, or its deepest existing folder's plus the rest (a file about to be created). */
	private async realPath(uri: URI): Promise<string> {
		let current = uri;
		const rest: string[] = [];
		for (let depth = 0; depth < 64; depth++) {
			let real: URI | undefined;
			try {
				real = await this.fileService.realpath(current);
			} catch {
				real = undefined;
			}
			if (real) {
				return (rest.length ? joinPath(real, ...[...rest].reverse()) : real).fsPath;
			}
			const parent = dirname(current);
			if (parent.path === current.path) {
				break;
			}
			rest.push(basename(current));
			current = parent;
		}
		return uri.fsPath;
	}

	/**
	 * browser_run with `edits`: the fix and its check in one call. Every edit is validated against
	 * the files first and nothing is written unless all of them fit; then the page reloads and the
	 * steps run. The changes join the chat's change set like any other agent edit.
	 */
	private async editThenRun(sessionId: string, args: Record<string, unknown>, options: IVoltBrowserAutomationOptions): Promise<IVoltHostToolResult> {
		const { edits, errors } = parseFileEdits(args.edits);
		if (errors.length) {
			return { error: `browser_run did not start: ${errors.join('; ')}` };
		}
		const root = options.cwd ? URI.file(options.cwd) : undefined;
		if (!root) {
			return { error: 'browser_run did not start: no folder is open to resolve the edit paths against.' };
		}
		const planned: { uri: URI; path: string; before?: string; text: string; replacements: number }[] = [];
		for (const [path, group] of groupFileEdits(edits)) {
			const absolute = isAbsolute(path) ? URI.file(path) : undefined;
			const relative = absolute ? (isEqualOrParent(absolute, root) ? relativePath(root, absolute) : undefined) : safeEditPath(path);
			if (!relative) {
				return { error: `browser_run did not start: no file was changed. ${path} is outside the project.` };
			}
			const uri = joinPath(root, relative);
			const before = await this.fileService.readFile(uri).then(content => content.value.toString(), () => undefined);
			const applied = applyFileEdits(before, group, relative);
			if ('error' in applied) {
				return { error: `browser_run did not start: no file was changed. ${applied.error}` };
			}
			planned.push({ uri, path: relative, before, text: applied.text, replacements: applied.replacements });
		}
		const changes: IVoltHostFileChange[] = [];
		for (const item of planned) {
			if (item.before === item.text) {
				continue;
			}
			try {
				await this.fileService.writeFile(item.uri, VSBuffer.fromString(item.text));
			} catch (err) {
				const written = changes.map(change => relativePath(root, change.uri)).join(', ');
				return { error: `Could not write ${item.path}: ${err instanceof Error ? err.message : String(err)}.${written ? ` Already written: ${written}.` : ''}`, changes };
			}
			changes.push({ uri: item.uri, kind: item.before === undefined ? 'create' : 'edit', ...(item.before !== undefined ? { before: item.before } : {}), existed: item.before !== undefined });
		}
		const summary = `### Edited ${planned.length} file(s): ${planned.map(item => `${item.path} (${item.before === undefined ? 'created' : item.before === item.text ? 'unchanged' : `${item.replacements} change(s)`})`).join(', ')}`;
		const rest: Record<string, unknown> = { ...args };
		delete rest.edits;
		const hasSteps = Array.isArray(rest.steps) && rest.steps.length > 0;
		const pageUrl = hasSteps ? undefined : await this.commandService.executeCommand<string | undefined>(BROWSER_PAGE_URL_COMMAND_ID, sessionId).catch(() => undefined);
		if (!hasSteps && !pageUrl && !rest.url) {
			return { text: summary, changes };
		}
		const runArgs = hasSteps ? { ...rest, reload_first: true } : { ...rest, steps: [{ action: 'reload' }] };
		const result = await this.commandService.executeCommand<IVoltHostToolResult>(AUTOMATE_BROWSER_COMMAND_ID, sessionId, BROWSER_RUN_TOOL_NAME, runArgs, options).catch((err): IVoltHostToolResult => ({ error: err instanceof Error ? err.message : String(err) }));
		if (!result || result.error) {
			return { text: `${summary}\n\nThe browser steps did not run: ${result?.error ?? 'the in-app browser is not available in this window.'}`, changes };
		}
		return { ...result, text: `${summary}\n\n${result.text ?? ''}`, changes };
	}

	/**
	 * Ask and Plan are read-only. Browser calls that act beyond looking at a local page run only
	 * after the user allows them; without an approver they are refused with a reason the model can use.
	 */
	private async checkMode(sessionId: string, name: string, args: Record<string, unknown>, call: IVoltHostToolCall): Promise<IVoltHostToolResult | undefined> {
		const mode = call.mode ?? this.sessions?.mode(sessionId);
		if (mode !== 'ask' && mode !== 'plan') {
			return undefined;
		}
		const pageUrl = browserVerdictNeedsPage(name)
			? await this.commandService.executeCommand<string | undefined>(BROWSER_PAGE_URL_COMMAND_ID, sessionId).catch(() => undefined)
			: undefined;
		const verdict = browserToolVerdict(name, args, mode, pageUrl);
		if (verdict.kind === 'allow') {
			return undefined;
		}
		const label = MODE_LABEL[mode];
		if (!this.approver) {
			return { error: `${name} was not run: in ${label} mode it needs the user's approval because it ${verdict.reason}. Observe with browser_snapshot or browser_screenshot instead, or ask the user to switch to Agent mode.` };
		}
		const allowed = await this.approver.approve({ sessionId, name, args, mode, reason: verdict.reason }, call.token ?? CancellationToken.None).catch(() => false);
		return allowed ? undefined : { error: `The user did not allow ${name} in ${label} mode (it ${verdict.reason}). Continue without it.` };
	}

	/** A provider tool that needs the user's approval in every mode (desktop control). */
	private async checkAlways(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined, reason: string): Promise<IVoltHostToolResult | undefined> {
		if (!call?.sessionId || !this.approver) {
			return { error: `${name} was not run: it ${reason}, which needs the user's approval in a Volt chat.` };
		}
		const mode = call.mode ?? this.sessions?.mode(call.sessionId) ?? 'agent';
		const allowed = await this.approver.approve({ sessionId: call.sessionId, name, args, mode, reason }, call.token ?? CancellationToken.None).catch(() => false);
		return allowed ? undefined : { error: `The user did not allow ${name} (it ${reason}). Continue without it, or ask them.` };
	}

	/** A provider tool that acts (taps, installs, records) needs the user's approval in Ask and Plan. */
	private async checkReadOnly(sessionId: string, name: string, args: Record<string, unknown>, call: IVoltHostToolCall, reason: string): Promise<IVoltHostToolResult | undefined> {
		const mode = call.mode ?? this.sessions?.mode(sessionId);
		if (mode !== 'ask' && mode !== 'plan') {
			return undefined;
		}
		const label = MODE_LABEL[mode];
		if (!this.approver) {
			return { error: `${name} was not run: in ${label} mode it needs the user's approval because it ${reason}. Look with the read-only tools instead, or ask the user to switch to Agent mode.` };
		}
		const allowed = await this.approver.approve({ sessionId, name, args, mode, reason }, call.token ?? CancellationToken.None).catch(() => false);
		return allowed ? undefined : { error: `The user did not allow ${name} in ${label} mode (it ${reason}). Continue without it.` };
	}

	private resolveImage(path: unknown, call: IVoltHostToolCall | undefined): URI {
		const value = typeof path === 'string' ? path.trim() : '';
		if (!value) {
			throw new Error('Pass the image `path`.');
		}
		if (/^file:\/\//i.test(value)) {
			return URI.parse(value);
		}
		if (isAbsolute(value)) {
			return URI.file(value);
		}
		const cwd = call?.cwd ?? (call?.sessionId ? this.sessions?.cwd(call.sessionId) : undefined);
		const base = cwd ? URI.file(cwd) : this.workspace.getWorkspace().folders[0]?.uri;
		if (!base) {
			throw new Error(`${value} is relative and no folder is open; pass an absolute path.`);
		}
		return joinPath(base, value);
	}

	private async readImage(uri: URI): Promise<IRgbaImage> {
		let bytes: Uint8Array;
		try {
			bytes = (await this.fileService.readFile(uri, { limits: { size: MAX_IMAGE_BYTES } })).value.buffer;
		} catch (err) {
			throw new Error(`Could not read ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
		const image = await decodeImage(bytes);
		if (image.width * image.height > MAX_ANALYSIS_PIXELS) {
			throw new Error(`${uri.fsPath} is ${image.width}×${image.height}; the image tools handle up to about 4096×4096. Crop or scale it first.`);
		}
		return image;
	}

	private async loadReference(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<Pick<IVoltBrowserAutomationOptions, 'reference' | 'referenceLabel'>> {
		const uri = this.resolveImage(args.reference_path, call);
		const reference = flattenAlpha(await this.readImage(uri));
		return { reference, referenceLabel: typeof args.reference_path === 'string' ? args.reference_path : uri.fsPath };
	}

	private async inspect(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const uri = this.resolveImage(args.path, call);
		const image = await this.readImage(uri);
		const regions = Array.isArray(args.regions) ? args.regions.slice(0, 16).map(parseRect).filter((rect): rect is IImageRect => !!rect) : [];
		const result = inspectImage(image, { points: parsePoints(args.points), regions });
		const lines = [`### Image ${typeof args.path === 'string' ? args.path : uri.fsPath}`, ...describeInspection(result)];
		const crop = parseRect(args.crop);
		if (!crop) {
			return { text: lines.join('\n') };
		}
		const part = cropImage(image, crop);
		lines.push(`- Zoomed crop: x ${Math.round(crop.x)}, y ${Math.round(crop.y)}, ${part.width}×${part.height} (attached)`);
		return { text: lines.join('\n'), image: await zoomImage(part) };
	}

	private async askQuestions(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const draft = parseQuestionDraft(args);
		if (!draft) {
			return { error: 'ask_question needs a non-empty `questions` array, each with `id`, `prompt` and `options` ({ id, label }).' };
		}
		if (!call?.sessionId || !this.questionHandler) {
			return { error: 'Questions can only be asked from a Volt chat.' };
		}
		const requestId = this.questionHandler.ask(call.sessionId, draft);
		this.drafts.set(requestId, draft);
		return this.awaitAnswers(requestId, call);
	}

	/**
	 * Waits a little under the 60s agents give an MCP call (Cursor's client cannot be told to wait
	 * longer), then tells the agent to poll again, so the user can take their time.
	 */
	private async awaitAnswers(requestId: string, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const draft = this.drafts.get(requestId);
		if (!this.questionHandler || !draft) {
			return { error: `No open questions with request_id ${requestId}.` };
		}
		const response = await this.questionHandler.wait(requestId, QUESTION_POLL_MS, call?.token ?? CancellationToken.None);
		if (!response) {
			return { text: `STILL WAITING: the user is still answering (request_id: ${requestId}). Call the \`${AWAIT_ANSWERS_TOOL_NAME}\` tool with this request_id now to keep waiting. Do not ask again, do not continue, and do not end your turn.` };
		}
		this.drafts.delete(requestId);
		return { text: questionResponseText(draft, response) };
	}

	getMcpServers(sessionId?: string, options?: { readonly groups?: readonly VoltHostToolGroup[] }): readonly IVoltMcpServer[] {
		if (!this.mcpUrl) {
			return [];
		}
		let url = sessionId ? `${this.mcpUrl}/${encodeURIComponent(sessionId)}` : this.mcpUrl;
		if (options?.groups) {
			url += `?groups=${options.groups.join(',')}`;
		}
		// Each chat's agent gets a token for its own session and groups, never the server secret: a
		// server without a session gets no credentials (the server refuses it), so nothing an agent
		// holds lets it act as another chat. The token expires and dies when the chat is revoked.
		const token = this.mcpToken && sessionId ? hostMcpSessionToken(this.mcpToken, sessionId, options?.groups, this.mcpLease(sessionId)) : undefined;
		const headers = token ? [{ name: 'Authorization', value: `Bearer ${token}` }] : [];
		return [{ type: 'http', name: 'volt', url, headers }];
	}

	/**
	 * The chat's current lease. It stays the same until it nears expiry or the chat is revoked, so
	 * the agent's MCP config (compared every turn) does not change under it.
	 */
	private mcpLease(sessionId: string): IHostMcpLease {
		const now = Date.now();
		const current = this.mcpLeases.get(sessionId);
		if (current && current.expiry - now > HOST_MCP_TOKEN_RENEW_MS) {
			return current;
		}
		if (this.mcpLeases.size > 256) {
			for (const [id, lease] of this.mcpLeases) {
				if (lease.expiry <= now) {
					this.mcpLeases.delete(id);
				}
			}
		}
		const lease = newHostMcpLease(this.nextMcpEpoch());
		this.mcpLeases.set(sessionId, lease);
		return lease;
	}

	/** Monotonic: a revocation's epoch is below every epoch issued after it. */
	private nextMcpEpoch(): number {
		this.lastMcpEpoch = Math.max(Date.now(), this.lastMcpEpoch + 1);
		return this.lastMcpEpoch;
	}

	revokeMcpSession(sessionId: string): void {
		this.mcpLeases.delete(sessionId);
		this._onDidRevokeMcpSession.fire({ sessionId, epoch: this.nextMcpEpoch() });
	}

	setMcpEndpoint(url: string | undefined, token?: string): void {
		if (this.mcpUrl === url && this.mcpToken === token) {
			return;
		}
		this.mcpUrl = url;
		this.mcpToken = url ? token : undefined;
		this._onDidChangeMcp.fire();
	}

	async askUser(sessionId: string, draft: AgentQuestionDraft, options: { readonly requestId?: string; readonly ms: number; readonly token: CancellationToken }): Promise<{ readonly requestId: string; readonly response?: IAgentQuestionResponse } | undefined> {
		if (!this.questionHandler) {
			return undefined;
		}
		const requestId = options.requestId && this.drafts.has(options.requestId) ? options.requestId : this.questionHandler.ask(sessionId, draft);
		this.drafts.set(requestId, draft);
		const response = await this.questionHandler.wait(requestId, options.ms, options.token);
		if (response) {
			this.drafts.delete(requestId);
		}
		return { requestId, ...(response ? { response } : {}) };
	}

	setQuestionHandler(handler: IVoltQuestionHandler | undefined): void {
		this.questionHandler = handler;
	}

	setSessionResolver(resolver: IVoltHostSessionResolver | undefined): void {
		this.sessions = resolver;
	}

	setApprover(approver: IVoltHostToolApprover | undefined): void {
		this.approver = approver;
	}

	setSandboxResolver(resolver: IVoltHostSandboxResolver | undefined): void {
		this.sandboxes = resolver;
	}

	private async captureBrowser(args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		const image = await this.commandService.executeCommand(CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID) as string | undefined;
		if (!image) {
			return { error: 'No in-app browser page is available to capture.' };
		}
		const format: ImageFormat = args.format === 'png' || args.format === 'webp' ? args.format : 'jpeg';
		const maxSide = Math.max(256, Math.min(2560, num(args.max_side) ?? 1280));
		const shot = await scaleScreenshot(image, { maxSide, format }).catch(() => undefined);
		return { text: shot ? `Captured the in-app browser (${shot.width}×${shot.height}).` : 'Captured the in-app browser.', image: shot?.dataUrl ?? image };
	}
}

registerSingleton(IVoltHostToolService, VoltHostToolService, InstantiationType.Delayed);
