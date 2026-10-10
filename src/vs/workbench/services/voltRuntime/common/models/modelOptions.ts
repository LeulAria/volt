/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per model options (reasoning, context window, service tier, fast, thinking) are described by
 * the provider rather than invented by the UI. A CLI agent reports them over ACP, an HTTP
 * provider declares them statically, and the composer renders whatever it is given.
 */

export interface IModelOptionChoice {
	value: string;
	label: string;
	isDefault?: boolean;
}

export interface IModelOptionDescriptor {
	id: string;
	label: string;
	type: 'select' | 'boolean';
	/** Choices for a `select` descriptor. */
	options?: IModelOptionChoice[];
	/** Initial state for a `boolean` descriptor. */
	defaultValue?: boolean;
}

/** User selections keyed by descriptor id. */
export type IVoltModelOptions = Record<string, string | boolean>;

export const VOLT_MODEL_OPTIONS_STORAGE_KEY = 'volt.runtime.modelOptions';

/** Descriptor ids the UI and the providers agree on, so summaries stay meaningful. */
export const MODEL_OPTION_REASONING = 'reasoning';
export const MODEL_OPTION_CONTEXT = 'contextWindow';
export const MODEL_OPTION_SERVICE_TIER = 'serviceTier';
export const MODEL_OPTION_FAST = 'fastMode';
export const MODEL_OPTION_THINKING = 'thinking';

/**
 * Sampling pins for API models, set in Settings > Providers & Models. They live in the same
 * per-model record as the option selections (as strings) but are not descriptors: no provider
 * advertises them, and an unset pin means the provider's own default. Agent CLIs never get them.
 */
export const MODEL_PARAM_TEMPERATURE = 'temperature';
export const MODEL_PARAM_TOP_P = 'topP';
export const MODEL_PARAM_MAX_OUTPUT = 'maxOutputTokens';

export interface IModelParamSpec {
	readonly id: string;
	readonly min: number;
	readonly max: number;
	readonly integer: boolean;
}

export const MODEL_GENERATION_PARAMS: readonly IModelParamSpec[] = [
	{ id: MODEL_PARAM_TEMPERATURE, min: 0, max: 2, integer: false },
	{ id: MODEL_PARAM_TOP_P, min: 0, max: 1, integer: false },
	{ id: MODEL_PARAM_MAX_OUTPUT, min: 1, max: 1_000_000, integer: true },
];

export interface IModelGenerationParams {
	readonly temperature?: number;
	readonly topP?: number;
	readonly maxOutputTokens?: number;
}

/** A stored pin as a number in its range, or undefined for blank, malformed or out-of-range input. */
export function parseModelParam(id: string, value: string | boolean | undefined): number | undefined {
	const spec = MODEL_GENERATION_PARAMS.find(candidate => candidate.id === id);
	if (!spec || typeof value !== 'string' || !value.trim()) {
		return undefined;
	}
	const parsed = Number(value.trim());
	if (!Number.isFinite(parsed) || parsed < spec.min || parsed > spec.max || (spec.integer && !Number.isInteger(parsed))) {
		return undefined;
	}
	return parsed;
}

/** The pins a request carries, read from resolved options. */
export function generationParams(options: IVoltModelOptions | undefined): IModelGenerationParams {
	const temperature = parseModelParam(MODEL_PARAM_TEMPERATURE, options?.[MODEL_PARAM_TEMPERATURE]);
	const topP = parseModelParam(MODEL_PARAM_TOP_P, options?.[MODEL_PARAM_TOP_P]);
	const maxOutputTokens = parseModelParam(MODEL_PARAM_MAX_OUTPUT, options?.[MODEL_PARAM_MAX_OUTPUT]);
	return {
		...(temperature !== undefined ? { temperature } : {}),
		...(topP !== undefined ? { topP } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	};
}

/** Only the valid pins of a stored record, for merging back after `resolveModelOptions` drops them. */
export function pickGenerationParams(options: IVoltModelOptions | undefined): IVoltModelOptions {
	const picked: IVoltModelOptions = {};
	for (const spec of MODEL_GENERATION_PARAMS) {
		const value = parseModelParam(spec.id, options?.[spec.id]);
		if (value !== undefined) {
			picked[spec.id] = String(value);
		}
	}
	return picked;
}

/** Trait rows render in this order, then any other advertised selects. */
export const MODEL_OPTION_TRAIT_ORDER = [
	MODEL_OPTION_REASONING,
	MODEL_OPTION_CONTEXT,
	MODEL_OPTION_SERVICE_TIER,
	MODEL_OPTION_FAST,
	MODEL_OPTION_THINKING,
] as const;

export function selectOption(id: string, label: string, options: IModelOptionChoice[]): IModelOptionDescriptor {
	return { id, label, type: 'select', options };
}

export function booleanOption(id: string, label: string, defaultValue = false): IModelOptionDescriptor {
	return { id, label, type: 'boolean', defaultValue };
}

export function reasoningOption(values: readonly (string | IModelOptionChoice)[], defaultValue?: string): IModelOptionDescriptor {
	const choices = values.map(value => typeof value === 'string'
		? { value, label: reasoningLabel(value), isDefault: value === defaultValue }
		: value);
	return selectOption(MODEL_OPTION_REASONING, 'Reasoning', choices);
}

const REASONING_LABELS: Record<string, string> = {
	auto: 'Auto',
	off: 'Off',
	none: 'None',
	minimal: 'Minimal',
	min: 'Minimal',
	low: 'Low',
	medium: 'Medium',
	med: 'Medium',
	high: 'High',
	xhigh: 'Extra High',
	'x-high': 'Extra High',
	'extra-high': 'Extra High',
	'extra high': 'Extra High',
	extrahigh: 'Extra High',
	max: 'Max',
	ultra: 'Ultra',
	ultracode: 'Ultracode',
	ultrathink: 'Ultrathink',
	thinking: 'Thinking',
};

/** Short trigger chip so "X-High" does not stretch the model button. */
const COMPACT_REASONING_LABELS: Record<string, string> = {
	auto: '',
	off: 'Off',
	none: '',
	minimal: 'Min',
	min: 'Min',
	low: 'L',
	medium: 'M',
	med: 'M',
	high: 'H',
	xhigh: 'xH',
	'x-high': 'xH',
	'extra-high': 'xH',
	'extra high': 'xH',
	extrahigh: 'xH',
	max: 'Max',
	ultra: 'U',
	ultracode: 'UC',
	ultrathink: 'UT',
	thinking: 'T',
};

function normalizeEffortKey(value: string): string {
	return value.trim().toLowerCase().replace(/[_]+/g, '-').replace(/\s+/g, ' ');
}

function lookupEffortMap(value: string, map: Record<string, string>): string | undefined {
	const key = normalizeEffortKey(value);
	if (key in map) {
		return map[key];
	}
	const collapsed = key.replace(/[\s-]/g, '');
	return collapsed in map ? map[collapsed] : undefined;
}

export function reasoningLabel(value: string): string {
	return lookupEffortMap(value, REASONING_LABELS) ?? value.charAt(0).toUpperCase() + value.slice(1);
}

export function compactEffortLabel(value: string, fullLabel = ''): string {
	for (const raw of [value, fullLabel]) {
		if (!raw?.trim()) {
			continue;
		}
		const mapped = lookupEffortMap(raw, COMPACT_REASONING_LABELS);
		if (mapped !== undefined) {
			return mapped;
		}
	}
	const label = (fullLabel || value).trim();
	if (!label || label.length <= 3) {
		return label;
	}
	const words = label.split(/\s+/).filter(Boolean);
	if (words.length > 1) {
		return words.map(word => word[0]).join('');
	}
	return label.slice(0, 3);
}

/** Trailing Effort / Fast words that agents bake into a display name. */
const MODEL_OPTION_SUFFIX = /(?:\s+(?:extra[\s-]*high|x[\s-]*high|xhigh|ultracode|ultrathink|thinking|high|medium|low|minimal|min|max|ultra|none|fast))+$/i;

/** `Grok 4.5 Extra High Fast` → name `Grok 4.5` plus a compact effort chip. */
export function splitModelDisplayName(name: string): { name: string; effortCompact?: string; effortFull?: string } {
	const trimmed = name.trim();
	const match = MODEL_OPTION_SUFFIX.exec(trimmed);
	if (!match || match.index <= 0) {
		return { name: trimmed };
	}
	const base = trimmed.slice(0, match.index).trim();
	if (!base) {
		return { name: trimmed };
	}
	const effort = match[0].trim().replace(/\s+fast$/i, '').trim();
	if (!effort) {
		return { name: base };
	}
	const effortCompact = compactEffortLabel(effort, effort);
	return {
		name: base,
		...(effortCompact ? { effortCompact, effortFull: reasoningLabel(effort) } : {}),
	};
}

export function descriptorDefault(descriptor: IModelOptionDescriptor): string | boolean | undefined {
	if (descriptor.type === 'boolean') {
		return descriptor.defaultValue ?? false;
	}
	const choices = descriptor.options ?? [];
	return (choices.find(choice => choice.isDefault) ?? choices[0])?.value;
}

/** Current value of a descriptor, falling back to the provider supplied default. */
export function optionValue(descriptor: IModelOptionDescriptor, options: IVoltModelOptions | undefined): string | boolean | undefined {
	const stored = options?.[descriptor.id];
	if (stored === undefined) {
		return descriptorDefault(descriptor);
	}
	return descriptor.type === 'boolean' ? stored === true || stored === 'true' : String(stored);
}

/** Fills in every provider default so a request always carries a complete selection. */
export function resolveModelOptions(descriptors: readonly IModelOptionDescriptor[] | undefined, options: IVoltModelOptions | undefined): IVoltModelOptions {
	const resolved: IVoltModelOptions = {};
	for (const descriptor of descriptors ?? []) {
		const value = optionValue(descriptor, options);
		if (value !== undefined) {
			resolved[descriptor.id] = value;
		}
	}
	return resolved;
}

/** Short trailing label for the composer button, e.g. "High" or "High Fast". */
export function describeModelOptions(descriptors: readonly IModelOptionDescriptor[] | undefined, options: IVoltModelOptions | undefined): string | undefined {
	if (!descriptors?.length) {
		return undefined;
	}
	const parts: string[] = [];
	const reasoning = descriptors.find(descriptor => descriptor.id === MODEL_OPTION_REASONING);
	if (reasoning) {
		const value = optionValue(reasoning, options);
		const choice = reasoning.options?.find(option => option.value === value);
		if (choice) {
			parts.push(choice.label);
		}
	}
	const fast = descriptors.find(descriptor => descriptor.id === MODEL_OPTION_FAST);
	if (fast && optionValue(fast, options) === true) {
		parts.push('Fast');
	}
	return parts.length ? parts.join(' ') : undefined;
}

export function copyDescriptor(descriptor: IModelOptionDescriptor): IModelOptionDescriptor {
	return {
		...descriptor,
		...(descriptor.options ? { options: descriptor.options.map(choice => ({ ...choice })) } : {}),
	};
}

/** Later descriptors fill ids the first list does not already carry. */
export function fillDescriptors(base: readonly IModelOptionDescriptor[], extra: readonly IModelOptionDescriptor[]): IModelOptionDescriptor[] {
	const result = base.map(copyDescriptor);
	const ids = new Set(result.map(descriptor => descriptor.id));
	for (const descriptor of extra) {
		if (ids.has(descriptor.id)) {
			continue;
		}
		ids.add(descriptor.id);
		result.push(copyDescriptor(descriptor));
	}
	return result;
}

/** Same-id selects keep every distinct choice, used when collapsing parameterized twins. */
export function unionDescriptors(base: readonly IModelOptionDescriptor[], extra: readonly IModelOptionDescriptor[]): IModelOptionDescriptor[] {
	const result = base.map(copyDescriptor);
	const byId = new Map(result.map(descriptor => [descriptor.id, descriptor]));
	for (const descriptor of extra) {
		const existing = byId.get(descriptor.id);
		if (!existing) {
			const copy = copyDescriptor(descriptor);
			result.push(copy);
			byId.set(copy.id, copy);
			continue;
		}
		if (existing.type !== 'select' || descriptor.type !== 'select') {
			continue;
		}
		const options = existing.options ?? [];
		for (const choice of descriptor.options ?? []) {
			if (!options.some(option => option.value === choice.value)) {
				options.push({ ...choice });
			}
		}
		existing.options = options;
	}
	return result;
}

export function isSelectableDescriptor(descriptor: IModelOptionDescriptor): boolean {
	if (descriptor.type === 'boolean') {
		return true;
	}
	return (descriptor.options?.length ?? 0) > 1;
}

/** Reasoning, then context / service tier / toggles, then any other advertised selects. */
export function traitDescriptors(descriptors: readonly IModelOptionDescriptor[] | undefined): IModelOptionDescriptor[] {
	const available = (descriptors ?? []).filter(isSelectableDescriptor);
	const ordered: IModelOptionDescriptor[] = [];
	for (const id of MODEL_OPTION_TRAIT_ORDER) {
		const match = available.find(descriptor => descriptor.id === id);
		if (match) {
			ordered.push(match);
		}
	}
	for (const descriptor of available) {
		if (!ordered.includes(descriptor)) {
			ordered.push(descriptor);
		}
	}
	return ordered;
}

export function optionChoiceLabel(descriptor: IModelOptionDescriptor, options: IVoltModelOptions | undefined): string {
	if (descriptor.type === 'boolean') {
		return optionValue(descriptor, options) === true ? 'On' : 'Off';
	}
	const value = optionValue(descriptor, options);
	return descriptor.options?.find(choice => choice.value === value)?.label ?? (value === undefined ? '' : String(value));
}
