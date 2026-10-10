/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestContext, IRequestOptions } from '../../../../../base/parts/request/common/request.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { GeminiProvider, geminiModelThinks } from '../../browser/providers/gemini.js';
import { OllamaProvider } from '../../browser/providers/ollama.js';
import { createCompatProvider, createOpenRouterProvider } from '../../browser/providers/openaiCompat.js';
import { adaptModelStream } from '../../common/deepseek/llmAdapter.js';
import { StreamChunk } from '../../common/deepseek/protocol.js';
import { IVoltEvent } from '../../common/events.js';
import { toOpenAiMessages } from '../../common/harness/providerMessages.js';
import { IModelProvider, IModelRequest } from '../../common/providers.js';
import { IProviderProfile } from '../../common/profiles.js';

interface IRoute {
	readonly match: (url: string) => boolean;
	readonly status?: number;
	readonly body: string;
}

/** The request body fields these tests read. */
interface ISentBody {
	readonly reasoning?: unknown;
	readonly reasoning_effort?: unknown;
	readonly think?: unknown;
	readonly generationConfig?: unknown;
}

/** Answers each request from the first matching route and keeps what was sent. */
function fakeRequests(routes: readonly IRoute[]): { service: IRequestService; sent: IRequestOptions[] } {
	const sent: IRequestOptions[] = [];
	const service = {
		_serviceBrand: undefined,
		async request(options: IRequestOptions): Promise<IRequestContext> {
			sent.push(options);
			const route = routes.find(candidate => candidate.match(options.url ?? ''));
			return {
				res: { statusCode: route?.status ?? (route ? 200 : 404), headers: {} },
				stream: bufferToStream(VSBuffer.fromString(route?.body ?? '')),
			};
		},
		resolveProxy: async () => undefined,
		lookupAuthorization: async () => undefined,
		lookupKerberosAuthorization: async () => undefined,
		loadCertificates: async () => [],
	} satisfies IRequestService;
	return { service, sent };
}

function profile(providerId: string): IProviderProfile {
	return { id: `${providerId}-test`, label: providerId, kind: 'model', providerId, enabled: true, transport: 'http', authKind: 'apikey', hasSecret: false };
}

async function collect(provider: IModelProvider, request: Partial<IModelRequest> & { modelId: string }): Promise<IVoltEvent[]> {
	const events: IVoltEvent[] = [];
	for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }], profile: profile(provider.id), ...request }, CancellationToken.None)) {
		events.push(event);
	}
	return events;
}

function sse(chunks: readonly object[]): string {
	return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function thought(events: readonly IVoltEvent[]): string {
	return events.filter(event => event.type === 'reasoning.delta').map(event => event.type === 'reasoning.delta' ? event.delta : '').join('');
}

function types(events: readonly IVoltEvent[]): string[] {
	return events.map(event => event.type).filter(type => type !== 'usage');
}

suite('Volt provider reasoning', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reasoning_content streams as a thought and closes as a replayable block before the reply', async () => {
		const { service } = fakeRequests([{
			match: url => url.endsWith('/chat/completions'),
			body: sse([
				{ choices: [{ delta: { reasoning_content: 'Let me ' } }] },
				{ choices: [{ delta: { reasoning_content: 'check.' } }] },
				{ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] },
			]),
		}]);
		const events = await collect(createCompatProvider(service), { modelId: 'deepseek-reasoner' });
		assert.strictEqual(thought(events), 'Let me check.');
		assert.deepStrictEqual(types(events), ['reasoning.start', 'reasoning.delta', 'reasoning.delta', 'reasoning.end', 'reasoning.block', 'text.start', 'text.delta', 'text.end', 'finish']);
		const block = events.find(event => event.type === 'reasoning.block');
		assert.deepStrictEqual(block, { type: 'reasoning.block', provider: 'openai-compat', model: 'deepseek-reasoner', text: 'Let me check.', opaque: { reasoning_content: 'Let me check.' } });
	});

	test('the native loop stores the block so a tool-call turn hands reasoning_content back', async () => {
		const { service } = fakeRequests([{
			match: url => url.endsWith('/chat/completions'),
			body: sse([
				{ choices: [{ delta: { reasoning_content: 'Need the file.' } }] },
				{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }, finish_reason: 'tool_calls' }] },
			]),
		}]);
		const chunks: StreamChunk[] = [];
		for await (const chunk of adaptModelStream(createCompatProvider(service).stream({ modelId: 'deepseek-chat', messages: [], profile: profile('openai-compat') }, CancellationToken.None))) {
			chunks.push(chunk);
		}
		const sealed = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning');
		assert.ok(sealed && sealed.type === 'block-end' && sealed.block.type === 'reasoning');
		assert.strictEqual(sealed.block.provider, 'openai-compat');
		assert.deepStrictEqual(sealed.block.opaque, { reasoning_content: 'Need the file.' });

		const replay = toOpenAiMessages([
			{ role: 'user', content: 'read a' },
			{
				role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }],
				parts: [{ type: 'reasoning', block: { provider: 'openai-compat', model: 'deepseek-chat', text: 'Need the file.', opaque: { reasoning_content: 'Need the file.' } } }, { type: 'tool_call', callId: 'call_1' }],
			},
			{ role: 'tool', content: 'x', callId: 'call_1', name: 'read_file' },
		], { reasoning: { provider: 'openai-compat', model: 'deepseek-chat' } });
		assert.strictEqual((replay[1] as { reasoning_content?: string }).reasoning_content, 'Need the file.');
		const otherModel = toOpenAiMessages([
			{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 't', arguments: '{}' }], parts: [{ type: 'reasoning', block: { provider: 'openai-compat', model: 'deepseek-chat', text: 'x', opaque: { reasoning_content: 'x' } } }] },
		], { reasoning: { provider: 'openai-compat', model: 'other' } });
		assert.strictEqual('reasoning_content' in (otherModel[0] as object), false);
	});

	test('OpenRouter delta.reasoning is read and reasoning_details are kept for replay', async () => {
		const { service, sent } = fakeRequests([{
			match: url => url.endsWith('/chat/completions'),
			body: sse([
				{ choices: [{ delta: { reasoning: 'Plan ', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'Plan ' }] } }] },
				{ choices: [{ delta: { reasoning: 'it.', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'it.', signature: 'sig' }] } }] },
				{ choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }] },
			]),
		}]);
		const events = await collect(createOpenRouterProvider(service), { modelId: 'anthropic/claude-sonnet-4' });
		assert.strictEqual(thought(events), 'Plan it.');
		const block = events.find(event => event.type === 'reasoning.block');
		assert.deepStrictEqual(block && block.type === 'reasoning.block' ? block.opaque : undefined, {
			reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'Plan it.', signature: 'sig' }],
		});
		// No effort picked: nothing asks for reasoning, so optional-thinking models are not switched on.
		const body = JSON.parse(String(sent[0].data)) as ISentBody;
		assert.strictEqual(body.reasoning, undefined);
		assert.strictEqual(body.reasoning_effort, undefined);
	});

	test('OpenRouter sends a picked effort in its own reasoning field', async () => {
		const { service, sent } = fakeRequests([
			{ match: url => url.endsWith('/models'), body: JSON.stringify({ data: [{ id: 'x/thinker', supported_parameters: ['reasoning', 'tools'] }, { id: 'x/plain', supported_parameters: ['tools'] }] }) },
			{ match: url => url.endsWith('/chat/completions'), body: sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]) },
		]);
		const provider = createOpenRouterProvider(service);
		const models = await provider.listModels(profile('openrouter'));
		assert.strictEqual(models.find(model => model.id === 'x/thinker')?.capabilities.reasoning, true);
		assert.strictEqual(models.find(model => model.id === 'x/plain')?.capabilities.reasoning, false);
		await collect(provider, { modelId: 'x/thinker', options: { reasoning: 'high' } });
		await collect(provider, { modelId: 'x/plain', options: { reasoning: 'high' } });
		const bodies = sent.filter(options => options.url?.endsWith('/chat/completions')).map(options => JSON.parse(String(options.data)) as ISentBody);
		assert.deepStrictEqual(bodies[0].reasoning, { effort: 'high' });
		assert.strictEqual(bodies[0].reasoning_effort, undefined);
		assert.strictEqual(bodies[1].reasoning, undefined);
	});

	test('Ollama asks thinking models to think and streams message.thinking', async () => {
		const ndjson = (lines: readonly object[]) => lines.map(line => JSON.stringify(line)).join('\n') + '\n';
		const { service, sent } = fakeRequests([
			{ match: url => url.endsWith('/api/show'), body: JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'] }) },
			{
				match: url => url.endsWith('/api/chat'),
				body: ndjson([
					{ message: { role: 'assistant', content: '', thinking: 'Hmm, ' } },
					{ message: { role: 'assistant', content: '', thinking: 'two.' } },
					{ message: { role: 'assistant', content: '2' } },
					{ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 },
				]),
			},
		]);
		const provider = new OllamaProvider(service);
		const events = await collect(provider, { modelId: 'qwen3' });
		assert.strictEqual(thought(events), 'Hmm, two.');
		assert.deepStrictEqual(types(events), ['reasoning.start', 'reasoning.delta', 'reasoning.delta', 'reasoning.end', 'text.start', 'text.delta', 'text.end', 'finish']);
		const chat = sent.find(options => options.url?.endsWith('/api/chat'));
		assert.strictEqual((JSON.parse(String(chat?.data)) as ISentBody).think, true);
		// The capability is asked once per model.
		await collect(provider, { modelId: 'qwen3' });
		assert.strictEqual(sent.filter(options => options.url?.endsWith('/api/show')).length, 1);
	});

	test('Ollama leaves think out for models without the capability', async () => {
		const { service, sent } = fakeRequests([
			{ match: url => url.endsWith('/api/show'), body: JSON.stringify({ capabilities: ['completion'] }) },
			{ match: url => url.endsWith('/api/chat'), body: JSON.stringify({ message: { content: 'hi' }, done: true }) + '\n' },
		]);
		await collect(new OllamaProvider(service), { modelId: 'llama3' });
		const chat = sent.find(options => options.url?.endsWith('/api/chat'));
		assert.strictEqual('think' in JSON.parse(String(chat?.data)), false);
	});

	test('Gemini requests thoughts only from thinking models and streams them', async () => {
		const { service, sent } = fakeRequests([{
			match: url => url.includes(':streamGenerateContent'),
			body: sse([
				{ candidates: [{ content: { parts: [{ text: 'Weighing options.', thought: true }] } }] },
				{ candidates: [{ content: { parts: [{ text: 'Use B.' }] }, finishReason: 'STOP' }] },
			]),
		}]);
		const provider = new GeminiProvider(service);
		const events = await collect(provider, { modelId: 'gemini-2.5-flash' });
		assert.strictEqual(thought(events), 'Weighing options.');
		assert.deepStrictEqual(types(events), ['reasoning.start', 'reasoning.delta', 'reasoning.end', 'text.start', 'text.delta', 'text.end', 'finish']);
		await collect(provider, { modelId: 'gemini-2.0-flash' });
		const bodies = sent.map(options => JSON.parse(String(options.data)) as ISentBody);
		assert.deepStrictEqual(bodies[0].generationConfig, { thinkingConfig: { includeThoughts: true } });
		assert.strictEqual(bodies[1].generationConfig, undefined);
	});

	test('Gemini thinking guess by model id', () => {
		assert.strictEqual(geminiModelThinks('gemini-2.5-pro'), true);
		assert.strictEqual(geminiModelThinks('models/gemini-3-pro-preview'), true);
		assert.strictEqual(geminiModelThinks('gemini-2.0-flash'), false);
		assert.strictEqual(geminiModelThinks('gemini-2.5-flash-image'), false);
		assert.strictEqual(geminiModelThinks('gemini-2.5-flash-preview-tts'), false);
	});
});
