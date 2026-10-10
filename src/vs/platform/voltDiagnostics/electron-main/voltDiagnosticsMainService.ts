/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { powerMonitor } from 'electron';
import { promises as fs } from 'fs';
import * as os from 'os';
import { generateUuid } from '../../../base/common/uuid.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { IChannelServer, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { IInstantiationService, ServicesAccessor } from '../../instantiation/common/instantiation.js';
import { ILifecycleMainService, LifecycleMainPhase } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogger, ILogService } from '../../log/common/log.js';
import { ILoggerMainService } from '../../log/electron-main/loggerService.js';
import { IProductService } from '../../product/common/productService.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { IUpdateService, State as UpdateState, StateType as UpdateStateType } from '../../update/common/update.js';
import { IpcActivityRecorder } from '../common/ipcActivity.js';
import { OtlpBatchExporter, OtlpTransport } from '../common/otlp.js';
import { DriftStallMonitor, formatStall, StallRateLimiter } from '../common/stalls.js';
import { IVoltSpan, VoltTracer } from '../common/tracer.js';
import {
	IVoltDiagnosticsService, IVoltHeapSnapshotResult, IVoltSpanData, IVoltStallReport, IVoltTracingConfig, readStallThreshold, readTracingConfig,
	VOLT_DIAGNOSTICS_CHANNEL_NAME, VOLT_STALL_THRESHOLD_SETTING, VOLT_TRACING_ENABLED_SETTING, VOLT_TRACING_ENDPOINT_SETTING,
	VOLT_TRACING_HEADERS_SETTING, VOLT_TRACING_SAMPLE_RATE_SETTING, VoltAttributes, VoltSpanKind, VoltSpanStatusCode,
} from '../common/voltDiagnostics.js';

/** IPC channels whose calls become spans: git snapshots, checkouts and worktree plumbing, and pull requests. */
const TRACED_CHANNELS: Readonly<Record<string, string>> = {
	voltGit: 'git',
	voltPullRequests: 'pull_request',
};

const fetchTransport: OtlpTransport = async (url, body, headers, signal) => {
	const response = await fetch(url, { method: 'POST', body, headers, signal });
	const text = response.ok ? undefined : await response.text().catch(() => undefined);
	return { status: response.status, body: text };
};

function osType(): string {
	switch (process.platform) {
		case 'win32': return 'windows';
		case 'darwin': return 'darwin';
		default: return process.platform;
	}
}

function hostArch(): string {
	switch (process.arch) {
		case 'x64': return 'amd64';
		case 'ia32': return 'x86';
		default: return process.arch;
	}
}

function fileTimestamp(date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Main-process diagnostics: the OTLP exporter every process's spans go through, the main event-loop
 * stall monitor, heap snapshots (SIGUSR2 on macOS and Linux, or the Developer command), and the
 * Volt Diagnostics log.
 */
export class VoltDiagnosticsMainService extends Disposable implements IVoltDiagnosticsService {

	declare readonly _serviceBrand: undefined;

	readonly ipcActivity = new IpcActivityRecorder();

	private readonly diagnosticsLog: ILogger;
	private readonly exporter = this._register(new MutableDisposable<OtlpBatchExporter>());
	private tracingConfig: IVoltTracingConfig;
	private readonly tracer: VoltTracer;
	private readonly resource: VoltAttributes;
	private readonly stallMonitor = this._register(new MutableDisposable<IDisposable>());
	private readonly stallLimiter = new StallRateLimiter();
	private heapSnapshot: Promise<IVoltHeapSnapshotResult> | undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@ILoggerMainService loggerService: ILoggerMainService,
		@ILogService private readonly logService: ILogService,
		@IProductService productService: IProductService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.diagnosticsLog = this._register(loggerService.createLogger('voltDiagnostics', { name: 'Volt Diagnostics' }));
		this.resource = {
			'service.name': productService.applicationName,
			'service.version': productService.version,
			'service.instance.id': generateUuid(),
			'volt.quality': productService.quality ?? 'dev',
			'volt.commit': productService.commit,
			'os.type': osType(),
			'os.version': os.release(),
			'host.arch': hostArch(),
		};
		this.tracingConfig = readTracingConfig(key => configurationService.getValue(key));
		this.tracer = new VoltTracer({
			sink: span => this.exporter.value?.add([span]),
			sampleRate: () => this.tracingConfig.sampleRate,
			attributes: { 'volt.process': 'main' },
		});
		this.applyTracingConfig();
		this.applyStallThreshold();

		// Sleep is not a stall. The monitor's clock already pauses with the machine on macOS and Linux;
		// stopping it across suspend covers Windows, where that clock can keep running.
		const onSuspend = () => this.stallMonitor.clear();
		const onResume = () => this.applyStallThreshold();
		powerMonitor.on('suspend', onSuspend);
		powerMonitor.on('resume', onResume);
		this._register(toDisposable(() => {
			powerMonitor.off('suspend', onSuspend);
			powerMonitor.off('resume', onResume);
		}));

		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VOLT_TRACING_ENABLED_SETTING) || e.affectsConfiguration(VOLT_TRACING_ENDPOINT_SETTING)
				|| e.affectsConfiguration(VOLT_TRACING_HEADERS_SETTING) || e.affectsConfiguration(VOLT_TRACING_SAMPLE_RATE_SETTING)) {
				this.tracingConfig = readTracingConfig(key => configurationService.getValue(key));
				this.applyTracingConfig();
			}
			if (e.affectsConfiguration(VOLT_STALL_THRESHOLD_SETTING)) {
				this.applyStallThreshold();
			}
		}));

		this._register(lifecycleMainService.onWillShutdown(e => {
			const exporter = this.exporter.value;
			if (exporter?.pending) {
				// Bounded by the exporter's own request timeout.
				e.join('voltTracingFlush', exporter.flush());
			}
		}));

		if (!isWindows) {
			const onSignal = () => {
				this.diagnosticsLog.info('SIGUSR2: writing heap snapshots');
				void this.writeHeapSnapshots('signal');
			};
			process.on('SIGUSR2', onSignal);
			this._register(toDisposable(() => process.off('SIGUSR2', onSignal)));
		}

		// The update service is created later in startup; only listen once it exists.
		void lifecycleMainService.when(LifecycleMainPhase.AfterWindowOpen).then(() => {
			if (!this._store.isDisposed) {
				instantiationService.invokeFunction(accessor => this.traceUpdateChecks(accessor.get(IUpdateService)));
			}
		});
	}

	//#region Tracing

	private applyTracingConfig(): void {
		const config = this.tracingConfig;
		const previous = this.exporter.clearAndLeak();
		if (previous) {
			void previous.flush().finally(() => previous.dispose());
		}
		if (!config.enabled) {
			return;
		}
		this.exporter.value = new OtlpBatchExporter({
			endpoint: config.endpoint,
			headers: config.headers,
			resource: this.resource,
			scope: { name: 'volt', version: this.resource['service.version'] as string | undefined },
			transport: fetchTransport,
			onError: message => this.diagnosticsLog.warn(message),
		});
		this.diagnosticsLog.info(`Tracing on: exporting to ${config.endpoint} (sample rate ${config.sampleRate})`);
	}

	private get tracing(): boolean {
		return !!this.exporter.value;
	}

	async exportSpans(spans: readonly IVoltSpanData[]): Promise<void> {
		// Renderers also check the setting; a late batch after it was turned off is dropped here.
		this.exporter.value?.add(spans);
	}

	/** Observes IPC calls on the traced channels. Called by {@link IpcActivityRecorder.instrument}. */
	observeIpcCall(channel: string, command: string, startTime: number, result: Promise<unknown>): void {
		const prefix = TRACED_CHANNELS[channel];
		if (!prefix || !this.tracing) {
			return;
		}
		const span = this.tracer.startSpan(`${prefix}.${command}`, {
			kind: VoltSpanKind.Server,
			startTime,
			attributes: { 'rpc.system': 'volt-ipc', 'rpc.service': channel, 'rpc.method': command },
		});
		result.then(() => {
			span.setStatus(VoltSpanStatusCode.Ok);
			span.end();
		}, error => {
			span.setStatus(VoltSpanStatusCode.Error, error instanceof Error ? error.message : String(error));
			span.end();
		});
	}

	private traceUpdateChecks(updateService: IUpdateService): void {
		let check: IVoltSpan | undefined;
		const onState = (state: UpdateState) => {
			if (state.type === UpdateStateType.CheckingForUpdates) {
				check?.end();
				check = this.tracing ? this.tracer.startSpan('update.check', { attributes: { 'volt.update.explicit': state.explicit } }) : undefined;
				return;
			}
			if (!check) {
				return;
			}
			check.setAttribute('volt.update.result', state.type);
			if (state.type === UpdateStateType.Idle && state.error) {
				check.setStatus(VoltSpanStatusCode.Error, state.error);
			} else {
				check.setStatus(VoltSpanStatusCode.Ok);
			}
			check.end();
			check = undefined;
		};
		this._register(updateService.onStateChange(onState));
	}

	//#endregion

	//#region Stalls

	private applyStallThreshold(): void {
		const threshold = readStallThreshold(key => this.configurationService.getValue(key));
		this.stallMonitor.value = threshold > 0
			? new DriftStallMonitor(threshold, stall => {
				const suppressed = this.stallLimiter.take(Date.now());
				const report: IVoltStallReport = {
					process: 'main',
					startTime: stall.startTime,
					durationMs: stall.durationMs,
					attribution: this.ipcActivity.attribute(stall.startTime, stall.startTime + stall.durationMs),
					suppressed,
				};
				if (suppressed !== undefined) {
					this.diagnosticsLog.warn(formatStall(report));
				}
				// Traced even when the log line was held back: the collector does its own aggregation.
				this.traceStall(report);
			})
			: undefined;
	}

	async reportStall(report: IVoltStallReport): Promise<void> {
		this.diagnosticsLog.warn(formatStall(report));
		this.traceStall(report);
	}

	private traceStall(report: IVoltStallReport): void {
		if (!this.tracing) {
			return;
		}
		const top = report.attribution[0];
		this.tracer.recordSpan('event_loop.stall', report.startTime, report.startTime + report.durationMs, {
			attributes: {
				'volt.process': report.process,
				'volt.window.id': report.windowId,
				'volt.stall.duration_ms': Math.round(report.durationMs),
				'volt.stall.blocking_ms': report.blockingMs !== undefined ? Math.round(report.blockingMs) : undefined,
				'volt.stall.attribution.kind': top?.kind,
				'volt.stall.attribution': top?.detail,
				'volt.stall.attributions': report.attribution.length ? report.attribution.map(item => `${item.kind}: ${item.detail}`) : undefined,
			},
		});
	}

	//#endregion

	//#region Heap snapshots

	writeHeapSnapshots(trigger: 'signal' | 'command' = 'command'): Promise<IVoltHeapSnapshotResult> {
		if (this.heapSnapshot) {
			this.diagnosticsLog.info('Heap snapshots are already being written; waiting for those');
			return this.heapSnapshot;
		}
		this.heapSnapshot = this.doWriteHeapSnapshots(trigger).finally(() => this.heapSnapshot = undefined);
		return this.heapSnapshot;
	}

	private async doWriteHeapSnapshots(trigger: 'signal' | 'command'): Promise<IVoltHeapSnapshotResult> {
		const folder = this.environmentMainService.logsHome.fsPath;
		const stamp = fileTimestamp();
		const files: string[] = [];
		const errors: string[] = [];
		const span = this.tracing ? this.tracer.startSpan('diagnostics.heap_snapshots', { attributes: { 'volt.heap_snapshot.trigger': trigger } }) : undefined;
		await fs.mkdir(folder, { recursive: true }).catch(() => undefined);

		// Renderers first: the main snapshot below blocks this process (and so their IPC) until it is written.
		// A code window renders into a view inside its BrowserWindow, so snapshot that view's contents;
		// auxiliary windows share their parent's renderer and are covered by it.
		const windows = this.instantiationService.invokeFunction(accessor => accessor.get(IWindowsMainService).getWindows());
		for (const window of windows) {
			const contents = window.webContents;
			if (contents.isDestroyed() || contents.isCrashed()) {
				continue;
			}
			const file = join(folder, `window${window.id}-${stamp}.heapsnapshot`);
			try {
				await contents.takeHeapSnapshot(file);
				files.push(file);
			} catch (error) {
				errors.push(`window ${window.id}: ${error instanceof Error ? error.message : String(error)}`);
				await fs.rm(file, { force: true }).catch(() => undefined);
			}
		}

		const mainFile = join(folder, `main-${stamp}.heapsnapshot`);
		try {
			// Electron's own API (v8.writeHeapSnapshot is not allowed in this layer); it blocks this process until written.
			if (!process.takeHeapSnapshot(mainFile)) {
				throw new Error('takeHeapSnapshot returned false');
			}
			files.push(mainFile);
		} catch (error) {
			errors.push(`main: ${error instanceof Error ? error.message : String(error)}`);
		}

		for (const file of files) {
			this.diagnosticsLog.info(`Wrote heap snapshot ${file}`);
		}
		for (const error of errors) {
			this.diagnosticsLog.error(`Heap snapshot failed: ${error}`);
		}
		this.logService.info(`[volt diagnostics] wrote ${files.length} heap snapshots to ${folder}`);
		if (span) {
			span.setAttributes({ 'volt.heap_snapshot.files': files.length, 'volt.heap_snapshot.errors': errors.length });
			span.setStatus(errors.length ? VoltSpanStatusCode.Error : VoltSpanStatusCode.Ok, errors[0]);
			span.end();
		}
		return { folder, files, errors };
	}

	//#endregion
}

/**
 * Hooks diagnostics into the main IPC server: every channel registered after this call is timed (for
 * stall attribution and git spans), and the diagnostics channel itself is registered.
 */
export function registerVoltDiagnosticsMain(accessor: ServicesAccessor, server: IChannelServer<string>): IDisposable {
	const service = accessor.get(IVoltDiagnosticsService) as VoltDiagnosticsMainService;
	const disposables = new DisposableStore();
	const restore = service.ipcActivity.instrument(server, (channel, command, startTime, result) => service.observeIpcCall(channel, command, startTime, result));
	disposables.add(toDisposable(restore));
	server.registerChannel(VOLT_DIAGNOSTICS_CHANNEL_NAME, ProxyChannel.fromService(service, disposables));
	return disposables;
}
