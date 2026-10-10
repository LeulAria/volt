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
import { generationParams, IModelOptionDescriptor, MODEL_OPTION_REASONING, reasoningOption } from '../../common/models/modelOptions.js';
import { OpenAiToolAssembler } from '../../common/harness/openaiToolStream.js';
import { IOpenAiReasoningFields, openAiReasoningText, ProviderReasoning, reasoningDetails } from '../../common/harness/reasoningStream.js';
import { toOpenAiMessages, toOpenAiTools } from '../../common/harness/providerMessages.js';
import { parseSseData, requestSseStream, requestText } from '../host/httpStream.js';

interface IListedModel {
	id: string;
	name?: string;
	display_name?: string;
	description?: string;
	context_length?: number;
	context_window?: number;
	max_model_len?: number;
	top_provider?: { context_length?: number };
	/** OpenRouter: the request parameters the model takes, e.g. `reasoning`. */
	supported_parameters?: string[];
}

/** Reasoning models accept an effort hint; chat models reject the field outright. */
function looksLikeReasoningModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return /^o\d/.test(id) || id.includes('gpt-5') || id.includes('reason') || id.includes('thinking');
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
		const effort = this.supportsReasoning(req.modelId) && typeof selected === 'string' && selected !== 'auto' && selected !== 'off' ? selected : undefined;
		const tools = req.tools?.length ? toOpenAiTools(req.tools) : undefined;
		const params = generationParams(req.options);
		const sampling = this.acceptsSampling(req.modelId);
		const body = JSON.stringify({
			model: req.modelId,
			stream: true,
			stream_options: { include_usage: true },
			messages: toOpenAiMessages(req.messages, {
				vision: this.capabilitiesFor(req.modelId).vision,
				reasoning: { provider: this.id, model: req.modelId },
			}),
			...(effort ? this.reasoningRequest(effort) : {}),
			...(tools ? { tools, tool_choice: 'auto' } : {}),
			...(sampling && params.temperature !== undefined ? { temperature: params.temperature } : {}),
			...(sampling && params.topP !== undefined ? { top_p: params.topP } : {}),
			...(params.maxOutputTokens !== undefined ? { [this.maxTokensField]: Math.min(params.maxOutputTokens, req.maxOutputTokens ?? params.maxOutputTokens) } : {}),
		});
		const textId = `text-${Date.now()}`;
		const assembler = new OpenAiToolAssembler();
		const reasoning = new ProviderReasoning(`${textId}-think`, this.id, req.modelId, this.reasoningReplay);
		let started = false;
		for await (const line of requestSseStream(this.requestService, url, {
			type: 'POST',
			headers: { ...this.headers(req.apiKey), 'Content-Type': 'application/json' },
			data: body,
		}, token)) {
			if (typeof line !== 'string') {
				yield { type: 'retry', ...line.retry };
				continue;
			}
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
					delta?: IOpenAiReasoningFields & { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
					finish_reason?: string | null;
				}[];
				usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number };
			};
			try {
				json = JSON.parse(data);
			} catch {
				continue;
			}
			const usage = json.usage;
			if (usage) {
				const prompt = usage.prompt_tokens ?? usage.input_tokens;
				const output = usage.completion_tokens ?? usage.output_tokens;
				if (prompt !== undefined || output !== undefined) {
					// Prompt counts include cached tokens here; report them apart, as Anthropic does.
					const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
					const total = prompt ?? 0;
					yield { type: 'usage', input: Math.max(0, total - cached), output: output ?? 0, cache: cached, used: total };
				}
			}
			const choice = json.choices?.[0];
			const delta = choice?.delta;
			yield* reasoning.delta(openAiReasoningText(delta), reasoningDetails(delta));
			const content = delta?.content;
			if (content || delta?.tool_calls?.length) {
				// The thought is over: seal it before the reply or the call, so it is stored apart.
				yield* reasoning.close();
			}
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
		yield* reasoning.close();
		if (started) {
			yield { type: 'text.end', id: textId };
		}
		yield* assembler.drain();
		yield assembler.finish();
	}

	/** How this server takes reasoning back on later requests (see `toOpenAiMessages`). */
	protected readonly reasoningReplay: 'reasoning_content' | 'details' | 'none' = 'reasoning_content';

	/** Whether the model takes a reasoning effort. Only those get the option and the request field. */
	protected supportsReasoning(modelId: string, _listed?: IListedModel): boolean {
		return looksLikeReasoningModel(modelId);
	}

	/** The request fields for a picked effort, in this server's dialect. */
	protected reasoningRequest(effort: string): Record<string, unknown> {
		return { reasoning_effort: effort };
	}

	/** The output-length field this server reads for a pinned maximum. */
	protected readonly maxTokensField: string = 'max_tokens';

	/** Whether the model takes temperature and top_p; a server that rejects them never gets them. */
	protected acceptsSampling(_modelId: string): boolean {
		return true;
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
		const optionDescriptors: IModelOptionDescriptor[] | undefined = this.supportsReasoning(id, listed) ? [reasoningOption(['auto', 'low', 'medium', 'high'], 'auto')] : undefined;
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
		/** OpenAI's reasoning models refuse `max_tokens` and any temperature but the default. */
		protected override readonly maxTokensField = 'max_completion_tokens';
		protected override acceptsSampling(modelId: string): boolean {
			return !looksLikeReasoningModel(modelId);
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
		/** Models the listing said take `reasoning`; the name guess covers ones not listed yet. */
		private readonly reasoningModels = new Set<string>();
		protected override readonly reasoningReplay = 'details';
		protected override supportsReasoning(modelId: string, listed?: IListedModel): boolean {
			if (listed?.supported_parameters?.includes('reasoning')) {
				this.reasoningModels.add(modelId);
			}
			return this.reasoningModels.has(modelId) || looksLikeReasoningModel(modelId);
		}
		/**
		 * OpenRouter's unified field. Nothing is sent without a picked effort: reasoning models
		 * already stream their thoughts by default, and asking would turn thinking on (and bill it)
		 * for models where it is optional.
		 */
		protected override reasoningRequest(effort: string): Record<string, unknown> {
			return { reasoning: { effort } };
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
