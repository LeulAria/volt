/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { DEFAULT_MODEL_CAPABILITIES } from '../../common/capabilities.js';
import { IVoltEvent } from '../../common/events.js';
import { contextLabelFromTokens, pickNumber, pickText } from '../../common/models/modelMeta.js';
import { generationParams } from '../../common/models/modelOptions.js';
import { IProviderProfile } from '../../common/profiles.js';
import { IDetectResult, IModelInfo, IModelProvider, IModelRequest } from '../../common/providers.js';
import { GeminiToolAssembler, IGeminiPart } from '../../common/harness/geminiToolStream.js';
import { ProviderReasoning } from '../../common/harness/reasoningStream.js';
import { toGeminiContents, toGeminiTools } from '../../common/harness/providerMessages.js';
import { parseSseData, requestSseStream, requestText } from '../host/httpStream.js';

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];

/**
 * Gemini 2.5 and later think; 2.0 and the image, speech and live variants do not, and reject a
 * `thinkingConfig`. Used when the model listing did not say.
 */
export function geminiModelThinks(modelId: string): boolean {
	const id = modelId.toLowerCase().replace(/^models\//, '');
	const version = /^gemini-(\d+(?:\.\d+)?)/.exec(id);
	if (!version || Number(version[1]) < 2.5) {
		return false;
	}
	return !/(image|tts|live|audio|embedding)/.test(id);
}

export class GeminiProvider implements IModelProvider {
	readonly id = 'gemini';
	readonly label = 'Gemini';

	constructor(private readonly requestService: IRequestService) { }

	async detect(): Promise<IDetectResult> {
		return { available: true, detail: 'Google Generative Language API' };
	}

	async listModels(profile: IProviderProfile, apiKey?: string): Promise<IModelInfo[]> {
		const fetched = await this.fetchModels(profile, apiKey);
		if (fetched.length) {
			return fetched;
		}
		return MODELS.map(id => this.modelInfo(id, id, undefined, 1_000_000));
	}

	private async fetchModels(profile: IProviderProfile, apiKey?: string): Promise<IModelInfo[]> {
		if (!apiKey) {
			return [];
		}
		try {
			const base = (profile.endpoint?.baseURL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
			const query = new URLSearchParams({ key: apiKey });
			const { status, text } = await requestText(this.requestService, `${base}/v1beta/models?${query.toString()}`, { type: 'GET' }, CancellationToken.None);
			if (status < 200 || status >= 300) {
				return [];
			}
			const parsed = JSON.parse(text) as {
				models?: {
					name?: string;
					displayName?: string;
					description?: string;
					inputTokenLimit?: number;
					supportedGenerationMethods?: string[];
					thinking?: boolean;
				}[];
			};
			return (parsed.models ?? []).flatMap(item => {
				const methods = item.supportedGenerationMethods ?? [];
				if (methods.length && !methods.includes('generateContent')) {
					return [];
				}
				const raw = pickText(item.name);
				if (!raw) {
					return [];
				}
				const id = raw.replace(/^models\//, '');
				if (typeof item.thinking === 'boolean') {
					this.thinking.set(id, item.thinking);
				}
				return [this.modelInfo(id, pickText(item.displayName) ?? id, pickText(item.description), pickNumber(item.inputTokenLimit))];
			});
		} catch {
			return [];
		}
	}

	/** What the model listing said about thinking, by model id. */
	private readonly thinking = new Map<string, boolean>();

	private thinks(modelId: string): boolean {
		return this.thinking.get(modelId) ?? geminiModelThinks(modelId);
	}

	private modelInfo(id: string, label: string, description?: string, tokens?: number): IModelInfo {
		const contextWindow = tokens ?? 1_000_000;
		return {
			id,
			label,
			capabilities: { ...DEFAULT_MODEL_CAPABILITIES, contextWindow, reasoning: this.thinks(id) },
			...(description ? { description } : {}),
			contextLabel: contextLabelFromTokens(contextWindow),
		};
	}

	async *stream(req: IModelRequest, token: CancellationToken): AsyncIterable<IVoltEvent> {
		const base = (req.profile.endpoint?.baseURL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
		const query = new URLSearchParams({ alt: 'sse' });
		if (req.apiKey) {
			query.set('key', req.apiKey);
		}
		const url = `${base}/v1beta/models/${req.modelId}:streamGenerateContent?${query.toString()}`;
		const system = req.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
		const tools = req.tools?.length ? toGeminiTools(req.tools) : undefined;
		const textId = `text-${Date.now()}`;
		const assembler = new GeminiToolAssembler(req.modelId);
		// Gemini takes thoughts back only as signatures on calls (see GeminiToolAssembler).
		const reasoning = new ProviderReasoning(`${textId}-think`, this.id, req.modelId, 'none');
		const params = generationParams(req.options);
		const generationConfig = {
			// Thought summaries stream only when asked for; they become the Thought row.
			...(this.thinks(req.modelId) ? { thinkingConfig: { includeThoughts: true } } : {}),
			...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
			...(params.topP !== undefined ? { topP: params.topP } : {}),
			...(params.maxOutputTokens !== undefined ? { maxOutputTokens: params.maxOutputTokens } : {}),
		};
		let started = false;
		for await (const line of requestSseStream(this.requestService, url, {
			type: 'POST',
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({
				contents: toGeminiContents(req.messages, { model: req.modelId }),
				systemInstruction: system ? { parts: [{ text: system }] } : undefined,
				...(tools ? { tools } : {}),
				...(Object.keys(generationConfig).length ? { generationConfig } : {}),
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
			const data = parseSseData(line) ?? (line.trim().startsWith('{') ? line : undefined);
			if (!data) {
				continue;
			}
			let json: {
				candidates?: {
					content?: { parts?: IGeminiPart[] };
					finishReason?: string;
				}[];
				usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
			};
			try {
				json = JSON.parse(data);
			} catch {
				continue;
			}
			const usage = json.usageMetadata;
			if (usage && (usage.promptTokenCount !== undefined || usage.candidatesTokenCount !== undefined)) {
				const prompt = usage.promptTokenCount ?? 0;
				const cached = usage.cachedContentTokenCount ?? 0;
				yield { type: 'usage', input: Math.max(0, prompt - cached), output: usage.candidatesTokenCount ?? 0, cache: cached, used: prompt };
			}
			const candidate = json.candidates?.[0];
			const parts = candidate?.content?.parts ?? [];
			for (const part of parts) {
				if (part.thought && part.text) {
					yield* reasoning.delta(part.text);
					continue;
				}
				if (part.text || part.functionCall) {
					yield* reasoning.close();
				}
				if (part.text && !part.functionCall) {
					if (!started) {
						started = true;
						yield { type: 'text.start', id: textId };
					}
					yield { type: 'text.delta', id: textId, delta: part.text };
				}
			}
			for (const event of assembler.apply(parts, candidate?.finishReason)) {
				yield event;
			}
		}
		yield* reasoning.close();
		if (started) {
			yield { type: 'text.end', id: textId };
		}
		yield assembler.finish();
	}
}
