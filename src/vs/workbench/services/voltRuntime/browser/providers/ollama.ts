/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { DEFAULT_MODEL_CAPABILITIES } from '../../common/capabilities.js';
import { IVoltEvent } from '../../common/events.js';
import { pickText } from '../../common/models/modelMeta.js';
import { generationParams } from '../../common/models/modelOptions.js';
import { IProviderProfile } from '../../common/profiles.js';
import { IDetectResult, IModelInfo, IModelProvider, IModelRequest } from '../../common/providers.js';
import { OpenAiToolAssembler } from '../../common/harness/openaiToolStream.js';
import { stringifyToolArgs, toOllamaMessages, toOpenAiTools } from '../../common/harness/providerMessages.js';
import { ProviderReasoning } from '../../common/harness/reasoningStream.js';
import { requestSseStream, requestText } from '../host/httpStream.js';

/**
 * The window Volt plans a local model's prompts around. Ollama's own default is 4K tokens below
 * 24 GiB of VRAM, smaller than Volt's system prompt and tools, and a longer prompt is cut down
 * silently; 32K leaves room for a working history while keeping the KV cache within most machines.
 */
const OLLAMA_CONTEXT_WINDOW = 32_768;

interface IOllamaModelDetails {
	readonly capabilities: readonly string[];
	/** Sent as `num_ctx` on every request (a different value would reload the model) and planned with. */
	readonly contextWindow: number;
}

const UNKNOWN_MODEL: IOllamaModelDetails = { capabilities: [], contextWindow: OLLAMA_CONTEXT_WINDOW };

/** A `num_ctx` set in the model's Modelfile wins; otherwise Volt's window, capped at what the model was trained on. */
export function ollamaContextWindow(show: { readonly parameters?: unknown; readonly model_info?: unknown }): number {
	const pinned = typeof show.parameters === 'string' ? /^\s*num_ctx\s+(\d+)/m.exec(show.parameters) : null;
	if (pinned && Number(pinned[1]) > 0) {
		return Number(pinned[1]);
	}
	const info = show.model_info && typeof show.model_info === 'object' ? show.model_info as Record<string, unknown> : {};
	const trained = Object.entries(info).find(([key, value]) => key.endsWith('.context_length') && typeof value === 'number' && value > 0)?.[1] as number | undefined;
	return trained ? Math.min(trained, OLLAMA_CONTEXT_WINDOW) : OLLAMA_CONTEXT_WINDOW;
}

export class OllamaProvider implements IModelProvider {
	readonly id = 'ollama';
	readonly label = 'Ollama';

	constructor(private readonly requestService: IRequestService) { }

	private baseURL(profile: IProviderProfile): string {
		return (profile.endpoint?.baseURL || 'http://127.0.0.1:11434').replace(/\/$/, '');
	}

	async detect(profile: IProviderProfile): Promise<IDetectResult> {
		try {
			const { status, text } = await requestText(this.requestService, `${this.baseURL(profile)}/api/tags`, { type: 'GET' }, CancellationToken.None);
			return { available: status === 200, detail: status === 200 ? text.slice(0, 80) : `HTTP ${status}` };
		} catch (err) {
			return { available: false, detail: err instanceof Error ? err.message : String(err) };
		}
	}

	async listModels(profile: IProviderProfile): Promise<IModelInfo[]> {
		try {
			const { status, text } = await requestText(this.requestService, `${this.baseURL(profile)}/api/tags`, { type: 'GET' }, CancellationToken.None);
			if (status !== 200) {
				return [];
			}
			const parsed = JSON.parse(text) as {
				models?: {
					name?: string;
					details?: { family?: string; parameter_size?: string; quantization_level?: string };
				}[];
			};
			const baseURL = this.baseURL(profile);
			const listed = await Promise.all((parsed.models ?? []).map(async model => {
				const id = pickText(model.name);
				if (!id) {
					return undefined;
				}
				const details = await this.details(baseURL, id, CancellationToken.None);
				const description = pickText([
					model.details?.parameter_size,
					model.details?.quantization_level,
					model.details?.family,
				].filter(Boolean).join(' - '));
				return {
					id,
					label: id,
					capabilities: { ...DEFAULT_MODEL_CAPABILITIES, vision: details.capabilities.includes('vision'), contextWindow: details.contextWindow },
					...(description ? { description } : {}),
				};
			}));
			return listed.filter(model => model !== undefined);
		} catch {
			return [];
		}
	}

	/**
	 * What the model can do and its window, from `/api/show` (asked once per model). Ollama rejects
	 * `think` for a model that cannot think, and only a vision model is sent images.
	 */
	private details(baseURL: string, model: string, token: CancellationToken): Promise<IOllamaModelDetails> {
		const key = `${baseURL}|${model}`;
		let known = this.known.get(key);
		if (!known) {
			known = requestText(this.requestService, `${baseURL}/api/show`, {
				type: 'POST',
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify({ model }),
			}, token).then(({ status, text }) => {
				if (status !== 200) {
					this.known.delete(key);
					return UNKNOWN_MODEL;
				}
				const show = JSON.parse(text) as { capabilities?: unknown; parameters?: unknown; model_info?: unknown };
				const capabilities = Array.isArray(show.capabilities) ? show.capabilities.filter((item): item is string => typeof item === 'string') : [];
				return { capabilities, contextWindow: ollamaContextWindow(show) };
			}).catch(() => {
				this.known.delete(key);
				return UNKNOWN_MODEL;
			});
			this.known.set(key, known);
		}
		return known;
	}

	private readonly known = new Map<string, Promise<IOllamaModelDetails>>();

	async *stream(req: IModelRequest, token: CancellationToken): AsyncIterable<IVoltEvent> {
		const baseURL = this.baseURL(req.profile);
		const url = `${baseURL}/api/chat`;
		const tools = req.tools?.length ? toOpenAiTools(req.tools) : undefined;
		const textId = `text-${Date.now()}`;
		const assembler = new OpenAiToolAssembler();
		// Ollama never takes thinking back, so the block is for the Thought row only.
		const reasoning = new ProviderReasoning(`${textId}-think`, this.id, req.modelId, 'none');
		const { capabilities, contextWindow } = await this.details(baseURL, req.modelId, token);
		const think = capabilities.includes('thinking');
		const callPrefix = `ollama_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const params = generationParams(req.options);
		const options = {
			num_ctx: contextWindow,
			...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
			...(params.topP !== undefined ? { top_p: params.topP } : {}),
			...(params.maxOutputTokens !== undefined ? { num_predict: params.maxOutputTokens } : {}),
		};
		let started = false;
		for await (const line of requestSseStream(this.requestService, url, {
			type: 'POST',
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({
				model: req.modelId,
				stream: true,
				messages: toOllamaMessages(req.messages, { vision: capabilities.includes('vision') }),
				...(tools ? { tools } : {}),
				// Thinking in its own field, not inline <think> tags in the reply.
				...(think ? { think: true } : {}),
				options,
			}),
		}, token)) {
			if (typeof line !== 'string') {
				yield { type: 'retry', ...line.retry };
				continue;
			}
			if (token.isCancellationRequested) {
				yield { type: 'finish', reason: 'abort' };
				return;
			}
			if (!line.trim()) {
				continue;
			}
			let json: {
				message?: {
					content?: string;
					thinking?: string;
					tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[];
				};
				done?: boolean;
				done_reason?: string;
				prompt_eval_count?: number;
				eval_count?: number;
			};
			try {
				json = JSON.parse(line) as typeof json;
			} catch {
				continue;
			}
			const thinking = json.message?.thinking;
			if (thinking) {
				yield* reasoning.delta(thinking);
			}
			const content = json.message?.content;
			if (content || json.message?.tool_calls?.length) {
				yield* reasoning.close();
			}
			if (content) {
				if (!started) {
					started = true;
					yield { type: 'text.start', id: textId };
				}
				yield { type: 'text.delta', id: textId, delta: content };
			}
			const toolCalls = json.message?.tool_calls?.map((call, index) => ({
				index,
				id: call.id ?? `${callPrefix}_${index}`,
				function: {
					name: call.function?.name,
					arguments: stringifyToolArgs(call.function?.arguments),
				},
			}));
			for (const event of assembler.apply(
				toolCalls?.length ? { tool_calls: toolCalls } : undefined,
				json.done ? (json.done_reason ?? (toolCalls?.length ? 'tool_calls' : 'stop')) : undefined,
			)) {
				yield event;
			}
			if (json.done) {
				yield* reasoning.close();
				if (json.prompt_eval_count !== undefined || json.eval_count !== undefined) {
					yield { type: 'usage', input: json.prompt_eval_count ?? 0, output: json.eval_count ?? 0 };
				}
				if (started) {
					yield { type: 'text.end', id: textId };
					started = false;
				}
			}
		}
		yield* reasoning.close();
		if (started) {
			yield { type: 'text.end', id: textId };
		}
		yield* assembler.drain();
		yield assembler.finish();
	}
}
