/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { voltExec } from '../../../../services/voltRuntime/common/execContext.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { INotebookEditorModelResolverService } from '../../../notebook/common/notebookEditorModelResolverService.js';
import { INotebookExecutionService } from '../../../notebook/common/notebookExecutionService.js';
import { INotebookExecutionStateService } from '../../../notebook/common/notebookExecutionStateService.js';
import { INotebookKernelService } from '../../../notebook/common/notebookKernelService.js';
import { IVoltHttpService } from '../../../voltHttp/browser/voltHttpService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { DEBUG_TOOL_NAME, IDE_TOOLS, TASKS_TOOL_NAME, TESTS_TOOL_NAME } from '../../../../services/voltRuntime/common/ide/ideTools.js';
import { IDE_CAPABILITIES, IDE_GATEWAY_TOOL_NAME, ideHelp, ideOp } from '../../../../services/voltRuntime/common/ide/ideCapabilities.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IDebugService, IDebugSession, REPL_VIEW_ID, State, VIEWLET_ID as DEBUG_VIEWLET_ID } from '../../../debug/common/debug.js';
import { Task } from '../../../tasks/common/tasks.js';
import { ITaskService } from '../../../tasks/common/taskService.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { Testing } from '../../../testing/common/constants.js';
import { ITestProfileService } from '../../../testing/common/testProfileService.js';
import { ITestResult, LiveTestResult } from '../../../testing/common/testResult.js';
import { ITestResultService } from '../../../testing/common/testResultService.js';
import { ITestService } from '../../../testing/common/testService.js';
import { TestResultState } from '../../../testing/common/testTypes.js';
import { IDebugArgs, IdeDebug } from './ideDebug.js';
import { IdeTasks } from './ideTasks.js';
import { IdeTests } from './ideTests.js';
import { IdeCli, IIdeCapability } from './capabilities/capability.js';
import { EditorCapability } from './capabilities/editorCapability.js';
import { GitCapability } from './capabilities/gitCapability.js';
import { CiCapability, DockerCapability, KubernetesCapability } from './capabilities/infraCapabilities.js';
import { NotebookCapability } from './capabilities/notebookCapability.js';
import { RemoteCapability } from './capabilities/remoteCapability.js';
import { AnalyzeCapability, CoverageCapability, ProfileCapability } from './capabilities/qualityCapabilities.js';
import { ExtensionsCapability, HttpCapability } from './capabilities/workbenchCapabilities.js';
import { VoltTestController } from './voltTestController.js';

/** Ops kept per chat and tab. */
const MAX_LOG_ENTRIES = 40;

/** Activities kept per chat once they end. */
const MAX_ENDED_PER_CHAT = 6;

export type AgentIdeActivityKind = 'tests' | 'debug' | 'task';
export type AgentIdeActivityState = 'running' | 'passed' | 'failed' | 'paused' | 'ended' | 'stopped';

/** Something an agent started in the IDE for a chat: a test run, a debug session, a task. */
export interface IAgentIdeActivity {
	readonly id: string;
	readonly chatId: string;
	readonly kind: AgentIdeActivityKind;
	readonly title: string;
	readonly state: AgentIdeActivityState;
	/** One line: "39 passed, 2 failed", "Paused at src/a.ts:12 (breakpoint)", "exit code 1". */
	readonly detail?: string;
	readonly startedAt: number;
	readonly endedAt?: number;
}

/** One op an agent ran through the IDE tools, as the capability's tab shows it. */
export interface IAgentIdeLogEntry {
	readonly id: string;
	readonly op: string;
	/** The arguments, one line. */
	readonly args: string;
	readonly at: number;
	readonly durationMs: number;
	readonly ok: boolean;
	readonly text: string;
}

/** The tab a tool call belongs to: tests, debug, tasks, or an `ide` capability. */
export type AgentIdeTabKey = string;

/** Opens a capability's tab beside the chat (registered by agentIdeActivityEditor.ts). */
export const OPEN_IDE_ACTIVITY_TAB_COMMAND_ID = 'volt.agentIde.openActivityTab';
export const IDE_AUTO_OPEN_SETTING = 'volt.agent.ide.autoOpenTabs';

export const IAgentIdeService = createDecorator<IAgentIdeService>('agentIdeService');

export interface IAgentIdeService {
	readonly _serviceBrand: undefined;
	/** A chat's activities changed (the chat id). */
	readonly onDidChange: Event<string>;
	list(chatId: string): readonly IAgentIdeActivity[];
	/** Every chat's activities, newest first (the Agent Sessions view). */
	listAll(): readonly IAgentIdeActivity[];
	/** Shows the activity where the IDE shows it: Test Results, Run and Debug, the task's terminal. */
	reveal(activityId: string): void;
	stop(activityId: string): void;
	/** Debug sessions: resume a paused one. Tests: rerun the failures. */
	primary(activityId: string): void;
	dismiss(activityId: string): void;
	/** A chat's log for one tab, oldest first. */
	log(chatId: string, key: AgentIdeTabKey): readonly IAgentIdeLogEntry[];
	readonly onDidLog: Event<{ readonly chatId: string; readonly key: AgentIdeTabKey }>;
}

interface IActivityEntry {
	view: IAgentIdeActivity;
	readonly store: DisposableStore;
	readonly result?: ITestResult;
	readonly session?: IDebugSession;
	readonly task?: Task;
	readonly sessionKey?: string;
}

/**
 * The IDE as agent tools (`tests`, `debug`, `tasks`; see `ideTools.ts`) and what they started, per
 * chat, for the card above the composer. The tools act on VS Code's own Testing, Debug and Tasks
 * services, so what the agent runs is what the Test Explorer, Run and Debug view and terminals show.
 */
export class AgentIdeService extends Disposable implements IAgentIdeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private readonly activities = new Map<string, IActivityEntry>();
	private readonly tests: IdeTests;
	private readonly debug: IdeDebug;
	private readonly tasks: IdeTasks;
	private readonly capabilities = new Map<string, IIdeCapability>();
	private readonly logs = new Map<string, IAgentIdeLogEntry[]>();
	private readonly _onDidLog = this._register(new Emitter<{ readonly chatId: string; readonly key: AgentIdeTabKey }>());
	readonly onDidLog = this._onDidLog.event;

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ITestService testService: ITestService,
		@ITestResultService testResults: ITestResultService,
		@ITestProfileService testProfiles: ITestProfileService,
		@IDebugService private readonly debugService: IDebugService,
		@ITaskService private readonly taskService: ITaskService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IFileService fileService: IFileService,
		@ICommandService private readonly commandService: ICommandService,
		@IViewsService private readonly viewsService: IViewsService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.tests = new IdeTests(testService, testResults, testProfiles);
		this.debug = new IdeDebug(debugService, fileService);
		this.tasks = new IdeTasks(taskService, terminalService);
		const editor = instantiationService.invokeFunction(accessor => new EditorCapability(accessor.get(IEditorService), accessor.get(ICodeEditorService), accessor.get(ITextFileService)));
		// Highlights point at code for the run that made them; they go when it ends.
		this._register(runtime.onDidEmit(envelope => {
			if (envelope.event.type === 'run.end') {
				editor.clearChat(runtime.chatFor(envelope.sessionId));
			}
		}));
		for (const capability of [
			editor,
			new GitCapability(fileService),
			instantiationService.invokeFunction(accessor => new NotebookCapability(accessor.get(INotebookEditorModelResolverService), accessor.get(INotebookKernelService), accessor.get(INotebookExecutionService), accessor.get(INotebookExecutionStateService), accessor.get(ITextModelService), fileService, accessor.get(IEditorService), accessor.get(IContextKeyService))),
			new DockerCapability(),
			new KubernetesCapability(),
			new CiCapability(),
			instantiationService.invokeFunction(accessor => new HttpCapability(accessor.get(IVoltHttpService))),
			instantiationService.invokeFunction(accessor => new ProfileCapability(fileService, accessor.get(IEnvironmentService), accessor.get(IEditorService))),
			instantiationService.invokeFunction(accessor => new AnalyzeCapability(fileService, accessor.get(IMarkerService))),
			new CoverageCapability(fileService),
			instantiationService.invokeFunction(accessor => new RemoteCapability(accessor.get(IWorkbenchEnvironmentService), fileService, accessor.get(IPathService))),
			instantiationService.invokeFunction(accessor => new ExtensionsCapability(accessor.get(IExtensionService), commandService)),
		]) {
			this.capabilities.set(capability.id, capability);
		}
		this._register(hostTools.registerToolProvider({
			tools: IDE_TOOLS,
			invoke: (name, args, call) => this.invokeLogged(name, args, call),
			// Some ops ask every time, whatever the access mode (cluster deletes, editor commands).
			needsApproval: async (name, args) => name === IDE_GATEWAY_TOOL_NAME ? ideOp(String(args.capability ?? ''), String(args.op ?? ''))?.confirm : undefined,
		}));
		this._register({ dispose: () => this.activities.forEach(entry => entry.store.dispose()) });
	}

	// --- Tools -------------------------------------------------------------------------------

	/** Runs a call, records it in the chat's tab for that capability, and opens the tab beside the chat. */
	private async invokeLogged(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const started = Date.now();
		const result = await this.invoke(name, args, call).catch((err): IVoltHostToolResult => ({ error: err instanceof Error ? err.message : String(err) }));
		const chatId = call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
		const key = name === IDE_GATEWAY_TOOL_NAME ? (typeof args.capability === 'string' ? args.capability : '') : name;
		const op = name === IDE_GATEWAY_TOOL_NAME ? String(args.op ?? '') : String(args.op ?? '');
		if (chatId && key && op && op !== 'help') {
			const opArgs = name === IDE_GATEWAY_TOOL_NAME ? (args.args as Record<string, unknown> | undefined) ?? {} : Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'op'));
			const entry: IAgentIdeLogEntry = { id: generateUuid(), op, args: summarizeArgs(opArgs), at: started, durationMs: Date.now() - started, ok: !result.error, text: result.error ?? result.text ?? '' };
			const logKey = `${chatId}\u0000${key}`;
			this.logs.set(logKey, [...(this.logs.get(logKey) ?? []), entry].slice(-MAX_LOG_ENTRIES));
			this._onDidLog.fire({ chatId, key });
			void this.commandService.executeCommand(OPEN_IDE_ACTIVITY_TAB_COMMAND_ID, { chatId, sessionId: call?.sessionId, root: (call?.cwd ? URI.file(call.cwd) : this.workspace.getWorkspace().folders[0]?.uri)?.toString(), key, op, args: opArgs }).catch(() => undefined);
		}
		return result;
	}

	log(chatId: string, key: AgentIdeTabKey): readonly IAgentIdeLogEntry[] {
		return this.logs.get(`${chatId}\u0000${key}`) ?? [];
	}

	private async invoke(name: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const root = call?.cwd ? URI.file(call.cwd) : this.workspace.getWorkspace().folders[0]?.uri;
		const chatId = call?.sessionId ? this.runtime.chatFor(call.sessionId) : undefined;
		// Per-chat state (the last run, the chat's debug sessions); outside agents share one slot.
		const key = chatId ?? call?.external?.grantId ?? 'external';
		const token = call?.token ?? CancellationToken.None;
		const op = typeof args.op === 'string' ? args.op : '';
		const toResult = (result: { readonly text: string; readonly isError?: boolean }): IVoltHostToolResult => result.isError ? { error: result.text } : { text: result.text };
		switch (name) {
			case TESTS_TOOL_NAME: {
				if (op === 'list') {
					return toResult(await this.tests.list(root, str(args.path), str(args.query)));
				}
				if (op === 'results') {
					return toResult(await this.tests.resultsFor(key, root, str(args.target)));
				}
				if (op === 'run') {
					const targets = Array.isArray(args.targets) ? args.targets.filter((item): item is string => typeof item === 'string') : typeof args.targets === 'string' ? [args.targets] : undefined;
					return toResult(await this.tests.run(key, root, { targets, failed: args.failed === true, coverage: args.coverage === true }, chatId ? { started: (result, title) => this.trackTests(chatId, key, result, title) } : undefined, token));
				}
				return { error: 'op must be list, run or results.' };
			}
			case DEBUG_TOOL_NAME:
				return toResult(await this.debug.invoke(key, root, args as unknown as IDebugArgs, chatId ? { started: (session, title) => this.trackDebug(chatId, session, title) } : undefined, token));
			case IDE_GATEWAY_TOOL_NAME:
				return this.invokeCapability(args, root, chatId, token);
			case TASKS_TOOL_NAME:
				return toResult(await this.tasks.invoke(root, op, str(args.name), num(args.wait_ms), chatId ? {
					started: (task, title) => this.trackTask(chatId, task, title),
					ended: (task, exitCode) => this.endTask(task, exitCode),
				} : undefined, token));
		}
		return { error: `Unknown tool ${name}.` };
	}

	private async invokeCapability(args: Record<string, unknown>, root: URI | undefined, chatId: string | undefined, token: CancellationToken): Promise<IVoltHostToolResult> {
		const id = typeof args.capability === 'string' ? args.capability : '';
		const op = typeof args.op === 'string' ? args.op : '';
		const capability = this.capabilities.get(id);
		if (!capability) {
			return { error: `capability must be one of ${IDE_CAPABILITIES.map(item => item.id).join(', ')}.` };
		}
		if (op === 'help' || !op) {
			return { text: ideHelp(id) ?? '' };
		}
		if (!ideOp(id, op)) {
			return { error: `${id} has no op "${op}".\n${ideHelp(id)}` };
		}
		const opArgs = args.args && typeof args.args === 'object' ? args.args as Record<string, unknown> : {};
		const result = await capability.invoke(op, opArgs, { root, chatId, token, cli: new IdeCli(this.stdio, root?.fsPath, chatId ? this.runtime.chatExec(chatId, 'agent-shell') : voltExec('agent-shell')) });
		return result.isError ? { error: result.text } : { text: result.text, ...(result.changes?.length ? { changes: result.changes } : {}) };
	}

	// --- Activities --------------------------------------------------------------------------

	private add(chatId: string, kind: AgentIdeActivityKind, title: string, extra: Partial<Pick<IActivityEntry, 'result' | 'session' | 'task' | 'sessionKey'>>): IActivityEntry {
		const entry: IActivityEntry = { view: { id: generateUuid(), chatId, kind, title, state: 'running', startedAt: Date.now() }, store: new DisposableStore(), ...extra };
		this.activities.set(entry.view.id, entry);
		this.prune(chatId);
		this._onDidChange.fire(chatId);
		return entry;
	}

	private update(entry: IActivityEntry, patch: Partial<Pick<IAgentIdeActivity, 'state' | 'detail'>>): void {
		const ended = patch.state && patch.state !== 'running' && patch.state !== 'paused';
		entry.view = { ...entry.view, ...patch, ...(ended && !entry.view.endedAt ? { endedAt: Date.now() } : {}) };
		this._onDidChange.fire(entry.view.chatId);
	}

	private trackTests(chatId: string, sessionKey: string, result: ITestResult, title: string): void {
		const entry = this.add(chatId, 'tests', title, { result, sessionKey });
		const refresh = () => {
			const counts = result.counts;
			const failed = counts[TestResultState.Failed] + counts[TestResultState.Errored];
			const detail = [
				counts[TestResultState.Passed] ? `${counts[TestResultState.Passed]} passed` : '',
				failed ? `${failed} failed` : '',
				counts[TestResultState.Skipped] ? `${counts[TestResultState.Skipped]} skipped` : '',
				counts[TestResultState.Running] + counts[TestResultState.Queued] ? `${counts[TestResultState.Running] + counts[TestResultState.Queued]} to go` : '',
			].filter(Boolean).join(' \u00b7 ');
			const state: AgentIdeActivityState = result.completedAt ? (failed ? 'failed' : 'passed') : 'running';
			this.update(entry, { state, ...(detail ? { detail } : {}) });
		};
		if (result instanceof LiveTestResult) {
			entry.store.add(result.onChange(refresh));
			entry.store.add(result.onComplete(refresh));
		}
		refresh();
	}

	private trackDebug(chatId: string, session: IDebugSession, title: string): void {
		const entry = this.add(chatId, 'debug', title, { session });
		const refresh = () => {
			const tree = this.debugService.getModel().getSessions().filter(candidate => rootOf(candidate) === session);
			if (!tree.length || tree.every(candidate => candidate.state === State.Inactive)) {
				this.update(entry, { state: 'ended', detail: 'Session ended' });
				return;
			}
			const paused = tree.find(candidate => candidate.state === State.Stopped);
			const thread = paused?.getAllThreads().find(item => item.stopped);
			const frame = thread?.getTopStackFrame();
			if (thread && frame) {
				const root = this.workspace.getWorkspace().folders[0]?.uri;
				const where = `${(root && relativePath(root, frame.source.uri)) || frame.source.name}:${frame.range.startLineNumber}`;
				this.update(entry, { state: 'paused', detail: `Paused at ${where}${thread.stoppedDetails?.reason ? ` (${thread.stoppedDetails.reason})` : ''}` });
			} else {
				this.update(entry, { state: 'running', detail: 'Running' });
			}
		};
		entry.store.add(this.debugService.onDidChangeState(refresh));
		entry.store.add(this.debugService.getModel().onDidChangeCallStack(refresh));
		entry.store.add(this.debugService.onDidEndSession(({ session: ended }) => {
			if (ended === session) {
				this.update(entry, { state: entry.view.state === 'stopped' ? 'stopped' : 'ended', detail: 'Session ended' });
				entry.store.clear();
			} else {
				refresh();
			}
		}));
		refresh();
	}

	private trackTask(chatId: string, task: Task, title: string): void {
		const same = [...this.activities.values()].find(entry => entry.task?.getMapKey() === task.getMapKey() && entry.view.chatId === chatId && entry.view.state === 'running');
		if (same) {
			return;
		}
		this.add(chatId, 'task', title, { task });
	}

	private endTask(task: Task, exitCode: number | undefined): void {
		for (const entry of this.activities.values()) {
			if (entry.task?.getMapKey() === task.getMapKey() && entry.view.state === 'running') {
				this.update(entry, { state: exitCode ? 'failed' : 'passed', detail: exitCode === undefined ? 'Finished' : `Exit code ${exitCode}` });
			}
		}
	}

	private prune(chatId: string): void {
		const ended = [...this.activities.values()].filter(entry => entry.view.chatId === chatId && entry.view.endedAt);
		for (const entry of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_PER_CHAT))) {
			entry.store.dispose();
			this.activities.delete(entry.view.id);
		}
	}

	list(chatId: string): readonly IAgentIdeActivity[] {
		return [...this.activities.values()].filter(entry => entry.view.chatId === chatId).map(entry => entry.view);
	}

	listAll(): readonly IAgentIdeActivity[] {
		return [...this.activities.values()].map(entry => entry.view).sort((a, b) => b.startedAt - a.startedAt);
	}

	reveal(activityId: string): void {
		const entry = this.activities.get(activityId);
		if (!entry) {
			return;
		}
		switch (entry.view.kind) {
			case 'tests':
				void this.viewsService.openViewContainer(Testing.ViewletId);
				void this.commandService.executeCommand('testing.showMostRecentOutput');
				break;
			case 'debug':
				void this.viewsService.openViewContainer(DEBUG_VIEWLET_ID);
				void this.viewsService.openView(REPL_VIEW_ID, false);
				break;
			case 'task': {
				const uri = entry.task && this.taskService.getTerminalsForTasks(entry.task)?.[0];
				const instance = uri && this.terminalService.getInstanceFromResource(uri);
				if (instance) {
					this.terminalService.setActiveInstance(instance);
					void this.terminalService.revealActiveTerminal();
				}
				break;
			}
		}
	}

	stop(activityId: string): void {
		const entry = this.activities.get(activityId);
		if (!entry) {
			return;
		}
		if (entry.session) {
			this.update(entry, { state: 'stopped' });
			void this.debugService.stopSession(entry.session);
		} else if (entry.task) {
			void this.taskService.terminate(entry.task).then(() => this.update(entry, { state: 'stopped', detail: 'Stopped' }));
		} else if (entry.result && !entry.result.completedAt) {
			void this.commandService.executeCommand('testing.cancelRun');
		}
	}

	primary(activityId: string): void {
		const entry = this.activities.get(activityId);
		if (!entry) {
			return;
		}
		if (entry.session) {
			const paused = this.debugService.getModel().getSessions().find(candidate => rootOf(candidate) === entry.session && candidate.state === State.Stopped);
			void paused?.getAllThreads().find(thread => thread.stopped)?.continue();
		} else if (entry.result && entry.sessionKey) {
			const root = this.workspace.getWorkspace().folders[0]?.uri;
			void this.tests.run(entry.sessionKey, root, { failed: true }, { started: (result, title) => this.trackTests(entry.view.chatId, entry.sessionKey!, result, title) }, CancellationToken.None);
		}
	}

	dismiss(activityId: string): void {
		const entry = this.activities.get(activityId);
		if (entry) {
			entry.store.dispose();
			this.activities.delete(activityId);
			this._onDidChange.fire(entry.view.chatId);
		}
	}
}

function rootOf(session: IDebugSession): IDebugSession {
	let current = session;
	while (current.parentSession) {
		current = current.parentSession;
	}
	return current;
}

function summarizeArgs(args: Record<string, unknown>): string {
	return Object.entries(args).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => `${key}=${typeof value === 'string' ? (value.length > 60 ? `${value.slice(0, 60)}\u2026` : value) : JSON.stringify(value)?.slice(0, 60)}`).join(' ');
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

registerSingleton(IAgentIdeService, AgentIdeService, InstantiationType.Delayed);

/** Creates the service (and so registers its tools) at startup, before any card asks for it. */
class AgentIdeContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltAgentIde';
	constructor(@IAgentIdeService _service: IAgentIdeService) { }
}

registerWorkbenchContribution2(AgentIdeContribution.ID, AgentIdeContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(VoltTestController.ID, VoltTestController, WorkbenchPhase.Eventually);
