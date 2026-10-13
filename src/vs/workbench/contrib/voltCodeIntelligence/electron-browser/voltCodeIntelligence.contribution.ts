/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IVoltCodeIndexService, IVoltLspBudget, VOLT_CODE_INDEX_CHANNEL_NAME } from '../../../../platform/voltCodeIndex/common/voltCodeIndex.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { LSP_ENABLED_SETTING, LSP_MAX_LOCAL_SETTING, LSP_MAX_REMOTE_SETTING, readLspLimits } from '../../../services/voltRuntime/common/codeIntelligence.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { CodeIntelligenceHostTools } from '../browser/voltCodeIntelligence.contribution.js';

registerMainProcessRemoteService(IVoltCodeIndexService, VOLT_CODE_INDEX_CHANNEL_NAME);

registerWorkbenchContribution2(CodeIntelligenceHostTools.ID, CodeIntelligenceHostTools, WorkbenchPhase.AfterRestored);

/** No project stops its language servers in its first minute (startup is busy enough). */
const STARTUP_GRACE_MS = 60_000;
/** A project switched away from keeps them this long, so switching back is instant. */
const STOP_DELAY_MS = 45_000;
const HEARTBEAT_MS = 2 * 60_000;

/**
 * Settings > Code Intelligence > LSP: each Volt project is its own workbench, and a parked one
 * keeps its extension host (tsserver, rust-analyzer, pylance...) running. This reports what the
 * project is doing to the main process, which ranks every project, and stops this project's
 * extension host while it is outside the budget; it starts again the moment the project is
 * back on screen or gets a slot.
 */
class LspBudgetController extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltLspBudget';

	private readonly startedAt = Date.now();
	private readonly running = new Set<string>();
	private stopped = false;
	private allowed = true;
	private queue: Promise<void> = Promise.resolve();
	private readonly reporter = this._register(new RunOnceScheduler(() => void this.report(), 250));
	private readonly stopper = this._register(new RunOnceScheduler(() => this.stopIfStillOutside(), STOP_DELAY_MS));

	constructor(
		@IVoltCodeIndexService private readonly codeIndex: IVoltCodeIndexService,
		@INativeHostService private readonly nativeHost: INativeHostService,
		@IHostService private readonly hostService: IHostService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IAgentRuntimeService runtime: IAgentRuntimeService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.codeIndex.onDidChangeLspBudget(budget => this.apply(budget)));
		this._register(this.hostService.onDidChangeFocus(() => this.onActivity()));
		this._register(addDisposableListener(mainWindow.document, 'visibilitychange', () => this.onActivity()));
		this._register(runtime.onDidEmit(({ sessionId, event }) => {
			if (event.type === 'run.start') {
				this.running.add(sessionId);
				this.reporter.schedule();
			} else if (event.type === 'run.end') {
				this.running.delete(sessionId);
				this.reporter.schedule();
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(LSP_ENABLED_SETTING) || e.affectsConfiguration(LSP_MAX_LOCAL_SETTING) || e.affectsConfiguration(LSP_MAX_REMOTE_SETTING)) {
				this.reporter.schedule();
			}
		}));
		this._register(lifecycleService.onWillShutdown(() => {
			void this.codeIndex.reportWorkspaceActivity(this.activity(true), readLspLimits(this.configurationService)).catch(() => undefined);
		}));
		const heartbeat = mainWindow.setInterval(() => this.reporter.schedule(), HEARTBEAT_MS);
		this._register({ dispose: () => mainWindow.clearInterval(heartbeat) });
		this.reporter.schedule();
	}

	/** On screen: visible in its window (a parked project is not), whether or not Volt has focus. */
	private get onScreen(): boolean {
		return mainWindow.document.visibilityState === 'visible' || this.hostService.hasFocus;
	}

	private activity(closed = false) {
		return {
			windowId: this.nativeHost.windowId,
			remote: !!this.environmentService.remoteAuthority,
			active: this.onScreen,
			busy: this.running.size > 0,
			...(closed ? { closed } : {}),
		};
	}

	private onActivity(): void {
		if (this.onScreen && this.stopped) {
			// Back on screen: do not wait for the round trip.
			this.allowed = true;
			this.start();
		}
		this.reporter.schedule();
	}

	private async report(): Promise<void> {
		try {
			this.apply(await this.codeIndex.reportWorkspaceActivity(this.activity(), readLspLimits(this.configurationService)));
		} catch (err) {
			this.logService.trace('[volt lsp] could not report activity', err);
		}
	}

	private apply(budget: IVoltLspBudget): void {
		this.allowed = budget.allowed.includes(this.nativeHost.windowId) || this.onScreen;
		if (this.allowed) {
			this.stopper.cancel();
			this.start();
		} else if (!this.stopped && !this.stopper.isScheduled()) {
			const wait = Math.max(STOP_DELAY_MS, STARTUP_GRACE_MS - (Date.now() - this.startedAt));
			this.stopper.schedule(wait);
		}
	}

	private stopIfStillOutside(): void {
		if (this.allowed || this.onScreen || this.running.size) {
			return;
		}
		this.queue = this.queue.then(async () => {
			if (this.stopped || this.allowed || this.onScreen) {
				return;
			}
			const stopped = await this.extensionService.stopExtensionHosts(localize('volt.lspBudget.stop', "Volt paused language servers for a project in the background"), true).catch(() => false);
			if (stopped) {
				this.stopped = true;
				this.logService.info('[volt lsp] stopped this project\'s language servers (outside the budget)');
			}
		});
	}

	private start(): void {
		this.queue = this.queue.then(async () => {
			if (!this.stopped) {
				return;
			}
			this.stopped = false;
			await this.extensionService.startExtensionHosts().catch(err => this.logService.warn('[volt lsp] could not restart language servers', err));
			this.logService.info('[volt lsp] restarted this project\'s language servers');
		});
	}
}

registerWorkbenchContribution2(LspBudgetController.ID, LspBudgetController, WorkbenchPhase.Eventually);
