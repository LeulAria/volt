/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type VoltProviderKind = 'model' | 'agent';
export type VoltAuthKind = 'apikey' | 'oauth' | 'cli' | 'none';
export type VoltTransportKind = 'http' | 'stdio' | 'sdk';
export type VoltApiStyle = 'openai-compat' | 'anthropic' | 'gemini' | 'ollama';

export interface IProviderProfile {
	id: string;
	label: string;
	kind: VoltProviderKind;
	providerId: string;
	modelId?: string;
	enabled: boolean;
	transport: VoltTransportKind;
	apiStyle?: VoltApiStyle;
	endpoint?: { baseURL: string };
	command?: string;
	args?: string[];
	cwd?: string;
	authKind: VoltAuthKind;
	hasSecret: boolean;
}

export interface IProviderProfileDraft {
	id?: string;
	label: string;
	kind: VoltProviderKind;
	providerId: string;
	modelId?: string;
	enabled?: boolean;
	transport: VoltTransportKind;
	apiStyle?: VoltApiStyle;
	endpoint?: { baseURL: string };
	command?: string;
	args?: string[];
	cwd?: string;
	authKind: VoltAuthKind;
}

export const VOLT_PROFILES_STORAGE_KEY = 'volt.runtime.profiles';
export const VOLT_ENABLED_MODELS_STORAGE_KEY = 'volt.runtime.enabledModels';
export const VOLT_TASK_MODELS_STORAGE_KEY = 'volt.runtime.taskModels';
export const VOLT_MODE_PROFILES_STORAGE_KEY = 'volt.runtime.modeProfiles';
export const VOLT_HEALTH_INTERVAL_STORAGE_KEY = 'volt.runtime.healthInterval';
export const VOLT_SEED_VERSION_STORAGE_KEY = 'volt.runtime.seedVersion';
export const VOLT_CATALOG_STORAGE_KEY = 'volt.runtime.catalog';
export const VOLT_ACTIVE_CATALOG_REF_STORAGE_KEY = 'volt.runtime.activeCatalogRef';

/** Seconds between background provider health checks. 0 disables the timer. */
export const VOLT_DEFAULT_HEALTH_INTERVAL = 300;

export function secretKeyForProfile(profileId: string): string {
	return `volt.runtime.secret.${profileId}`;
}

export function displayProviderLabel(label: string, providerId?: string): string {
	if (providerId === 'cursor-acp' || /^cursor(\s+acp)?$/i.test(label.trim())) {
		return 'Cursor';
	}
	const cleaned = label
		.replace(/\s*via\s+CLI\s*/ig, ' ')
		.replace(/\s*\bACP\b\s*/ig, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned || label;
}
