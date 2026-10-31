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
import { IAgentWorktreeService } from '../../../../services/voltRuntime/common/git/agentWorktree.js';
import { IWorkspaceDevice, IWorkspaceGit, IWorkspaceSnapshot, IWorkspaceTab, IWorkspaceTerminal, WORKSPACE_SNAPSHOT_COMMAND_ID, WORKSPACE_STATUS_TOOL_NAME, formatWorkspaceStatus } from '../../../../services/voltRuntime/common/harness/workspaceContext.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { parseBranchStatus } from '../../../../services/voltRuntime/common/orchestration/agentThreadTools.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../terminal/browser/terminalEditorInput.js';
import { IAgentDevicesService } from '../devices/agentDevicesService.js';
import { DevicePreviewEditorInput } from '../devices/deviceEditor.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { VoltBrowserEditorInput } from '../preview/browserEditorInput.js';
import { AgentChangesEditorInput } from '../review/agentChangesEditor.js';
import { ScratchBoardEditorInput } from '../scratchBoard/scratchBoardInput.js';
import { IScratchBoardService } from '../scratchBoard/scratchBoardService.js';
import { boardDisplayTitle } from '../../common/scratchBoard/scratchIndex.js';
import { agentSessionToolTabs } from './agentSurfaceHost.js';

/** The turn waits at most this long for the snapshot (git, the device's app); then it goes without. */
const SNAPSHOT_BUDGET_MS = 1200;
/** A turn's summary reuses a git result this fresh as it is; an older one is refreshed behind the turn. */
const GIT_FRESH_MS = 2_000;
/** Past this a git result is too old to show: the turn waits for a new one. */
const GIT_STALE_MS = 60_000;
const OUTPUT_LINES = 30;
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

	constructor(
		@IAgentDevicesService private readonly devices: IAgentDevicesService,
		@IAgentWorktreeService private readonly worktrees: IAgentWorktreeService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IScratchBoardService private readonly scratchBoards: IScratchBoardService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
	) {
		super();
		this._register(CommandsRegistry.registerCommand(WORKSPACE_SNAPSHOT_COMMAND_ID, (_accessor, sessionId: string) =>
			raceTimeout(this.snapshot(sessionId, false), SNAPSHOT_BUDGET_MS)));
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
		const snapshot = await this.snapshot(this.runtime.chatFor(call.sessionId), true);
		return { text: formatWorkspaceStatus(snapshot) };
	}

	/** `detail`: terminal output and changed file names too (workspace_status). */
	async snapshot(sessionId: string, detail: boolean): Promise<IWorkspaceSnapshot> {
		const id = this.runtime.chatFor(sessionId);
		const root = this.folder(id);
		const panel = agentSessionToolTabs(id);
		const [tabs, git] = await Promise.all([
			Promise.all((panel?.tabs ?? []).map(tab => this.describe(tab.input, tab.focused, root, detail))),
			root ? this.git(root.fsPath, detail) : Promise.resolve(undefined),
		]);
		return {
			panelOpen: panel?.open ?? false,
			tabs: tabs.filter((tab): tab is IWorkspaceTab => !!tab),
			...(git ? { git } : {}),
		};
	}

	private folder(sessionId: string): URI | undefined {
		const worktree = this.history.get(sessionId)?.worktreePath;
		const folder = worktree ? URI.file(worktree) : this.sessionContext.rootFor(sessionId);
		return folder?.scheme === Schemas.file ? folder : undefined;
	}

	private async describe(input: EditorInput, focused: boolean, root: URI | undefined, detail: boolean): Promise<IWorkspaceTab | undefined> {
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
			};
			return { kind: 'device', title, focused, device: info };
		}
		if (input instanceof TerminalEditorInput) {
			const instance = input.terminalInstance;
			return { kind: 'terminal', title, focused, ...(instance && !instance.isDisposed ? { terminal: await this.terminal(instance, detail) } : {}) };
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

	private async terminal(instance: ITerminalInstance, detail: boolean): Promise<IWorkspaceTerminal> {
		const commands = instance.capabilities.get(TerminalCapability.CommandDetection);
		const running = commands?.executingCommand?.trim();
		const last = commands?.commands.at(-1);
		const cwd = instance.capabilities.get(TerminalCapability.CwdDetection)?.getCwd()
			?? await raceTimeout(instance.getSpeculativeCwd(), 300).catch(() => undefined);
		const output = detail ? terminalTail(instance, OUTPUT_LINES) : undefined;
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
