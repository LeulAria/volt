/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import {
	IVoltVoiceCall, IVoltVoiceChatService, IVoltVoiceKeyStatus, IVoltVoiceMintRequest, IVoltVoiceSession, isVoiceCallId, isVoiceProvider, providerSpeed, VOLT_VOICE_PROVIDER_INFO,
	VOLT_VOICE_PROVIDERS, VoltVoiceProvider,
} from '../common/voltVoiceChat.js';

/** A call's socket secret lives an hour (xAI's limit); the client opens a new socket before then. */
const SECRET_SECONDS = 3600;
const MINT_TIMEOUT_MS = 15_000;
const MAX_LISTED_CALLS = 200;
const MAX_CALL_BYTES = 2 * 1024 * 1024;

type IKeyFile = Partial<Record<VoltVoiceProvider, string>>;

/**
 * Voice chat's side on the computer (the desktop's main process, or the agent server for the
 * browser and the phone): it keeps the realtime provider's API key (Volt's own, or one from the
 * environment), trades it for a short-lived secret the client opens its socket with, and keeps
 * call transcripts in `<dir>/calls`.
 */
export class VoltVoiceChatService implements IVoltVoiceChatService {

	declare readonly _serviceBrand: undefined;

	private writes: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly resolveEnv: () => Promise<NodeJS.ProcessEnv>,
		private readonly logService: ILogService,
		private readonly dir: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) { }

	async keyStatus(): Promise<readonly IVoltVoiceKeyStatus[]> {
		const saved = await this.readKeys();
		const env = await this.resolveEnv().catch(() => process.env);
		return VOLT_VOICE_PROVIDERS.map(provider => {
			if (saved[provider]) {
				return { provider, source: 'saved' };
			}
			const envKey = VOLT_VOICE_PROVIDER_INFO[provider].envKeys.find(name => env[name]?.trim());
			return envKey ? { provider, source: 'env', envKey } : { provider, source: undefined };
		});
	}

	async setKey(provider: VoltVoiceProvider, key: string | undefined): Promise<void> {
		if (!isVoiceProvider(provider)) {
			throw new Error('Unknown voice provider.');
		}
		const value = key?.trim();
		if (value && (value.length > 512 || /\s/.test(value))) {
			throw new Error('That does not look like an API key.');
		}
		await this.serialize(async () => {
			const keys = await this.readKeys();
			if (value) {
				keys[provider] = value;
			} else {
				delete keys[provider];
			}
			await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
			const file = join(this.dir, 'keys.json');
			await fs.writeFile(file, JSON.stringify(keys, undefined, '\t'), { mode: 0o600 });
			await fs.chmod(file, 0o600);
		});
	}

	async mint(request: IVoltVoiceMintRequest): Promise<IVoltVoiceSession> {
		const provider = request.provider;
		if (!isVoiceProvider(provider)) {
			throw new Error('Unknown voice provider.');
		}
		if (provider === 'local') {
			throw new Error('A voice chat on this computer opens no connection, so it needs no secret.');
		}
		const key = await this.key(provider);
		if (provider === 'custom') {
			const url = request.url?.trim() ?? '';
			if (!/^wss?:\/\/[^\s]+$/i.test(url)) {
				throw new Error('Set a ws:// or wss:// URL for the custom voice server.');
			}
			return { provider, url, protocols: key ? [`xai-client-secret.${key}`] : [], expiresAt: Date.now() + SECRET_SECONDS * 1000, model: '' };
		}
		const info = VOLT_VOICE_PROVIDER_INFO[provider];
		if (!key) {
			throw new Error(`Voice chat needs an ${provider === 'xai' ? 'xAI' : 'OpenAI'} API key. Add one in Volt Settings > Voice, or set ${info.envKeys[0]}.`);
		}
		const body = provider === 'xai'
			? { expires_after: { seconds: SECRET_SECONDS } }
			: { expires_after: { anchor: 'created_at', seconds: SECRET_SECONDS }, session: { type: 'realtime', model: info.model } };
		const endpoint = provider === 'xai' ? 'https://api.x.ai/v1/realtime/client_secrets' : 'https://api.openai.com/v1/realtime/client_secrets';
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
		let response: Response;
		try {
			response = await this.fetchImpl(endpoint, {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (err) {
			throw new Error(`Could not reach ${info.label}: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			clearTimeout(timer);
		}
		const text = await response.text();
		if (!response.ok) {
			this.logService.warn(`[volt voice] ${provider} client secret failed: HTTP ${response.status}`);
			throw new Error(mintError(info.label, response.status, text));
		}
		const json = parseRecord(text);
		const nested = json?.client_secret && typeof json.client_secret === 'object' ? json.client_secret as Record<string, unknown> : undefined;
		const value = typeof json?.value === 'string' ? json.value : typeof nested?.value === 'string' ? nested.value : undefined;
		const expires = typeof json?.expires_at === 'number' ? json.expires_at : typeof nested?.expires_at === 'number' ? nested.expires_at : undefined;
		if (!value) {
			throw new Error(`${info.label} did not return a session secret.`);
		}
		return {
			provider,
			url: info.url,
			protocols: provider === 'xai' ? [`xai-client-secret.${value}`] : ['realtime', `openai-insecure-api-key.${value}`],
			expiresAt: expires ? expires * 1000 : Date.now() + SECRET_SECONDS * 1000,
			model: info.model,
		};
	}

	async previewVoice(provider: VoltVoiceProvider, voice: string, speed: number): Promise<{ readonly mime: string; readonly base64: string }> {
		if (provider !== 'xai' && provider !== 'openai') {
			throw new Error('Voice previews need xAI or OpenAI.');
		}
		if (!/^[a-z0-9_-]{1,40}$/i.test(voice)) {
			throw new Error('Unknown voice.');
		}
		const key = await this.key(provider);
		if (!key) {
			throw new Error(`Add an ${provider === 'xai' ? 'xAI' : 'OpenAI'} API key to hear voice previews.`);
		}
		const text = 'This is a voice preview.';
		const [endpoint, body] = provider === 'xai'
			? ['https://api.x.ai/v1/tts', { text, voice_id: voice.toLowerCase(), language: 'auto', output_format: { codec: 'mp3' }, speed: providerSpeed(provider, speed) }]
			: ['https://api.openai.com/v1/audio/speech', { model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'mp3', speed: providerSpeed(provider, speed) }];
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
		try {
			const response = await this.fetchImpl(endpoint, {
				method: 'POST',
				headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(mintError(VOLT_VOICE_PROVIDER_INFO[provider].label, response.status, await response.text()));
			}
			const bytes = Buffer.from(await response.arrayBuffer());
			if (!bytes.length) {
				throw new Error('The voice preview came back empty.');
			}
			return { mime: 'audio/mpeg', base64: bytes.toString('base64') };
		} finally {
			clearTimeout(timer);
		}
	}

	async saveCall(call: IVoltVoiceCall): Promise<void> {
		if (!isVoiceCallId(call?.id)) {
			throw new Error('Invalid call id.');
		}
		const text = JSON.stringify(call);
		if (text.length > MAX_CALL_BYTES) {
			throw new Error('The call transcript is too large to save.');
		}
		await this.serialize(async () => {
			await fs.mkdir(join(this.dir, 'calls'), { recursive: true, mode: 0o700 });
			const file = join(this.dir, 'calls', `${call.id}.json`);
			const temp = `${file}.${process.pid}.tmp`;
			await fs.writeFile(temp, text, { mode: 0o600 });
			await fs.rename(temp, file);
		});
	}

	async getCall(id: string): Promise<IVoltVoiceCall | undefined> {
		if (!isVoiceCallId(id)) {
			return undefined;
		}
		try {
			return readCall(await fs.readFile(join(this.dir, 'calls', `${id}.json`), 'utf8'));
		} catch {
			return undefined;
		}
	}

	async listCalls(chatId?: string): Promise<readonly IVoltVoiceCall[]> {
		let names: string[];
		try {
			names = (await fs.readdir(join(this.dir, 'calls'))).filter(name => name.endsWith('.json'));
		} catch {
			return [];
		}
		const calls: IVoltVoiceCall[] = [];
		await Promise.all(names.map(async name => {
			try {
				const call = readCall(await fs.readFile(join(this.dir, 'calls', name), 'utf8'));
				if (call && (!chatId || call.chatIds.includes(chatId) || call.originChatId === chatId)) {
					calls.push(call);
				}
			} catch {
				// A file being written or removed.
			}
		}));
		calls.sort((a, b) => a.startedAt - b.startedAt);
		return chatId ? calls : calls.slice(-MAX_LISTED_CALLS);
	}

	private async key(provider: VoltVoiceProvider): Promise<string | undefined> {
		const saved = (await this.readKeys())[provider];
		if (saved) {
			return saved;
		}
		const env = await this.resolveEnv().catch(() => process.env);
		for (const name of VOLT_VOICE_PROVIDER_INFO[provider].envKeys) {
			const value = env[name]?.trim();
			if (value) {
				return value;
			}
		}
		return undefined;
	}

	private async readKeys(): Promise<IKeyFile> {
		try {
			const json = parseRecord(await fs.readFile(join(this.dir, 'keys.json'), 'utf8'));
			const keys: IKeyFile = {};
			for (const provider of VOLT_VOICE_PROVIDERS) {
				if (typeof json?.[provider] === 'string' && json[provider]) {
					keys[provider] = json[provider] as string;
				}
			}
			return keys;
		} catch {
			return {};
		}
	}

	private serialize<T>(task: () => Promise<T>): Promise<T> {
		const next = this.writes.then(task, task);
		this.writes = next.catch(() => undefined);
		return next;
	}
}

function parseRecord(text: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function readCall(text: string): IVoltVoiceCall | undefined {
	const json = parseRecord(text);
	if (!json || !isVoiceCallId(json.id) || typeof json.startedAt !== 'number' || !Array.isArray(json.turns) || !Array.isArray(json.chatIds)) {
		return undefined;
	}
	return json as unknown as IVoltVoiceCall;
}

/** The provider's error message when it sent one (never the key), else the status. */
export function mintError(label: string, status: number, body: string): string {
	const json = parseRecord(body);
	const error = json?.error;
	const message = typeof error === 'string' ? error
		: error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string' ? (error as Record<string, unknown>).message as string
			: undefined;
	if (status === 401 || status === 403) {
		return `${label} rejected the API key${message ? `: ${message}` : '.'}`;
	}
	return `${label} could not start a voice session (HTTP ${status})${message ? `: ${message}` : '.'}`;
}
