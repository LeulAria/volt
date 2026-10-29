/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Kept free of DOM imports: the Volt agent server reads provider families too.

/**
 * Providers that share a rail entry in the picker. Codex is OpenAI's CLI, so an API key
 * connection to OpenAI belongs on the same tab rather than beside a duplicate icon, and every
 * on-device runtime collapses into one "Local" tab.
 */
const PROVIDER_FAMILIES: Record<string, string> = {
	codex: 'codex',
	openai: 'codex',
	claude: 'claude',
	'claude-code': 'claude',
	anthropic: 'claude',
	cursor: 'cursor',
	'cursor-acp': 'cursor',
	grok: 'grok',
	xai: 'grok',
	opencode: 'opencode',
	pi: 'pi',
	antigravity: 'antigravity',
	agy: 'antigravity',
	gemini: 'antigravity',
	'gemini-cli': 'antigravity',
	'gemini-acp': 'antigravity',
	kimi: 'kimi',
	muse: 'muse',
	fx: 'fx',
	ollama: 'local',
	lmstudio: 'local',
	'openai-compat': 'local',
	openrouter: 'openrouter',
};

/** Rail identity for a provider: several provider ids can collapse onto one family. */
export function providerFamily(providerId: string): string {
	return PROVIDER_FAMILIES[providerId] ?? providerId;
}
