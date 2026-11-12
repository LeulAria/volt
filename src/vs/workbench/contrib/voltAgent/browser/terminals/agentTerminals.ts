/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/path.js';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
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
import { isTerminalLive, TERMINAL_TOOLS, VoltTerminalToolName } from '../../../../services/voltRuntime/common/terminalTools.js';
import {
	AGENT_TERMINAL_ENV, IAgentTerminalInfo, IAgentTerminalStart, IManagedTerminalBackend, IManagedTerminalExit, IManagedTerminalLaunch, IManagedTerminalProcess, ManagedTerminals, ManagedTerminalTools,
} from '../../../../services/voltRuntime/common/terminals/managedTerminals.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalInstanceService } from '../../../terminal/browser/terminal.js';
import { ITerminalProfileService } from '../../../terminal/common/terminal.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { createAgentTaskTerminal } from './agentTaskTerminal.js';

export { describeAgentTerminalStatus } from '../../../../services/voltRuntime/common/terminals/managedTerminals.js';
export type { IAgentTerminalInfo, IAgentTerminalStart } from '../../../../services/voltRuntime/common/terminals/managedTerminals.js';

export interface IAgentTerminalRevealRequest {
	readonly chatId: string;
	/** A Volt terminal, or the view of an agent's background task. */
	readonly instance: ITerminalInstance;
	readonly preserveFocus: boolean;
}

export const IAgentTerminalsService = createDecorator<IAgentTerminalsService>('agentTerminalsService');

/**
 * Long-running commands of a chat (dev servers, watchers, `docker compose up`) in real terminals.
 * The process runs in this window's pty host, or in the agent server when agents run there (they
 * then outlive the window, which shows them through a terminal attached to the server). Either way
 * the chat shows them as chips and lists them in its Terminals tab (marked as the agent's). A
 * terminal opens that tab once, when it starts; after the user closes the tab it opens again only
 * from a chip click or the next terminal. Closing it never stops the agent's terminals.
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

	constructor(
		private readonly instance: ITerminalInstance,
		/** A sandboxed terminal: confirms its sandbox from outside and resolves with the go line; `end` kills its whole sandbox. */
		private readonly sandbox?: { readonly confirm: (pid: number) => Promise<string>; readonly end: () => Promise<void> },
	) {
		// As data arrives from the process, before xterm parses it: no lag behind the pty, view or no view.
		this.onData = instance.onWillData;
		this.onExit = Event.map(instance.onExit, (code): IManagedTerminalExit => typeof code === 'object' && code
			? { code: code.code ?? 1, error: code.message }
			: { code: typeof code === 'number' ? code : instance.exitCode });
		this.onClosed = Event.map(instance.onDisposed, () => undefined);
		this.ready = sandbox ? this.confirmSandbox(sandbox) : instance.processReady;
		if (sandbox) {
			Event.once(instance.onExit)(() => void sandbox.end());
			Event.once(instance.onDisposed)(() => void sandbox.end());
		}
	}

	/** The shell starts only after the sandbox is confirmed: Volt types the go line, and nothing before it. */
	private async confirmSandbox(sandbox: { readonly confirm: (pid: number) => Promise<string>; readonly end: () => Promise<void> }): Promise<void> {
		await this.instance.processReady;
		const pid = this.instance.processId;
		if (!pid) {
			void sandbox.end();
			throw new Error('The terminal has no process to confirm its sandbox for.');
		}
		let go: string;
		try {
			go = await sandbox.confirm(pid);
		} catch (err) {
			this.kill();
			throw err;
		}
		this.confirmed = true;
		await this.instance.sendText(go, false);
	}

	private confirmed = false;

	get viewable(): boolean {
		return !this.instance.isDisposed;
	}

	sendText(text: string, enter: boolean): Promise<void> {
		if (this.sandbox && !this.confirmed) {
			// Nothing reaches a sandboxed terminal before its go line.
			return this.ready.then(() => this.sendText(text, enter), () => undefined);
		}
		return this.instance.isDisposed ? Promise.resolve() : this.instance.sendText(text, enter);
	}

	kill(): void {
		void this.sandbox?.end();
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
		private readonly stdio: IVoltStdioService,
	) { }

	async spawn(launch: IManagedTerminalLaunch): Promise<IManagedTerminalProcess> {
		const shell = await this.shell();
		if (launch.exec.sandbox) {
			return this.spawnSandboxed(shell.file, shell.args(launch.command), launch);
		}
		if (launch.exec.context.sandboxed) {
			// A sandboxed chat's terminal without its sandbox: refused, never started outside it.
			throw new Error(localize('voltAgent.terminal.noSandbox', "{0} was not started: this chat runs in Volt's sandbox, and the terminal came without it.", launch.label));
		}
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

	/**
	 * A sandboxed chat's terminal (spec F.6) in this window's pty host: the main process prepares
	 * the sandbox and the launcher that carries its control channels as FIFOs, the terminal starts
	 * that launcher with exactly the sandbox's environment, and the shell starts only once the main
	 * process confirmed the sandbox. Every failure refuses the terminal.
	 */
	private async spawnSandboxed(file: string, args: string[], launch: IManagedTerminalLaunch): Promise<IManagedTerminalProcess> {
		const stdio = this.stdio;
		if (isWindows || !stdio.prepareSandboxedTerminal || !stdio.confirmSandboxedTerminal || !stdio.endSandboxedTerminal) {
			throw new Error(localize('voltAgent.terminal.cannotSandbox', "{0} was not started: terminals cannot run in Volt's sandbox here.", launch.label));
		}
		const prepared = await stdio.prepareSandboxedTerminal({
			id: launch.id,
			file,
			args,
			cwd: launch.cwd,
			env: { ...launch.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
			sandbox: launch.exec.sandbox!,
			context: launch.exec.context,
		}).catch(err => {
			throw new Error(localize('voltAgent.terminal.sandboxRefused', "{0} was not started: {1}", launch.label, err instanceof Error ? err.message : String(err)));
		});
		const config: IShellLaunchConfig = {
			name: launch.label,
			executable: prepared.file,
			args: [...prepared.args],
			cwd: prepared.cwd,
			// The sandbox's environment and nothing else (plus the mark that makes it the agent's).
			env: { ...prepared.env, [AGENT_TERMINAL_ENV]: '1' },
			strictEnv: true,
			waitOnExit: code => code
				? `\r\n\u001b[2m${localize('voltAgent.terminal.exitedCode', "{0} exited with code {1}", launch.label, code)}\u001b[0m`
				: `\r\n\u001b[2m${localize('voltAgent.terminal.finished', "{0} finished", launch.label)}\u001b[0m`,
			isTransient: true,
		};
		let instance: ITerminalInstance;
		try {
			instance = this.instanceService.createInstance(config, TerminalLocation.Editor);
		} catch (err) {
			await stdio.endSandboxedTerminal(launch.id).catch(() => undefined);
			throw err;
		}
		this.terminalEditorService.resolveResource(instance);
		this.onInstance(launch.id, instance);
		return new WindowTerminalProcess(instance, {
			confirm: pid => stdio.confirmSandboxedTerminal!(launch.id, pid),
			end: () => stdio.endSandboxedTerminal!(launch.id).catch(() => undefined),
		});
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
	/** Terminals that already opened their chat's Terminals tab once. */
	private readonly shown = new Set<string>();
	readonly onDidChange: Event<string>;
	private readonly _onDidRequestReveal = this._register(new Emitter<IAgentTerminalRevealRequest>());
	readonly onDidRequestReveal: Event<IAgentTerminalRevealRequest> = this._onDidRequestReveal.event;

	constructor(
		@ITerminalInstanceService private readonly instanceService: ITerminalInstanceService,
		@ITerminalEditorService private readonly terminalEditorService: ITerminalEditorService,
		@ITerminalProfileService profileService: ITerminalProfileService,
		@IAgentWorkspaceService workspaceService: IAgentWorkspaceService,
		@IWorkspaceContextService workspaceContext: IWorkspaceContextService,
		@IAgentRuntimeService runtime: IAgentRuntimeService,
		@IFileService private readonly fileService: IFileService,
		@IVoltStdioService stdio: IVoltStdioService,
	) {
		super();
		const backend = new WindowTerminalBackend(instanceService, terminalEditorService, profileService, (id, instance) => this.instances.set(id, instance), stdio);
		this.core = this._register(new ManagedTerminals(backend, runtime, fileService, () => workspaceContext.getWorkspace().folders[0]?.uri.fsPath));
		this.onDidChange = this.core.onDidChange;
		this._register(this.core.onDidChange(chatId => this.showStarted(chatId)));
		this._register(this.core.onDidForget(terminal => {
			const instance = this.instances.get(terminal.id);
			this.instances.delete(terminal.id);
			this.shown.delete(terminal.id);
			// A background task's view goes with the task; a Volt terminal's tab closes on its own.
			if (terminal.task && instance && !instance.isDisposed) {
				instance.dispose();
			}
		}));
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

	/** A terminal that just started shows in its chat's Terminals tab, once it has something to show. */
	private showStarted(chatId: string): void {
		for (const info of this.core.list(chatId)) {
			if (this.shown.has(info.id) || !isTerminalLive(info.status) || (info.kind === 'agent-task' ? !info.outputFile : !this.instanceOf(info.id))) {
				continue;
			}
			this.shown.add(info.id);
			this.reveal(info.id, true);
		}
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
		const info = this.core.get(id);
		if (terminal?.task && info?.outputFile) {
			// A CLI agent's background command shows in the Terminals tab too, as a terminal that follows its output.
			let instance = this.instanceOf(id);
			if (!instance) {
				instance = createAgentTaskTerminal({ ...info, outputFile: info.outputFile }, () => this.core.get(id), this.instanceService, this.terminalEditorService, this.fileService);
				this.instances.set(id, instance);
			}
			this._onDidRequestReveal.fire({ chatId: terminal.chatId, instance, preserveFocus });
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
