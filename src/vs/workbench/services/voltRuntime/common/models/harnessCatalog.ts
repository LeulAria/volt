/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_ACP_CAPABILITIES } from '../capabilities.js';
import { IModelInfo } from '../providers.js';
import { contextLabelFromTokens, formatContextChoice, formatContextLabel } from './modelMeta.js';
import { booleanOption, IModelOptionDescriptor, MODEL_OPTION_CONTEXT, MODEL_OPTION_FAST, MODEL_OPTION_REASONING, MODEL_OPTION_THINKING, reasoningLabel, selectOption } from './modelOptions.js';

/**
 * Turns a CLI harness payload into picker rows. Callers pass only what the harness returned
 * after a login check. Nothing here adds a model the payload did not contain.
 */

interface ICodexWireModel {
	slug?: string;
	id?: string;
	model?: string;
	display_name?: string;
	displayName?: string;
	description?: string;
	visibility?: string;
	hidden?: boolean;
	default_reasoning_level?: string;
	defaultReasoningEffort?: string;
	supported_reasoning_levels?: { effort?: string; description?: string }[];
	supportedReasoningEfforts?: { reasoningEffort?: string; description?: string }[];
	additional_speed_tiers?: string[];
	additionalSpeedTiers?: string[];
	service_tiers?: { id?: string; name?: string }[];
	serviceTiers?: { id?: string; name?: string }[];
	context_window?: number;
	max_context_window?: number;
	contextWindow?: number;
	maxContextWindow?: number;
}

interface IClaudeEffortOption {
	id?: string;
	name?: string;
	badge?: { message?: string };
}

interface IClaudeCatalogModel {
	id?: string;
	name?: string;
	description?: string;
	section?: string;
	thinking?: { type?: string; effort_options?: IClaudeEffortOption[] };
	fast_mode?: { type?: string };
	runtime?: { max_input_tokens?: number; default_effort?: string };
}

export interface ICodexContextWindow {
	contextWindow?: number;
	maxContextWindow?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function modelInfo(id: string, label: string, description: string | undefined, descriptors: IModelOptionDescriptor[], contextWindow: number | undefined): IModelInfo {
	const tokens = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_ACP_CAPABILITIES.contextWindow;
	const contextLabel = contextWindow ? contextLabelFromTokens(contextWindow) : undefined;
	return {
		id,
		label,
		capabilities: {
			...DEFAULT_ACP_CAPABILITIES,
			reasoning: descriptors.some(descriptor => descriptor.id === MODEL_OPTION_REASONING),
			contextWindow: tokens,
		},
		...(descriptors.length ? { optionDescriptors: descriptors } : {}),
		...(description ? { description } : {}),
		...(contextLabel ? { contextLabel } : {}),
	};
}

function effortChoices(levels: readonly { value: string; isDefault?: boolean }[], fallbackDefault?: string): IModelOptionDescriptor | undefined {
	const unique: { value: string; label: string; isDefault?: boolean }[] = [];
	for (const level of levels) {
		const value = level.value.trim().toLowerCase();
		if (!value || unique.some(choice => choice.value === value)) {
			continue;
		}
		unique.push({
			value,
			label: reasoningLabel(value),
			...(level.isDefault ? { isDefault: true } : {}),
		});
	}
	if (unique.length <= 1) {
		return undefined;
	}
	const preferred = fallbackDefault?.trim().toLowerCase();
	if (preferred && !unique.some(choice => choice.isDefault)) {
		const match = unique.find(choice => choice.value === preferred);
		if (match) {
			match.isDefault = true;
		}
	}
	return selectOption(MODEL_OPTION_REASONING, 'Effort', unique);
}

function contextChoices(contextWindow: number | undefined, maxContextWindow: number | undefined): IModelOptionDescriptor | undefined {
	if (!contextWindow || !maxContextWindow || maxContextWindow <= contextWindow) {
		return undefined;
	}
	const current = formatContextLabel(contextWindow);
	const max = formatContextLabel(maxContextWindow);
	if (!current || current === max) {
		return undefined;
	}
	return selectOption(MODEL_OPTION_CONTEXT, 'Context', [
		{ value: current, label: formatContextChoice(current), isDefault: true },
		{ value: max, label: formatContextChoice(max) },
	]);
}

function supportsFast(tiers: readonly string[], serviceNames: readonly string[]): boolean {
	const values = [...tiers, ...serviceNames].map(value => value.trim().toLowerCase());
	return values.some(value => value === 'fast' || value === 'priority');
}

function codexWire(value: unknown): ICodexWireModel | undefined {
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}
	return record as ICodexWireModel;
}

/** `~/.codex/models_cache.json` or a Codex app-server `model/list` page. Hidden rows are dropped. */
export function parseCodexModels(payload: unknown, contextById?: ReadonlyMap<string, ICodexContextWindow>): IModelInfo[] {
	const root = asRecord(payload);
	const listed = Array.isArray(payload)
		? payload
		: Array.isArray(root?.models)
			? root.models
			: Array.isArray(root?.data)
				? root.data
				: [];
	const models: IModelInfo[] = [];
	for (const entry of listed) {
		const wire = codexWire(entry);
		if (!wire) {
			continue;
		}
		if (wire.hidden === true || wire.visibility === 'hide') {
			continue;
		}
		const id = (wire.slug || wire.id || wire.model || '').trim();
		const label = (wire.display_name || wire.displayName || id).trim();
		if (!id || !label) {
			continue;
		}
		const efforts = [
			...(wire.supported_reasoning_levels ?? []).map(level => level.effort),
			...(wire.supportedReasoningEfforts ?? []).map(level => level.reasoningEffort),
		].filter((value): value is string => !!value?.trim());
		const defaultEffort = wire.default_reasoning_level || wire.defaultReasoningEffort;
		const extra = contextById?.get(id);
		const contextWindow = wire.context_window ?? wire.contextWindow ?? extra?.contextWindow;
		const maxContextWindow = wire.max_context_window ?? wire.maxContextWindow ?? extra?.maxContextWindow;
		const serviceNames = [
			...(wire.service_tiers ?? []).map(tier => tier.name || tier.id || ''),
			...(wire.serviceTiers ?? []).map(tier => tier.name || tier.id || ''),
		];
		const speed = [...(wire.additional_speed_tiers ?? []), ...(wire.additionalSpeedTiers ?? [])];
		const descriptors: IModelOptionDescriptor[] = [];
		const effort = effortChoices(efforts.map(value => ({ value })), defaultEffort);
		if (effort) {
			descriptors.push(effort);
		}
		const context = contextChoices(contextWindow, maxContextWindow);
		if (context) {
			descriptors.push(context);
		}
		if (supportsFast(speed, serviceNames)) {
			descriptors.push(booleanOption(MODEL_OPTION_FAST, 'Fast', false));
		}
		models.push(modelInfo(id, label, wire.description?.trim(), descriptors, contextWindow));
	}
	return models;
}

/** Claude Code's published model catalog (`surfaces.cc`). */
export function parseClaudeCatalog(payload: unknown): IModelInfo[] {
	const root = asRecord(payload);
	const surfaces = asRecord(root?.surfaces);
	const cc = asRecord(surfaces?.cc);
	const configs = Array.isArray(cc?.model_selector_config) ? cc.model_selector_config : [];
	const config = asRecord(configs[0]);
	const listed = Array.isArray(config?.models) ? config.models as IClaudeCatalogModel[] : [];
	const models: IModelInfo[] = [];
	for (const entry of listed) {
		const id = entry.id?.trim();
		const label = entry.name?.trim();
		if (!id || !label) {
			continue;
		}
		const runtime = entry.runtime;
		const defaultEffort = runtime?.default_effort;
		const effortOptions = entry.thinking?.type === 'effort' ? entry.thinking.effort_options ?? [] : [];
		const descriptors: IModelOptionDescriptor[] = [];
		const effort = effortChoices(effortOptions.flatMap(option => {
			const value = option.id?.trim();
			if (!value) {
				return [];
			}
			return [{
				value,
				isDefault: option.badge?.message?.toLowerCase() === 'default' || value === defaultEffort,
			}];
		}), defaultEffort);
		if (effort) {
			descriptors.push(effort);
		}
		if (entry.fast_mode?.type === 'toggle') {
			descriptors.push(booleanOption(MODEL_OPTION_FAST, 'Fast', false));
		}
		models.push(modelInfo(id, label, entry.description?.trim(), descriptors, runtime?.max_input_tokens));
	}
	return models;
}

/** `opencode models` prints `provider/model` lines and nothing else. */
export function parseOpenCodeModelLines(output: string): IModelInfo[] {
	const models: IModelInfo[] = [];
	const seen = new Set<string>();
	for (const line of output.split(/\r?\n/g)) {
		const id = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
		if (!id || id.includes(' ') || !id.includes('/') || seen.has(id)) {
			continue;
		}
		seen.add(id);
		const slug = id.slice(id.indexOf('/') + 1);
		models.push(modelInfo(id, prettifySlug(slug), undefined, [], undefined));
	}
	return models;
}

function prettifySlug(slug: string): string {
	return slug.split(/[-_:/]+/).filter(Boolean).map(part => {
		if (/^gpt/i.test(part)) {
			return part.replace(/^gpt/i, 'GPT');
		}
		if (/^\d/.test(part)) {
			return part;
		}
		return part.charAt(0).toUpperCase() + part.slice(1);
	}).join(' ');
}

export interface IModelEditSection {
	readonly id: 'options' | 'context' | 'effort' | 'custom';
	readonly label: string;
	readonly descriptors: readonly IModelOptionDescriptor[];
}

/**
 * Groups harness descriptors into the edit panel. Booleans land in Options at the position of
 * the first toggle, so a model that advertises effort then fast renders Effort then Options,
 * and one that advertises thinking then context then effort renders Options, Context, Effort.
 */
export function modelEditSections(descriptors: readonly IModelOptionDescriptor[] | undefined): IModelEditSection[] {
	const sections: IModelEditSection[] = [];
	const options: IModelOptionDescriptor[] = [];
	let optionsPlaced = false;
	const placeOptions = () => {
		if (optionsPlaced) {
			return;
		}
		optionsPlaced = true;
		sections.push({ id: 'options', label: 'Options', descriptors: options });
	};
	for (const descriptor of descriptors ?? []) {
		if (descriptor.type === 'boolean' || descriptor.id === MODEL_OPTION_FAST || descriptor.id === MODEL_OPTION_THINKING) {
			options.push(descriptor);
			placeOptions();
			continue;
		}
		if (descriptor.type === 'select' && (descriptor.options?.length ?? 0) <= 1) {
			continue;
		}
		if (descriptor.id === MODEL_OPTION_CONTEXT) {
			sections.push({ id: 'context', label: 'Context', descriptors: [descriptor] });
			continue;
		}
		if (descriptor.id === MODEL_OPTION_REASONING) {
			sections.push({ id: 'effort', label: 'Effort', descriptors: [descriptor] });
			continue;
		}
		sections.push({ id: 'custom', label: descriptor.label, descriptors: [descriptor] });
	}
	return sections.filter(section => section.descriptors.length);
}

export interface IModelHoverCard {
	title: string;
	description?: string;
	context?: string;
	version?: string;
}

/** Hover card copy from harness metadata and the user's current selections. */
export function modelHoverCard(name: string, description: string | undefined, contextLabel: string | undefined, effortLabel: string | undefined, fast: boolean): IModelHoverCard {
	const title = fast ? `${name} (fast)` : name;
	const context = contextLabel?.trim();
	const effort = effortLabel?.trim();
	return {
		title,
		...(description?.trim() ? { description: description.trim() } : {}),
		...(context ? { context: `${context.toLowerCase()} context window` } : {}),
		...(effort ? { version: `Version: ${effort.toLowerCase()} effort` } : {}),
	};
}

/** Keeps a Codex context window discovered in the on-disk cache when the live list omits it. */
export function codexContextIndex(payload: unknown): Map<string, ICodexContextWindow> {
	const index = new Map<string, ICodexContextWindow>();
	const root = asRecord(payload);
	const listed = Array.isArray(root?.models) ? root.models : [];
	for (const entry of listed) {
		const wire = codexWire(entry);
		const id = wire?.slug?.trim() || wire?.id?.trim();
		if (!id) {
			continue;
		}
		const contextWindow = wire?.context_window ?? wire?.contextWindow;
		const maxContextWindow = wire?.max_context_window ?? wire?.maxContextWindow;
		if (contextWindow || maxContextWindow) {
			index.set(id, {
				...(contextWindow ? { contextWindow } : {}),
				...(maxContextWindow ? { maxContextWindow } : {}),
			});
		}
	}
	return index;
}
