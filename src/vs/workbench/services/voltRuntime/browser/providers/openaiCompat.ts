/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { DEFAULT_MODEL_CAPABILITIES, IProviderCapabilities } from '../../common/capabilities.js';
import { IVoltEvent } from '../../common/events.js';
import { IProviderProfile } from '../../common/profiles.js';
import { contextLabelFromTokens, pickNumber, pickText } from '../../common/models/modelMeta.js';
import { IDetectResult, IModelInfo, IModelProvider, IModelRequest } from '../../common/providers.js';
import { IModelOptionDescriptor, MODEL_OPTION_REASONING, reasoningOption } from '../../common/models/modelOptions.js';
import { OpenAiToolAssembler } from '../../common/harness/openaiToolStream.js';
import { toOpenAiMessages, toOpenAiTools } from '../../common/harness/providerMessages.js';
import { parseSseData, requestSseLines, requestText } from '../host/httpStream.js';

interface IListedModel {
	id: string;
	name?: string;
	display_name?: string;
	description?: string;
	context_length?: number;
	context_window?: number;
	max_model_len?: number;
	top_provider?: { context_length?: number };
}

/** Reasoning models accept an effort hint; chat models reject the field outright. */
function reasoningDescriptors(modelId: string): IModelOptionDescriptor[] | undefined {
	const id = modelId.toLowerCase();
	const reasoning = /^o\d/.test(id) || id.includes('gpt-5') || id.includes('reason') || id.includes('thinking');
	return reasoning ? [reasoningOption(['low', 'medium', 'high'], 'medium')] : undefined;
}

export class OpenAICompatProvider implements IModelProvider {

	constructor(
		readonly id: string,
		readonly label: string,
		private readonly requestService: IRequestService,
		private readonly defaultBaseURL: string,
		private readonly extraHeaders?: (apiKey?: string) => Record<string, string>,
	) { }

	protected baseURL(profile: IProviderProfile): string {
		return (profile.endpoint?.baseURL || this.defaultBaseURL).replace(/\/$/, '');
	}

	async detect(profile: IProviderProfile): Promise<IDetectResult> {
		try {
			const { status } = await requestText(this.requestService, `${this.baseURL(profile)}/models`, { type: 'GET' }, CancellationToken.None);
			return { available: status > 0 && status < 500, detail: `HTTP ${status}` };
		} catch (err) {
			return { available: false, detail: err instanceof Error ? err.message : String(err) };
		}
	}

	async listModels(profile: IProviderProfile, apiKey?: string): Promise<IModelInfo[]> {
		const headers = this.headers(apiKey);
		try {
			const { status, text } = await requestText(this.requestService, `${this.baseURL(profile)}/models`, { type: 'GET', headers }, CancellationToken.None);
			if (status < 200 || status >= 300) {
				return this.fallbackModels();
			}
			const parsed = JSON.parse(text) as { data?: IListedModel[] };
			return (parsed.data ?? []).map(item => this.modelInfo(item.id, item));
		} catch {
			return this.fallbackModels();
		}
	}

	async *stream(req: IModelRequest, token: CancellationToken): AsyncIterable<IVoltEvent> {
		const url = `${this.baseURL(req.profile)}/chat/completions`;
		const selected = req.options?.[MODEL_OPTION_REASONING];
		const effort = reasoningDescriptors(req.modelId) && typeof selected === 'string' ? selected : undefined;
		const tools = req.tools?.length ? toOpenAiTools(req.tools) : undefined;
		const body = JSON.stringify({
			model: req.modelId,
			stream: true,
			stream_options: { include_usage: true },
			messages: toOpenAiMessages(req.messages),
			...(effort ? { reasoning_effort: effort } : {}),
			...(tools ? { tools, tool_choice: 'auto' } : {}),
		});
		const textId = `text-${Date.now()}`;
		const assembler = new OpenAiToolAssembler();
		let started = false;
		for await (const line of requestSseLines(this.requestService, url, {
			type: 'POST',
			headers: { ...this.headers(req.apiKey), 'Content-Type': 'application/json' },
			data: body,
		}, token)) {
			if (token.isCancellationRequested) {
				yield { type: 'finish', reason: 'abort' };
				return;
			}
			const data = parseSseData(line);
			if (!data) {
				continue;
			}
			let json: {
				choices?: {
					delta?: { content?: string; reasoning_content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
					finish_reason?: string | null;
				}[];
				usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
			};
			try {
				json = JSON.parse(data);
			} catch {
				continue;
			}
			const usage = json.usage;
			if (usage) {
				const input = usage.prompt_tokens ?? usage.input_tokens;
				const output = usage.completion_tokens ?? usage.output_tokens;
				if (input !== undefined || output !== undefined) {
					yield { type: 'usage', input: input ?? 0, output: output ?? 0 };
				}
			}
			const choice = json.choices?.[0];
			const delta = choice?.delta;
			const reasoning = delta?.reasoning_content;
			if (reasoning) {
				yield { type: 'reasoning.delta', id: `${textId}-think`, delta: reasoning };
			}
			const content = delta?.content;
			if (content) {
				if (!started) {
					started = true;
					yield { type: 'text.start', id: textId };
				}
				yield { type: 'text.delta', id: textId, delta: content };
			}
			for (const event of assembler.apply(delta, choice?.finish_reason)) {
				yield event;
			}
		}
		if (started) {
			yield { type: 'text.end', id: textId };
		}
		yield assembler.finish();
	}

	protected headers(apiKey?: string): Record<string, string> {
		const extra = this.extraHeaders?.(apiKey) ?? {};
		return {
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			...extra,
		};
	}

	protected capabilitiesFor(_modelId: string): IProviderCapabilities {
		return { ...DEFAULT_MODEL_CAPABILITIES };
	}

	protected modelInfo(id: string, listed?: IListedModel): IModelInfo {
		const optionDescriptors = reasoningDescriptors(id);
		const description = pickText(listed?.description);
		const tokens = pickNumber(listed?.context_length, listed?.context_window, listed?.max_model_len, listed?.top_provider?.context_length);
		const capabilities = { ...this.capabilitiesFor(id), reasoning: !!optionDescriptors, ...(tokens ? { contextWindow: tokens } : {}) };
		return {
			id,
			label: pickText(listed?.name, listed?.display_name) ?? id,
			capabilities,
			...(optionDescriptors ? { optionDescriptors } : {}),
			...(description ? { description } : {}),
			...(tokens ? { contextLabel: contextLabelFromTokens(tokens) } : {}),
		};
	}

	protected fallbackModels(): IModelInfo[] {
		return [];
	}
}

export function createOpenAIProvider(requestService: IRequestService): OpenAICompatProvider {
	return new class extends OpenAICompatProvider {
		constructor() {
			super('openai', 'OpenAI', requestService, 'https://api.openai.com/v1');
		}
		protected override fallbackModels(): IModelInfo[] {
			return ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini'].map(id => this.modelInfo(id));
		}
	};
}

export function createOpenRouterProvider(requestService: IRequestService): OpenAICompatProvider {
	return new class extends OpenAICompatProvider {
		constructor() {
			super('openrouter', 'OpenRouter', requestService, 'https://openrouter.ai/api/v1', () => ({
				'HTTP-Referer': 'https://volt.dev',
				'X-Title': 'Volt',
			}));
		}
		protected override fallbackModels(): IModelInfo[] {
			return [
				'anthropic/claude-sonnet-4',
				'openai/gpt-4.1',
				'google/gemini-2.5-flash',
			].map(id => this.modelInfo(id));
		}
	};
}

export function createCompatProvider(requestService: IRequestService): OpenAICompatProvider {
	return new OpenAICompatProvider('openai-compat', 'OpenAI Compatible', requestService, 'http://127.0.0.1:1234/v1');
}

export function createLMStudioProvider(requestService: IRequestService): OpenAICompatProvider {
	return new OpenAICompatProvider('lmstudio', 'LM Studio', requestService, 'http://127.0.0.1:1234/v1');
}
