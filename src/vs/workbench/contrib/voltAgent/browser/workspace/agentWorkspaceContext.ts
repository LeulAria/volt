/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { relative } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAgentWorktreeService } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { IVoltBrowserService } from '../../../../../platform/voltBrowser/common/voltBrowser.js';
import { isTerminalLive } from '../../../../services/voltRuntime/common/terminalTools.js';
import { IWorkspaceAgentTerminal, IWorkspaceDevice, IWorkspaceFleetFacts, IWorkspaceGit, IWorkspaceSnapshot, IWorkspaceTab, IWorkspaceTerminal, WORKSPACE_DETAIL_COMMAND_ID, WORKSPACE_FLEET_COMMAND_ID, WORKSPACE_SNAPSHOT_COMMAND_ID, WORKSPACE_STATUS_TOOL_NAME, formatWorkspaceStatus } from '../../../../services/voltRuntime/common/harness/workspaceContext.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IFleetProjectRef } from '../../../../services/voltRuntime/common/orchestration/agentFleet.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { parseBranchStatus } from '../../../../services/voltRuntime/common/orchestration/agentThreadTools.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { isSandboxed } from '../../../../services/voltRuntime/common/hostToolSandbox.js';
import { IAgentTerminalsService } from '../terminals/agentTerminals.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../terminal/browser/terminalEditorInput.js';
import { IAgentDevicesService } from '../devices/agentDevicesService.js';
import { DevicePreviewEditorInput } from '../devices/deviceEditor.js';
import { devicePreviews } from '../devices/devicePreview.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { VoltBrowserEditorInput } from '../preview/browserEditorInput.js';
import { AgentChangesEditorInput } from '../review/agentChangesEditor.js';
import { ScratchBoardEditorInput } from '../scratchBoard/scratchBoardInput.js';
import { IScratchBoardService } from '../scratchBoard/scratchBoardService.js';
import { IScratchSessionLinks } from '../scratchBoard/scratchSessionLinks.js';
import { boardDisplayTitle } from '../../common/scratchBoard/scratchIndex.js';
import { agentSessionToolTabs } from './agentSurfaceHost.js';

/** The turn waits at most this long for the snapshot (git, the device's app); then it goes without. */
const SNAPSHOT_BUDGET_MS = 1200;
/** A turn's summary reuses a git result this fresh as it is; an older one is refreshed behind the turn. */
const GIT_FRESH_MS = 2_000;
/** Past this a git result is too old to show: the turn waits for a new one. */
const GIT_STALE_MS = 60_000;
const OUTPUT_LINES = 30;
/** A project counts as open while one of its chats was active this recently. */
const RECENT_PROJECT_MS = 14 * 24 * 60 * 60_000;
const MAX_OTHER_PROJECTS = 8;
const PROJECTS_FRESH_MS = 30_000;
/** CanvasEditorInput.TypeID and CANVAS_SCHEME (visuals/canvas/canvasEditor.ts), not imported for its weight. */
const CANVAS_INPUT_TYPE_ID = 'workbench.input.voltCanvas';
const CANVAS_SCHEME = 'volt-canvas';

/**
 * What the user has open beside each chat, for its agent: a compact snapshot the runtime puts in
 * the turn when it changed (WORKSPACE_SNAPSHOT_COMMAND_ID), and workspace_status for the details.
 */
export class AgentWorkspaceContextContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentWorkspaceContext';

	/** The last `git status` summary per folder (see git). */
	private readonly gitByFolder = new Map<string, { at: number; settled?: { value: IWorkspaceGit | undefined }; refreshing: boolean }>();
	/** The projects with recent chats, most recent first (see recentProjects). */
	private recent: { readonly at: number; readonly projects: readonly IFleetProjectRef[] } | undefined;

	constructor(
		@IAgentDevicesService private readonly devices: IAgentDevicesService,
		@IAgentWorktreeService private readonly worktrees: IAgentWorktreeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IScratchBoardService private readonly scratchBoards: IScratchBoardService,
		@IScratchSessionLinks private readonly scratchLinks: IScratchSessionLinks,
		@IEditorService private readonly editorService: IEditorService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IAgentTerminalsService private readonly agentTerminals: IAgentTerminalsService,
		@IVoltBrowserService private readonly browser: IVoltBrowserService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand(WORKSPACE_SNAPSHOT_COMMAND_ID, (_accessor, sessionId: string) =>
			raceTimeout(this.snapshot(sessionId, false, isSandboxed(this.runtime.getSandboxSettings(this.runtime.chatFor(sessionId)))), SNAPSHOT_BUDGET_MS), 'internal'));
		this._register(CommandsRegistry.registerCommand(WORKSPACE_DETAIL_COMMAND_ID, (_accessor, sessionId: string, options?: { readonly ownTerminalsOnly?: boolean; readonly outputLines?: number }) =>
			this.snapshot(sessionId, true, options?.ownTerminalsOnly === true, options?.outputLines), 'internal'));
		this._register(CommandsRegistry.registerCommand(WORKSPACE_FLEET_COMMAND_ID, (_accessor, _callerId: string, options?: { readonly chats?: readonly string[]; readonly terminalLines?: number }) =>
			this.fleetFacts(options?.chats ?? [], options?.terminalLines), 'internal'));
		this._register(hostTools.registerToolProvider({
			tools: [{
				name: WORKSPACE_STATUS_TOOL_NAME,
				title: 'Checked the workspace',
				group: 'core',
				description: 'What the user has open beside this chat in Volt, in detail: every right-panel tab (which one is in front), the simulator or emulator shown and the app in front on it, browser tabs and their URLs, scratch boards and design canvases with their ids, terminals with their running or last command, exit code and last output lines, and git branch with the changed files. Call it when the request refers to something on screen ("this", "the app", "the error in the terminal") and the turn\'s workspace summary does not say enough.',
				inputSchema: { type: 'object', properties: {} },
			}],
			invoke: (_name, _args, call) => this.status(call),
		}));
	}

	private async status(call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		if (!call?.sessionId) {
			return { error: 'workspace_status needs a Volt chat.' };
		}
		// A sandboxed chat sees its own terminals only: other terminals (the user's, other chats') need agents.read:other (INV-26).
		const snapshot = await this.snapshot(this.runtime.chatFor(call.sessionId), true, isSandboxed(call.sandbox));
		return { text: formatWorkspaceStatus(snapshot) };
	}

	/** `detail`: terminal output and changed file names too (workspace_status). `ownTerminalsOnly`: what other terminals ran and printed is left out. */
	async snapshot(sessionId: string, detail: boolean, ownTerminalsOnly = false, outputLines = OUTPUT_LINES): Promise<IWorkspaceSnapshot> {
		const id = this.runtime.chatFor(sessionId);
		const root = this.folder(id);
		const panel = agentSessionToolTabs(id);
		const [tabs, git] = await Promise.all([
			Promise.all((panel?.tabs ?? []).map(tab => this.describe(tab.input, tab.focused, root, detail ? Math.max(0, Math.min(200, outputLines)) : undefined, ownTerminalsOnly ? id : undefined))),
			root ? this.git(root.fsPath, detail) : Promise.resolve(undefined),
		]);
		const shown = tabs.filter((tab): tab is IWorkspaceTab => !!tab);
		const scratchBoard = this.chatBoard(id, shown);
		const project = this.projectOf(id);
		const otherProjects = this.recentProjects().filter(other => other.id !== project?.id).slice(0, MAX_OTHER_PROJECTS);
		return {
			panelOpen: panel?.open ?? false,
			tabs: shown,
			...(git ? { git } : {}),
			...(scratchBoard ? { scratchBoard } : {}),
			...(project ? { project } : {}),
			...(otherProjects.length ? { otherProjects } : {}),
		};
	}

	/** What only a window knows about several chats: listening processes, each chat's page and its agent's terminals. */
	private async fleetFacts(chats: readonly string[], terminalLines: number | undefined): Promise<IWorkspaceFleetFacts> {
		const servers = await raceTimeout(this.browser.listLocalServers().catch(() => undefined), 5_000) ?? [];
		const facts: Record<string, { browserUrl?: string; terminals?: IWorkspaceAgentTerminal[] }> = {};
		for (const chat of chats.slice(0, 400)) {
			const id = this.runtime.chatFor(chat);
			const browserUrl = agentSessionToolTabs(id)?.tabs.map(tab => tab.input).find((input): input is VoltBrowserEditorInput => input instanceof VoltBrowserEditorInput)?.url;
			const terminals = this.agentTerminals.list(id).slice(0, 12).map((terminal): IWorkspaceAgentTerminal => {
				const tail = terminalLines ? this.agentTerminals.output(terminal.id)?.text.trimEnd().split('\n').slice(-Math.min(terminalLines, 40)) : undefined;
				return {
					id: terminal.id,
					command: terminal.command,
					status: terminal.status,
					live: isTerminalLive(terminal.status),
					...(terminal.cwd ? { cwd: terminal.cwd } : {}),
					...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
					...(terminal.urls.length ? { urls: terminal.urls.slice(0, 3) } : {}),
					...(terminal.error ? { error: terminal.error } : {}),
					...(tail?.some(line => line.trim()) ? { tail } : {}),
				};
			});
			if (browserUrl || terminals.length) {
				facts[chat] = { ...(browserUrl ? { browserUrl } : {}), ...(terminals.length ? { terminals } : {}) };
			}
		}
		return { servers: servers.map(server => ({ port: server.port, pid: server.pid, command: server.command, ...(server.cwd ? { cwd: server.cwd } : {}) })), chats: facts };
	}

	private projectOf(sessionId: string): IFleetProjectRef | undefined {
		const bound = this.sessionContext.bindingFor(sessionId);
		const record = (bound ? this.sessionContext.getProject(bound.projectId) : undefined)
			?? this.sessionContext.getProject(this.history.get(sessionId)?.workspaceId ?? '');
		return record && !record.scratch && record.root.scheme === Schemas.file ? { id: record.id, name: record.displayName, root: record.root.fsPath } : undefined;
	}

	/**
	 * The projects the user is working in: those with a chat active in the last two weeks, most
	 * recent first. Every project ever opened would name folders the user forgot about.
	 */
	private recentProjects(): readonly IFleetProjectRef[] {
		const now = Date.now();
		if (this.recent && now - this.recent.at < PROJECTS_FRESH_MS) {
			return this.recent.projects;
		}
		const latest = new Map<string, number>();
		for (const meta of this.history.list({ inWindow: true })) {
			const at = Math.max(meta.updatedAt, meta.lastPromptAt ?? 0);
			if (!meta.subagent && now - at < RECENT_PROJECT_MS && at > (latest.get(meta.workspaceId) ?? 0)) {
				latest.set(meta.workspaceId, at);
			}
		}
		const projects = [...latest].sort((a, b) => b[1] - a[1]).flatMap(([id]): IFleetProjectRef[] => {
			const record = this.sessionContext.getProject(id);
			return record && !record.scratch && record.root.scheme === Schemas.file ? [{ id: record.id, name: record.displayName, root: record.root.fsPath }] : [];
		});
		this.recent = { at: now, projects };
		return projects;
	}

	/** The chat's one board, as scratch_draw picks it: the Scratch tab beside the chat, else one on screen, else the board it drew on. */
	private chatBoard(sessionId: string, tabs: readonly IWorkspaceTab[]): { id: string; title: string } | undefined {
		const onScreen = [this.editorService.activeEditor, ...this.editorService.visibleEditors]
			.find((input): input is ScratchBoardEditorInput => input instanceof ScratchBoardEditorInput && !!input.boardId)?.boardId;
		const ids = [tabs.find(tab => tab.kind === 'scratch')?.surfaceId, onScreen, this.scratchLinks.boardFor(sessionId)];
		for (const id of ids) {
			const board = id ? this.scratchBoards.getBoard(id) : undefined;
			if (board && !board.deleted && !board.archived) {
				return { id: board.id, title: boardDisplayTitle(board) };
			}
		}
		return undefined;
	}

	private folder(sessionId: string): URI | undefined {
		const worktree = this.history.get(sessionId)?.worktreePath;
		const folder = worktree ? URI.file(worktree) : this.sessionContext.rootFor(sessionId);
		return folder?.scheme === Schemas.file ? folder : undefined;
	}

	/** `outputLines`: terminal output too, this many lines (workspace_status, thread_inspect); undefined for a turn's summary. */
	private async describe(input: EditorInput, focused: boolean, root: URI | undefined, outputLines: number | undefined, onlyTerminalsOf?: string): Promise<IWorkspaceTab | undefined> {
		const title = input.getName();
		if (input instanceof VoltBrowserEditorInput) {
			return { kind: 'browser', title, focused, ...(input.url ? { target: input.url } : {}) };
		}
		if (input instanceof DevicePreviewEditorInput) {
			const target = input.deviceKey ? this.devices.find(input.deviceKey) : undefined;
			if (!target) {
				return { kind: 'device', title, focused };
			}
			const device = target.device;
			const foreground = device.state === 'booted' ? await this.devices.foregroundApp(target) : undefined;
			const info: IWorkspaceDevice = {
				name: device.name,
				platform: device.platform,
				kind: device.kind,
				state: device.state,
				...(device.runtime ? { runtime: device.runtime } : {}),
				...(foreground ? { foreground } : {}),
				...(target.host.ssh ? { host: target.host.label } : {}),
				id: device.id,
				...(devicePreviews.get(input)?.floating ? { floating: true } : {}),
			};
			return { kind: 'device', title, focused, device: info };
		}
		if (input instanceof TerminalEditorInput) {
			const instance = input.terminalInstance;
			if (instance && onlyTerminalsOf !== undefined && this.agentTerminals.forInstance(instance)?.chatId !== onlyTerminalsOf) {
				return { kind: 'terminal', title, focused };
			}
			return { kind: 'terminal', title, focused, ...(instance && !instance.isDisposed ? { terminal: await this.terminal(instance, outputLines) } : {}) };
		}
		if (input instanceof AgentChangesEditorInput) {
			return { kind: 'changes', title, focused };
		}
		if (input instanceof AgentEditorInput) {
			return { kind: 'chat', title, focused };
		}
		if (input instanceof ScratchBoardEditorInput) {
			const boardId = input.boardId;
			const board = boardId ? this.scratchBoards.getBoard(boardId) : undefined;
			return { kind: 'scratch', title: board ? boardDisplayTitle(board) : title, focused, ...(boardId ? { surfaceId: boardId } : {}) };
		}
		if (input.typeId === CANVAS_INPUT_TYPE_ID || input.resource?.scheme === CANVAS_SCHEME) {
			// CanvasEditorInput is read structurally: its module pulls in webviews and the editor.
			const canvasId = (input as { readonly canvasId?: unknown }).canvasId;
			return { kind: 'canvas', title, focused, ...(typeof canvasId === 'string' && canvasId ? { surfaceId: canvasId } : {}) };
		}
		const resource = input.resource;
		if (resource?.scheme === Schemas.file || resource?.scheme === Schemas.vscodeUserData) {
			const path = root && resource.fsPath.startsWith(root.fsPath) ? relative(root.fsPath, resource.fsPath) : resource.fsPath;
			return { kind: 'file', title, focused, target: path, ...(input.isDirty() ? { dirty: true } : {}) };
		}
		return { kind: 'other', title, focused };
	}

	private async terminal(instance: ITerminalInstance, outputLines: number | undefined): Promise<IWorkspaceTerminal> {
		const commands = instance.capabilities.get(TerminalCapability.CommandDetection);
		const running = commands?.executingCommand?.trim();
		const last = commands?.commands.at(-1);
		const cwd = instance.capabilities.get(TerminalCapability.CwdDetection)?.getCwd()
			?? await raceTimeout(instance.getSpeculativeCwd(), 300).catch(() => undefined);
		const output = outputLines ? terminalTail(instance, outputLines) : undefined;
		return {
			...(cwd ? { cwd } : {}),
			...(running ? { running } : {}),
			...(!running && last?.command ? { last: last.command, ...(last.exitCode !== undefined ? { exitCode: last.exitCode } : {}) } : {}),
			...(output ? { output } : {}),
		};
	}

	/**
	 * A turn's summary takes the folder's last git result at once and refreshes it behind the turn:
	 * `git status` in a big repository takes a few hundred ms, and every prompt would wait for it.
	 * workspace_status (`detail`) always runs it.
	 */
	private git(folder: string, detail: boolean): Promise<IWorkspaceGit | undefined> {
		const cached = this.gitByFolder.get(folder);
		const age = cached ? Date.now() - cached.at : Infinity;
		if (!detail && cached?.settled && age < GIT_STALE_MS) {
			if (age >= GIT_FRESH_MS && !cached.refreshing) {
				cached.refreshing = true;
				void this.readGit(folder, false);
			}
			return Promise.resolve(cached.settled.value);
		}
		return this.readGit(folder, detail);
	}

	private async readGit(folder: string, detail: boolean): Promise<IWorkspaceGit | undefined> {
		const at = Date.now();
		const value = await this.gitStatus(folder, detail);
		const current = this.gitByFolder.get(folder);
		if (!current || current.at <= at) {
			// Kept as a turn's summary has it: the counts, not workspace_status's file list.
			const summary = value && detail ? (({ files: _files, ...rest }) => rest)(value) : value;
			this.gitByFolder.set(folder, { at, settled: { value: summary }, refreshing: false });
		}
		return value;
	}

	private async gitStatus(folder: string, detail: boolean): Promise<IWorkspaceGit | undefined> {
		const status = await this.worktrees.git(folder, ['status', '--porcelain=v1', '-b']).catch(() => undefined);
		if (!status || status.exitCode !== 0) {
			return undefined;
		}
		const parsed = parseBranchStatus(status.stdout);
		return {
			...(parsed.branch && !parsed.detached ? { branch: parsed.branch } : {}),
			...(parsed.ahead ? { ahead: parsed.ahead } : {}),
			...(parsed.behind ? { behind: parsed.behind } : {}),
			changed: parsed.changes.length,
			...(detail ? { files: parsed.changes } : {}),
		};
	}
}

/** The last non-empty lines on the terminal's screen and scrollback. */
function terminalTail(instance: ITerminalInstance, count: number): string | undefined {
	const buffer = instance.xterm?.raw.buffer.active;
	if (!buffer) {
		return undefined;
	}
	const end = buffer.baseY + buffer.cursorY;
	const lines: string[] = [];
	for (let y = Math.max(0, end - count * 3); y <= end; y++) {
		lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
	}
	while (lines.length && !lines[lines.length - 1].trim()) {
		lines.pop();
	}
	const text = lines.slice(-count).join('\n').trim();
	return text || undefined;
}

registerWorkbenchContribution2(AgentWorkspaceContextContribution.ID, AgentWorkspaceContextContribution, WorkbenchPhase.AfterRestored);
