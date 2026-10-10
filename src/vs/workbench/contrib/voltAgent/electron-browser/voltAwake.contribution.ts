/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, disposableWindowInterval } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { preventBackgroundThrottling } from '../../../../platform/native/electron-browser/voltBackgroundThrottling.js';
import { INotificationService, NeverShowAgainScope, Severity } from '../../../../platform/notification/common/notification.js';
import { AWAKE_LID_CLOSED_MODE_SETTING, IAwakeLease, IAwakeState, IVoltAwakeService, LidCapability, readAwakePrefs, VOLT_AWAKE_CHANNEL_NAME } from '../../../../platform/voltAwake/common/voltAwake.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAgentOrchestratorService } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { agentHomeLiveWork } from '../browser/home/agentHomeModel.js';
import '../common/agentAwakeSettings.js';

registerMainProcessRemoteService(IVoltAwakeService, VOLT_AWAKE_CHANNEL_NAME);

const HEARTBEAT_MS = 30_000;
/** A run the orchestrator does not track counts only while it still emits; one that never ended stops counting. */
const UNTRACKED_RUN_QUIET_MS = 15 * 60_000;

interface IBatteryManager extends EventTarget {
	readonly level: number;
	readonly charging: boolean;
}

/**
 * This window's part of Lid-Closed Mode: tells the main process how many of its chats are working
 * (and the battery, which only the renderer can read on every OS), keeps its timers at full speed
 * while they work (the agent runtime runs in this renderer, and a closed lid occludes the window),
 * and offers the one-time setup the first time an agent works without it.
 */
class VoltAwakeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAwake';

	/** Runs seen through the runtime, with the time of their latest event. */
	private readonly runs = new Map<string, number>();
	private readonly throttling = this._register(new MutableDisposable());
	private readonly push = this._register(new RunOnceScheduler(() => this.send(false), 250));
	private batteryPercent: number | undefined;
	private sent: string | undefined;
	private lastWorking = 0;
	/** This window had agents working in the current stretch, so it is the one to explain what changed. */
	private hadWork = false;
	private offeredSetup = false;
	private state: IAwakeState | undefined;

	constructor(
		@IVoltAwakeService private readonly awake: IVoltAwakeService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@IAgentRuntimeService runtime: IAgentRuntimeService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(orchestrator.onDidChange(() => this.push.schedule()));
		this._register(runtime.onDidEmit(envelope => {
			const type = envelope.event.type;
			if (type === 'run.end') {
				this.runs.delete(envelope.runId);
				this.push.schedule();
			} else if (type === 'run.start' || this.runs.has(envelope.runId)) {
				const isNew = !this.runs.has(envelope.runId);
				this.runs.set(envelope.runId, Date.now());
				if (isNew) {
					this.push.schedule();
				}
			}
		}));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('volt.awake')) {
				this.offeredSetup = false;
				this.push.schedule();
			}
		}));
		this._register(awake.onDidChange(state => this.onState(state)));
		this._register(disposableWindowInterval(mainWindow, () => this.send(true), HEARTBEAT_MS));
		void this.watchBattery();
		void awake.getState().then(state => this.state = state, () => undefined);
		// A reloaded window starts from nothing; what it reported before the reload goes.
		this.send(true);
		void orchestrator.whenReady.then(() => this.send(true));
	}

	private lease(): IAwakeLease {
		const state = this.orchestrator.getState();
		const tracked = new Set<string>();
		let waitingOnUser = 0;
		for (const thread of Object.values(state.threads)) {
			if (thread.active?.runId) {
				tracked.add(thread.active.runId);
			}
			if (thread.inputs.length) {
				waitingOnUser++;
			}
		}
		const now = Date.now();
		let untracked = 0;
		for (const [runId, at] of this.runs) {
			if (now - at > UNTRACKED_RUN_QUIET_MS) {
				this.runs.delete(runId);
			} else if (!tracked.has(runId)) {
				untracked++; // e.g. an inline review comment's run, sent without the orchestrator
			}
		}
		return { working: agentHomeLiveWork(state).size + untracked, waitingOnUser, batteryPercent: this.batteryPercent };
	}

	private send(force: boolean): void {
		const lease = this.lease();
		const prefs = readAwakePrefs(key => this.configurationService.getValue(key));
		const key = JSON.stringify([lease, prefs]);
		if (!force && key === this.sent) {
			return;
		}
		this.sent = key;
		const working = lease.working > 0;
		if (working && !this.throttling.value) {
			this.throttling.value = preventBackgroundThrottling(this.nativeHostService);
		} else if (!working) {
			this.throttling.clear();
		}
		if (working && !this.lastWorking) {
			this.hadWork = true;
		}
		this.lastWorking = lease.working;
		this.awake.setLease(this.nativeHostService.windowId, lease, prefs).catch(err => this.logService.warn('[volt awake] could not report agent activity', err));
		if (working && prefs.lidClosedMode) {
			void this.offerSetup();
		}
	}

	private onState(state: IAwakeState): void {
		const previous = this.state;
		this.state = state;
		if (state.tier === 'none' && !this.lastWorking) {
			this.hadWork = false;
		}
		if (!this.hadWork) {
			return;
		}
		if (state.blockedBy && state.blockedBy !== previous?.blockedBy && state.blockedBy !== 'snoozed' && this.lidClosedModeOn()) {
			this.notificationService.notify({
				severity: Severity.Info,
				message: state.blockedBy === 'battery'
					? localize('voltAwake.stoppedBattery', "Lid-Closed Mode stopped: the battery is low. Agents keep working, but closing the lid will put the computer to sleep.")
					: state.blockedBy === 'thermal'
						? localize('voltAwake.stoppedThermal', "Lid-Closed Mode stopped: the computer is too hot. Closing the lid will put it to sleep.")
						: localize('voltAwake.stoppedCap', "Lid-Closed Mode stopped after its time limit. Closing the lid will put the computer to sleep."),
			});
		}
		if (state.lastError && state.lastError !== previous?.lastError) {
			this.notificationService.notify({ severity: Severity.Warning, message: localize('voltAwake.error', "Lid-Closed Mode: {0}", state.lastError) });
		}
	}

	private lidClosedModeOn(): boolean {
		return this.configurationService.getValue<boolean>(AWAKE_LID_CLOSED_MODE_SETTING) !== false;
	}

	/** Once per launch (across windows): Lid-Closed Mode is on but this Mac still needs the approval. */
	private async offerSetup(): Promise<void> {
		if (this.offeredSetup) {
			return;
		}
		const state = this.state ?? await this.awake.getState();
		if (state.lid.kind !== 'needsSetup') {
			return;
		}
		this.offeredSetup = true;
		if (!(await this.awake.claimSetupPrompt())) {
			return;
		}
		this.notificationService.prompt(Severity.Info, localize('voltAwake.offerSetup', "Lid-Closed Mode keeps agents working when you close the lid. It needs a one-time administrator approval on this Mac."), [{
			label: localize('voltAwake.setUp', "Set Up…"),
			run: () => void setUpLidClosedMode(this.awake, this.notificationService),
		}, {
			label: localize('voltAwake.turnOff', "Turn Off"),
			run: () => void this.configurationService.updateValue(AWAKE_LID_CLOSED_MODE_SETTING, false),
		}], { sticky: true, neverShowAgain: { id: 'volt.awake.offerSetup', scope: NeverShowAgainScope.APPLICATION, isSecondary: true } });
	}

	private async watchBattery(): Promise<void> {
		const nav = mainWindow.navigator as Navigator & { getBattery?(): Promise<IBatteryManager> };
		let battery: IBatteryManager | undefined;
		try {
			battery = await nav.getBattery?.();
		} catch {
			return;
		}
		if (!battery || this._store.isDisposed) {
			return;
		}
		const manager = battery;
		const read = () => {
			// A desktop reports a full, charging "battery"; only a draining one matters to the floor.
			const percent = Math.round(manager.level * 100);
			this.batteryPercent = manager.charging && percent >= 100 ? undefined : percent;
			this.push.schedule();
		};
		read();
		this._register(addDisposableListener(manager, 'levelchange', read));
		this._register(addDisposableListener(manager, 'chargingchange', read));
	}
}

registerWorkbenchContribution2(VoltAwakeContribution.ID, VoltAwakeContribution, WorkbenchPhase.AfterRestored);

/** Runs the one-time approval and says how it went. */
export async function setUpLidClosedMode(awake: IVoltAwakeService, notificationService: INotificationService): Promise<LidCapability> {
	const capability = await awake.setUpLidClosedMode();
	if (capability.kind === 'ready') {
		notificationService.info(localize('voltAwake.ready', "Lid-Closed Mode is ready. Agents keep working when you close the lid."));
	} else if (capability.kind !== 'checking') {
		const { lastError } = await awake.getState();
		notificationService.warn(lastError ?? capability.detail);
	}
	return capability;
}

const category = localize2('volt', "Volt");

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.awake.setUpLidClosedMode', title: localize2('voltAwake.setUpCommand', "Set Up Lid-Closed Mode"), category, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await setUpLidClosedMode(accessor.get(IVoltAwakeService), accessor.get(INotificationService));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.awake.removeLidClosedModePermission', title: localize2('voltAwake.removeCommand', "Remove Lid-Closed Mode Permission"), category, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const awake = accessor.get(IVoltAwakeService);
		const notificationService = accessor.get(INotificationService);
		await awake.removeLidClosedModePermission();
		const { lastError } = await awake.getState();
		if (lastError) {
			notificationService.warn(lastError);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'volt.awake.allowSleepNow', title: localize2('voltAwake.allowSleepCommand', "Allow Sleep Until Agents Finish"), category, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IVoltAwakeService).allowSleepNow();
	}
});
