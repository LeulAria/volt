/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { DEFAULT_MODEL_CAPABILITIES, IProviderCapabilities } from '../../common/capabilities.js';
import { IVoltEvent } from '../../common/events.js';
import { IProviderProfile } from '../../common/profiles.js';
import { contextLabelFromTokens, pickText } from '../../common/modelMeta.js';
import { booleanOption, IModelOptionDescriptor, MODEL_OPTION_THINKING } from '../../common/modelOptions.js';
import { IDetectResult, IModelInfo, IModelProvider, IModelRequest } from '../../common/providers.js';
import { parseSseData, requestSseLines, requestText } from '../httpStream.js';

interface IAnthropicModel {
	id: string;
	label: string;
	optionDescriptors?: IModelOptionDescriptor[];
}

const THINKING = [booleanOption(MODEL_OPTION_THINKING, 'Thinking', true)];

const MODELS: IAnthropicModel[] = [
	{ id: 'claude-opus-4-20250514', label: 'Claude Opus 4', optionDescriptors: THINKING },
	{ id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', optionDescriptors: THINKING },
	{ id: 'claude-3-5-haiku-20241022', label: 'Claude Haiku 3.5' },
];

/** Anthropic bills extended thinking as a token budget rather than an effort level. */
const THINKING_BUDGET_TOKENS = 4096;
const MAX_TOKENS = 8192;

export class AnthropicProvider implements IModelProvider {
	readonly id = 'anthropic';
	readonly label = 'Anthropic';

	constructor(private readonly requestService: IRequestService) { }

	async detect(): Promise<IDetectResult> {
		return { available: true, detail: 'Anthropic Messages API' };
	}

	async listModels(profile: IProviderProfile, apiKey?: string): Promise<IModelInfo[]> {
		const fetched = await this.fetchModels(profile, apiKey);
		const models = fetched.length ? fetched : MODELS;
		return models.map(model => {
			const capabilities = this.caps(model.id);
			return {
				id: model.id,
				label: model.label,
				capabilities,
				...(model.optionDescriptors ? { optionDescriptors: model.optionDescriptors } : {}),
				contextLabel: contextLabelFromTokens(capabilities.contextWindow),
			};
		});
	}

	private async fetchModels(profile: IProviderProfile, apiKey?: string): Promise<IAnthropicModel[]> {
		if (!apiKey) {
			return [];
		}
		try {
			const url = `${(profile.endpoint?.baseURL || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/models`;
			const { status, text } = await requestText(this.requestService, url, {
				type: 'GET',
				headers: {
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01',
				},
			}, CancellationToken.None);
			if (status < 200 || status >= 300) {
				return [];
			}
			const parsed = JSON.parse(text) as { data?: { id?: string; display_name?: string }[] };
			return (parsed.data ?? []).flatMap(item => {
				const id = pickText(item.id);
				return id ? [{ id, label: pickText(item.display_name) ?? id, optionDescriptors: this.thinkingFor(id) }] : [];
			});
		} catch {
			return [];
		}
	}

	private thinkingFor(id: string): IModelOptionDescriptor[] | undefined {
		return id.includes('opus') || id.includes('sonnet') ? THINKING : undefined;
	}

	async *stream(req: IModelRequest, token: CancellationToken): AsyncIterable<IVoltEvent> {
		const system = req.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
		const messages = req.messages.filter(m => m.role !== 'system').map(m => ({
			role: m.role === 'assistant' ? 'assistant' : 'user',
			content: m.content,
		}));
		const url = `${(req.profile.endpoint?.baseURL || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
		const textId = `text-${Date.now()}`;
		let started = false;
		for await (const line of requestSseLines(this.requestService, url, {
			type: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': req.apiKey ?? '',
				'anthropic-version': '2023-06-01',
			},
			data: JSON.stringify({
				model: req.modelId,
				max_tokens: MAX_TOKENS,
				stream: true,
				system: system || undefined,
				messages,
				...(req.options?.[MODEL_OPTION_THINKING] === true
					? { thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS } }
					: {}),
			}),
		}, token)) {
			const data = parseSseData(line);
			if (!data) {
				continue;
			}
			let json: {
				type?: string;
				delta?: { type?: string; text?: string; thinking?: string };
				usage?: { input_tokens?: number; output_tokens?: number };
				message?: { usage?: { input_tokens?: number; output_tokens?: number } };
			};
			try {
				json = JSON.parse(data);
			} catch {
				continue;
			}
			const usage = json.usage ?? json.message?.usage;
			if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
				yield { type: 'usage', input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 };
			}
			if (json.delta?.thinking) {
				yield { type: 'reasoning.delta', id: `${textId}-think`, delta: json.delta.thinking };
			}
			if (json.type === 'content_block_delta' && json.delta?.text) {
				if (!started) {
					started = true;
					yield { type: 'text.start', id: textId };
				}
				yield { type: 'text.delta', id: textId, delta: json.delta.text };
			}
		}
		if (started) {
			yield { type: 'text.end', id: textId };
		}
	}

	private caps(id: string): IProviderCapabilities {
		return {
			...DEFAULT_MODEL_CAPABILITIES,
			reasoning: id.includes('opus') || id.includes('sonnet'),
			promptCaching: true,
			contextWindow: 200_000,
		};
	}
}
