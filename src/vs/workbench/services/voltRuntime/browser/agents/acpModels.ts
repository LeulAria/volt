/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { catalogOverlay } from '../../common/models/agentModelCatalogs.js';
import { normalizeCursorModelId } from '../../common/harness/cursorQuota.js';
import { contextLabelFromTokens, formatContextChoice, pickNumber, pickText } from '../../common/models/modelMeta.js';
import { booleanOption, fillDescriptors, IModelOptionDescriptor, IVoltModelOptions, MODEL_OPTION_CONTEXT, MODEL_OPTION_FAST, MODEL_OPTION_REASONING, MODEL_OPTION_SERVICE_TIER, MODEL_OPTION_THINKING, reasoningLabel, reasoningOption, selectOption } from '../../common/models/modelOptions.js';

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
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
	const limit = asRecord(raw.limit) ?? asRecord(extra.limit);
	const capabilities = asRecord(raw.capabilities) ?? asRecord(extra.capabilities);
	const tokens = pickNumber(
		model.contextWindow,
		model.contextLength,
		model.context_length,
		raw.max_model_len,
		limit?.context,
		limit?.contextWindow,
		limit?.context_length,
		capabilities?.contextWindow,
		capabilities?.contextLength,
		capabilities?.maxContextTokens,
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
	if (!option || (option.type && option.type !== 'select' && option.type !== 'string')) {
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

function isSessionModeOption(option: IAcpConfigOption): boolean {
	return id(option) === 'mode' || category(option) === 'mode' || name(option) === 'session mode';
}

function isIgnoredConfigOption(option: IAcpConfigOption): boolean {
	return isModelConfigOption(option) || isSessionModeOption(option);
}

const EFFORT_VALUES = new Set(['minimal', 'min', 'low', 'medium', 'med', 'high', 'xhigh', 'x-high', 'max', 'ultra', 'ultracode', 'ultrathink']);

function looksLikeEffortValue(value: string): boolean {
	return EFFORT_VALUES.has(value.trim().toLowerCase());
}

function isReasoningOption(option: IAcpConfigOption): boolean {
	if (category(option) === 'thought_level'
		|| ['effort', 'reasoning'].includes(id(option))
		|| ['effort', 'reasoning'].includes(name(option))
		|| name(option).includes('effort')
		|| name(option).includes('reasoning')) {
		return true;
	}
	if (id(option) === 'variant' || name(option) === 'variant') {
		const choices = flattenChoices({ ...option, type: option.type ?? 'select' })
			.filter(choice => choice.value.toLowerCase() !== 'default');
		return choices.length > 0 && choices.every(choice => looksLikeEffortValue(choice.value) || looksLikeEffortValue(choice.name));
	}
	return false;
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

function isServiceTierOption(option: IAcpConfigOption): boolean {
	const key = id(option).replace(/[\s-]/g, '');
	return ['servicetier', 'service_tier', 'speed', 'speedtier'].includes(key)
		|| name(option).includes('service tier')
		|| (name(option).includes('speed') && !name(option).includes('reasoning'));
}

function canonicalSelectId(option: IAcpConfigOption): string {
	if (isReasoningOption(option)) {
		return MODEL_OPTION_REASONING;
	}
	if (isContextOption(option)) {
		return MODEL_OPTION_CONTEXT;
	}
	if (isServiceTierOption(option)) {
		return MODEL_OPTION_SERVICE_TIER;
	}
	if (isFastOption(option)) {
		return MODEL_OPTION_FAST;
	}
	if (isThinkingOption(option)) {
		return MODEL_OPTION_THINKING;
	}
	return option.id?.trim() || option.name?.trim() || 'option';
}

function defaultSelectLabel(optionId: string, fallback: string): string {
	if (optionId === MODEL_OPTION_REASONING) {
		return 'Reasoning';
	}
	if (optionId === MODEL_OPTION_CONTEXT) {
		return 'Context Window';
	}
	if (optionId === MODEL_OPTION_SERVICE_TIER) {
		return 'Service Tier';
	}
	if (optionId === MODEL_OPTION_FAST) {
		return 'Fast';
	}
	if (optionId === MODEL_OPTION_THINKING) {
		return 'Thinking';
	}
	return fallback;
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
	const seen = new Set<string>();
	for (const option of configOptions) {
		if (isIgnoredConfigOption(option)) {
			continue;
		}
		if (booleanLike(option)) {
			const optionId = isThinkingOption(option)
				? MODEL_OPTION_THINKING
				: isFastOption(option)
					? MODEL_OPTION_FAST
					: option.id?.trim() || 'toggle';
			if (seen.has(optionId)) {
				continue;
			}
			seen.add(optionId);
			descriptors.push(booleanOption(optionId, option.name?.trim() || defaultSelectLabel(optionId, 'Option'), booleanCurrentValue(option)));
			continue;
		}
		if (option.type && option.type !== 'select' && option.type !== 'string' && !option.options?.length) {
			continue;
		}
		const optionId = canonicalSelectId(option);
		const choices = flattenChoices({ ...option, type: 'select' })
			.filter(choice => optionId !== MODEL_OPTION_REASONING || choice.value.toLowerCase() !== 'default');
		if (choices.length <= 1) {
			continue;
		}
		if (seen.has(optionId)) {
			continue;
		}
		seen.add(optionId);
		const current = option.currentValue === undefined ? undefined : String(option.currentValue);
		const mapped = choices.map(choice => ({
			value: choice.value,
			label: optionId === MODEL_OPTION_REASONING
				? reasoningLabel(choice.name || choice.value)
				: optionId === MODEL_OPTION_CONTEXT
					? formatContextChoice(choice.name || choice.value)
					: optionId === MODEL_OPTION_SERVICE_TIER
						? serviceTierLabel(choice.name || choice.value)
						: (choice.name || choice.value),
			isDefault: current !== undefined && choice.value === current,
		}));
		if (optionId === MODEL_OPTION_REASONING && !mapped.some(choice => choice.isDefault)) {
			const preferred = mapped.find(choice => choice.value === 'high') ?? mapped[0];
			if (preferred) {
				preferred.isDefault = true;
			}
		}
		descriptors.push(selectOption(optionId, option.name?.trim() || defaultSelectLabel(optionId, option.id), mapped));
	}
	return descriptors;
}

function serviceTierLabel(value: string): string {
	const key = value.trim().toLowerCase();
	if (key === 'default' || key === 'standard') {
		return 'Standard';
	}
	if (key === 'fast' || key === 'priority') {
		return 'Fast';
	}
	if (key === 'flex') {
		return 'Flex';
	}
	if (key === 'ultrafast' || key === 'ultra-fast') {
		return 'Ultra Fast';
	}
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeServiceTier(value: string): string {
	const key = value.trim().toLowerCase();
	return key === 'priority' ? 'fast' : key;
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
 * becomes Reasoning (Low / Medium / High / X-High) plus a Fast toggle.
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
		descriptors.push(selectOption(MODEL_OPTION_REASONING, 'Reasoning', choices));
	}
	if (params.context) {
		descriptors.push(selectOption(MODEL_OPTION_CONTEXT, 'Context Window', [{
			value: params.context,
			label: formatContextChoice(params.context),
			isDefault: true,
		}]));
	}
	if (params.fast !== undefined) {
		descriptors.push(booleanOption(MODEL_OPTION_FAST, 'Fast', params.fast === 'true'));
	}
	if (params.thinking !== undefined) {
		descriptors.push(booleanOption(MODEL_OPTION_THINKING, 'Thinking', params.thinking === 'true'));
	}
	const tier = params.servicetier ?? params.service_tier ?? params.speed;
	if (tier) {
		descriptors.push(selectOption(MODEL_OPTION_SERVICE_TIER, 'Service Tier', [{
			value: normalizeServiceTier(tier),
			label: serviceTierLabel(tier),
			isDefault: true,
		}]));
	}
	return descriptors;
}

const VARIANT_LEVELS: Record<string, string> = {
	minimal: 'minimal',
	min: 'minimal',
	low: 'low',
	medium: 'medium',
	med: 'medium',
	high: 'high',
	xhigh: 'xhigh',
	'x-high': 'xhigh',
	max: 'max',
	ultra: 'ultra',
	ultracode: 'ultracode',
	ultrathink: 'ultrathink',
};

function variantLevel(value: string): string | undefined {
	return VARIANT_LEVELS[value.trim().toLowerCase()];
}

function descriptorsFromCursorParameters(model: IAcpAvailableModel | undefined): IModelOptionDescriptor[] {
	const raw = model as IAcpAvailableModel & Record<string, unknown> | undefined;
	const extra = asRecord(model?._meta) ?? {};
	const parameters = asArray(raw?.parameters) ?? asArray(extra.parameters);
	if (!parameters?.length) {
		return [];
	}
	const variants = asArray(raw?.variants) ?? asArray(extra.variants) ?? [];
	const defaultParams = asArray(variants.map(item => asRecord(item)).find(item => item?.isDefault === true)?.params) ?? [];
	const descriptors: IModelOptionDescriptor[] = [];
	for (const parameter of parameters) {
		const record = asRecord(parameter);
		if (!record) {
			continue;
		}
		const parameterId = pickText(record.id, record.name);
		if (!parameterId) {
			continue;
		}
		const values = asArray(record.values) ?? [];
		const choices = values.flatMap(value => {
			const choice = asRecord(value);
			const id = pickText(choice?.value, choice?.id);
			if (!id) {
				return [];
			}
			return [{ value: id, label: pickText(choice?.displayName, choice?.name, choice?.label) ?? id }];
		});
		if (choices.length <= 1) {
			continue;
		}
		const fake: IAcpConfigOption = { id: parameterId, name: pickText(record.displayName, record.name, record.label) ?? parameterId, type: 'select' };
		const optionId = canonicalSelectId(fake);
		const defaultChoice = defaultParams
			.map(item => asRecord(item))
			.find(item => pickText(item?.id, item?.name) === parameterId);
		const current = pickText(defaultChoice?.value, defaultChoice?.id);
		descriptors.push(selectOption(optionId, fake.name || defaultSelectLabel(optionId, parameterId), choices.map(choice => ({
			...choice,
			label: optionId === MODEL_OPTION_REASONING ? reasoningLabel(choice.label) : optionId === MODEL_OPTION_CONTEXT ? formatContextChoice(choice.label) : choice.label,
			isDefault: current ? choice.value === current : undefined,
		}))));
	}
	return descriptors;
}

function collectReasoningValues(model: IAcpAvailableModel | undefined): string[] {
	const raw = model as IAcpAvailableModel & Record<string, unknown> | undefined;
	const extra = asRecord(model?._meta) ?? {};
	const values: string[] = [];
	const push = (value: unknown) => {
		const record = asRecord(value);
		const text = pickText(
			typeof value === 'string' ? value : undefined,
			record?.reasoningEffort,
			record?.id,
			record?.value,
			record?.name,
		);
		const level = text ? variantLevel(text) : undefined;
		if (level && !values.includes(level)) {
			values.push(level);
		}
	};
	for (const source of [
		raw?.supportedReasoningEfforts,
		raw?.supported_reasoning_efforts,
		raw?.reasoning_levels,
		raw?.reasoningLevels,
		raw?.efforts,
		extra.supportedReasoningEfforts,
		extra.supported_reasoning_efforts,
		extra.reasoning_levels,
		extra.reasoningLevels,
		extra.efforts,
		extra.variants,
		raw?.variants,
	]) {
		if (Array.isArray(source)) {
			source.forEach(push);
		} else if (asRecord(source)) {
			Object.keys(source as Record<string, unknown>).forEach(push);
		}
	}
	return values;
}

function descriptorsFromReasoningMeta(model: IAcpAvailableModel | undefined): IModelOptionDescriptor[] {
	const values = collectReasoningValues(model);
	if (values.length <= 1) {
		return [];
	}
	return [reasoningOption(values, values.includes('high') ? 'high' : values[0])];
}

function descriptorsFromServiceTierMeta(model: IAcpAvailableModel | undefined): IModelOptionDescriptor[] {
	const raw = model as IAcpAvailableModel & Record<string, unknown> | undefined;
	const extra = asRecord(model?._meta) ?? {};
	const tiers = asArray(raw?.serviceTiers) ?? asArray(extra.serviceTiers) ?? [];
	const additional = asArray(raw?.additionalSpeedTiers) ?? asArray(extra.additionalSpeedTiers) ?? [];
	const choices = [{ value: 'default', label: 'Standard', isDefault: true }];
	const seen = new Set(['default']);
	const pushTier = (value: unknown) => {
		const record = asRecord(value);
		const wire = pickText(record?.id, record?.value, typeof value === 'string' ? value : undefined);
		if (!wire) {
			return;
		}
		const id = normalizeServiceTier(wire);
		if (!seen.add(id)) {
			return;
		}
		choices.push({
			value: id,
			label: pickText(record?.name, record?.label, record?.displayName) ?? serviceTierLabel(wire),
			isDefault: false,
		});
	};
	tiers.forEach(pushTier);
	additional.forEach(pushTier);
	if (choices.length <= 1) {
		return [];
	}
	const current = pickText(raw?.defaultServiceTier, extra.defaultServiceTier);
	const normalized = current ? normalizeServiceTier(current) : 'default';
	return [selectOption(MODEL_OPTION_SERVICE_TIER, 'Service Tier', choices.map(choice => ({
		...choice,
		isDefault: choice.value === (seen.has(normalized) ? normalized : 'default'),
	})))];
}

/**
 * Every advertised select/toggle from the model payload, then any parameterized id
 * fallback, then shared session options. Overlay catalogs fill only what is still missing.
 */
export function descriptorsFromAcpModel(
	model: IAcpAvailableModel | undefined,
	params: Record<string, string> = {},
	shared: readonly IModelOptionDescriptor[] = [],
	providerId?: string,
	modelId?: string,
	label?: string,
): IModelOptionDescriptor[] {
	let descriptors: IModelOptionDescriptor[] = [];
	descriptors = fillDescriptors(descriptors, descriptorsFromConfigOptions(model?.configOptions));
	descriptors = fillDescriptors(descriptors, descriptorsFromCursorParameters(model));
	descriptors = fillDescriptors(descriptors, descriptorsFromReasoningMeta(model));
	descriptors = fillDescriptors(descriptors, descriptorsFromServiceTierMeta(model));
	descriptors = fillDescriptors(descriptors, descriptorsFromParams(params));
	if (providerId) {
		const overlay = catalogOverlay(providerId, modelId ?? '', label);
		if (overlay) {
			descriptors = fillDescriptors(descriptors, overlay.optionDescriptors);
		}
	}
	descriptors = fillDescriptors(descriptors, shared);
	return descriptors;
}

export function metadataForAcpModel(
	model: IAcpAvailableModel | undefined,
	params: Record<string, string> = {},
	providerId?: string,
	modelId?: string,
	label?: string,
): IAcpModelMeta {
	const wire = model ? metadataFromAcpModel(model, params) : (params.context ? { contextLabel: params.context } : {});
	const overlay = providerId ? catalogOverlay(providerId, modelId ?? '', label) : undefined;
	const description = wire.description ?? overlay?.description;
	const contextWindow = wire.contextWindow ?? overlay?.contextWindow;
	const contextLabel = wire.contextLabel ?? (contextWindow ? contextLabelFromTokens(contextWindow) : undefined);
	return {
		...(description ? { description } : {}),
		...(contextWindow ? { contextWindow } : {}),
		...(contextLabel ? { contextLabel } : {}),
	};
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
		return normalizeCursorModelId(modelId) ?? modelId;
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
	const tier = options?.[MODEL_OPTION_SERVICE_TIER];
	if (typeof tier === 'string') {
		if ('servicetier' in next) {
			next.servicetier = tier;
		} else if ('service_tier' in next) {
			next.service_tier = tier;
		} else if ('speed' in next) {
			next.speed = tier;
		}
	}
	return `${base}[${Object.keys(params).map(key => `${key}=${next[key]}`).join(',')}]`;
}

/** Claude's 1M window is selected by appending `[1m]` to a bare model id. */
export function applyContextWindowSuffix(modelId: string, options: IVoltModelOptions | undefined): string {
	const { params } = parseParameterizedModelId(modelId);
	if (Object.keys(params).length) {
		return modelId;
	}
	const stripped = modelId.replace(/\[1m\]$/i, '');
	const value = options?.[MODEL_OPTION_CONTEXT];
	if (typeof value !== 'string') {
		return stripped;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === '1m' || normalized === '1000k' || normalized === '1000000') {
		return `${stripped}[1m]`;
	}
	return stripped;
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
	const used = new Set<string>();
	const push = (option: IAcpConfigOption | undefined, value: string | boolean | undefined) => {
		if (!option || value === undefined || used.has(option.id)) {
			return;
		}
		used.add(option.id);
		if (typeof value === 'boolean' && option.type !== 'boolean') {
			updates.push({ configId: option.id, value: value ? 'true' : 'false' });
			return;
		}
		updates.push({ configId: option.id, value });
	};

	for (const [key, value] of Object.entries(options)) {
		const option = configOptions.find(item => canonicalSelectId(item) === key || item.id === key);
		push(option, value);
	}
	return updates;
}
