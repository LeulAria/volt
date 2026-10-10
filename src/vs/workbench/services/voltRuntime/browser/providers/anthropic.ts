/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { DEFAULT_MODEL_CAPABILITIES, IProviderCapabilities } from '../../common/capabilities.js';
import { IVoltEvent } from '../../common/events.js';
import { IProviderProfile } from '../../common/profiles.js';
import { contextLabelFromTokens, pickText } from '../../common/models/modelMeta.js';
import { CLAUDE_STREAM_OUTPUT_TOKENS, claudeModelMeta, IClaudeModelMeta, IListedClaudeLimits } from '../../common/models/claudeModels.js';
import { generationParams, IModelOptionDescriptor, MODEL_OPTION_REASONING, reasoningOption } from '../../common/models/modelOptions.js';
import { IDetectResult, IModelInfo, IModelProvider, IModelRequest } from '../../common/providers.js';
import { AnthropicStreamParser, IAnthropicStreamJson } from '../../common/harness/anthropicToolStream.js';
import { buildAnthropicRequest } from '../../common/harness/anthropicRequest.js';
import { parseSseData, requestSseStream, requestText } from '../host/httpStream.js';

interface IAnthropicModel {
	id: string;
	label: string;
	limits?: IListedClaudeLimits;
}

/** Used only when the Models API is unreachable. The live list always wins. */
const FALLBACK_MODELS: IAnthropicModel[] = [
	{ id: 'claude-opus-5', label: 'Claude Opus 5' },
	{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
	{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

export class AnthropicProvider implements IModelProvider {
	readonly id = 'anthropic';
	readonly label = 'Anthropic';

	/** Limits the Models API reported, keyed by model id. */
	private readonly limits = new Map<string, IListedClaudeLimits>();

	constructor(private readonly requestService: IRequestService) { }

	async detect(): Promise<IDetectResult> {
		return { available: true, detail: 'Anthropic Messages API' };
	}

	async listModels(profile: IProviderProfile, apiKey?: string): Promise<IModelInfo[]> {
		const fetched = await this.fetchModels(profile, apiKey);
		const models = fetched.length ? fetched : FALLBACK_MODELS;
		return models.map(model => {
			if (model.limits) {
				this.limits.set(model.id, model.limits);
			}
			const meta = claudeModelMeta(model.id, model.limits);
			const capabilities = this.caps(meta);
			const optionDescriptors = reasoningDescriptors(meta);
			return {
				id: model.id,
				label: model.label,
				capabilities,
				...(optionDescriptors ? { optionDescriptors } : {}),
				contextLabel: contextLabelFromTokens(capabilities.contextWindow),
			};
		});
	}

	private async fetchModels(profile: IProviderProfile, apiKey?: string): Promise<IAnthropicModel[]> {
		if (!apiKey) {
			return [];
		}
		try {
			const { status, text } = await requestText(this.requestService, `${baseUrl(profile)}/v1/models?limit=100`, {
				type: 'GET',
				headers: {
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01',
				},
			}, CancellationToken.None);
			if (status < 200 || status >= 300) {
				return [];
			}
			const parsed = JSON.parse(text) as { data?: { id?: string; display_name?: string; max_input_tokens?: number; max_tokens?: number }[] };
			return (parsed.data ?? []).flatMap(item => {
				const id = pickText(item.id);
				return id ? [{
					id,
					label: pickText(item.display_name) ?? id,
					limits: { max_input_tokens: item.max_input_tokens, max_tokens: item.max_tokens },
				}] : [];
			});
		} catch {
			return [];
		}
	}

	async *stream(req: IModelRequest, token: CancellationToken): AsyncIterable<IVoltEvent> {
		const meta = claudeModelMeta(req.modelId, this.limits.get(req.modelId));
		const params = generationParams(req.options);
		const maxTokens = Math.max(1_024, Math.min(req.maxOutputTokens ?? CLAUDE_STREAM_OUTPUT_TOKENS, params.maxOutputTokens ?? Number.POSITIVE_INFINITY, meta.maxOutputTokens));
		const base = baseUrl(req.profile);
		const effort = req.options?.[MODEL_OPTION_REASONING];
		const request = buildAnthropicRequest({
			modelId: req.modelId,
			meta,
			messages: req.messages,
			tools: req.tools,
			maxTokens,
			effort: typeof effort === 'string' ? effort : undefined,
			firstParty: base === DEFAULT_BASE_URL,
			temperature: params.temperature,
			topP: params.topP,
		});
		const parser = new AnthropicStreamParser(req.modelId);
		for await (const item of requestSseStream(this.requestService, `${base}/v1/messages`, {
			type: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': req.apiKey ?? '',
				'anthropic-version': '2023-06-01',
				...(request.betas.length ? { 'anthropic-beta': request.betas.join(',') } : {}),
			},
			data: JSON.stringify(request.body),
		}, token)) {
			if (typeof item !== 'string') {
				yield { type: 'retry', ...item.retry };
				continue;
			}
			if (token.isCancellationRequested) {
				yield { type: 'finish', reason: 'abort' };
				return;
			}
			const data = parseSseData(item);
			if (!data) {
				continue;
			}
			let json: IAnthropicStreamJson;
			try {
				json = JSON.parse(data);
			} catch {
				continue;
			}
			yield* parser.apply(json);
		}
		yield* parser.finish();
	}

	private caps(meta: IClaudeModelMeta): IProviderCapabilities {
		return {
			...DEFAULT_MODEL_CAPABILITIES,
			reasoning: meta.thinking !== 'none',
			parallelToolCalls: true,
			vision: true,
			promptCaching: true,
			contextWindow: meta.contextWindow,
		};
	}
}

/** Adaptive models get Auto plus the effort levels they accept; budget models get Auto, Off, and depth. */
function reasoningDescriptors(meta: IClaudeModelMeta): IModelOptionDescriptor[] | undefined {
	if (meta.thinking === 'adaptive') {
		return [reasoningOption(['auto', ...meta.efforts], 'auto')];
	}
	if (meta.thinking === 'budget') {
		return [reasoningOption(['auto', 'off', 'medium', 'high', 'max'], 'auto')];
	}
	return undefined;
}

function baseUrl(profile: IProviderProfile): string {
	return (profile.endpoint?.baseURL || DEFAULT_BASE_URL).replace(/\/$/, '');
}
