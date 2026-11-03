/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_ACP_CAPABILITIES } from '../capabilities.js';
import { reasoningOption } from './modelOptions.js';
import { IModelInfo } from '../providers.js';

/**
 * Vercel's fx (https://fx.sh). Its models come from `fx models --json` and its sign-in and
 * default model from `fx status --json`, never from a throwaway ACP session: fx saves every
 * session under `~/.fx/sessions` and ACP cannot delete one.
 */

/** The parts of `fx status --json` Volt reads. `auth` names the login method, `missing` when signed out. */
export interface IFxStatus {
	readonly auth?: string;
	readonly model?: string;
}

/** fx's effort values; its ACP `effort` select lists them for models that reason. */
const FX_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const FX_DEFAULT_EFFORT = 'medium';

function parseJsonObject(output: string): Record<string, unknown> | undefined {
	const start = output.indexOf('{');
	const end = output.lastIndexOf('}');
	if (start < 0 || end <= start) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(output.slice(start, end + 1));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseFxStatus(output: string): IFxStatus | undefined {
	const json = parseJsonObject(output);
	if (!json) {
		return undefined;
	}
	const auth = text(json.auth);
	const model = text(json.model);
	return { ...(auth ? { auth } : {}), ...(model ? { model } : {}) };
}

/** Signed in unless fx says `missing`; undefined when the status could not be read. */
export function fxSignedIn(status: IFxStatus | undefined): boolean | undefined {
	if (!status?.auth) {
		return undefined;
	}
	return status.auth !== 'missing';
}

/** `fx models --json`: `{ kind: "models", ids: ["anthropic/claude-opus-5.5", …] }`, ids deduplicated. */
export function parseFxModelIds(output: string): string[] {
	const ids = parseJsonObject(output)?.ids;
	if (!Array.isArray(ids)) {
		return [];
	}
	return [...new Set(ids.flatMap(id => text(id) ?? []))];
}

/** `anthropic/claude-opus-5.5` -> `Claude Opus 5.5`, `openai/gpt-5.4-nano` -> `GPT 5.4 Nano`. */
export function fxModelLabel(id: string): string {
	const slug = id.slice(id.lastIndexOf('/') + 1);
	return slug.split('-').filter(Boolean).map(part => {
		if (/^gpt/i.test(part)) {
			return part.replace(/^gpt/i, 'GPT');
		}
		return /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1);
	}).join(' ') || id;
}

function vendorLabel(id: string): string | undefined {
	const slash = id.indexOf('/');
	return slash > 0 ? fxModelLabel(id.slice(0, slash)) : undefined;
}

/**
 * Picker rows: the model `fx status` reports first (what fx runs when Volt sends no model), then
 * the rest in fx's order. Two vendors can serve a model under the same name, so a label that
 * would repeat carries its vendor.
 */
export function fxModelsToInfo(ids: readonly string[], defaultModel?: string): IModelInfo[] {
	const ordered = defaultModel && ids.includes(defaultModel) ? [defaultModel, ...ids.filter(id => id !== defaultModel)] : [...ids];
	const counts = new Map<string, number>();
	for (const id of ordered) {
		const label = fxModelLabel(id);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return ordered.map(id => {
		const label = fxModelLabel(id);
		const vendor = (counts.get(label) ?? 0) > 1 ? vendorLabel(id) : undefined;
		return {
			id,
			label: vendor ? `${label} (${vendor})` : label,
			capabilities: { ...DEFAULT_ACP_CAPABILITIES },
			optionDescriptors: [reasoningOption(FX_EFFORTS, FX_DEFAULT_EFFORT)],
		};
	});
}
