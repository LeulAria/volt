/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The providers the gateway can forward to. Two wire formats cover them: Anthropic Messages and
 * OpenAI (Chat Completions / Responses). Everything OpenAI-compatible (OpenRouter, Gemini's
 * OpenAI endpoint, Azure OpenAI, Groq, a self-hosted vLLM) is one kind with a base URL.
 */
export type ProviderKind = 'anthropic' | 'openai' | 'openai-compatible';
export type WireFormat = 'anthropic' | 'openai';
export type AuthHeader = 'x-api-key' | 'bearer' | 'api-key';

export interface IProviderPreset {
	readonly id: string;
	readonly kind: ProviderKind;
	readonly label: string;
	/** The API root including its version: the gateway appends `/messages`, `/chat/completions`, `/responses`, `/models`. */
	readonly baseUrl: string;
	readonly authHeader: AuthHeader;
	readonly format: WireFormat;
	readonly docs?: string;
	/** Model ids offered when the provider's /models listing is unavailable. */
	readonly models: readonly string[];
}

export const PROVIDER_PRESETS: readonly IProviderPreset[] = [
	{ id: 'anthropic', kind: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', authHeader: 'x-api-key', format: 'anthropic', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'] },
	{ id: 'openai', kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', authHeader: 'bearer', format: 'openai', models: ['gpt-5', 'gpt-5-mini', 'gpt-5-codex', 'gpt-4.1'] },
	{ id: 'openrouter', kind: 'openai-compatible', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', authHeader: 'bearer', format: 'openai', models: [] },
	{ id: 'gemini', kind: 'openai-compatible', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', authHeader: 'bearer', format: 'openai', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
	{ id: 'azure-openai', kind: 'openai-compatible', label: 'Azure OpenAI', baseUrl: 'https://<resource>.openai.azure.com/openai/v1', authHeader: 'api-key', format: 'openai', models: [] },
	{ id: 'custom', kind: 'openai-compatible', label: 'OpenAI-compatible', baseUrl: 'http://localhost:8000/v1', authHeader: 'bearer', format: 'openai', models: [] },
];

export function presetFor(id: string): IProviderPreset | undefined {
	return PROVIDER_PRESETS.find(p => p.id === id);
}

/**
 * Developers address a model as `<provider>/<model>` (the gateway also accepts a bare model id
 * when exactly one provider offers it). Policies match that same string.
 */
export function qualifiedModel(provider: string, model: string): string {
	return `${provider}/${model}`;
}

export function splitModel(ref: string): { readonly provider?: string; readonly model: string } {
	const slash = ref.indexOf('/');
	if (slash > 0 && PROVIDER_PRESETS.some(p => p.id === ref.slice(0, slash))) {
		return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
	}
	return { model: ref };
}

/** Agent CLIs Volt can drive, which policies can allow or block. */
export const AGENT_CLIS = [
	{ id: 'native', label: 'Volt native agent' },
	{ id: 'claude-code', label: 'Claude Code' },
	{ id: 'codex', label: 'Codex' },
	{ id: 'opencode', label: 'OpenCode' },
	{ id: 'cursor', label: 'Cursor Agent' },
	{ id: 'gemini', label: 'Gemini CLI' },
] as const;

export type AgentCliId = typeof AGENT_CLIS[number]['id'];
