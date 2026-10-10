/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../../../base/common/path.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ASK_QUESTION_TOOL_NAME, AUTOMATE_BROWSER_COMMAND_ID, AWAIT_ANSWERS_TOOL_NAME, BROWSER_COMPARE_IMAGE_TOOL_NAME, BROWSER_PAGE_URL_COMMAND_ID, BROWSER_SCREENSHOT_TOOL_NAME, browserToolVerdict, browserVerdictNeedsPage, canonicalHostToolName, CAPTURE_BROWSER_SNAPSHOT_COMMAND_ID, IMAGE_INSPECT_TOOL_NAME, isBrowserAutomationTool, IVoltBrowserAutomationOptions, IVoltHostSessionResolver, IVoltHostToolApprover, IVoltHostToolCall, IVoltHostToolInfo, IVoltHostToolInvocation, IVoltHostToolProvider, IVoltHostToolResult, IVoltHostToolService, IVoltMcpServer, IVoltQuestionHandler, VOLT_HOST_TOOLS, VoltHostToolGroup } from '../../common/hostTools.js';
import { browserBlockedMessage, IVoltBrowserAccessService } from '../../common/browserAccess.js';
import { PROPOSE_PLAN_TOOL_NAME } from '../../common/plans.js';
import { VoltMode } from '../../common/modes.js';
import '../browserAccessService.js';
import { AgentQuestionDraft, parseQuestionDraft, questionResponseText } from '../../common/questions.js';
import { cropImage, describeInspection, flattenAlpha, IImagePoint, IImageRect, inspectImage, IRgbaImage, MAX_ANALYSIS_PIXELS, parseRect } from '../../common/tools/imageAnalysis.js';
import { decodeImage, ImageFormat, MAX_IMAGE_BYTES, scaleScreenshot, zoomImage } from './imageCodec.js';

/** Under the 60s default MCP request timeout of the agents' SDK clients. */
const QUESTION_POLL_MS = 45_000;

const MODE_LABEL: Record<VoltMode, string> = { agent: 'Agent', plan: 'Plan', ask: 'Ask', debug: 'Debug', multitask: 'Multitask' };

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
	private readonly drafts = new Map<string, AgentQuestionDraft>();
	private questionHandler: IVoltQuestionHandler | undefined;
	private sessions: IVoltHostSessionResolver | undefined;
	private approver: IVoltHostToolApprover | undefined;
	private readonly _onDidChangeMcp = this._register(new Emitter<void>());
	readonly onDidChangeMcp: Event<void> = this._onDidChangeMcp.event;
	private readonly _onDidInvokeTool = this._register(new Emitter<IVoltHostToolInvocation>());
	readonly onDidInvokeTool: Event<IVoltHostToolInvocation> = this._onDidInvokeTool.event;
	private readonly _onDidChangeTools = this._register(new Emitter<void>());
	readonly onDidChangeTools: Event<void> = this._onDidChangeTools.event;
	private readonly providers = new Set<IVoltHostToolProvider>();

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IVoltBrowserAccessService private readonly browserAccess: IVoltBrowserAccessService,
	) {
		super();
	}

	listTools(): readonly IVoltHostToolInfo[] {
		return this.providers.size ? [...VOLT_HOST_TOOLS, ...[...this.providers].flatMap(provider => provider.tools)] : VOLT_HOST_TOOLS;
	}

	registerToolProvider(provider: IVoltHostToolProvider): IDisposable {
		this.providers.add(provider);
		this._onDidChangeTools.fire();
		return toDisposable(() => {
			if (this.providers.delete(provider)) {
				this._onDidChangeTools.fire();
			}
		});
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
		const call = requested?.sessionId && !requested.cwd ? { ...requested, cwd: this.sessions?.cwd(requested.sessionId) } : requested;
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
			const refusal = await this.checkMode(call.sessionId, name, args, call);
			if (refusal) {
				return refusal;
			}
			const cwd = call.cwd ?? this.sessions?.cwd(call.sessionId) ?? this.workspace.getWorkspace().folders[0]?.uri.fsPath;
			const options: IVoltBrowserAutomationOptions = name === BROWSER_COMPARE_IMAGE_TOOL_NAME
				? { token, cwd, ...await this.loadReference(args, call) }
				: { token, cwd };
			if (token.isCancellationRequested) {
				return { error: 'Cancelled.' };
			}
			const result = await this.commandService.executeCommand<IVoltHostToolResult>(AUTOMATE_BROWSER_COMMAND_ID, call.sessionId, name, args, options);
			return result ?? { error: 'The in-app browser is not available in this window.' };
		}
		return { error: `Unknown tool ${name}` };
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
		const headers = this.mcpToken ? [{ name: 'Authorization', value: `Bearer ${this.mcpToken}` }] : [];
		return [{ type: 'http', name: 'volt', url, headers }];
	}

	setMcpEndpoint(url: string | undefined, token?: string): void {
		if (this.mcpUrl === url && this.mcpToken === token) {
			return;
		}
		this.mcpUrl = url;
		this.mcpToken = url ? token : undefined;
		this._onDidChangeMcp.fire();
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
