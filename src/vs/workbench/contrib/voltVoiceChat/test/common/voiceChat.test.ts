/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { floatToPcm16Base64, parseServerEvent, pcm16Base64ToFloat, resampleTo, sessionUpdate } from '../../common/realtimeProtocol.js';
import { recentLines, searchConversations, spokenAnswer, VOICE_TOOLS, voiceInstructions, workLandedNote } from '../../common/voiceAgent.js';

suite('Volt voice chat: realtime protocol', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const config = { instructions: 'be brief', voice: 'ara', speed: 2, language: 'de', tools: VOICE_TOOLS.slice(0, 1) };

	test('xAI keeps voice and turn detection at the top and transcribes with grok-transcribe', () => {
		const update = sessionUpdate({ ...config, provider: 'xai' }) as { session: Record<string, any> };
		assert.strictEqual(update.session.voice, 'ara');
		assert.deepStrictEqual(update.session.turn_detection, { type: 'server_vad' });
		assert.deepStrictEqual(update.session.audio.input, { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'grok-transcribe', language_hint: 'de' } });
		// xAI takes 0.7 to 1.5.
		assert.strictEqual(update.session.audio.output.speed, 1.5);
		assert.deepStrictEqual(update.session.tools[0].type, 'function');
		assert.strictEqual(update.session.tools[0].name, 'send_task');
	});

	test('OpenAI nests voice and turn detection under audio', () => {
		const update = sessionUpdate({ ...config, provider: 'openai', language: 'pt-BR' }) as { session: Record<string, any> };
		assert.strictEqual(update.session.type, 'realtime');
		assert.strictEqual(update.session.audio.output.voice, 'ara');
		assert.strictEqual(update.session.audio.input.turn_detection.type, 'server_vad');
		assert.strictEqual(update.session.audio.input.transcription.language, 'pt');
		assert.strictEqual(update.session.tool_choice, 'auto');
	});

	test('normalizes server events from either provider', () => {
		const draft = new Map<string, string>();
		assert.deepStrictEqual(parseServerEvent({ type: 'session.updated' }, draft), [{ type: 'ready' }]);
		assert.deepStrictEqual(parseServerEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', delta: 'Hel' }, draft), [{ type: 'userTranscript', itemId: 'u1', text: 'Hel', final: false }]);
		assert.deepStrictEqual(parseServerEvent({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', delta: 'lo' }, draft), [{ type: 'userTranscript', itemId: 'u1', text: 'Hello', final: false }]);
		assert.deepStrictEqual(parseServerEvent({ type: 'conversation.item.input_audio_transcription.updated', item_id: 'u2', transcript: 'Hi th' }, draft), [{ type: 'userTranscript', itemId: 'u2', text: 'Hi th', final: false }]);
		assert.deepStrictEqual(parseServerEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: ' Hello. ' }, draft), [{ type: 'userTranscript', itemId: 'u1', text: 'Hello.', final: true }]);
		assert.strictEqual(draft.has('u1'), false);
		assert.deepStrictEqual(parseServerEvent({ type: 'response.audio.delta', item_id: 'a', delta: 'AAA=' }, draft), [{ type: 'audio', itemId: 'a', base64: 'AAA=' }]);
		assert.deepStrictEqual(parseServerEvent({ type: 'response.output_audio_transcript.delta', item_id: 'a', delta: 'Sure' }, draft), [{ type: 'assistantTranscript', itemId: 'a', delta: 'Sure' }]);
		assert.deepStrictEqual(parseServerEvent({ type: 'response.function_call_arguments.done', call_id: 'c', name: 'send_task', arguments: '{"request":"x"}' }, draft), [{ type: 'functionCall', callId: 'c', name: 'send_task', arguments: '{"request":"x"}' }]);
		assert.deepStrictEqual(parseServerEvent({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c', name: 'stay_silent' } }, draft), [{ type: 'functionCall', callId: 'c', name: 'stay_silent', arguments: '{}' }]);
		assert.deepStrictEqual(parseServerEvent({ type: 'response.done', response: { id: 'r', status: 'cancelled' } }, draft), [{ type: 'responseDone', responseId: 'r', cancelled: true }]);
		assert.deepStrictEqual(parseServerEvent({ type: 'error', error: { message: 'Bad voice', code: 'invalid' } }, draft), [{ type: 'error', message: 'Bad voice', code: 'invalid' }]);
		assert.deepStrictEqual(parseServerEvent({ type: 'rate_limits.updated' }, draft), []);
		assert.deepStrictEqual(parseServerEvent('nope', draft), []);
	});

	test('PCM16 round-trips and resamples to 24 kHz', () => {
		const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
		const back = pcm16Base64ToFloat(floatToPcm16Base64(samples));
		assert.deepStrictEqual(Array.from(back).map(v => Math.round(v * 1000) / 1000), [0, 0.5, -0.5, 1, -1]);
		const resampled = resampleTo(new Float32Array(4800).fill(0.25), 48000);
		assert.strictEqual(resampled.length, 2400);
		assert.strictEqual(resampled[10], 0.25);
	});
});

suite('Volt voice chat: voice agent', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('instructions name the chat, the language and the surface', () => {
		const text = voiceInstructions({ chatTitle: 'Math helpers', projectName: 'proj', language: 'German', recent: ['User: add subtract'], now: new Date(2026, 10, 16, 15, 4), surface: 'desk' });
		assert.ok(text.includes('the chat "Math helpers" in the project proj'));
		assert.ok(text.includes('Speak and listen in German.'));
		assert.ok(text.includes('User: add subtract'));
		assert.ok(text.includes('Today is 2026-11-16.'));
		assert.ok(!text.includes('\n\n\n'));
		const fresh = voiceInstructions({ now: new Date(), surface: 'phone' });
		assert.ok(fresh.includes('the first job you send starts one'));
		assert.ok(fresh.includes('20 to 30 words'));
	});

	test('work landed notes say what came back, and never invent a result', () => {
		assert.strictEqual(workLandedNote('add subtract', 'done', 'Added subtract(a, b).', false), 'work_landed: This answers "add subtract": Added subtract(a, b).');
		assert.match(workLandedNote('add subtract', 'failed', 'boom', false), /hit an error: boom\. Say that it failed, and do not invent a result\./);
		assert.match(workLandedNote(undefined, 'needs-user', undefined, false), /needs the person in the chat/);
		assert.match(workLandedNote('x', 'done', undefined, false), /finished without a written reply/);
		assert.match(workLandedNote('what is 2+2', 'done', '4', true), /They typed in the chat: "what is 2\+2"\. They are on this call/);
	});

	test('the spoken answer drops tool blocks and keeps the end of the reply', () => {
		const reply = 'I will look first.\n\nuse_tool\n{"tool_name":"volt__code_nav","tool_input":{}}\n\n{"variant":"x"}\n\nAdded `subtract` after `add` in math.js.';
		assert.strictEqual(spokenAnswer(reply), 'I will look first.\n\nAdded `subtract` after `add` in math.js.');
		assert.strictEqual(spokenAnswer('a'.repeat(50) + '\n\n' + 'b'.repeat(30), 40), 'b'.repeat(30));
	});

	test('recent lines skip filler and stay within budget', () => {
		const lines = recentLines([
			{ speaker: 'User', text: 'old line that will not fit' },
			{ speaker: 'Volt', text: 'ok' },
			{ speaker: 'User', text: 'add a subtract function' },
			{ speaker: 'Volt', text: 'Added it.' },
		], 50);
		assert.deepStrictEqual(lines, ['User: add a subtract function', 'Volt: Added it.']);
	});

	test('search ranks matching lines and says where they were', () => {
		const now = new Date(2026, 10, 16, 12).getTime();
		const result = searchConversations([
			{ id: 'a', where: 'this chat', writer: 'them', text: 'Use port 9975 for the mock server', at: now - 1000 },
			{ id: 'b', where: 'an earlier call', writer: 'you', text: 'The deploy finished', at: now - 86_400_000 },
			{ id: 'c', where: 'an earlier call', writer: 'them', text: 'what port does the mock use', at: now - 3 * 86_400_000 },
		], 'mock port', now);
		const hits = result.hits as { id: string; when: string; where: string }[];
		assert.deepStrictEqual(hits.map(hit => hit.id), ['c', 'a']);
		assert.strictEqual(hits[0].when, '3 days ago');
		assert.strictEqual(hits[1].when, 'earlier today');
		assert.deepStrictEqual(searchConversations([], 'the of', now), { hits: [], more: false });
	});
});
