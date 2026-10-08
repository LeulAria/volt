/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IVoltSpeechEndpoint, IVoltSpeechEvent, IVoltSpeechService, IVoltSpeechStartOptions, transcriptionUrl, VoltSpeechEngine, VOLT_SPEECH_SAMPLE_RATE, wavFromPcm16 } from '../common/voltSpeech.js';
import { VOLT_SPEECH_HELPER_SOURCE } from './voltSpeechHelper.js';

const ENDPOINT_TIMEOUT_MS = 120_000;

interface IHelperProbe {
	readonly onDevice: boolean;
	readonly available: boolean;
}

interface IAppleSession {
	readonly kind: 'apple';
	readonly child: ChildProcessWithoutNullStreams;
	partial: string;
	/** `stop` closed the audio; the helper now owes a `final`. */
	ending: boolean;
	/** The session ended with an `error`, a `final` or a cancel, so nothing more is sent. */
	settled: boolean;
	stdout: string;
}

interface IEndpointSession {
	readonly kind: 'endpoint';
	readonly endpoint: IVoltSpeechEndpoint;
	readonly chunks: Uint8Array[];
}

type ISession = IAppleSession | IEndpointSession;

export class VoltSpeechMainService extends Disposable implements IVoltSpeechService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidEvent = this._register(new Emitter<IVoltSpeechEvent>());
	readonly onDidEvent = this._onDidEvent.event;

	private readonly sessions = new Map<string, ISession>();
	private readonly probes = new Map<string, Promise<IHelperProbe>>();
	private helper: Promise<string> | undefined;
	private readonly voiceDir: string;

	constructor(
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.voiceDir = join(environmentMainService.userDataPath, 'volt-speech');
	}

	async start(options: IVoltSpeechStartOptions): Promise<VoltSpeechEngine> {
		if (this.sessions.has(options.sessionId)) {
			throw new Error(`Dictation session ${options.sessionId} is already running.`);
		}
		if (process.platform === 'darwin') {
			const helper = await this.ensureHelper();
			const probe = await this.probe(helper, options.locale);
			if (probe.onDevice) {
				return this.startApple(options, helper, 'apple-on-device');
			}
			if (options.endpoint) {
				return this.startEndpoint(options.sessionId, options.endpoint);
			}
			if (probe.available) {
				return this.startApple(options, helper, 'apple');
			}
			throw new Error(`Speech recognition is not available for ${options.locale} on this Mac.`);
		}
		if (options.endpoint) {
			return this.startEndpoint(options.sessionId, options.endpoint);
		}
		throw new Error('Dictation needs a transcription endpoint on this platform. Set one in the agent settings.');
	}

	pushAudio(sessionId: string, pcmBase64: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return Promise.resolve();
		}
		const bytes = Buffer.from(pcmBase64, 'base64');
		if (session.kind === 'endpoint') {
			session.chunks.push(bytes);
		} else if (!session.ending && !session.settled) {
			session.child.stdin.write(bytes);
		}
		return Promise.resolve();
	}

	async stop(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		if (session.kind === 'apple') {
			session.ending = true;
			session.child.stdin.end();
			return;
		}
		this.sessions.delete(sessionId);
		await this.transcribeWithEndpoint(sessionId, session);
	}

	async cancel(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		this.sessions.delete(sessionId);
		if (session.kind === 'apple') {
			session.settled = true;
			session.child.kill('SIGTERM');
		}
	}

	override dispose(): void {
		for (const session of this.sessions.values()) {
			if (session.kind === 'apple') {
				session.settled = true;
				session.child.kill('SIGTERM');
			}
		}
		this.sessions.clear();
		super.dispose();
	}

	private startApple(options: IVoltSpeechStartOptions, helper: string, engine: 'apple' | 'apple-on-device'): VoltSpeechEngine {
		const args = ['--locale', options.locale];
		if (engine === 'apple-on-device') {
			args.push('--on-device');
		}
		const child = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		const session: IAppleSession = { kind: 'apple', child, partial: '', ending: false, settled: false, stdout: '' };
		this.sessions.set(options.sessionId, session);
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this.readAppleLines(options.sessionId, session, chunk));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => this.logService.trace('[volt-speech]', chunk.trim()));
		child.stdin.on('error', err => this.logService.trace('[volt-speech] stdin', err));
		child.on('close', code => {
			if (this.sessions.get(options.sessionId) === session) {
				this.sessions.delete(options.sessionId);
			}
			if (!session.settled) {
				session.settled = true;
				this.logService.trace(`[volt-speech] helper closed with ${code}`);
				this._onDidEvent.fire({ sessionId: options.sessionId, type: 'final', text: session.partial });
			}
		});
		return engine;
	}

	private readAppleLines(sessionId: string, session: IAppleSession, chunk: string): void {
		session.stdout += chunk;
		let newline = session.stdout.indexOf('\n');
		while (newline !== -1) {
			const line = session.stdout.slice(0, newline).trim();
			session.stdout = session.stdout.slice(newline + 1);
			newline = session.stdout.indexOf('\n');
			if (!line || session.settled) {
				continue;
			}
			let message: { type?: string; text?: string; message?: string };
			try {
				message = JSON.parse(line);
			} catch {
				this.logService.trace('[volt-speech] unreadable line', line);
				continue;
			}
			if (message.type === 'partial' && typeof message.text === 'string') {
				session.partial = message.text;
				this._onDidEvent.fire({ sessionId, type: 'partial', text: message.text });
			} else if (message.type === 'final') {
				session.settled = true;
				this.sessions.delete(sessionId);
				this._onDidEvent.fire({ sessionId, type: 'final', text: typeof message.text === 'string' ? message.text : session.partial, message: message.message });
			} else if (message.type === 'error') {
				session.settled = true;
				this.sessions.delete(sessionId);
				this._onDidEvent.fire({ sessionId, type: 'error', message: message.message ?? 'Speech recognition failed.' });
			}
		}
	}

	private startEndpoint(sessionId: string, endpoint: IVoltSpeechEndpoint): VoltSpeechEngine {
		transcriptionUrl(endpoint.baseUrl);
		this.sessions.set(sessionId, { kind: 'endpoint', endpoint, chunks: [] });
		return 'endpoint';
	}

	private async transcribeWithEndpoint(sessionId: string, session: IEndpointSession): Promise<void> {
		const pcm = Buffer.concat(session.chunks);
		try {
			const form = new FormData();
			form.append('file', new Blob([wavFromPcm16(pcm, VOLT_SPEECH_SAMPLE_RATE)], { type: 'audio/wav' }), 'dictation.wav');
			form.append('model', session.endpoint.model);
			const response = await fetch(transcriptionUrl(session.endpoint.baseUrl), { method: 'POST', body: form, signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS) });
			if (!response.ok) {
				throw new Error(`The transcription endpoint answered ${response.status}.`);
			}
			const body = await response.json() as { text?: unknown };
			this._onDidEvent.fire({ sessionId, type: 'final', text: typeof body.text === 'string' ? body.text.trim() : '' });
		} catch (err) {
			this.logService.warn('[volt-speech] endpoint transcription failed', err);
			this._onDidEvent.fire({ sessionId, type: 'error', message: err instanceof Error ? err.message : String(err) });
		}
	}

	private probe(helper: string, locale: string): Promise<IHelperProbe> {
		const cached = this.probes.get(locale);
		if (cached) {
			return cached;
		}
		const probe = new Promise<IHelperProbe>((resolve, reject) => {
			execFile(helper, ['--probe', '--locale', locale], { timeout: 15_000 }, (error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				const reply = stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('{')).pop() ?? '{}';
				try {
					const parsed = JSON.parse(reply) as { onDevice?: boolean; available?: boolean };
					resolve({ onDevice: parsed.onDevice === true, available: parsed.available === true });
				} catch (err) {
					reject(err);
				}
			});
		});
		this.probes.set(locale, probe);
		probe.catch(() => this.probes.delete(locale));
		return probe;
	}

	private ensureHelper(): Promise<string> {
		this.helper ??= this.buildHelper().catch(err => {
			this.helper = undefined;
			throw err;
		});
		return this.helper;
	}

	private async buildHelper(): Promise<string> {
		const hash = createHash('sha256').update(VOLT_SPEECH_HELPER_SOURCE).digest('hex').slice(0, 16);
		const dir = join(this.voiceDir, hash);
		const binary = join(dir, 'volt-speech');
		try {
			await fs.access(binary);
			return binary;
		} catch {
			// not built yet
		}
		await fs.mkdir(dir, { recursive: true });
		const source = join(dir, 'volt-speech.swift');
		const partial = join(dir, `volt-speech-${process.pid}.tmp`);
		await fs.writeFile(source, VOLT_SPEECH_HELPER_SOURCE, 'utf8');
		try {
			await new Promise<void>((resolve, reject) => execFile('xcrun', ['swiftc', '-O', '-swift-version', '5', source, '-o', partial], { timeout: 180_000 }, (error, _stdout, stderr) => {
				if (error) {
					this.logService.warn('[volt-speech] swiftc failed', stderr);
					reject(new Error('Could not build the speech helper. Install the Xcode command line tools (xcode-select --install).'));
					return;
				}
				resolve();
			}));
			await fs.rename(partial, binary);
		} finally {
			await fs.rm(partial, { force: true });
		}
		return binary;
	}
}
