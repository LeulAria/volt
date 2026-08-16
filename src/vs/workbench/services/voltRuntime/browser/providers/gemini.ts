/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { DEFAULT_MODEL_CAPABILITIES } from '../../common/capabilities.js';
import { IVoltEvent } from '../../common/events.js';
import { contextLabelFromTokens, pickNumber, pickText } from '../../common/modelMeta.js';
import { IProviderProfile } from '../../common/profiles.js';
import { IDetectResult, IModelInfo, IModelProvider, IModelRequest } from '../../common/providers.js';
import { parseSseData, requestSseLines, requestText } from '../httpStream.js';

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];

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
				return [this.modelInfo(id, pickText(item.displayName) ?? id, pickText(item.description), pickNumber(item.inputTokenLimit))];
			});
		} catch {
			return [];
		}
	}

	private modelInfo(id: string, label: string, description?: string, tokens?: number): IModelInfo {
		const contextWindow = tokens ?? 1_000_000;
		return {
			id,
			label,
			capabilities: { ...DEFAULT_MODEL_CAPABILITIES, contextWindow },
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
		const contents = req.messages.filter(m => m.role !== 'system').map(m => ({
			role: m.role === 'assistant' ? 'model' : 'user',
			parts: [{ text: m.content }],
		}));
		const system = req.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
		const textId = `text-${Date.now()}`;
		let started = false;
		for await (const line of requestSseLines(this.requestService, url, {
			type: 'POST',
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({
				contents,
				systemInstruction: system ? { parts: [{ text: system }] } : undefined,
			}),
		}, token)) {
			const data = parseSseData(line) ?? (line.trim().startsWith('{') ? line : undefined);
			if (!data) {
				continue;
			}
			let json: {
				candidates?: { content?: { parts?: { text?: string }[] } }[];
				usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
			};
			try {
				json = JSON.parse(data);
			} catch {
				continue;
			}
			const usage = json.usageMetadata;
			if (usage && (usage.promptTokenCount !== undefined || usage.candidatesTokenCount !== undefined)) {
				yield { type: 'usage', input: usage.promptTokenCount ?? 0, output: usage.candidatesTokenCount ?? 0 };
			}
			const text = json.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
			if (!text) {
				continue;
			}
			if (!started) {
				started = true;
				yield { type: 'text.start', id: textId };
			}
			yield { type: 'text.delta', id: textId, delta: text };
		}
		if (started) {
			yield { type: 'text.end', id: textId };
		}
	}
}
