/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { contextLabelFromTokens, pickNumber, pickText } from '../../common/modelMeta.js';
import { booleanOption, IModelOptionDescriptor, IVoltModelOptions, MODEL_OPTION_CONTEXT, MODEL_OPTION_FAST, MODEL_OPTION_REASONING, MODEL_OPTION_THINKING, selectOption } from '../../common/modelOptions.js';

/**
 * Session config options as reported by an ACP agent.
 * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
 */
export interface IAcpSelectChoice {
	value: string;
	name: string;
}

interface IAcpChoiceGroup {
	options: IAcpSelectChoice[];
}

export interface IAcpConfigOption {
	id: string;
	name: string;
	category?: string;
	type?: string;
	currentValue?: string | boolean;
	options?: (IAcpSelectChoice | IAcpChoiceGroup)[];
}

export interface IAcpAvailableModel {
	/** `cursor/list_available_models` says `value`; a session's `availableModels` says `modelId`. */
	value?: string;
	modelId?: string;
	name: string;
	description?: string;
	longDescription?: string;
	displayName?: string;
	contextWindow?: number;
	contextLength?: number;
	context_length?: number;
	configOptions?: IAcpConfigOption[];
	_meta?: Record<string, unknown>;
}

export interface IAcpModelMeta {
	description?: string;
	contextLabel?: string;
	contextWindow?: number;
}

/** Reads description and context from whatever the agent actually sent. Nothing is invented. */
export function metadataFromAcpModel(model: IAcpAvailableModel, params: Record<string, string> = {}): IAcpModelMeta {
	const raw = model as IAcpAvailableModel & Record<string, unknown>;
	const extra = model._meta && typeof model._meta === 'object' ? model._meta : {};
	const description = pickText(
		model.description,
		model.longDescription,
		raw.blurb,
		raw.summary,
		raw.about,
		raw.shortDescription,
		extra.description,
		extra.longDescription,
		extra.blurb,
		extra.summary,
	);
	const tokens = pickNumber(
		model.contextWindow,
		model.contextLength,
		model.context_length,
		extra.contextWindow,
		extra.contextLength,
		extra.context_length,
		params.context,
	);
	return {
		...(description ? { description } : {}),
		...(tokens ? { contextWindow: tokens, contextLabel: contextLabelFromTokens(tokens) } : params.context ? { contextLabel: params.context } : {}),
	};
}

/** Choices may arrive grouped, so both shapes flatten to a single list. */
export function flattenChoices(option: IAcpConfigOption | undefined): IAcpSelectChoice[] {
	if (!option || option.type !== 'select') {
		return [];
	}
	return (option.options ?? []).flatMap(entry => 'value' in entry
		? [{ value: String(entry.value).trim(), name: String(entry.name).trim() }]
		: (entry.options ?? []).map(choice => ({ value: String(choice.value).trim(), name: String(choice.name).trim() })));
}

function id(option: IAcpConfigOption): string {
	return option.id?.trim().toLowerCase() ?? '';
}

function name(option: IAcpConfigOption): string {
	return option.name?.trim().toLowerCase() ?? '';
}

function category(option: IAcpConfigOption): string {
	return option.category?.trim().toLowerCase() ?? '';
}

export function isModelConfigOption(option: IAcpConfigOption): boolean {
	return category(option) === 'model' || id(option) === 'model';
}

function isReasoningOption(option: IAcpConfigOption): boolean {
	return ['effort', 'reasoning'].includes(id(option))
		|| ['effort', 'reasoning'].includes(name(option))
		|| name(option).includes('effort')
		|| name(option).includes('reasoning');
}

function findReasoningOption(configOptions: readonly IAcpConfigOption[]): IAcpConfigOption | undefined {
	const candidates = configOptions.filter(option => option.type === 'select' && isReasoningOption(option));
	return candidates.find(option => category(option) === 'model_option')
		?? candidates.find(option => id(option) === 'effort')
		?? candidates.find(option => category(option) === 'thought_level')
		?? candidates[0];
}

function isContextOption(option: IAcpConfigOption): boolean {
	return id(option) === 'context' || id(option) === 'context_size' || name(option).includes('context');
}

function isFastOption(option: IAcpConfigOption): boolean {
	return id(option) === 'fast' || name(option) === 'fast' || name(option).includes('fast mode');
}

function isThinkingOption(option: IAcpConfigOption): boolean {
	return id(option) === 'thinking' || name(option).includes('thinking');
}

/** Some agents model a toggle as a two value select of "true"/"false". */
function booleanLike(option: IAcpConfigOption): boolean {
	if (option.type === 'boolean') {
		return true;
	}
	const values = new Set(flattenChoices(option).map(choice => choice.value.toLowerCase()));
	return values.has('true') && values.has('false');
}

function booleanCurrentValue(option: IAcpConfigOption): boolean {
	if (typeof option.currentValue === 'boolean') {
		return option.currentValue;
	}
	return String(option.currentValue ?? '').trim().toLowerCase() === 'true';
}

/** Translates one model's ACP config options into descriptors the composer can render. */
export function descriptorsFromConfigOptions(configOptions: readonly IAcpConfigOption[] | undefined): IModelOptionDescriptor[] {
	if (!configOptions?.length) {
		return [];
	}
	const descriptors: IModelOptionDescriptor[] = [];

	const thinking = configOptions.find(option => isThinkingOption(option) && booleanLike(option));
	if (thinking) {
		descriptors.push(booleanOption(MODEL_OPTION_THINKING, thinking.name?.trim() || 'Thinking', booleanCurrentValue(thinking)));
	}

	const fast = configOptions.find(option => isFastOption(option) && booleanLike(option));
	if (fast) {
		descriptors.push(booleanOption(MODEL_OPTION_FAST, fast.name?.trim() || 'Fast', booleanCurrentValue(fast)));
	}

	const context = configOptions.find(option => option.type === 'select' && isContextOption(option) && !booleanLike(option));
	const contextChoices = flattenChoices(context);
	if (context && contextChoices.length > 1) {
		descriptors.push(selectOption(MODEL_OPTION_CONTEXT, context.name?.trim() || 'Context', contextChoices.map(choice => ({
			value: choice.value,
			label: choice.name,
			isDefault: choice.value === context.currentValue,
		}))));
	}

	const reasoning = findReasoningOption(configOptions);
	const reasoningChoices = flattenChoices(reasoning);
	if (reasoning && !booleanLike(reasoning) && reasoningChoices.length > 1) {
		descriptors.push(selectOption(MODEL_OPTION_REASONING, reasoning.name?.trim() || 'Effort', reasoningChoices.map(choice => ({
			value: choice.value,
			label: choice.name,
			isDefault: choice.value === reasoning.currentValue,
		}))));
	}

	return descriptors;
}

/**
 * Cursor enumerates its models as `base[key=value,...]`, e.g.
 * `claude-opus-5[thinking=true,context=300k,effort=high,fast=false]`. The bracketed parameters are
 * baked into the id: the agent rejects any combination it did not advertise, so they are shown as
 * detail rather than offered as choices. Builds on the lab channel answer
 * `cursor/list_available_models` instead and get real per model options.
 */
export function parseParameterizedModelId(value: string): { base: string; params: Record<string, string> } {
	const match = /^(.*?)\[(.*)\]$/.exec(value.trim());
	if (!match) {
		return { base: value.trim(), params: {} };
	}
	const params: Record<string, string> = {};
	for (const pair of match[2].split(',')) {
		const [key, ...rest] = pair.split('=');
		if (key.trim() && rest.length) {
			params[key.trim().toLowerCase()] = rest.join('=').trim();
		}
	}
	return { base: match[1].trim(), params };
}

const CURSOR_EFFORTS = [
	{ value: 'low', label: 'Low' },
	{ value: 'medium', label: 'Medium' },
	{ value: 'high', label: 'High' },
	{ value: 'xhigh', label: 'Extra High' },
];

function normalizeEffortValue(value: string): string {
	const normalized = value.trim().toLowerCase();
	return normalized === 'extra-high' || normalized === 'extra high' ? 'xhigh' : normalized;
}

/**
 * Turns the keys baked into a Cursor model id into selectable descriptors. `grok-4.6[effort=high,fast=true]`
 * becomes Effort (Low / Medium / High / Extra High) plus a Fast toggle, matching the T3 picker.
 */
export function descriptorsFromParams(params: Record<string, string>): IModelOptionDescriptor[] {
	const descriptors: IModelOptionDescriptor[] = [];
	const effort = params.effort ?? params.reasoning;
	if (effort) {
		const current = normalizeEffortValue(effort);
		const choices = CURSOR_EFFORTS.map(choice => ({ ...choice, isDefault: choice.value === current }));
		if (current === 'max' && !choices.some(choice => choice.value === 'max')) {
			choices.push({ value: 'max', label: 'Max', isDefault: true });
		}
		descriptors.push(selectOption(MODEL_OPTION_REASONING, 'Effort', choices));
	}
	if (params.context) {
		const windows = [...new Set([params.context, '200k', '272k', '300k', '1m'])];
		descriptors.push(selectOption(MODEL_OPTION_CONTEXT, 'Context', windows.map(value => ({
			value,
			label: value.toUpperCase(),
			isDefault: value === params.context,
		}))));
	}
	if (params.fast !== undefined) {
		descriptors.push(booleanOption(MODEL_OPTION_FAST, 'Fast', params.fast === 'true'));
	}
	if (params.thinking !== undefined) {
		descriptors.push(booleanOption(MODEL_OPTION_THINKING, 'Thinking', params.thinking === 'true'));
	}
	return descriptors;
}

/** `grok-4.6` -> `Grok 4.6`, `gpt-5.6-sol` -> `GPT-5.6 Sol`. */
export function prettifyModelSlug(slug: string): string {
	const base = slug.replace(/\[.*\]$/, '').trim();
	if (!base || base === 'default') {
		return 'Auto';
	}
	return base.split('-').map(part => {
		if (/^gpt/i.test(part)) {
			return part.replace(/^gpt/i, 'GPT');
		}
		if (/^\d/.test(part)) {
			return part;
		}
		return part.charAt(0).toUpperCase() + part.slice(1);
	}).join(' ');
}

/** Pretty model name without a provider prefix: `Grok 4.6`. */
export function formatAgentModelLabel(_providerLabel: string, slug: string, rawName?: string): string {
	return prettifyModelSlug(slug || rawName || '');
}

/**
 * Writes the user's Effort / Fast / Thinking / Context choices back into a Cursor model id,
 * keeping the original key order so the agent still recognizes the value.
 */
export function applyOptionsToParameterizedId(modelId: string, options: IVoltModelOptions | undefined): string {
	const { base, params } = parseParameterizedModelId(modelId);
	if (!base || !Object.keys(params).length) {
		return modelId;
	}
	const next = { ...params };
	const effort = options?.[MODEL_OPTION_REASONING];
	if (typeof effort === 'string') {
		if ('effort' in next) {
			next.effort = effort;
		} else if ('reasoning' in next) {
			next.reasoning = effort;
		}
	}
	if (options?.[MODEL_OPTION_FAST] !== undefined && 'fast' in next) {
		next.fast = options[MODEL_OPTION_FAST] ? 'true' : 'false';
	}
	if (options?.[MODEL_OPTION_THINKING] !== undefined && 'thinking' in next) {
		next.thinking = options[MODEL_OPTION_THINKING] ? 'true' : 'false';
	}
	if (options?.[MODEL_OPTION_CONTEXT] !== undefined && 'context' in next) {
		next.context = String(options[MODEL_OPTION_CONTEXT]);
	}
	return `${base}[${Object.keys(params).map(key => `${key}=${next[key]}`).join(',')}]`;
}

export interface IAcpConfigUpdate {
	configId: string;
	value: string | boolean;
}

/**
 * Maps the user's selections back onto the live session config options. Values are sent in the
 * shape the agent declared, so a toggle backed by a select goes out as "true"/"false".
 */
export function configUpdatesForOptions(configOptions: readonly IAcpConfigOption[] | undefined, options: IVoltModelOptions | undefined): IAcpConfigUpdate[] {
	if (!configOptions?.length || !options) {
		return [];
	}
	const updates: IAcpConfigUpdate[] = [];
	const push = (option: IAcpConfigOption | undefined, value: string | boolean | undefined) => {
		if (!option || value === undefined) {
			return;
		}
		if (typeof value === 'boolean' && option.type !== 'boolean') {
			updates.push({ configId: option.id, value: value ? 'true' : 'false' });
			return;
		}
		updates.push({ configId: option.id, value });
	};

	push(configOptions.find(option => isThinkingOption(option) && booleanLike(option)), options[MODEL_OPTION_THINKING]);
	push(configOptions.find(option => isFastOption(option) && booleanLike(option)), options[MODEL_OPTION_FAST]);
	push(configOptions.find(option => option.type === 'select' && isContextOption(option) && !booleanLike(option)), options[MODEL_OPTION_CONTEXT]);
	push(findReasoningOption(configOptions), options[MODEL_OPTION_REASONING]);
	return updates;
}
