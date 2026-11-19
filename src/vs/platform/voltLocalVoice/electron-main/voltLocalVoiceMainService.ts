/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { net } from 'electron';
import { once } from 'events';
import { createWriteStream, promises as fs } from 'fs';
import { homedir } from 'os';
import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { delimiter, join } from '../../../base/common/path.js';
import { ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { Client as MessagePortClient } from '../../../base/parts/ipc/electron-main/ipc.mp.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { NullTelemetryService } from '../../telemetry/common/telemetryUtils.js';
import { UtilityProcess } from '../../utilityProcess/electron-main/utilityProcess.js';
import { ILocalVoice, ILocalVoiceDownload, ILocalVoiceModel, ILocalVoiceRequest, ILocalVoiceState, ILocalVoiceWorker, IVoltLocalVoiceService, LOCAL_VOICE_KEPT_TEXT, LOCAL_VOICE_MODEL_IDS, LOCAL_VOICE_MODELS, LOCAL_VOICE_RUNTIME_VERSION, LOCAL_VOICE_WORKER_CHANNEL, localVoice, LocalVoiceModelId, localVoiceRuntime } from '../common/voltLocalVoice.js';

/** The engine holds about 500 MB; it goes this long after the last sentence was asked for. */
const WORKER_IDLE_MS = 90_000;
/** Speech kept in memory, newest last: a sentence asked for again (a replayed reply, a sample) is not made twice. */
const MEMORY_CACHE_BYTES = 24 << 20;
/** Short lines kept on disk, at most this many files. */
const DISK_CACHE_FILES = 400;
const PROGRESS_EVERY_MS = 150;
const HASH_SLICE = 1 << 20;

interface IWorker {
	/** The model and, for Kokoro, the accent's dictionary: what a running engine can speak. */
	readonly key: string;
	readonly process: UtilityProcess;
	readonly service: ILocalVoiceWorker;
	readonly store: DisposableStore;
}

/** Throws unless `digest` matches `sha256-<hex>` or npm's `sha512-<base64>`. */
export function assertIntegrity(integrity: string, digest: Buffer, what: string): void {
	const [algorithm, expected] = [integrity.slice(0, integrity.indexOf('-')), integrity.slice(integrity.indexOf('-') + 1)];
	if (digest.toString(algorithm === 'sha256' ? 'hex' : 'base64') !== expected) {
		throw new Error(`${what} is not the file Volt expects (its ${algorithm} checksum differs). Nothing was installed.`);
	}
}

/**
 * Downloads, checks and unpacks the local voices on request, and speaks with them in a utility
 * process that loads the downloaded addon. Everything lives in `~/.volt/voices`, shared by every
 * profile and build.
 */
export class VoltLocalVoiceMainService extends Disposable implements IVoltLocalVoiceService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<ILocalVoiceState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly root = process.env['VOLT_LOCAL_VOICE_DIR'] || join(homedir(), '.volt', 'voices');
	private readonly runtime = localVoiceRuntime(process.platform, process.arch);
	private readonly runtimeDir = join(this.root, `sherpa-onnx-${LOCAL_VOICE_RUNTIME_VERSION}-${process.platform}-${process.arch}`);
	private readonly runtimeProbe = join(this.runtimeDir, 'sherpa-onnx.node');

	private readonly states = new Map<LocalVoiceModelId, ILocalVoiceState>();
	private readonly ready: Promise<void>;
	private readonly installing = new Map<LocalVoiceModelId, { readonly promise: Promise<void>; readonly abort: AbortController }>();
	/** Two models asked for at once share one runtime download. */
	private runtimeInstall: Promise<void> | undefined;
	private worker: IWorker | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** Sentences being spoken right now: the engine is not idle while there are any. */
	private speaking = 0;
	/** A call keeps the engine at least until then. */
	private heldUntil = 0;
	private readonly spoken = new Map<string, VSBuffer>();
	private spokenBytes = 0;
	/** The same sentence asked for twice at once is made once. */
	private readonly making = new Map<string, Promise<VSBuffer>>();

	constructor(
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.ready = this.readInstalled();
	}

	private modelDir(model: LocalVoiceModelId): string {
		return join(this.root, LOCAL_VOICE_MODELS[model].folder);
	}

	private cacheDir(model: LocalVoiceModelId): string {
		return join(this.modelDir(model), '.spoken');
	}

	private exists(path: string): Promise<boolean> {
		return fs.access(path).then(() => true, () => false);
	}

	private async totalBytes(model: LocalVoiceModelId): Promise<number> {
		return LOCAL_VOICE_MODELS[model].bytes + (await this.exists(this.runtimeProbe) ? 0 : this.runtime?.bytes ?? 0);
	}

	private async readInstalled(): Promise<void> {
		const runtime = this.runtime ? await this.exists(this.runtimeProbe) : false;
		for (const model of LOCAL_VOICE_MODEL_IDS) {
			const dir = this.modelDir(model);
			const present = runtime && (await Promise.all([join(dir, LOCAL_VOICE_MODELS[model].probe), join(dir, '.installed')].map(path => this.exists(path)))).every(Boolean);
			this.states.set(model, { model, status: !this.runtime ? 'unsupported' : present ? 'ready' : 'absent', totalBytes: await this.totalBytes(model) });
		}
	}

	private setState(state: ILocalVoiceState): void {
		this.states.set(state.model, state);
		this._onDidChangeState.fire(state);
	}

	private isReady(model: LocalVoiceModelId): boolean {
		return this.states.get(model)?.status === 'ready';
	}

	async getStates(): Promise<ILocalVoiceState[]> {
		await this.ready;
		return LOCAL_VOICE_MODEL_IDS.map(model => this.states.get(model)!);
	}

	async install(model: LocalVoiceModelId): Promise<void> {
		await this.ready;
		const runtime = this.runtime;
		if (!runtime || !LOCAL_VOICE_MODELS[model]) {
			throw new Error(`Local voices are not available on ${process.platform} ${process.arch}.`);
		}
		if (this.isReady(model)) {
			return;
		}
		let installing = this.installing.get(model);
		if (!installing) {
			const abort = new AbortController();
			const promise = this.download(LOCAL_VOICE_MODELS[model], runtime, abort.signal).then(
				async () => {
					this.setState({ model, status: 'ready', totalBytes: await this.totalBytes(model) });
					// The runtime is there now, so the other models' downloads got smaller.
					for (const other of LOCAL_VOICE_MODEL_IDS) {
						const state = this.states.get(other);
						if (other !== model && state?.status === 'absent') {
							this.setState({ ...state, totalBytes: await this.totalBytes(other) });
						}
					}
				},
				async error => {
					const cancelled = abort.signal.aborted;
					if (!cancelled) {
						this.logService.error('[local voice] install failed', error);
					}
					this.setState({ model, status: 'absent', totalBytes: await this.totalBytes(model), error: cancelled ? undefined : String(error?.message ?? error) });
					throw cancelled ? new CancellationError() : error;
				},
			).finally(() => this.installing.delete(model));
			installing = { promise, abort };
			this.installing.set(model, installing);
		}
		return installing.promise;
	}

	async cancelInstall(model: LocalVoiceModelId): Promise<void> {
		const installing = this.installing.get(model);
		if (installing) {
			installing.abort.abort();
			await installing.promise.catch(() => undefined);
		}
	}

	private async download(model: ILocalVoiceModel, runtime: ILocalVoiceDownload, signal: AbortSignal): Promise<void> {
		await fs.mkdir(this.root, { recursive: true });
		const scratch = await fs.mkdtemp(join(this.root, '.download-'));
		try {
			const needsRuntime = !this.runtimeInstall && !await this.exists(this.runtimeProbe);
			const total = model.bytes + (needsRuntime ? runtime.bytes : 0);
			let received = 0;
			let shown = 0;
			const progress = (bytes: number) => {
				received += bytes;
				const now = Date.now();
				if (now - shown >= PROGRESS_EVERY_MS) {
					shown = now;
					this.setState({ model: model.id, status: 'downloading', totalBytes: total, receivedBytes: Math.min(received, total) });
				}
			};
			this.setState({ model: model.id, status: 'downloading', totalBytes: total, receivedBytes: 0 });
			if (needsRuntime) {
				this.runtimeInstall = this.installRuntime(runtime, scratch, signal, progress).finally(() => this.runtimeInstall = undefined);
			}
			await this.runtimeInstall;
			const modelArchive = join(scratch, 'model.tar.bz2');
			await this.fetchFile(model, modelArchive, 'The voice model', signal, progress);

			this.setState({ model: model.id, status: 'installing', totalBytes: total });
			const modelOut = join(scratch, 'model');
			await fs.mkdir(modelOut);
			await this.untar(modelArchive, modelOut, signal);
			// The engine reads Kokoro's dictionaries; these two folders are for engines it no longer has.
			const unpacked = join(modelOut, model.folder);
			await fs.rm(join(unpacked, 'espeak-ng-data'), { recursive: true, force: true });
			await fs.rm(join(unpacked, 'dict'), { recursive: true, force: true });
			if (signal.aborted) {
				throw new CancellationError();
			}
			const dir = this.modelDir(model.id);
			if (this.worker?.key.startsWith(model.id)) {
				this.stopWorker();
			}
			await fs.rm(dir, { recursive: true, force: true });
			await fs.rename(unpacked, dir);
			await fs.writeFile(join(dir, '.installed'), `${model.folder}\n`);
		} finally {
			await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async installRuntime(runtime: ILocalVoiceDownload, scratch: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
		const archive = join(scratch, 'runtime.tgz');
		await this.fetchFile(runtime, archive, 'The speech runtime', signal, progress);
		const out = join(scratch, 'runtime');
		await fs.mkdir(out);
		await this.untar(archive, out, signal);
		this.stopWorker();
		await fs.rm(this.runtimeDir, { recursive: true, force: true });
		await fs.rename(join(out, 'package'), this.runtimeDir);
	}

	/** Streams `download` to `path`, counting bytes and checking size and checksum at the end. */
	private async fetchFile(download: ILocalVoiceDownload, path: string, what: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<void> {
		const response = await net.fetch(download.url, { signal });
		if (!response.ok || !response.body) {
			throw new Error(`${what} could not be downloaded (${response.status} ${response.statusText}).`);
		}
		const hash = createHash(download.integrity.startsWith('sha256-') ? 'sha256' : 'sha512');
		const file = createWriteStream(path);
		let bytes = 0;
		try {
			const reader = response.body.getReader();
			for (; ;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				bytes += value.byteLength;
				if (bytes > download.bytes) {
					await reader.cancel();
					break;
				}
				// The network hands over tens of megabytes at once; hashing that in one go stalls the main process.
				for (let offset = 0; offset < value.byteLength; offset += HASH_SLICE) {
					const slice = value.subarray(offset, offset + HASH_SLICE);
					hash.update(slice);
					progress(slice.byteLength);
					if (!file.write(slice)) {
						await once(file, 'drain');
					} else {
						await new Promise<void>(resolve => setImmediate(resolve));
					}
				}
			}
		} finally {
			await new Promise<void>(resolve => file.end(resolve));
		}
		if (bytes !== download.bytes) {
			throw new Error(`${what} is not the file Volt expects (${bytes} bytes, not ${download.bytes}). Nothing was installed.`);
		}
		assertIntegrity(download.integrity, hash.digest(), what);
	}

	private untar(archive: string, into: string, signal: AbortSignal): Promise<void> {
		// Windows' own tar (bsdtar): a Git Bash tar earlier on PATH reads `C:` as a remote host.
		const tar = process.platform === 'win32' ? join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
		return new Promise<void>((resolve, reject) => {
			execFile(tar, ['-xf', archive, '-C', into], { signal, windowsHide: true }, (error, _stdout, stderr) => {
				if (error) {
					reject(signal.aborted ? new CancellationError() : new Error(`Unpacking failed: ${stderr.trim() || error.message}`));
				} else {
					resolve();
				}
			});
		});
	}

	async remove(model: LocalVoiceModelId): Promise<void> {
		await this.ready;
		await this.cancelInstall(model);
		if (this.worker?.key.startsWith(model)) {
			this.stopWorker();
		}
		this.forget();
		await fs.rm(this.modelDir(model), { recursive: true, force: true });
		if (!this.runtime) {
			return;
		}
		this.setState({ model, status: 'absent', totalBytes: LOCAL_VOICE_MODELS[model].bytes });
		// The runtime goes with the last model, unless another is on its way.
		if (!LOCAL_VOICE_MODEL_IDS.some(id => this.isReady(id)) && !this.installing.size) {
			this.stopWorker();
			await fs.rm(this.runtimeDir, { recursive: true, force: true });
		}
		for (const id of LOCAL_VOICE_MODEL_IDS) {
			const state = this.states.get(id);
			if (state?.status === 'absent') {
				this.setState({ ...state, totalBytes: await this.totalBytes(id) });
			}
		}
	}

	async synthesize(request: ILocalVoiceRequest): Promise<VSBuffer> {
		await this.ready;
		const voice = localVoice(request.voice);
		if (!voice) {
			throw new Error(`Unknown voice ${request.voice}`);
		}
		if (!this.isReady(voice.model)) {
			throw new Error('This voice is not downloaded.');
		}
		const text = request.text.trim();
		const key = createHash('sha1').update(`${voice.ref}\n${request.speed || 1}\n${text}`).digest('hex');
		const kept = this.spoken.get(key);
		if (kept) {
			// Moved to the newest end.
			this.spoken.delete(key);
			this.spoken.set(key, kept);
			return kept;
		}
		let making = this.making.get(key);
		if (!making) {
			making = this.make(key, voice, { ...request, text }).finally(() => this.making.delete(key));
			this.making.set(key, making);
		}
		return making;
	}

	private async make(key: string, voice: ILocalVoice, request: ILocalVoiceRequest): Promise<VSBuffer> {
		const short = request.text.length <= LOCAL_VOICE_KEPT_TEXT;
		const cacheDir = this.cacheDir(voice.model);
		const file = join(cacheDir, `${key}.f32`);
		if (short) {
			const stored = await fs.readFile(file).catch(() => undefined);
			if (stored?.byteLength) {
				return this.keep(key, VSBuffer.wrap(stored));
			}
		}
		const worker = this.useWorker(voice);
		this.speaking++;
		clearTimeout(this.idleTimer);
		try {
			const audio = await worker.service.synthesize(request);
			if (short && audio.byteLength) {
				void this.store(cacheDir, file, audio);
			}
			return this.keep(key, audio);
		} catch (error) {
			if (!isCancellationError(error)) {
				this.logService.error('[local voice] reading failed', error);
			}
			if (this.worker === worker) {
				this.stopWorker();
			}
			throw error;
		} finally {
			this.speaking--;
			this.keepWorker();
		}
	}

	private keep(key: string, audio: VSBuffer): VSBuffer {
		this.spoken.set(key, audio);
		this.spokenBytes += audio.byteLength;
		for (const [oldest, buffer] of this.spoken) {
			if (this.spokenBytes <= MEMORY_CACHE_BYTES || oldest === key) {
				break;
			}
			this.spoken.delete(oldest);
			this.spokenBytes -= buffer.byteLength;
		}
		return audio;
	}

	private async store(cacheDir: string, file: string, audio: VSBuffer): Promise<void> {
		try {
			await fs.mkdir(cacheDir, { recursive: true });
			const names = await fs.readdir(cacheDir);
			if (names.length >= DISK_CACHE_FILES) {
				// Full: starts over instead of tracking which lines are used.
				await Promise.all(names.map(name => fs.rm(join(cacheDir, name), { force: true })));
			}
			await fs.writeFile(file, audio.buffer);
		} catch (error) {
			this.logService.trace('[local voice] a line was not kept', error);
		}
	}

	private forget(): void {
		this.spoken.clear();
		this.spokenBytes = 0;
	}

	async warm(voiceRef: string, holdMs = 0): Promise<void> {
		await this.ready;
		const voice = localVoice(voiceRef);
		if (!voice || !this.isReady(voice.model)) {
			return;
		}
		this.heldUntil = Math.max(this.heldUntil, Date.now() + Math.max(0, Math.min(holdMs, 10 * 60_000)));
		const worker = this.useWorker(voice);
		try {
			await worker.service.warm();
		} catch (error) {
			this.logService.warn('[local voice] the engine could not get ready', error);
		}
	}

	/** The engine for `voice`. One model is loaded at a time, and Kokoro's accents have a dictionary each, so changing either restarts the process. */
	private useWorker(voice: ILocalVoice): IWorker {
		const key = `${voice.model}:${voice.model === 'kokoro' ? voice.accent : ''}`;
		if (this.worker && this.worker.key !== key) {
			this.stopWorker();
		}
		if (!this.worker) {
			const store = new DisposableStore();
			const utilityProcess = store.add(new UtilityProcess(this.logService, NullTelemetryService, this.lifecycleMainService));
			const env: Record<string, string | undefined> = {
				...process.env,
				VOLT_LOCAL_VOICE_RUNTIME: this.runtimeDir,
				VOLT_LOCAL_VOICE_MODEL: this.modelDir(voice.model),
				VOLT_LOCAL_VOICE_MODEL_ID: voice.model,
				VOLT_LOCAL_VOICE_ACCENT: voice.accent,
			};
			if (process.platform === 'linux') {
				// The addon's own libraries sit beside it. (macOS and Windows find them there on their own.)
				env['LD_LIBRARY_PATH'] = [this.runtimeDir, process.env['LD_LIBRARY_PATH']].filter(Boolean).join(delimiter);
			}
			utilityProcess.start({
				type: 'voltLocalVoice',
				name: 'volt-local-voice',
				entryPoint: 'vs/platform/voltLocalVoice/node/localVoiceWorkerMain',
				// The addon is signed by its makers, not by Volt.
				allowLoadingUnsignedLibraries: true,
				env,
			});
			const client = store.add(new MessagePortClient(utilityProcess.connect(), 'voltLocalVoice'));
			const worker: IWorker = { key, process: utilityProcess, service: ProxyChannel.toService<ILocalVoiceWorker>(client.getChannel(LOCAL_VOICE_WORKER_CHANNEL)), store };
			const gone = (what: string) => {
				if (this.worker === worker) {
					this.logService.warn(`[local voice] the engine ${what}`);
					this.worker = undefined;
					store.dispose();
				}
			};
			store.add(utilityProcess.onExit(event => gone(`exited with code ${event.code}`)));
			store.add(utilityProcess.onCrash(event => gone(`crashed (${event.reason})`)));
			store.add(utilityProcess.onStderr(text => this.logService.info(`[local voice] ${text.trimEnd()}`)));
			store.add(utilityProcess.onStdout(text => this.logService.info(`[local voice] ${text.trimEnd()}`)));
			this.worker = worker;
		}
		this.keepWorker();
		return this.worker;
	}

	private keepWorker(): void {
		clearTimeout(this.idleTimer);
		if (!this.speaking) {
			this.idleTimer = setTimeout(() => this.stopWorker(), Math.max(WORKER_IDLE_MS, this.heldUntil - Date.now()));
		}
	}

	private stopWorker(): void {
		clearTimeout(this.idleTimer);
		const worker = this.worker;
		if (worker) {
			this.worker = undefined;
			worker.process.kill();
			worker.store.dispose();
		}
	}

	override dispose(): void {
		for (const installing of this.installing.values()) {
			installing.abort.abort();
		}
		this.stopWorker();
		super.dispose();
	}
}
