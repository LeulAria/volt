/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_ACP_CAPABILITIES } from '../capabilities.js';
import { contextLabelFromTokens } from './modelMeta.js';
import { reasoningOption } from './modelOptions.js';
import { IModelInfo } from '../providers.js';

/** One row from `grok models`. */
export interface IGrokListedModel {
	readonly id: string;
	readonly isDefault: boolean;
}

/** The bits of `~/.grok/models_cache.json` the picker can show. No credentials. */
export interface IGrokCachedModel {
	readonly name?: string;
	readonly description?: string;
	readonly contextWindow?: number;
	readonly efforts?: readonly string[];
	readonly defaultEffort?: string;
}

/** `grok-4.7` -> `Grok 4.7`. */
export function grokModelLabel(id: string): string {
	return id.split('-').filter(Boolean).map(part => /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

/**
 * `grok models` prints a header, then `* grok-4.7 (default)` rows.
 * Lines before "Available models" are the login banner, not models.
 */
export function parseGrokModelLines(output: string): IGrokListedModel[] {
	const models: IGrokListedModel[] = [];
	let inList = false;
	for (const raw of output.split(/\r?\n/)) {
		const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
		if (/^available models:?$/i.test(line)) {
			inList = true;
			continue;
		}
		if (!inList) {
			continue;
		}
		const match = /^\*\s+(\S+?)(?:\s+\(default\))?$/i.exec(line);
		if (!match?.[1]) {
			continue;
		}
		models.push({ id: match[1], isDefault: /\(default\)/i.test(line) });
	}
	return models;
}

export function grokModelsToInfo(listed: readonly IGrokListedModel[], cache?: Readonly<Record<string, IGrokCachedModel>>): IModelInfo[] {
	return listed.map(model => {
		const cached = cache?.[model.id];
		const efforts = cached?.efforts?.filter(Boolean) ?? [];
		const defaultEffort = cached?.defaultEffort ?? efforts[0];
		const optionDescriptors = efforts.length ? [reasoningOption(efforts, defaultEffort)] : [];
		const contextWindow = cached?.contextWindow ?? DEFAULT_ACP_CAPABILITIES.contextWindow;
		const contextLabel = cached?.contextWindow ? contextLabelFromTokens(cached.contextWindow) : undefined;
		return {
			id: model.id,
			label: cached?.name?.trim() || grokModelLabel(model.id),
			capabilities: { ...DEFAULT_ACP_CAPABILITIES, contextWindow, reasoning: efforts.length > 0 },
			...(optionDescriptors.length ? { optionDescriptors } : {}),
			...(cached?.description ? { description: cached.description } : {}),
			...(contextLabel ? { contextLabel } : {}),
		};
	});
}
