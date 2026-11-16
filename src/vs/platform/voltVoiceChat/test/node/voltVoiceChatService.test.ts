/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IVoltVoiceCall } from '../../common/voltVoiceChat.js';
import { mintError, VoltVoiceChatService } from '../../node/voltVoiceChatService.js';

interface IRecordedRequest {
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: unknown;
}

function fakeFetch(respond: (request: IRecordedRequest) => { status: number; body: string | Uint8Array }, seen: IRecordedRequest[]): typeof fetch {
	return (async (url: string, init: RequestInit) => {
		const request = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
		seen.push(request);
		const { status, body } = respond(request);
		return new Response(body as BodyInit, { status });
	}) as unknown as typeof fetch;
}

function call(id: string, chatIds: string[], startedAt: number): IVoltVoiceCall {
	return { id, startedAt, status: 'ended', provider: 'xai', voice: 'ara', chatIds, turns: [{ id: 't1', role: 'user', text: 'hi', at: startedAt }] };
}

suite('Volt voice chat service', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	setup(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'volt-voice-test-'));
	});
	teardown(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test('a saved key wins over the environment, and removing it falls back', async () => {
		const service = new VoltVoiceChatService(async () => ({ XAI_API_KEY: 'env-key' }), new NullLogService(), dir);
		assert.deepStrictEqual((await service.keyStatus()).find(s => s.provider === 'xai'), { provider: 'xai', source: 'env', envKey: 'XAI_API_KEY' });
		await service.setKey('xai', 'saved-key');
		assert.strictEqual((await service.keyStatus()).find(s => s.provider === 'xai')?.source, 'saved');
		const stat = await fs.stat(join(dir, 'keys.json'));
		assert.strictEqual(stat.mode & 0o777, 0o600);
		await service.setKey('xai', undefined);
		assert.strictEqual((await service.keyStatus()).find(s => s.provider === 'xai')?.source, 'env');
		await assert.rejects(service.setKey('xai', 'has a space'));
	});

	test('mints an xAI client secret and hands back only the subprotocol', async () => {
		const seen: IRecordedRequest[] = [];
		const service = new VoltVoiceChatService(async () => ({}), new NullLogService(), dir, fakeFetch(() => ({ status: 200, body: JSON.stringify({ value: 'secret-1', expires_at: 2_000_000_000 }) }), seen));
		await assert.rejects(service.mint({ provider: 'xai' }), /needs an xAI API key/);
		await service.setKey('xai', 'xai-key');
		const session = await service.mint({ provider: 'xai' });
		assert.strictEqual(seen[0].url, 'https://api.x.ai/v1/realtime/client_secrets');
		assert.strictEqual(seen[0].headers.Authorization, 'Bearer xai-key');
		assert.deepStrictEqual(seen[0].body, { expires_after: { seconds: 3600 } });
		assert.deepStrictEqual(session.protocols, ['xai-client-secret.secret-1']);
		assert.strictEqual(session.url, 'wss://api.x.ai/v1/realtime?model=grok-voice-latest');
		assert.strictEqual(session.expiresAt, 2_000_000_000_000);
		assert.ok(!JSON.stringify(session).includes('xai-key'));
	});

	test('mints an OpenAI client secret with the realtime session', async () => {
		const seen: IRecordedRequest[] = [];
		const service = new VoltVoiceChatService(async () => ({ OPENAI_API_KEY: 'sk-env' }), new NullLogService(), dir, fakeFetch(() => ({ status: 200, body: JSON.stringify({ value: 'ek_1', expires_at: 1 }) }), seen));
		const session = await service.mint({ provider: 'openai' });
		assert.strictEqual(seen[0].headers.Authorization, 'Bearer sk-env');
		assert.deepStrictEqual(seen[0].body, { expires_after: { anchor: 'created_at', seconds: 3600 }, session: { type: 'realtime', model: 'gpt-realtime' } });
		assert.deepStrictEqual(session.protocols, ['realtime', 'openai-insecure-api-key.ek_1']);
	});

	test('a rejected key says so without echoing it', async () => {
		const service = new VoltVoiceChatService(async () => ({ XAI_API_KEY: 'bad-key' }), new NullLogService(), dir, fakeFetch(() => ({ status: 401, body: JSON.stringify({ error: 'Incorrect API key' }) }), []));
		await assert.rejects(service.mint({ provider: 'xai' }), (err: Error) => /rejected the API key: Incorrect API key/.test(err.message) && !err.message.includes('bad-key'));
		assert.strictEqual(mintError('OpenAI Realtime', 429, '{"error":{"message":"Rate limited"}}'), 'OpenAI Realtime could not start a voice session (HTTP 429): Rate limited');
	});

	test('a custom server needs a ws URL and no key', async () => {
		const service = new VoltVoiceChatService(async () => ({}), new NullLogService(), dir);
		await assert.rejects(service.mint({ provider: 'custom', url: 'http://example.com' }), /ws:\/\/ or wss:\/\//);
		const session = await service.mint({ provider: 'custom', url: 'ws://127.0.0.1:9975/v1/realtime' });
		assert.deepStrictEqual(session.protocols, []);
		assert.strictEqual(session.url, 'ws://127.0.0.1:9975/v1/realtime');
	});

	test('previews a voice through xAI text to speech', async () => {
		const seen: IRecordedRequest[] = [];
		const service = new VoltVoiceChatService(async () => ({ XAI_API_KEY: 'k' }), new NullLogService(), dir, fakeFetch(() => ({ status: 200, body: new Uint8Array([1, 2, 3]) }), seen));
		const clip = await service.previewVoice('xai', 'Ara', 2);
		assert.deepStrictEqual(seen[0].body, { text: 'This is a voice preview.', voice_id: 'ara', language: 'auto', output_format: { codec: 'mp3' }, speed: 1.5 });
		assert.deepStrictEqual(clip, { mime: 'audio/mpeg', base64: 'AQID' });
		await assert.rejects(service.previewVoice('xai', '../etc', 1));
	});

	test('keeps calls and lists those of a chat', async () => {
		const service = new VoltVoiceChatService(async () => ({}), new NullLogService(), dir);
		await service.saveCall(call('call-aaaaaaaa', ['chat-1'], 2));
		await service.saveCall(call('call-bbbbbbbb', ['chat-2', 'chat-1'], 1));
		await service.saveCall(call('call-cccccccc', ['chat-2'], 3));
		assert.deepStrictEqual((await service.listCalls('chat-1')).map(c => c.id), ['call-bbbbbbbb', 'call-aaaaaaaa']);
		assert.deepStrictEqual((await service.listCalls()).map(c => c.id), ['call-bbbbbbbb', 'call-aaaaaaaa', 'call-cccccccc']);
		assert.strictEqual((await service.getCall('call-cccccccc'))?.turns[0].text, 'hi');
		assert.strictEqual(await service.getCall('../keys'), undefined);
		await assert.rejects(service.saveCall({ ...call('call-dddddddd', [], 1), id: '../../x' }));
	});
});
