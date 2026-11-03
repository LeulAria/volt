/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/path.js';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IShellLaunchConfig, TerminalExitReason, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { agentServerEnabled } from '../../../../services/voltAgentServer/common/agentServerClient.js';
import { IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { TERMINAL_TOOLS, VoltTerminalToolName } from '../../../../services/voltRuntime/common/terminalTools.js';
import {
	AGENT_TERMINAL_ENV, IAgentTerminalInfo, IAgentTerminalStart, IManagedTerminalBackend, IManagedTerminalExit, IManagedTerminalLaunch, IManagedTerminalProcess, ManagedTerminals, ManagedTerminalTools,
} from '../../../../services/voltRuntime/common/terminals/managedTerminals.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalInstanceService } from '../../../terminal/browser/terminal.js';
import { ITerminalProfileService } from '../../../terminal/common/terminal.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';

export { describeAgentTerminalStatus } from '../../../../services/voltRuntime/common/terminals/managedTerminals.js';
export type { IAgentTerminalInfo, IAgentTerminalStart } from '../../../../services/voltRuntime/common/terminals/managedTerminals.js';

export interface IAgentTerminalRevealRequest {
	readonly chatId: string;
	/** A Volt terminal. */
	readonly instance?: ITerminalInstance;
	/** An agent's background task: the file it writes its output to. */
	readonly file?: URI;
	readonly preserveFocus: boolean;
}

export const IAgentTerminalsService = createDecorator<IAgentTerminalsService>('agentTerminalsService');

/**
 * Long-running commands of a chat (dev servers, watchers, `docker compose up`) in real terminals.
 * The process runs in this window's pty host, or in the agent server when agents run there (they
 * then outlive the window, which shows them through a terminal attached to the server). Either way
 * the chat shows them as chips; while the chat has a Terminals tab its running terminals are
 * listed there (marked as the agent's); the tab itself opens only when the user asks (a chip
 * click), never on start.
 */
export interface IAgentTerminalsService {
	readonly _serviceBrand: undefined;
	/** A chat's terminals changed (fires with the chat id). */
	readonly onDidChange: Event<string>;
	/** Someone asked to see a terminal; the chat's editor opens it in its tools. */
	readonly onDidRequestReveal: Event<IAgentTerminalRevealRequest>;
	list(chatId: string): readonly IAgentTerminalInfo[];
	get(id: string): IAgentTerminalInfo | undefined;
	start(chatId: string, options: IAgentTerminalStart): Promise<IAgentTerminalInfo>;
	stop(id: string): Promise<void>;
	restart(id: string): Promise<IAgentTerminalInfo | undefined>;
	/** Forgets a finished terminal (its chip goes away). */
	dismiss(id: string): void;
	reveal(id: string, preserveFocus?: boolean): void;
	/** Plain-text output after `offset` (all of it kept when omitted). */
	output(id: string, offset?: number): { readonly text: string; readonly offset: number } | undefined;
	/** The managed terminal a terminal instance runs, if the agent started it. */
	forInstance(instance: ITerminalInstance): IAgentTerminalInfo | undefined;
	/** The terminal instance of a managed terminal, while it is open. */
	instanceOf(id: string): ITerminalInstance | undefined;
}

/** A terminal Volt's agent started, whether or not this service still tracks it. */
export function isAgentTerminal(instance: ITerminalInstance): boolean {
	return instance.shellLaunchConfig.env?.[AGENT_TERMINAL_ENV] === '1';
}

/** A managed terminal's process in one of this window's terminals. */
class WindowTerminalProcess implements IManagedTerminalProcess {

	readonly onData: Event<string>;
	readonly onExit: Event<IManagedTerminalExit>;
	readonly onClosed: Event<void>;
	readonly ready: Promise<void>;

	constructor(private readonly instance: ITerminalInstance) {
		// As data arrives from the process, before xterm parses it: no lag behind the pty, view or no view.
		this.onData = instance.onWillData;
		this.onExit = Event.map(instance.onExit, (code): IManagedTerminalExit => typeof code === 'object' && code
			? { code: code.code ?? 1, error: code.message }
			: { code: typeof code === 'number' ? code : instance.exitCode });
		this.onClosed = Event.map(instance.onDisposed, () => undefined);
		this.ready = instance.processReady;
	}

	get viewable(): boolean {
		return !this.instance.isDisposed;
	}

	sendText(text: string, enter: boolean): Promise<void> {
		return this.instance.isDisposed ? Promise.resolve() : this.instance.sendText(text, enter);
	}

	kill(): void {
		if (!this.instance.isDisposed) {
			this.instance.dispose(TerminalExitReason.Extension);
		}
	}
}

/** Starts managed terminals in this window's terminals: known to the terminal editors, not opened. */
class WindowTerminalBackend implements IManagedTerminalBackend {

	constructor(
		private readonly instanceService: ITerminalInstanceService,
		private readonly terminalEditorService: ITerminalEditorService,
		private readonly profileService: ITerminalProfileService,
		private readonly onInstance: (id: string, instance: ITerminalInstance) => void,
	) { }

	async spawn(launch: IManagedTerminalLaunch): Promise<IManagedTerminalProcess> {
		const shell = await this.shell();
		const config: IShellLaunchConfig = {
			name: launch.label,
			executable: shell.file,
			args: shell.args(launch.command),
			cwd: launch.cwd,
			env: { ...launch.env },
			// The tab keeps the last screen and exit status until the user closes it.
			waitOnExit: code => code
				? `\r\n\u001b[2m${localize('voltAgent.terminal.exitedCode', "{0} exited with code {1}", launch.label, code)}\u001b[0m`
				: `\r\n\u001b[2m${localize('voltAgent.terminal.finished', "{0} finished", launch.label)}\u001b[0m`,
			// Never revived on reload: that would run the command again.
			isTransient: true,
		};
		const instance = this.instanceService.createInstance(config, TerminalLocation.Editor);
		// Known to the terminal editors, so a chip click can open it, but not opened: no tab, no panel.
		this.terminalEditorService.resolveResource(instance);
		this.onInstance(launch.id, instance);
		return new WindowTerminalProcess(instance);
	}

	/** A POSIX shell for the agent's command lines; fish and friends fall back to zsh or bash. */
	private async shell(): Promise<{ file: string; args: (command: string) => string[] }> {
		if (isWindows) {
			return { file: 'cmd.exe', args: command => ['/d', '/s', '/c', command] };
		}
		if (this.profileService.availableProfiles.length === 0) {
			await Promise.race([this.profileService.profilesReady, new Promise(resolve => setTimeout(resolve, 500))]);
		}
		let path: string | undefined;
		try {
			path = this.profileService.getDefaultProfile()?.path;
		} catch {
			path = undefined;
		}
		const posix = path && /^(zsh|bash|sh|dash|ksh)$/.test(basename(path)) ? path : undefined;
		return { file: posix ?? (isMacintosh ? '/bin/zsh' : '/bin/bash'), args: command => ['-c', command] };
	}
}

export class AgentTerminalsService extends Disposable implements IAgentTerminalsService {

	declare readonly _serviceBrand: undefined;

	readonly core: ManagedTerminals;
	private readonly instances = new Map<string, ITerminalInstance>();
	readonly onDidChange: Event<string>;
	private readonly _onDidRequestReveal = this._register(new Emitter<IAgentTerminalRevealRequest>());
	readonly onDidRequestReveal: Event<IAgentTerminalRevealRequest> = this._onDidRequestReveal.event;

	constructor(
		@ITerminalInstanceService instanceService: ITerminalInstanceService,
		@ITerminalEditorService terminalEditorService: ITerminalEditorService,
		@ITerminalProfileService profileService: ITerminalProfileService,
		@IAgentWorkspaceService workspaceService: IAgentWorkspaceService,
		@IWorkspaceContextService workspaceContext: IWorkspaceContextService,
		@IAgentRuntimeService runtime: IAgentRuntimeService,
		@IFileService fileService: IFileService,
	) {
		super();
		const backend = new WindowTerminalBackend(instanceService, terminalEditorService, profileService, (id, instance) => this.instances.set(id, instance));
		this.core = this._register(new ManagedTerminals(backend, runtime, fileService, () => workspaceContext.getWorkspace().folders[0]?.uri.fsPath));
		this.onDidChange = this.core.onDidChange;
		this._register(this.core.onDidForget(terminal => this.instances.delete(terminal.id)));
		// A deleted chat takes its terminals with it.
		this._register(workspaceService.onDidChange(e => {
			if (e.slot === undefined && !workspaceService.get(e.sessionId)) {
				this.core.forgetChat(e.sessionId);
			}
		}));
	}

	list(chatId: string): readonly IAgentTerminalInfo[] {
		return this.core.list(chatId);
	}

	get(id: string): IAgentTerminalInfo | undefined {
		return this.core.get(id);
	}

	output(id: string, offset?: number): { readonly text: string; readonly offset: number } | undefined {
		return this.core.output(id, offset);
	}

	forInstance(instance: ITerminalInstance): IAgentTerminalInfo | undefined {
		for (const [id, candidate] of this.instances) {
			if (candidate === instance) {
				return this.core.get(id);
			}
		}
		return undefined;
	}

	instanceOf(id: string): ITerminalInstance | undefined {
		const instance = this.instances.get(id);
		return instance && !instance.isDisposed ? instance : undefined;
	}

	start(chatId: string, options: IAgentTerminalStart): Promise<IAgentTerminalInfo> {
		return this.core.start(chatId, options);
	}

	stop(id: string): Promise<void> {
		return this.core.stop(id);
	}

	restart(id: string): Promise<IAgentTerminalInfo | undefined> {
		return this.core.restart(id);
	}

	dismiss(id: string): void {
		this.core.dismiss(id);
	}

	reveal(id: string, preserveFocus = true): void {
		const terminal = this.core.managed(id);
		if (terminal?.task?.file) {
			this._onDidRequestReveal.fire({ chatId: terminal.chatId, file: terminal.task.file, preserveFocus });
			return;
		}
		const instance = this.instanceOf(id);
		if (terminal && instance) {
			this._onDidRequestReveal.fire({ chatId: terminal.chatId, instance, preserveFocus });
		}
	}
}

registerSingleton(IAgentTerminalsService, AgentTerminalsService, InstantiationType.Delayed);

/**
 * The terminal_* tools plus docker_ensure and app_open, for every agent of the window: CLI agents
 * get them over Volt's MCP server, Volt's own loop through its tool list. When agents run in the
 * agent server it serves these tools itself, with its own terminals, so they survive this window.
 */
class AgentTerminalTools extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentTerminals';

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IAgentTerminalsService service: IAgentTerminalsService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IVoltStdioService stdio: IVoltStdioService,
		@IFileService fileService: IFileService,
	) {
		super();
		if (agentServerEnabled(configurationService) || !(service instanceof AgentTerminalsService)) {
			return;
		}
		const tools = new ManagedTerminalTools(service.core, stdio, fileService);
		this._register(hostTools.registerToolProvider({
			tools: TERMINAL_TOOLS,
			invoke: (name, args, call) => tools.invoke(name as VoltTerminalToolName, args, call),
		}));
	}
}

registerWorkbenchContribution2(AgentTerminalTools.ID, AgentTerminalTools, WorkbenchPhase.AfterRestored);
