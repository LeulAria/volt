/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, powerMonitor, powerSaveBlocker, type WebContents } from 'electron';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { AwakeThermalState, decideAwake, DEFAULT_AWAKE_PREFS, IAwakeLease, IAwakePrefs, IAwakeState, IVoltAwakeService, LidCapability } from '../common/voltAwake.js';
import { IAwakeLidBackend, UnsupportedLidBackend } from '../node/awakeBackend.js';
import { DarwinLidBackend } from '../node/awakeDarwin.js';
import { realAwakeExec } from '../node/awakeExec.js';
import { LinuxLidBackend } from '../node/awakeLinux.js';
import { AwakeRegistry, createProcessProbe, defaultAwakeDir } from '../node/awakeRegistry.js';
import { Win32LidBackend } from '../node/awakeWin32.js';

/** Renderers heartbeat every 30 s; a window silent for this long (hung, crashed) stops counting. */
const LEASE_TTL_MS = 2 * 60_000;
const TICK_MS = 30_000;
const RENEW_MS = 60_000;
const SHUTDOWN_WAIT_MS = 5_000;

interface IWindowLease {
	readonly lease: IAwakeLease;
	readonly at: number;
}

/**
 * Keeps the computer awake while agents work, and with Lid-Closed Mode on, with the lid shut.
 *
 * Every window reports its busy chats ({@link setLease}); this sums them, decides with
 * {@link decideAwake}, holds idle sleep off with Electron's powerSaveBlocker, and asks the platform
 * backend for the lid. Everything is released when agents finish (after a grace period), on a
 * battery/thermal floor, at the hard cap, and when Volt quits; the backends' recovery paths cover a crash.
 */
export class VoltAwakeMainService extends Disposable implements IVoltAwakeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<IAwakeState>());
	readonly onDidChange = this._onDidChange.event;

	private readonly leases = new Map<number, IWindowLease>();
	private prefs: IAwakePrefs = DEFAULT_AWAKE_PREFS;
	private readonly backend: IAwakeLidBackend;
	private capability: LidCapability = { kind: 'checking' };
	private blockerId: number | undefined;
	private lidHeld = false;
	private lidClosed: boolean | undefined;
	private lastBusyAt: number | undefined;
	private episodeStartedAt: number | undefined;
	/** The episode in which taking the lid failed; no retry until the next one. */
	private lidFailedEpisode: number | undefined;
	private snoozed = false;
	private lastRenew = 0;
	private lastError: string | undefined;
	private thermal: AwakeThermalState = 'unknown';
	private setupPromptClaimed = false;
	private state: IAwakeState;
	private tick: ReturnType<typeof setInterval> | undefined;
	/** Backend calls run one at a time, in order. */
	private queue: Promise<unknown> = Promise.resolve();
	private readonly ready: Promise<void>;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
	) {
		super();
		const exec = realAwakeExec;
		const probe = createProcessProbe(exec);
		const ctx = { exec, probe, registry: new AwakeRegistry(defaultAwakeDir(), probe), log: logService, owner: 'volt' };
		this.backend = this._register(process.platform === 'darwin' ? new DarwinLidBackend(ctx)
			: process.platform === 'win32' ? new Win32LidBackend(ctx)
				: process.platform === 'linux' ? new LinuxLidBackend(ctx)
					: new UnsupportedLidBackend('Lid-Closed Mode is not available on this system.'));
		this._register(this.backend.onDidChangeLid(closed => {
			this.lidClosed = closed;
			this.publish();
		}));
		this.state = this.snapshot();

		this.thermal = readThermal();
		const onPower = () => this.evaluate();
		const onThermal = (details: { state?: string }) => {
			this.thermal = toThermal(details?.state);
			this.evaluate();
		};
		powerMonitor.on('on-ac', onPower);
		powerMonitor.on('on-battery', onPower);
		powerMonitor.on('thermal-state-change', onThermal);
		this._register(toDisposable(() => {
			powerMonitor.off('on-ac', onPower);
			powerMonitor.off('on-battery', onPower);
			powerMonitor.off('thermal-state-change', onThermal);
		}));

		const watch = (win: BrowserWindow) => {
			const id = win.id;
			win.once('closed', () => this.dropWindow(id));
		};
		BrowserWindow.getAllWindows().forEach(watch);
		const onCreated = (_event: unknown, win: BrowserWindow) => watch(win);
		const onGone = (_event: unknown, contents: WebContents) => {
			const win = BrowserWindow.fromWebContents(contents);
			if (win) {
				this.dropWindow(win.id);
			}
		};
		app.on('browser-window-created', onCreated);
		app.on('render-process-gone', onGone);
		this._register(toDisposable(() => {
			app.off('browser-window-created', onCreated);
			app.off('render-process-gone', onGone);
		}));

		this._register(lifecycleMainService.onWillShutdown(e => e.join('voltAwake', this.releaseAll())));
		this._register(toDisposable(() => this.stopTick()));

		// A Volt that crashed or was killed may have left the lid setting changed; undo that first.
		this.ready = this.enqueue(async () => {
			try {
				await this.backend.reconcile();
			} catch (err) {
				this.lastError = errorMessage(err);
				this.logService.warn('[volt awake] startup recovery failed', err);
			}
			await this.probe();
		});
	}

	async getState(): Promise<IAwakeState> {
		return this.state;
	}

	async setLease(windowId: number, lease: IAwakeLease, prefs: IAwakePrefs): Promise<void> {
		const lidModeTurnedOn = prefs.lidClosedMode && !this.prefs.lidClosedMode;
		this.prefs = prefs;
		this.leases.set(windowId, { lease, at: Date.now() });
		if (lidModeTurnedOn) {
			this.lidFailedEpisode = undefined;
			void this.enqueue(() => this.probe());
		}
		this.evaluate();
	}

	async allowSleepNow(): Promise<void> {
		this.snoozed = true;
		this.logService.info('[volt awake] sleep allowed until agents finish');
		this.evaluate();
	}

	async setUpLidClosedMode(): Promise<LidCapability> {
		return this.enqueue(async () => {
			try {
				await this.backend.setUp();
				this.lastError = undefined;
				this.lidFailedEpisode = undefined;
			} catch (err) {
				this.lastError = errorMessage(err);
				this.logService.warn('[volt awake] Lid-Closed Mode setup failed', err);
			}
			await this.probe();
			this.evaluate();
			return this.capability;
		});
	}

	async removeLidClosedModePermission(): Promise<LidCapability> {
		return this.enqueue(async () => {
			try {
				await this.backend.removeSetup();
				this.lastError = undefined;
			} catch (err) {
				this.lastError = errorMessage(err);
			}
			await this.probe();
			return this.capability;
		});
	}

	async refreshCapability(): Promise<LidCapability> {
		return this.enqueue(async () => {
			this.lidFailedEpisode = undefined;
			await this.probe();
			this.evaluate();
			return this.capability;
		});
	}

	async claimSetupPrompt(): Promise<boolean> {
		if (this.setupPromptClaimed) {
			return false;
		}
		this.setupPromptClaimed = true;
		return true;
	}

	private dropWindow(windowId: number): void {
		if (this.leases.delete(windowId)) {
			this.evaluate();
		}
	}

	private async probe(): Promise<void> {
		try {
			this.capability = await this.backend.probe();
		} catch (err) {
			this.capability = { kind: 'unsupported', detail: errorMessage(err) };
		}
		this.publish();
	}

	/** Recomputes what to hold and applies it. Cheap when nothing changed. */
	private evaluate(): void {
		void this.ready.then(() => this.enqueue(() => this.apply()));
	}

	private async apply(): Promise<void> {
		const now = Date.now();
		let working = 0;
		let battery: number | undefined;
		for (const [id, entry] of this.leases) {
			if (now - entry.at > LEASE_TTL_MS) {
				this.leases.delete(id);
				continue;
			}
			working += entry.lease.working;
			if (entry.lease.batteryPercent !== undefined) {
				battery = battery === undefined ? entry.lease.batteryPercent : Math.min(battery, entry.lease.batteryPercent);
			}
		}
		if (working > 0) {
			this.lastBusyAt = now;
		} else if (this.snoozed) {
			// "Allow sleep now" lasts until every agent has finished; the next run holds again.
			this.snoozed = false;
			this.lastBusyAt = undefined;
		}
		const inGrace = this.lastBusyAt !== undefined && now - this.lastBusyAt < this.prefs.graceMinutes * 60_000;
		const engaged = working > 0 || inGrace;
		if (engaged && this.episodeStartedAt === undefined) {
			this.episodeStartedAt = now;
			if (this.prefs.lidClosedMode) {
				await this.probe(); // a new stretch of work: the setup or another app's setting may have changed
			}
		} else if (!engaged) {
			this.episodeStartedAt = undefined;
		}

		const decision = decideAwake({
			now,
			prefs: this.prefs,
			working,
			lastBusyAt: this.lastBusyAt,
			episodeStartedAt: this.episodeStartedAt,
			snoozed: this.snoozed,
			onBattery: powerMonitor.isOnBatteryPower(),
			batteryPercent: battery,
			thermal: this.thermal,
		});

		this.setIdleBlocker(decision.idle);

		if (decision.lid && this.lidFailedEpisode !== this.episodeStartedAt) {
			try {
				const held = await this.backend.hold(this.capability);
				if (!held && this.capability.kind === 'ready') {
					await this.probe(); // ready but refused: another app owns the setting
				}
				if (held && !this.lidHeld) {
					this.lastError = undefined;
				}
				this.lidHeld = held;
				if (held && now - this.lastRenew >= RENEW_MS) {
					this.lastRenew = now;
					await this.backend.renew();
				}
			} catch (err) {
				this.lidHeld = false;
				this.lidFailedEpisode = this.episodeStartedAt;
				this.lastError = errorMessage(err);
				this.logService.warn('[volt awake] Lid-Closed Mode could not hold', err);
				await this.probe();
			}
		} else if (!decision.lid) {
			await this.releaseLid();
		}

		if (engaged || this.leases.size) {
			this.startTick();
		} else {
			this.stopTick();
		}
		this.publish(decision.idle || this.lidHeld ? (this.lidHeld ? 'lid' : 'idle') : 'none', decision.reason, decision.blockedBy, working, battery);
	}

	private async releaseLid(): Promise<void> {
		// Always ask: a partial hold (caffeinate on macOS) has no `lidHeld` but still needs stopping.
		try {
			await this.backend.release();
		} catch (err) {
			this.lastError = errorMessage(err);
			this.logService.error('[volt awake] could not undo Lid-Closed Mode', err);
		}
		this.lidHeld = false;
	}

	private setIdleBlocker(on: boolean): void {
		if (on && this.blockerId === undefined) {
			this.blockerId = powerSaveBlocker.start('prevent-app-suspension');
			this.logService.info('[volt awake] holding off idle sleep while agents work');
		} else if (!on && this.blockerId !== undefined) {
			powerSaveBlocker.stop(this.blockerId);
			this.blockerId = undefined;
			this.logService.info('[volt awake] idle sleep allowed again');
		}
	}

	private releaseAll(): Promise<void> {
		this.leases.clear();
		this.setIdleBlocker(false);
		const release = this.enqueue(() => this.releaseLid());
		return Promise.race([release, new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_WAIT_MS))]);
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private startTick(): void {
		this.tick ??= setInterval(() => this.evaluate(), TICK_MS);
	}

	private stopTick(): void {
		if (this.tick) {
			clearInterval(this.tick);
			this.tick = undefined;
		}
	}

	private publish(tier = this.state.tier, reason = this.state.reason, blockedBy = this.state.blockedBy, working = this.state.working, batteryPercent = this.state.batteryPercent): void {
		const next = this.snapshot(tier, reason, blockedBy, working, batteryPercent);
		if (!equals(next, this.state)) {
			this.state = next;
			this._onDidChange.fire(next);
		}
	}

	private snapshot(tier: IAwakeState['tier'] = 'none', reason: IAwakeState['reason'] = 'none', blockedBy?: IAwakeState['blockedBy'], working = 0, batteryPercent?: number): IAwakeState {
		return {
			tier,
			reason,
			blockedBy,
			lid: this.capability,
			lidClosed: this.lidHeld ? this.lidClosed : undefined,
			working,
			onBattery: powerMonitor.isOnBatteryPower(),
			batteryPercent,
			lastError: this.lastError,
		};
	}
}

function readThermal(): AwakeThermalState {
	try {
		return toThermal(powerMonitor.getCurrentThermalState());
	} catch {
		return 'unknown';
	}
}

function toThermal(state: string | undefined): AwakeThermalState {
	return state === 'nominal' || state === 'fair' || state === 'serious' || state === 'critical' ? state : 'unknown';
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
