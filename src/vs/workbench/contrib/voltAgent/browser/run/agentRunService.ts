/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../../base/browser/window.js';
import { IntervalTimer, RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { isLinux, isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { basename, isEqual, joinPath } from '../../../../../base/common/resources.js';
import { removeAnsiEscapeCodes } from '../../../../../base/common/strings.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ICommandDetectionCapability, TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { IVoltDevice } from '../../../../../platform/voltDevices/common/voltDevices.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { resolveRunModelRef } from '../../../../services/voltRuntime/common/models/modelAccess.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { IDebugService, ILaunch, State } from '../../../debug/common/debug.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { AGENT_RUN_SHOW_IN_VOLT_SETTING } from '../../common/agentRunSettings.js';
import { agentRunPrompt, AgentRunDeviceKind, detectRunScripts, findLocalUrl, IAgentRunDevice, IAgentRunScript, RUN_DESCRIPTION_SEPARATOR, runCommandFor, runOpensBrowser } from '../../common/agentRunTargets.js';
import { IAgentDevicesService, IDeviceTarget } from '../devices/agentDevicesService.js';
import { OPEN_BROWSER_COMMAND_ID } from '../preview/browserEditorInput.js';
import { IAgentWorkspaceService } from '../workspace/agentWorkspace.js';
import { OPEN_DEVICE_PREVIEW_COMMAND_ID } from '../workspace/agentSurfaceMenu.js';

/** Run with the chat's picked runner (the side toolbar's Run row). */
export const AGENT_RUN_START_COMMAND_ID = 'volt.agent.run.start';

/** The runner and device picked per project, by project folder. */
const CHOICES_KEY = 'volt.agent.run.choices';
/** How often booted devices are read while something may start one. */
const DEVICE_WATCH_MS = 4000;
/** A Volt-started simulator or emulator gets this long to boot. */
const DEVICE_BOOT_MS = 180_000;
/** Debug types that run mobile apps: their sessions show the booted device inside Volt. */
const MOBILE_DEBUG_TYPES = new Set(['dart', 'flutter', 'reactnative', 'reactnativedirect', 'expo']);

export const IAgentRunService = createDecorator<IAgentRunService>('agentRunService');

/** Where a chat runs its project: the project (whose picks it uses) and the checkout it runs in. */
export interface IAgentRunTarget {
	readonly project: URI;
	/** The chat's worktree, else the project. */
	readonly cwd: URI;
	readonly sessionId?: string;
}

/** Something the Run row can start: a detected script, a launch.json configuration or a recent debugger configuration. */
export interface IAgentRunner {
	/** `script:<id>`, `launch:<launch uri>#<name>` or `dynamic:<type>#<name>`. */
	readonly key: string;
	readonly label: string;
	readonly description?: string;
	readonly script?: IAgentRunScript;
	readonly launch?: ILaunch;
	readonly dynamicType?: string;
}

export interface IAgentRunDeviceChoice {
	/** The device service's key for a simulator or emulator, else `browser` or `desktop`. */
	readonly key: string;
	readonly kind: AgentRunDeviceKind;
	readonly label: string;
}

/** A script running in its terminal. */
export interface IAgentActiveRun {
	readonly project: URI;
	readonly label: string;
	readonly script: IAgentRunScript;
	readonly device: IAgentRunDevice | undefined;
	readonly terminal: ITerminalInstance;
	/** The local address it serves, once it printed one. */
	readonly url: string | undefined;
	/** The command finished (the terminal stays, with its output). */
	readonly ended: boolean;
}

export interface IAgentRunView {
	readonly target: IAgentRunTarget;
	/** The picked runner, else the first one found. */
	readonly runner: IAgentRunner | undefined;
	readonly runners: readonly IAgentRunner[];
	/** The runner runs on simulators, emulators or the desktop, so the device row shows. */
	readonly usesDevice: boolean;
	readonly device: IAgentRunDeviceChoice | undefined;
	readonly run: IAgentActiveRun | undefined;
}

export interface IAgentRunService {
	readonly _serviceBrand: undefined;
	/** Picks, detected runners, runs or debug sessions changed. */
	readonly onDidChange: Event<void>;
	targetFor(sessionId: string | undefined): IAgentRunTarget | undefined;
	view(target: IAgentRunTarget): Promise<IAgentRunView>;
	/** Runs the picked runner, asking for a runner or a device first when there is none. */
	start(target: IAgentRunTarget): Promise<void>;
	/** VS Code's "Select and Start Debugging", with "Let Agent Debug and Run the App" first. */
	pickRunner(target: IAgentRunTarget): Promise<void>;
	/** Flutter's "Select a device to use": booted devices, Volt's browser, the desktop, then offline emulators. */
	pickDevice(target: IAgentRunTarget): Promise<IAgentRunDeviceChoice | undefined>;
	/** Sends the chat's agent off to find how the project runs and run it (the chat shows a chip). */
	askAgent(target: IAgentRunTarget): Promise<void>;
	/** The run the toolbar controls: this project's, else the latest still running. */
	activeRun(project?: URI): IAgentActiveRun | undefined;
	stop(run: IAgentActiveRun): void;
	restart(run: IAgentActiveRun): Promise<void>;
	/** Flutter's `r` (hot reload) or `R` (hot restart) in the run's terminal. */
	hotReload(run: IAgentActiveRun, restart: boolean): void;
	showOutput(run: IAgentActiveRun): void;
	readonly debugging: boolean;
}

interface IChoice {
	runner?: string;
	device?: string;
}

interface IRunState {
	project: URI;
	label: string;
	script: IAgentRunScript;
	device: IAgentRunDevice | undefined;
	terminal: ITerminalInstance;
	url: string | undefined;
	ended: boolean;
	target: IAgentRunTarget;
	readonly store: DisposableStore;
}

type LauncherPick = IQuickPickItem & {
	run: () => Promise<void> | void;
};

type DevicePick = IQuickPickItem & {
	choice: IAgentRunDeviceChoice;
	offline?: IDeviceTarget;
};

export class AgentRunService extends Disposable implements IAgentRunService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly runs = new Map<string, IRunState>();
	/** Detected scripts per checkout, read again when its project files change. */
	private readonly scriptCache = new Map<string, Promise<IAgentRunScript[]>>();
	private readonly devices: IAgentDevicesService | undefined;
	private readonly deviceWatch = this._register(new MutableDisposable());
	private watchedBooted: Set<string> | undefined;
	/** Projects whose runners show devices, to watch for a simulator an agent starts from its shell. */
	private readonly mobileProjects = new Set<string>();
	private readonly syncWatchSoon = this._register(new RunOnceScheduler(() => this.syncDeviceWatch(), 200));

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@IProgressService private readonly progressService: IProgressService,
		@IDebugService private readonly debugService: IDebugService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentWorkspaceService private readonly workspaceService: IAgentWorkspaceService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.devices = instantiationService.invokeFunction(accessor => accessor.getIfExists(IAgentDevicesService));
		this._register(this.fileService.onDidFilesChange(e => {
			for (const key of [...this.scriptCache.keys()]) {
				const folder = URI.parse(key);
				if (['package.json', 'pubspec.yaml', 'app.json', 'manage.py', 'go.mod', 'Cargo.toml'].some(name => e.contains(joinPath(folder, name)))) {
					this.scriptCache.delete(key);
					this._onDidChange.fire();
				}
			}
		}));
		const configManager = this.debugService.getConfigurationManager();
		this._register(configManager.onDidSelectConfiguration(() => this._onDidChange.fire()));
		this._register(configManager.onDidChangeConfigurationProviders(() => this._onDidChange.fire()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('launch')) {
				this._onDidChange.fire();
			}
			if (e.affectsConfiguration(AGENT_RUN_SHOW_IN_VOLT_SETTING)) {
				this.syncWatchSoon.schedule();
			}
		}));
		this._register(this.debugService.onDidChangeState(() => {
			this._onDidChange.fire();
			this.syncWatchSoon.schedule();
		}));
		this._register(this.debugService.onDidNewSession(session => {
			if (MOBILE_DEBUG_TYPES.has(session.configuration.type)) {
				void this.showBootedDevice();
			}
		}));
		this._register(this.orchestrator.onDidChange(() => this.syncWatchSoon.schedule()));
		if (this.devices) {
			// An agent started a device or an app on it with the device tools: show it beside the chat.
			this._register(this.devices.onDidAct(activity => {
				if (activity.by === 'agent' && activity.action && this.showsInVolt()) {
					this.showDevice(activity.key);
				}
			}));
		}
		this._register({
			dispose: () => {
				for (const run of this.runs.values()) {
					run.store.dispose();
				}
				this.runs.clear();
			}
		});
	}

	get debugging(): boolean {
		return this.debugService.state !== State.Inactive;
	}

	targetFor(sessionId: string | undefined): IAgentRunTarget | undefined {
		const meta = sessionId ? this.history.get(sessionId) : undefined;
		const project = (sessionId ? this.sessionContext.rootFor(sessionId) : undefined)
			?? (meta?.workspaceFolder ? uriFromStoredRoot(meta.workspaceFolder) : undefined)
			?? this.sessionContext.activeProject?.root
			?? this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!project) {
			return undefined;
		}
		const cwd = meta?.worktreePath ? URI.file(meta.worktreePath) : project;
		return { project, cwd, sessionId };
	}

	//#region View

	async view(target: IAgentRunTarget): Promise<IAgentRunView> {
		const runners = await this.runners(target);
		const choice = this.choice(target.project);
		const runner = runners.find(candidate => candidate.key === choice.runner) ?? runners[0];
		// Debug configurations pick their device themselves (the Flutter extension's device item).
		const usesDevice = !!runner?.script && runner.script.devices.some(kind => kind !== 'browser');
		if (usesDevice) {
			this.mobileProjects.add(target.project.toString());
		} else {
			this.mobileProjects.delete(target.project.toString());
		}
		const device = usesDevice && runner.script ? this.deviceChoice(choice.device, runner.script) : undefined;
		return { target, runner, runners, usesDevice, device, run: this.publicRun(this.runs.get(target.project.toString())) };
	}

	private async runners(target: IAgentRunTarget): Promise<IAgentRunner[]> {
		const scripts = await this.scripts(target.cwd);
		const runners: IAgentRunner[] = scripts.map(script => ({ key: `script:${script.id}`, label: script.label, description: script.description, script }));
		const configManager = this.debugService.getConfigurationManager();
		const configs = configManager.getAllConfigurations();
		// The chat's project's launch.json; every folder's when none is the project.
		const own = configs.filter(config => config.launch.workspace && isEqual(config.launch.workspace.uri, target.project));
		for (const config of own.length ? own : configs) {
			if (config.presentation?.hidden) {
				continue;
			}
			runners.push({ key: `launch:${config.launch.uri.toString()}#${config.name}`, label: config.name, description: localize('agentRun.launchJson', "launch.json"), launch: config.launch });
		}
		const adapters = this.debugService.getAdapterManager();
		for (const recent of configManager.getRecentDynamicConfigurations()) {
			runners.push({ key: `dynamic:${recent.type}#${recent.name}`, label: recent.name, description: adapters.getDebuggerLabel(recent.type) ?? recent.type, dynamicType: recent.type });
		}
		return runners;
	}

	private scripts(cwd: URI): Promise<IAgentRunScript[]> {
		const key = cwd.toString();
		let cached = this.scriptCache.get(key);
		if (!cached) {
			cached = this.readScripts(cwd);
			this.scriptCache.set(key, cached);
		}
		return cached;
	}

	private async readScripts(cwd: URI): Promise<IAgentRunScript[]> {
		try {
			const stat = await this.fileService.resolve(cwd);
			const names = new Set((stat.children ?? []).map(child => child.name));
			const read = async (name: string) => names.has(name) ? (await this.fileService.readFile(joinPath(cwd, name))).value.toString() : undefined;
			const [packageJson, pubspec] = await Promise.all([read('package.json'), read('pubspec.yaml')]);
			return detectRunScripts({ names, packageJson, pubspec, platform: isMacintosh ? 'mac' : isWindows ? 'windows' : 'linux' });
		} catch {
			return [];
		}
	}

	private deviceChoice(key: string | undefined, script: IAgentRunScript): IAgentRunDeviceChoice | undefined {
		if (!key) {
			return undefined;
		}
		if (key === 'browser' || key === 'desktop') {
			return script.devices.includes(key) ? this.fixedChoice(key) : undefined;
		}
		const target = this.devices?.find(key);
		if (target && script.devices.includes(target.device.platform)) {
			return { key, kind: target.device.platform, label: target.device.name };
		}
		// Not listed yet (the device list loads lazily): keep the pick, named from its key.
		if (!target && this.devices && !this.devices.cached().length) {
			const platform = key.split('/')[1];
			if (platform === 'ios' || platform === 'android') {
				return { key, kind: platform, label: key.split('/').slice(2).join('/') };
			}
		}
		return undefined;
	}

	private fixedChoice(kind: 'browser' | 'desktop'): IAgentRunDeviceChoice {
		return kind === 'browser'
			? { key: 'browser', kind, label: localize('agentRun.voltBrowser', "Volt Browser") }
			: { key: 'desktop', kind, label: desktopName() };
	}

	private choice(project: URI): IChoice {
		return this.readChoices()[project.toString()] ?? {};
	}

	private setChoice(project: URI, change: IChoice): void {
		const all = this.readChoices();
		all[project.toString()] = { ...all[project.toString()], ...change };
		this.storageService.store(CHOICES_KEY, JSON.stringify(all), StorageScope.PROFILE, StorageTarget.USER);
		this._onDidChange.fire();
	}

	private readChoices(): Record<string, IChoice> {
		try {
			const parsed: unknown = JSON.parse(this.storageService.get(CHOICES_KEY, StorageScope.PROFILE, '{}'));
			return parsed && typeof parsed === 'object' ? parsed as Record<string, IChoice> : {};
		} catch {
			return {};
		}
	}

	//#endregion

	//#region Start

	async start(target: IAgentRunTarget): Promise<void> {
		const view = await this.view(target);
		if (!view.runner) {
			return this.pickRunner(target);
		}
		return this.startRunner(target, view.runner, view.device);
	}

	private async startRunner(target: IAgentRunTarget, runner: IAgentRunner, device: IAgentRunDeviceChoice | undefined): Promise<void> {
		this.setChoice(target.project, { runner: runner.key });
		if (runner.script) {
			return this.startScript(target, runner.script, device);
		}
		const configManager = this.debugService.getConfigurationManager();
		if (runner.launch) {
			await configManager.selectConfiguration(runner.launch, runner.label);
			await this.debugService.startDebugging(runner.launch, undefined, { startedByUser: true });
			return;
		}
		if (runner.dynamicType) {
			await configManager.selectConfiguration(undefined, runner.label, undefined, { type: runner.dynamicType });
			const { launch, getConfig } = configManager.selectedConfiguration;
			const config = await getConfig();
			if (config) {
				await this.debugService.startDebugging(launch, config, { startedByUser: true });
			}
		}
	}

	private async startScript(target: IAgentRunTarget, script: IAgentRunScript, picked: IAgentRunDeviceChoice | undefined): Promise<void> {
		let device: IAgentRunDevice | undefined;
		if (script.devices.length) {
			let choice = picked;
			if (!choice && script.devices[0] === 'browser') {
				choice = this.fixedChoice('browser');
			}
			if (!choice) {
				// Like Flutter's "No Device": pick one first.
				choice = await this.pickDevice(target, script);
				if (!choice) {
					return;
				}
			}
			device = await this.prepareDevice(choice);
			if (!device) {
				return;
			}
		}
		const key = target.project.toString();
		const previous = this.runs.get(key);
		const command = runCommandFor(script, device);
		// The last run's terminal runs it again once its command is over; a live one is stopped first.
		let terminal: ITerminalInstance;
		if (previous && previous.ended && !previous.terminal.isDisposed) {
			previous.store.dispose();
			terminal = previous.terminal;
		} else {
			if (previous) {
				this.stopState(previous);
			}
			terminal = await this.terminalService.createTerminal({
				cwd: target.cwd,
				config: { name: localize('agentRun.terminalName', "Run: {0}", script.label), icon: Codicon.play },
			});
		}
		const state: IRunState = { project: target.project, label: script.label, script, device, terminal, url: undefined, ended: false, target, store: new DisposableStore() };
		this.runs.set(key, state);
		this.watchRun(state, runOpensBrowser(script, device));
		this.terminalService.setActiveInstance(terminal);
		void this.terminalService.revealTerminal(terminal, true);
		void terminal.sendText(command, true);
		this._onDidChange.fire();
		this.syncWatchSoon.schedule();
	}

	private watchRun(state: IRunState, opensBrowser: boolean): void {
		const { terminal, store } = state;
		store.add(terminal.onDisposed(() => {
			if (this.runs.get(state.project.toString()) === state) {
				this.runs.delete(state.project.toString());
			}
			store.dispose();
			this._onDidChange.fire();
			this.syncWatchSoon.schedule();
		}));
		// Shell integration says when the command is over; without it the run lasts as long as its terminal.
		const watchCommands = (detection: ICommandDetectionCapability) => store.add(detection.onCommandFinished(() => {
			if (!state.ended) {
				state.ended = true;
				this._onDidChange.fire();
				this.syncWatchSoon.schedule();
			}
		}));
		const detection = terminal.capabilities.get(TerminalCapability.CommandDetection);
		if (detection) {
			watchCommands(detection);
		} else {
			store.add(terminal.capabilities.onDidAddCapability(e => {
				if (e.id === TerminalCapability.CommandDetection) {
					watchCommands(e.capability as ICommandDetectionCapability);
				}
			}));
		}
		if (!opensBrowser) {
			return;
		}
		let buffer = '';
		store.add(terminal.onData(data => {
			if (state.url || state.ended) {
				return;
			}
			buffer = (buffer + data).slice(-8000);
			const url = findLocalUrl(removeAnsiEscapeCodes(buffer));
			if (url) {
				state.url = url;
				if (this.showsInVolt()) {
					void this.commandService.executeCommand(OPEN_BROWSER_COMMAND_ID, url);
				}
				this._onDidChange.fire();
			}
		}));
	}

	/** Boots a simulator or emulator inside Volt (its screen comes up in the device panel) and says how the runner names it. */
	private async prepareDevice(choice: IAgentRunDeviceChoice): Promise<IAgentRunDevice | undefined> {
		if (choice.kind === 'browser') {
			return { kind: 'browser', name: choice.label };
		}
		if (choice.kind === 'desktop') {
			return { kind: 'desktop', id: isMacintosh ? 'macos' : isWindows ? 'windows' : isLinux ? 'linux' : undefined, name: choice.label };
		}
		const devices = this.devices;
		if (!devices) {
			return undefined;
		}
		let target = devices.find(choice.key);
		if (!target) {
			await devices.list(true);
			target = devices.find(choice.key);
		}
		if (!target) {
			this.notificationService.warn(localize('agentRun.deviceGone', "{0} is no longer available. Pick another device.", choice.label));
			return undefined;
		}
		this.showDevice(choice.key);
		if (target.device.state !== 'booted') {
			const found = target;
			const state = await this.progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('agentRun.booting', "Starting {0}", found.device.name),
			}, () => devices.boot(found, DEVICE_BOOT_MS));
			if (state !== 'booted') {
				this.notificationService.warn(localize('agentRun.bootSlow', "{0} is still starting. Run again once it is up.", found.device.name));
				return undefined;
			}
			await devices.list(true);
			target = devices.find(choice.key) ?? found;
		}
		return { kind: target.device.platform, id: runnerDeviceId(target.device), name: target.device.name };
	}

	//#endregion

	//#region Pickers

	async pickRunner(target: IAgentRunTarget): Promise<void> {
		const view = await this.view(target);
		const items: Array<LauncherPick | IQuickPickSeparator> = [];
		items.push({
			label: `$(${Codicon.robot.id}) ${localize('agentRun.askAgent', "Let Agent Debug and Run the App")}`,
			description: localize('agentRun.askAgentDesc', "The agent finds how it runs, starts it inside Volt and fixes what stops it"),
			run: () => this.askAgent(target),
		});
		const scripts = view.runners.filter(runner => runner.script);
		const launches = view.runners.filter(runner => runner.launch);
		const recent = view.runners.filter(runner => runner.dynamicType);
		const current = view.runner?.key;
		const runnerPick = (runner: IAgentRunner, icon: ThemeIcon): LauncherPick => ({
			label: `$(${icon.id}) ${runner.label}`,
			description: runner.description,
			run: () => this.startRunner(target, runner, runner.key === current ? view.device : undefined),
		});
		if (scripts.length) {
			items.push({ type: 'separator', label: localize('agentRun.detected', "Detected") });
			items.push(...scripts.map(runner => runnerPick(runner, Codicon.play)));
		}
		if (launches.length) {
			items.push({ type: 'separator', label: localize('agentRun.launchJson', "launch.json") });
			items.push(...launches.map(runner => runnerPick(runner, Codicon.debugAlt)));
		}
		if (recent.length) {
			items.push({ type: 'separator', label: localize('agentRun.recent', "Recent") });
			items.push(...recent.map(runner => runnerPick(runner, Codicon.debugAlt)));
		}
		const adapters = this.debugService.getAdapterManager();
		if (adapters.hasEnabledDebuggers()) {
			const configManager = this.debugService.getConfigurationManager();
			const providers = await configManager.getDynamicProviders();
			if (providers.length) {
				items.push({ type: 'separator', label: localize('agentRun.debuggers', "Debuggers") });
				for (const provider of providers) {
					items.push({
						label: `$(${Codicon.folder.id}) ${provider.label}`,
						description: localize('agentRun.moreConfigs', "Pick a configuration"),
						run: async () => {
							const pick = await provider.pick();
							if (!pick) {
								return;
							}
							await configManager.selectConfiguration(pick.launch, pick.config.name, pick.config, { type: provider.type });
							this.setChoice(target.project, { runner: `dynamic:${provider.type}#${pick.config.name}` });
							await this.debugService.startDebugging(pick.launch, pick.config, { startedByUser: true });
						},
					});
				}
			}
			const launch = configManager.getLaunches().find(candidate => !candidate.hidden && candidate.workspace && isEqual(candidate.workspace.uri, target.project))
				?? configManager.getLaunches().find(candidate => !candidate.hidden);
			if (launch) {
				items.push({ type: 'separator' });
				items.push({
					label: `$(${Codicon.add.id}) ${localize('agentRun.addConfiguration', "Add Configuration")}`,
					description: localize('agentRun.addConfigurationDesc', "Write a launch.json entry"),
					run: () => this.commandService.executeCommand('debug.addConfiguration', launch.uri.toString()),
				});
			}
		}
		const activeItem = items.find((item): item is LauncherPick => item.type !== 'separator' && 'run' in item && view.runner !== undefined && item.label.endsWith(` ${view.runner.label}`));
		const picked = await this.quickInputService.pick(items, {
			placeHolder: localize('agentRun.pickRunner', "Select how to run {0}", basename(target.project)),
			matchOnDescription: true,
			activeItem,
		});
		await picked?.run();
	}

	async pickDevice(target: IAgentRunTarget, forScript?: IAgentRunScript): Promise<IAgentRunDeviceChoice | undefined> {
		const script = forScript ?? (await this.view(target)).runner?.script;
		if (!script) {
			return undefined;
		}
		const kinds = new Set(script.devices);
		const available: DevicePick[] = [];
		const offline: DevicePick[] = [];
		const lists = this.devices ? await this.devices.list(true) : [];
		for (const entry of lists) {
			for (const device of entry.devices) {
				if (!kinds.has(device.platform) || device.kind === 'physical' && device.state !== 'booted') {
					continue;
				}
				const key = this.devices!.keyOf({ host: entry.host, device });
				const choice: IAgentRunDeviceChoice = { key, kind: device.platform, label: device.name };
				const where = entry.host.id === 'local' ? '' : `${RUN_DESCRIPTION_SEPARATOR}${entry.host.label}`;
				if (device.state === 'booted') {
					available.push({ label: `$(${Codicon.deviceMobile.id}) ${device.name}`, description: `${deviceKindLabel(device)}${where}`, choice });
				} else if (device.state === 'shutdown') {
					offline.push({ label: `$(${Codicon.play.id}) ${localize('agentRun.startDevice', "Start {0}", device.name)}`, description: `${deviceKindLabel(device)}${where}`, choice, offline: { host: entry.host, device } });
				}
			}
		}
		if (kinds.has('browser')) {
			available.push({ label: `$(${Codicon.globe.id}) ${localize('agentRun.voltBrowser', "Volt Browser")}`, description: localize('agentRun.web', "web"), choice: this.fixedChoice('browser') });
		}
		if (kinds.has('desktop')) {
			available.push({ label: `$(${Codicon.deviceDesktop.id}) ${desktopName()}`, description: localize('agentRun.desktop', "desktop"), choice: this.fixedChoice('desktop') });
		}
		const items: Array<DevicePick | IQuickPickSeparator> = [];
		if (available.length) {
			items.push({ type: 'separator', label: localize('agentRun.availableDevices', "Available Devices") }, ...available);
		}
		if (offline.length) {
			items.push({ type: 'separator', label: localize('agentRun.offlineEmulators', "Offline Emulators") }, ...offline);
		}
		if (!items.length) {
			this.notificationService.info(localize('agentRun.noDevices', "No simulators or emulators found. Install Xcode's iOS Simulator or Android Studio's emulator, or ask the agent to set one up."));
			return undefined;
		}
		const current = this.choice(target.project).device;
		const picked = await this.quickInputService.pick(items, {
			placeHolder: localize('agentRun.pickDevice', "Select a device to use"),
			matchOnDescription: true,
			activeItem: items.find((item): item is DevicePick => item.type !== 'separator' && (item as DevicePick).choice.key === current),
		});
		if (!picked) {
			return undefined;
		}
		this.setChoice(target.project, { device: picked.choice.key });
		if (picked.offline) {
			// Starts now, inside Volt, while the run gets ready.
			this.showDevice(picked.choice.key);
		}
		return picked.choice;
	}

	//#endregion

	//#region Agent

	async askAgent(target: IAgentRunTarget): Promise<void> {
		const sessionId = target.sessionId ?? this.workspaceService.active?.sessionId;
		if (!sessionId) {
			this.notificationService.info(localize('agentRun.noChat', "Open a chat to let the agent run the project."));
			return;
		}
		const view = await this.view(target);
		const text = agentRunPrompt({
			folder: target.cwd.fsPath,
			device: view.usesDevice ? view.device?.label : undefined,
			runners: view.runners.map(runner => runner.script ? runner.script.command : runner.label),
		});
		// The chat shows a chip for the button, not the prompt; its hover has the prompt.
		const label = localize('agentRun.chip', "Debug and Run the App");
		const display = { text: label, mentions: [{ kind: 'action', label, value: text }] };
		const modelRef = resolveRunModelRef({
			chat: this.orchestrator.getThread(sessionId)?.modelRef,
			lastUsed: this.runtime.getActiveCatalogRef(),
		}, this.runtime.listCatalog());
		try {
			await this.orchestrator.submit(sessionId, { text, display, ...(modelRef ? { modelRef } : {}) }, 'auto');
		} catch (err) {
			this.notificationService.error(localize('agentRun.askFailed', "Could not ask the agent: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	//#endregion

	//#region Runs

	activeRun(project?: URI): IAgentActiveRun | undefined {
		const own = project ? this.runs.get(project.toString()) : undefined;
		if (own && !own.ended) {
			return this.publicRun(own);
		}
		const live = [...this.runs.values()].filter(run => !run.ended);
		return this.publicRun(live[live.length - 1]);
	}

	stop(run: IAgentActiveRun): void {
		const state = this.runs.get(run.project.toString());
		if (state) {
			this.stopState(state);
		}
	}

	async restart(run: IAgentActiveRun): Promise<void> {
		const state = this.runs.get(run.project.toString());
		if (!state) {
			return;
		}
		const target = state.target;
		const choice = this.choice(target.project).device;
		this.stopState(state);
		await this.startScript(target, state.script, choice ? this.deviceChoice(choice, state.script) : undefined);
	}

	hotReload(run: IAgentActiveRun, restart: boolean): void {
		void run.terminal.sendText(restart ? 'R' : 'r', false);
	}

	showOutput(run: IAgentActiveRun): void {
		this.terminalService.setActiveInstance(run.terminal);
		void this.terminalService.revealTerminal(run.terminal);
	}

	private stopState(state: IRunState): void {
		this.runs.delete(state.project.toString());
		state.store.dispose();
		state.terminal.dispose();
		this._onDidChange.fire();
		this.syncWatchSoon.schedule();
	}

	private publicRun(state: IRunState | undefined): IAgentActiveRun | undefined {
		return state && { project: state.project, label: state.label, script: state.script, device: state.device, terminal: state.terminal, url: state.url, ended: state.ended };
	}

	//#endregion

	//#region Devices inside Volt

	private showsInVolt(): boolean {
		return this.configurationService.getValue<boolean>(AGENT_RUN_SHOW_IN_VOLT_SETTING) !== false;
	}

	private showDevice(key: string): void {
		void this.commandService.executeCommand(OPEN_DEVICE_PREVIEW_COMMAND_ID, key);
	}

	/** A mobile debug session began: show the device it runs on (the picked one, else the first booted). */
	private async showBootedDevice(): Promise<void> {
		if (!this.devices || !this.showsInVolt()) {
			return;
		}
		const lists = await this.devices.list(true);
		for (const entry of lists) {
			const device = entry.devices.find(candidate => candidate.state === 'booted' && candidate.kind !== 'physical');
			if (device) {
				this.showDevice(this.devices.keyOf({ host: entry.host, device }));
				return;
			}
		}
	}

	/**
	 * While a run, a debug session, or an agent turn in a mobile project may start a simulator or
	 * emulator from a shell (`flutter emulators --launch`, `xcrun simctl boot`), read the booted
	 * devices now and then and show a newly booted one in the device panel.
	 */
	private syncDeviceWatch(): void {
		const devices = this.devices;
		const active = !!devices && this.showsInVolt() && (
			[...this.runs.values()].some(run => !run.ended)
			|| this.debugging
			|| this.agentWorksOnMobile()
		);
		if (!active) {
			this.deviceWatch.clear();
			this.watchedBooted = undefined;
			return;
		}
		if (this.deviceWatch.value) {
			return;
		}
		const store = new DisposableStore();
		const tick = async () => {
			const lists = await devices.list(true);
			const booted = new Set<string>();
			for (const entry of lists) {
				for (const device of entry.devices) {
					if (device.state === 'booted' && device.kind !== 'physical') {
						booted.add(devices.keyOf({ host: entry.host, device }));
					}
				}
			}
			const before = this.watchedBooted;
			this.watchedBooted = booted;
			if (!before) {
				return;
			}
			const fresh = [...booted].find(key => !before.has(key));
			if (fresh) {
				this.showDevice(fresh);
			}
		};
		void tick();
		const timer = store.add(new IntervalTimer());
		timer.cancelAndSet(() => void tick(), DEVICE_WATCH_MS, mainWindow);
		this.deviceWatch.value = store;
	}

	private agentWorksOnMobile(): boolean {
		if (!this.mobileProjects.size) {
			return false;
		}
		const sessionId = this.workspaceService.active?.sessionId;
		if (!sessionId || !this.orchestrator.getThread(sessionId)?.active) {
			return false;
		}
		const project = this.targetFor(sessionId)?.project;
		return !!project && this.mobileProjects.has(project.toString());
	}

	//#endregion
}

/** What `flutter run -d` and React Native take: the UDID, or the adb serial of a running emulator. */
function runnerDeviceId(device: IVoltDevice): string {
	return device.platform === 'android' ? device.serial ?? device.id : device.id;
}

/** "iOS 27.0 simulator", "Android emulator": the runtime already names the platform when there is one. */
function deviceKindLabel(device: IVoltDevice): string {
	if (device.platform === 'ios') {
		const runtime = device.runtime ?? 'iOS';
		return device.kind === 'physical' ? localize('agentRun.iosDevice', "{0} device", runtime) : localize('agentRun.iosSimulator', "{0} simulator", runtime);
	}
	return device.kind === 'physical' ? localize('agentRun.androidDevice', "Android device") : localize('agentRun.androidEmulator', "Android emulator");
}

function desktopName(): string {
	return isMacintosh ? 'macOS' : isWindows ? 'Windows' : 'Linux';
}

registerSingleton(IAgentRunService, AgentRunService, InstantiationType.Delayed);
