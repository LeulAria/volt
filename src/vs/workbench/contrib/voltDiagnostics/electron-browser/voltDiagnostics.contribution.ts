/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../common/voltDiagnosticsConfiguration.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { StallRateLimiter } from '../../../../platform/voltDiagnostics/common/stalls.js';
import { VoltTracer } from '../../../../platform/voltDiagnostics/common/tracer.js';
import {
	IVoltDiagnosticsService, IVoltSpanData, IVoltTracingConfig, readStallThreshold, readTracingConfig, VOLT_DIAGNOSTICS_CHANNEL_NAME,
	VOLT_STALL_THRESHOLD_SETTING, VOLT_TRACING_ENABLED_SETTING, VOLT_TRACING_SAMPLE_RATE_SETTING,
} from '../../../../platform/voltDiagnostics/common/voltDiagnostics.js';
import { getLayoutMode } from '../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ILifecycleService, StartupKindToString } from '../../../services/lifecycle/common/lifecycle.js';
import { ITimerService } from '../../../services/timer/browser/timerService.js';
import { IAgentOrchestratorService } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { AgentTurnSpans } from '../common/agentTurnSpans.js';
import { attributeLongFrame, ILastCommand, ILongFrameEntry } from '../common/rendererStalls.js';
import { indexMarks, recordStartupTrace } from '../common/startupSpans.js';

registerMainProcessRemoteService(IVoltDiagnosticsService, VOLT_DIAGNOSTICS_CHANNEL_NAME);

/** Spans wait this long (or for this many) before going to the main process in one IPC message. */
const SPAN_BATCH_MS = 1000;
const SPAN_BATCH_SIZE = 64;

/**
 * Window-side diagnostics: spans for agent turns and window startup (exported by the main
 * process), and event-loop stalls from Long Animation Frame entries.
 */
class VoltDiagnosticsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltDiagnostics';

	private config: IVoltTracingConfig;
	private readonly tracer: VoltTracer;
	private pending: IVoltSpanData[] = [];
	private readonly sendScheduler = this._register(new RunOnceScheduler(() => this.sendSpans(), SPAN_BATCH_MS));
	private agentTurns: AgentTurnSpans | undefined;
	private readonly agentTurnListener = this._register(new MutableDisposable());
	private readonly stallObserver = this._register(new MutableDisposable());
	private readonly stallLimiter = new StallRateLimiter();
	private lastCommand: ILastCommand | undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IVoltDiagnosticsService private readonly diagnostics: IVoltDiagnosticsService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IAgentOrchestratorService private readonly orchestrator: IAgentOrchestratorService,
		@ITimerService private readonly timerService: ITimerService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.config = readTracingConfig(key => configurationService.getValue(key));
		this.tracer = new VoltTracer({
			sink: span => this.queueSpan(span),
			sampleRate: () => this.config.sampleRate,
			attributes: { 'volt.process': 'renderer', 'volt.window.id': nativeHostService.windowId },
		});

		this._register(commandService.onWillExecuteCommand(e => this.lastCommand = { id: e.commandId, time: Date.now() }));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VOLT_TRACING_ENABLED_SETTING) || e.affectsConfiguration(VOLT_TRACING_SAMPLE_RATE_SETTING)) {
				this.config = readTracingConfig(key => configurationService.getValue(key));
				this.applyTracing();
			}
			if (e.affectsConfiguration(VOLT_STALL_THRESHOLD_SETTING)) {
				this.applyStallThreshold();
			}
		}));
		this._register(lifecycleService.onWillShutdown(() => {
			this.agentTurns?.endAll('shutdown');
			this.sendSpans();
		}));

		this.applyTracing();
		this.applyStallThreshold();
		if (this.config.enabled) {
			void this.traceStartup();
		}
	}

	//#region Tracing

	private applyTracing(): void {
		if (!this.config.enabled) {
			this.agentTurns?.endAll('tracing turned off');
			this.agentTurns = undefined;
			this.agentTurnListener.clear();
			this.sendSpans();
			return;
		}
		if (this.agentTurns) {
			return;
		}
		const spans = new AgentTurnSpans(this.tracer, {
			chatFor: sessionId => this.runtime.chatFor(sessionId),
			turn: chatId => {
				const thread = this.orchestrator.getThread(chatId);
				return thread ? { turnId: thread.active?.id, kind: thread.active?.kind, modelLabel: thread.modelLabel, depth: thread.depth, subagent: !!thread.parentId } : undefined;
			},
			metrics: (sessionId, runId) => this.runtime.getRunMetrics(sessionId).find(metrics => metrics.runId === runId),
			model: ref => {
				const item = this.runtime.listCatalog().find(entry => entry.ref === ref);
				return item ? { providerId: item.providerId, modelId: item.id, label: item.label } : undefined;
			},
			defer: callback => setTimeout(callback, 0),
		});
		this.agentTurns = spans;
		this.agentTurnListener.value = this.runtime.onDidEmit(envelope => {
			try {
				spans.handle(envelope);
			} catch (error) {
				this.logService.error('[volt diagnostics] could not trace an agent event', error);
			}
		});
	}

	private queueSpan(span: IVoltSpanData): void {
		if (!this.config.enabled) {
			return;
		}
		this.pending.push(span);
		if (this.pending.length >= SPAN_BATCH_SIZE) {
			this.sendSpans();
		} else if (!this.sendScheduler.isScheduled()) {
			this.sendScheduler.schedule();
		}
	}

	private sendSpans(): void {
		this.sendScheduler.cancel();
		if (!this.pending.length) {
			return;
		}
		const batch = this.pending;
		this.pending = [];
		this.diagnostics.exportSpans(batch).catch(error => this.logService.warn('[volt diagnostics] could not hand spans to the main process', error));
	}

	private async traceStartup(): Promise<void> {
		await this.timerService.whenReady();
		if (!this.config.enabled || this._store.isDisposed) {
			return;
		}
		const metrics = this.timerService.startupMetrics;
		recordStartupTrace(this.tracer, indexMarks(this.timerService.getPerformanceMarks()), metrics.initialStartup, {
			'volt.startup.kind': StartupKindToString(metrics.windowKind),
			'volt.startup.window_count': metrics.windowCount,
			'volt.startup.cached_data': metrics.didUseCachedData,
			'volt.startup.empty_workbench': metrics.emptyWorkbench,
			'volt.startup.editors': metrics.editorIds.length,
			'volt.window.layout': getLayoutMode(this.layoutService),
		});
	}

	//#endregion

	//#region Stalls

	private applyStallThreshold(): void {
		this.stallObserver.clear();
		const threshold = readStallThreshold(key => this.configurationService.getValue(key));
		const supported = typeof PerformanceObserver === 'function' ? PerformanceObserver.supportedEntryTypes : [];
		const type = supported.includes('long-animation-frame') ? 'long-animation-frame' : supported.includes('longtask') ? 'longtask' : undefined;
		if (threshold <= 0 || !type) {
			return;
		}
		const observer = new PerformanceObserver(list => {
			for (const entry of list.getEntries() as unknown as ILongFrameEntry[]) {
				if (entry.duration >= threshold) {
					this.reportLongFrame(entry);
				}
			}
		});
		observer.observe({ type, buffered: false });
		this.stallObserver.value = toDisposable(() => observer.disconnect());
	}

	private reportLongFrame(entry: ILongFrameEntry): void {
		const suppressed = this.stallLimiter.take(Date.now());
		if (suppressed === undefined) {
			return;
		}
		const timeOrigin = mainWindow.performance.timeOrigin;
		this.diagnostics.reportStall({
			process: 'renderer',
			windowId: this.nativeHostService.windowId,
			startTime: timeOrigin + entry.startTime,
			durationMs: entry.duration,
			blockingMs: entry.blockingDuration,
			attribution: attributeLongFrame(entry, timeOrigin, this.lastCommand),
			suppressed,
		}).catch(() => undefined);
	}

	//#endregion
}

registerWorkbenchContribution2(VoltDiagnosticsContribution.ID, VoltDiagnosticsContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'volt.diagnostics.writeHeapSnapshots',
			title: localize2('voltDiagnostics.writeHeapSnapshots', "Write Heap Snapshots to Logs Folder"),
			category: Categories.Developer,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const diagnostics = accessor.get(IVoltDiagnosticsService);
		const progressService = accessor.get(IProgressService);
		const notificationService = accessor.get(INotificationService);
		const nativeHostService = accessor.get(INativeHostService);
		const result = await progressService.withProgress(
			{ location: ProgressLocation.Notification, title: localize('voltDiagnostics.writingHeapSnapshots', "Writing heap snapshots...") },
			() => diagnostics.writeHeapSnapshots(),
		);
		const message = result.errors.length
			? localize('voltDiagnostics.heapSnapshotsPartial', "Wrote {0} heap snapshots to {1}. {2} failed: {3}", result.files.length, result.folder, result.errors.length, result.errors.join('; '))
			: localize('voltDiagnostics.heapSnapshotsDone', "Wrote {0} heap snapshots to {1}.", result.files.length, result.folder);
		notificationService.prompt(result.errors.length ? Severity.Warning : Severity.Info, message, result.files.length ? [{
			label: isMacintosh ? localize('voltDiagnostics.revealInFinder', "Reveal in Finder") : isWindows ? localize('voltDiagnostics.revealInExplorer', "Reveal in File Explorer") : localize('voltDiagnostics.openContainingFolder', "Open Containing Folder"),
			run: () => nativeHostService.showItemInFolder(result.files[0]),
		}] : []);
	}
});
