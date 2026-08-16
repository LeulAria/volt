/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { DEFAULT_MODEL_CAPABILITIES } from '../../common/capabilities.js';
import { IVoltEvent } from '../../common/events.js';
import { pickText } from '../../common/modelMeta.js';
import { IProviderProfile } from '../../common/profiles.js';
import { IDetectResult, IModelInfo, IModelProvider, IModelRequest } from '../../common/providers.js';
import { requestSseLines, requestText } from '../httpStream.js';

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
			return (parsed.models ?? []).flatMap(model => {
				const id = pickText(model.name);
				if (!id) {
					return [];
				}
				const description = pickText([
					model.details?.parameter_size,
					model.details?.quantization_level,
					model.details?.family,
				].filter(Boolean).join(' - '));
				return [{
					id,
					label: id,
					capabilities: { ...DEFAULT_MODEL_CAPABILITIES, contextWindow: 32_768 },
					...(description ? { description } : {}),
				}];
			});
		} catch {
			return [];
		}
	}

	async *stream(req: IModelRequest, token: CancellationToken): AsyncIterable<IVoltEvent> {
		const url = `${this.baseURL(req.profile)}/api/chat`;
		const textId = `text-${Date.now()}`;
		let started = false;
		for await (const line of requestSseLines(this.requestService, url, {
			type: 'POST',
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({
				model: req.modelId,
				stream: true,
				messages: req.messages,
			}),
		}, token)) {
			if (!line.trim()) {
				continue;
			}
			let json: { message?: { content?: string }; done?: boolean; prompt_eval_count?: number; eval_count?: number };
			try {
				json = JSON.parse(line);
			} catch {
				continue;
			}
			const content = json.message?.content;
			if (content) {
				if (!started) {
					started = true;
					yield { type: 'text.start', id: textId };
				}
				yield { type: 'text.delta', id: textId, delta: content };
			}
			if (json.done) {
				if (json.prompt_eval_count !== undefined || json.eval_count !== undefined) {
					yield { type: 'usage', input: json.prompt_eval_count ?? 0, output: json.eval_count ?? 0 };
				}
				if (started) {
					yield { type: 'text.end', id: textId };
					started = false;
				}
			}
		}
		if (started) {
			yield { type: 'text.end', id: textId };
		}
	}
}
