/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_ACP_CAPABILITIES } from '../capabilities.js';
import { IModelInfo } from '../providers.js';
import { catalogOverlay } from './agentModelCatalogs.js';
import { fillDescriptors, reasoningOption } from './modelOptions.js';

/**
 * `agy models` discovery, matching Synara's Antigravity adapter.
 *
 * Newer rows are `slug<TAB>Display Name (Effort)`. Older builds printed only the
 * display label. Variants of one family collapse onto a single picker row with
 * a reasoning ladder.
 */

export interface IAntigravityCliModel {
	readonly model: string;
	readonly effort?: string;
}

export interface IAntigravityCatalogModel {
	readonly slug: string;
	readonly name: string;
	readonly efforts: readonly string[];
	readonly defaultEffort?: string;
}

const DEFAULT_EFFORT_BY_MODEL: Record<string, string> = {
	'Gemini 3.6 Flash': 'medium',
	'Gemini 3.5 Flash': 'medium',
	'Gemini 3.1 Pro': 'low',
	'Claude Sonnet 4.6': 'thinking',
	'Claude Opus 4.6': 'thinking',
	'Claude 3.7 Sonnet': 'thinking',
	'DeepSeek V4 Flash Max': 'high',
	'GPT-OSS 120B': 'medium',
};

const EFFORT_ORDER = ['low', 'medium', 'high', 'thinking'] as const;

function effortLabel(value: string): string {
	return value
		.split(/[-_\s]+/u)
		.filter(Boolean)
		.map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join(' ');
}

function sortEfforts(efforts: readonly string[]): string[] {
	return [...efforts].sort((left, right) => {
		const leftIndex = EFFORT_ORDER.indexOf(left as typeof EFFORT_ORDER[number]);
		const rightIndex = EFFORT_ORDER.indexOf(right as typeof EFFORT_ORDER[number]);
		return (leftIndex < 0 ? EFFORT_ORDER.length : leftIndex) - (rightIndex < 0 ? EFFORT_ORDER.length : rightIndex);
	});
}

/** Parses one `agy models` line into a family name plus an optional effort. */
export function parseAntigravityCliModelLabel(value: string): IAntigravityCliModel | undefined {
	const stripped = value.replace(/\x1b\[[0-9;]*m/g, '').trim();
	if (!stripped) {
		return undefined;
	}
	const tabIndex = stripped.indexOf('\t');
	const labelColumn = tabIndex >= 0
		? stripped.slice(tabIndex + 1).trim()
		: stripped.replace(/^(?:[*•-]\s+)+/u, '');
	const trimmed = labelColumn.replace(/^(?:[*•-]\s+)+/u, '').trim();
	if (!trimmed) {
		return undefined;
	}
	const match = trimmed.match(/^(.*?)\s+\(([^()]+)\)$/u);
	if (!match?.[1] || !match[2]) {
		return { model: trimmed };
	}
	return {
		model: match[1].trim(),
		effort: match[2].trim().toLowerCase(),
	};
}

/** Groups `agy models` stdout into one catalog row per family. */
export function parseAntigravityModelLines(output: string): IAntigravityCatalogModel[] {
	const groups = new Map<string, string[]>();
	for (const line of output.split(/\r?\n/g)) {
		const parsed = parseAntigravityCliModelLabel(line);
		if (!parsed) {
			continue;
		}
		const efforts = groups.get(parsed.model) ?? [];
		if (parsed.effort && !efforts.includes(parsed.effort)) {
			efforts.push(parsed.effort);
		}
		groups.set(parsed.model, efforts);
	}
	return [...groups.entries()].map(([model, discovered]) => {
		const efforts = sortEfforts(discovered);
		const defaultEffort = DEFAULT_EFFORT_BY_MODEL[model] ?? efforts[0];
		return {
			slug: model,
			name: model,
			efforts,
			...(defaultEffort ? { defaultEffort } : {}),
		};
	});
}

/** Rebuilds the exact CLI `--model` token Synara sends at dispatch. */
export function resolveAntigravityCliModelLabel(model: string, effort?: string): string {
	const parsed = parseAntigravityCliModelLabel(model);
	if (!parsed) {
		return model;
	}
	const resolved = effort?.trim().toLowerCase() || parsed.effort || DEFAULT_EFFORT_BY_MODEL[parsed.model];
	return resolved ? `${parsed.model} (${effortLabel(resolved)})` : parsed.model;
}

export function antigravityModelsToInfo(models: readonly IAntigravityCatalogModel[]): IModelInfo[] {
	return models.map(model => {
		const overlay = catalogOverlay('antigravity', model.slug, model.name);
		const fromCli = model.efforts.length ? [reasoningOption(model.efforts, model.defaultEffort)] : [];
		const optionDescriptors = overlay ? fillDescriptors(fromCli, overlay.optionDescriptors) : fromCli;
		const contextWindow = overlay?.contextWindow ?? DEFAULT_ACP_CAPABILITIES.contextWindow;
		return {
			id: model.slug,
			label: model.name,
			capabilities: { ...DEFAULT_ACP_CAPABILITIES, reasoning: model.efforts.length > 0, contextWindow },
			...(optionDescriptors.length ? { optionDescriptors } : {}),
			...(overlay?.description ? { description: overlay.description } : {}),
		};
	});
}
