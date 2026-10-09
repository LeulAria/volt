/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { decodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IVoltCaptureService, IVoltCaptureSource } from '../../../../platform/voltCapture/common/voltCapture.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { scaleScreenshot } from '../../../services/voltRuntime/browser/host/imageCodec.js';
import { CAPTURE_TOOLS, VoltCaptureToolName } from '../../../services/voltRuntime/common/deviceTools.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { IVoltRecording, IVoltRecordingStatusService } from '../browser/capture/recordingStatus.js';

export const IVoltWindowCaptureService = createDecorator<IVoltWindowCaptureService>('voltWindowCaptureService');

export const CAPTURE_WINDOW_COMMAND_ID = 'volt.capture.window';
export const RECORD_WINDOW_COMMAND_ID = 'volt.capture.recordWindow';
export const STOP_RECORDING_COMMAND_ID = 'volt.capture.stopRecording';

export interface IFinishedRecording {
	readonly id: string;
	readonly path: string;
	readonly label: string;
	readonly durationMs: number;
	readonly bytes: number;
}

export interface IVoltWindowCaptureService {
	readonly _serviceBrand: undefined;
	listSources(): Promise<IVoltCaptureSource[]>;
	/** A window by source id or by text in its title; undefined is this Volt window. */
	resolveSource(query: string | undefined): Promise<IVoltCaptureSource>;
	startRecording(source: IVoltCaptureSource, options: { readonly maxSeconds: number; readonly by: 'agent' | 'user'; readonly sessionId?: string }): Promise<IVoltRecording>;
	stopRecording(id: string): Promise<IFinishedRecording>;
	/** Resolves once the recording ends (stopped from anywhere, or at its time limit) and is saved. */
	whenFinished(id: string): Promise<IFinishedRecording>;
	latestRecording(sessionId?: string): string | undefined;
}

/** Chromium's desktop capture constraints for `getUserMedia` (not in the DOM typings). */
interface IDesktopVideoConstraints {
	readonly mandatory: {
		readonly chromeMediaSource: 'desktop';
		readonly chromeMediaSourceId: string;
		readonly maxWidth: number;
		readonly maxHeight: number;
		readonly maxFrameRate: number;
	};
}

const MAX_RECORD_SECONDS = 600;
const RECORDER_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

interface IActiveRecording {
	readonly recording: IVoltRecording;
	readonly finished: Promise<IFinishedRecording>;
	readonly sessionId?: string;
}

function slug(value: string): string {
	return value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'window';
}

function stamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}

export class VoltWindowCaptureService extends Disposable implements IVoltWindowCaptureService {

	declare readonly _serviceBrand: undefined;

	private readonly active = new Map<string, IActiveRecording>();
	private readonly finished = new Map<string, IFinishedRecording>();
	private readonly latest = new Map<string, string>();
	private readonly _onDidFinish = this._register(new Emitter<IFinishedRecording>());
	readonly onDidFinish = this._onDidFinish.event;

	constructor(
		@IVoltCaptureService private readonly capture: IVoltCaptureService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IFileService private readonly fileService: IFileService,
		@INativeWorkbenchEnvironmentService private readonly environmentService: INativeWorkbenchEnvironmentService,
		@IVoltRecordingStatusService private readonly status: IVoltRecordingStatusService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register({ dispose: () => this.active.forEach(entry => void entry.recording.stop()) });
	}

	listSources(): Promise<IVoltCaptureSource[]> {
		return this.capture.listSources();
	}

	async resolveSource(query: string | undefined): Promise<IVoltCaptureSource> {
		const sources = await this.capture.listSources();
		const value = query?.trim();
		if (!value) {
			const own = await this.capture.sourceIdOfWindow(this.nativeHostService.windowId);
			const source = sources.find(candidate => candidate.id === own);
			if (source) {
				return source;
			}
			if (own) {
				return { id: own, name: 'Volt', kind: 'window', own: true };
			}
			throw new Error('This Volt window could not be found for capture.');
		}
		const exact = sources.find(source => source.id === value);
		if (exact) {
			return exact;
		}
		const lower = value.toLowerCase();
		const named = sources.filter(source => source.name.toLowerCase().includes(lower));
		if (named.length === 1) {
			return named[0];
		}
		if (named.length > 1) {
			const exactName = named.find(source => source.name.toLowerCase() === lower);
			if (exactName) {
				return exactName;
			}
			throw new Error(`"${value}" matches ${named.length} windows; pass an id:\n${named.slice(0, 20).map(source => `- ${source.name} (id: ${source.id})`).join('\n')}`);
		}
		throw new Error(`No window title contains "${value}". Call window_list.${isMacintosh && !sources.some(source => !source.own && source.kind === 'window') ? ' Only Volt\'s windows are listed: allow Volt in System Settings > Privacy & Security > Screen & System Audio Recording to see other apps.' : ''}`);
	}

	private folder(): URI {
		return joinPath(this.environmentService.userHome, isMacintosh ? 'Movies' : 'Videos', 'Volt Recordings');
	}

	private async recordOwnWindow(): Promise<MediaStream | undefined> {
		try {
			await this.capture.allowOwnDisplayCapture();
			return await mainWindow.navigator.mediaDevices.getDisplayMedia({ audio: false, video: true });
		} catch {
			return undefined;
		}
	}

	async startRecording(source: IVoltCaptureSource, options: { readonly maxSeconds: number; readonly by: 'agent' | 'user'; readonly sessionId?: string }): Promise<IVoltRecording> {
		const video: IDesktopVideoConstraints = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: 2560, maxHeight: 1600, maxFrameRate: 30 } };
		let stream: MediaStream;
		try {
			stream = await mainWindow.navigator.mediaDevices.getUserMedia({ audio: false, video: video as unknown as MediaTrackConstraints });
		} catch (err) {
			// This window can always record itself: Electron grants its own page without the OS permission.
			const own = source.own && await this.capture.sourceIdOfWindow(this.nativeHostService.windowId) === source.id;
			const ownStream = own ? await this.recordOwnWindow() : undefined;
			if (!ownStream) {
				throw new Error(`Could not start recording ${source.name}: ${err instanceof Error ? err.message : String(err)}${isMacintosh ? '. Allow Volt in System Settings > Privacy & Security > Screen & System Audio Recording.' : ''}`);
			}
			stream = ownStream;
		}
		const mimeType = RECORDER_TYPES.find(type => MediaRecorder.isTypeSupported(type)) ?? '';
		const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
		const chunks: Blob[] = [];
		recorder.ondataavailable = event => {
			if (event.data.size) {
				chunks.push(event.data);
			}
		};
		const id = generateUuid().slice(0, 8);
		const startedAt = Date.now();
		const seconds = Math.max(1, Math.min(MAX_RECORD_SECONDS, options.maxSeconds));
		const win = getActiveWindow();
		const stopped = new Promise<void>(resolve => recorder.onstop = () => resolve());
		// The window or screen went away (closed, display unplugged): finish what was recorded.
		stream.getVideoTracks()[0]?.addEventListener('ended', () => void recording.stop());
		const finished = stopped.then(async (): Promise<IFinishedRecording> => {
			win.clearTimeout(stopTimer);
			stream.getTracks().forEach(track => track.stop());
			registration.dispose();
			this.active.delete(id);
			const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
			const target = joinPath(this.folder(), `${stamp(new Date(startedAt))} ${slug(source.name)}.webm`);
			await this.fileService.writeFile(target, VSBuffer.wrap(new Uint8Array(await blob.arrayBuffer())));
			const done: IFinishedRecording = { id, path: target.fsPath, label: source.name, durationMs: Date.now() - startedAt, bytes: blob.size };
			this.finished.set(id, done);
			this._onDidFinish.fire(done);
			this.logService.info(`[volt-capture] saved recording ${done.path} (${Math.round(done.durationMs / 1000)}s)`);
			return done;
		});
		const recording: IVoltRecording = {
			id,
			label: source.name,
			startedAt,
			by: options.by,
			sessionId: options.sessionId,
			ownWindow: source.own,
			stop: async () => {
				if (recorder.state !== 'inactive') {
					recorder.stop();
				}
				await finished.catch(() => undefined);
			},
		};
		recorder.start(1000);
		// Read by `finished` once the recorder stops, which is always after these lines ran.
		const registration: IDisposable = this.status.add(recording);
		const stopTimer = win.setTimeout(() => void recording.stop(), seconds * 1000);
		this.active.set(id, { recording, finished, sessionId: options.sessionId });
		if (options.sessionId) {
			this.latest.set(options.sessionId, id);
		}
		this.latest.set('', id);
		return recording;
	}

	async stopRecording(id: string): Promise<IFinishedRecording> {
		const done = this.finished.get(id);
		if (done) {
			return done;
		}
		const active = this.active.get(id);
		if (!active) {
			throw new Error(`No recording with id ${id}.`);
		}
		await active.recording.stop();
		return active.finished;
	}

	whenFinished(id: string): Promise<IFinishedRecording> {
		const done = this.finished.get(id);
		if (done) {
			return Promise.resolve(done);
		}
		const active = this.active.get(id);
		return active ? active.finished : Promise.reject(new Error(`No recording with id ${id}.`));
	}

	latestRecording(sessionId?: string): string | undefined {
		return this.latest.get(sessionId ?? '') ?? this.latest.get('');
	}
}

registerSingleton(IVoltWindowCaptureService, VoltWindowCaptureService, InstantiationType.Delayed);

function sizeText(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Serves the window_* host tools. */
class VoltWindowCaptureContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltWindowCapture';

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IVoltWindowCaptureService private readonly windows: IVoltWindowCaptureService,
		@IVoltCaptureService private readonly capture: IVoltCaptureService,
	) {
		super();
		this._register(hostTools.registerToolProvider({
			tools: CAPTURE_TOOLS,
			invoke: (name, args, call) => this.invoke(name as VoltCaptureToolName, args, call).catch(err => ({ error: err instanceof Error ? err.message : String(err) })),
		}));
	}

	private async invoke(name: VoltCaptureToolName, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const window = typeof args.window === 'string' ? args.window : undefined;
		switch (name) {
			case 'window_list': {
				const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : '';
				const sources = (await this.windows.listSources()).filter(source => !filter || source.name.toLowerCase().includes(filter));
				const lines = ['### Windows and screens', ...sources.map(source => `- ${source.name} (id: ${source.id})${source.kind === 'screen' ? ' · screen' : ''}${source.own ? ' · Volt' : ''}`)];
				if (isMacintosh && !sources.some(source => !source.own && source.kind === 'window')) {
					lines.push('- Note: only Volt\'s own windows are listed. The user can allow Volt in System Settings > Privacy & Security > Screen & System Audio Recording to capture other apps.');
				}
				return { text: lines.join('\n') };
			}
			case 'window_capture': {
				const source = await this.windows.resolveSource(window);
				const maxSide = Math.max(256, Math.min(2560, typeof args.max_side === 'number' ? args.max_side : 1280));
				const image = await this.capture.capture(source.id, maxSide);
				const shot = await scaleScreenshot(`data:image/png;base64,${image.pngBase64}`, { maxSide, format: 'jpeg', quality: 0.85 });
				return { text: `### Captured ${image.source.name}\n- ${shot.width}×${shot.height} (${image.method})`, image: shot.dataUrl };
			}
			case 'window_record_start': {
				const source = await this.windows.resolveSource(window);
				const maxSeconds = typeof args.max_seconds === 'number' ? args.max_seconds : 60;
				const recording = await this.windows.startRecording(source, { maxSeconds, by: 'agent', sessionId: call?.sessionId });
				return { text: `### Recording ${source.name}\n- recording_id: ${recording.id}\n- Stops by itself after ${Math.min(MAX_RECORD_SECONDS, Math.max(1, maxSeconds))}s; call window_record_stop when done.` };
			}
			case 'window_record_stop': {
				const id = (typeof args.recording_id === 'string' && args.recording_id) || this.windows.latestRecording(call?.sessionId);
				if (!id) {
					return { error: 'No recording to stop. Start one with window_record_start.' };
				}
				const done = await this.windows.stopRecording(id);
				return { text: `### Saved recording of ${done.label}\n- Path: ${done.path}\n- Length: ${(done.durationMs / 1000).toFixed(1)}s, ${sizeText(done.bytes)} (WebM)` };
			}
		}
	}
}

registerWorkbenchContribution2(VoltWindowCaptureContribution.ID, VoltWindowCaptureContribution, WorkbenchPhase.AfterRestored);

interface ISourcePick extends IQuickPickItem {
	readonly source: IVoltCaptureSource;
}

async function pickSource(accessor: ServicesAccessor, placeholder: string): Promise<IVoltCaptureSource | undefined> {
	const windows = accessor.get(IVoltWindowCaptureService);
	const quickInput = accessor.get(IQuickInputService);
	const sources = windows.listSources().then(list => list.map((source): ISourcePick => ({
		label: source.name,
		description: source.kind === 'screen' ? localize('voltCapture.screen', "Screen") : source.own ? 'Volt' : undefined,
		source,
	})));
	const picked = await quickInput.pick(sources, { placeHolder: placeholder, matchOnDescription: true });
	return picked?.source;
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: CAPTURE_WINDOW_COMMAND_ID, title: localize2('voltCapture.captureWindow', "Capture Window Screenshot…"), category: localize2('volt', "Volt"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const capture = accessor.get(IVoltCaptureService);
		const notifications = accessor.get(INotificationService);
		const source = await pickSource(accessor, localize('voltCapture.pickCapture', "Window or screen to capture"));
		if (!source) {
			return;
		}
		try {
			const image = await capture.capture(source.id, 4096);
			const win = getActiveWindow() as Window & typeof globalThis;
			await win.navigator.clipboard.write([new win.ClipboardItem({ 'image/png': new Blob([decodeBase64(image.pngBase64).buffer as Uint8Array<ArrayBuffer>], { type: 'image/png' }) })]);
			notifications.info(localize('voltCapture.copied', "Screenshot of {0} copied to the clipboard ({1}×{2}).", image.source.name, image.width, image.height));
		} catch (err) {
			notifications.error(err instanceof Error ? err.message : String(err));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: RECORD_WINDOW_COMMAND_ID, title: localize2('voltCapture.recordWindow', "Record Window…"), category: localize2('volt', "Volt"), f1: true });
	}
	async run(accessor: ServicesAccessor, sourceId?: string): Promise<void> {
		const windows = accessor.get(IVoltWindowCaptureService);
		const notifications = accessor.get(INotificationService);
		const nativeHost = accessor.get(INativeHostService);
		const source = sourceId ? await windows.resolveSource(sourceId).catch(() => undefined) : await pickSource(accessor, localize('voltCapture.pickRecord', "Window or screen to record"));
		if (!source) {
			return;
		}
		try {
			const recording = await windows.startRecording(source, { maxSeconds: MAX_RECORD_SECONDS, by: 'user' });
			const done = await windows.whenFinished(recording.id).then(undefined, () => undefined);
			if (done) {
				notifications.prompt(Severity.Info, localize('voltCapture.saved', "Saved a {0}s recording of {1}.", Math.round(done.durationMs / 1000), done.label), [{
					label: isMacintosh ? localize('voltCapture.revealMac', "Reveal in Finder") : localize('voltCapture.reveal', "Show in Folder"),
					run: () => nativeHost.showItemInFolder(done.path),
				}]);
			}
		} catch (err) {
			notifications.error(err instanceof Error ? err.message : String(err));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: STOP_RECORDING_COMMAND_ID, title: localize2('voltCapture.stopRecording', "Stop Recording"), category: localize2('volt', "Volt"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await Promise.all(accessor.get(IVoltRecordingStatusService).recordings.map(recording => recording.stop()));
	}
});
