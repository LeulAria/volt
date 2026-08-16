/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per model options (reasoning effort, context window, fast mode, thinking) are described by the
 * provider rather than inferred by the UI. A CLI agent reports them over ACP, an HTTP provider
 * declares them statically, and the composer renders whatever it is given.
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
export const MODEL_OPTION_FAST = 'fastMode';
export const MODEL_OPTION_THINKING = 'thinking';

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
	return selectOption(MODEL_OPTION_REASONING, 'Effort', choices);
}

const REASONING_LABELS: Record<string, string> = {
	none: 'None',
	minimal: 'Minimal',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra High',
	'extra-high': 'Extra High',
	max: 'Max',
	ultra: 'Ultra',
};

export function reasoningLabel(value: string): string {
	return REASONING_LABELS[value.trim().toLowerCase()] ?? value.charAt(0).toUpperCase() + value.slice(1);
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
