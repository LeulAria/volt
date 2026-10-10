/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type VoltAccessMode = 'supervised' | 'auto-accept-edits' | 'auto' | 'full-access';

export const VOLT_ACCESS_MODES: readonly VoltAccessMode[] = [
	'supervised',
	'auto-accept-edits',
	'auto',
	'full-access',
];

export const DEFAULT_ACCESS_MODE: VoltAccessMode = 'supervised';

export const VOLT_ACCESS_MODE_STORAGE_KEY = 'volt.runtime.accessMode';
/** Per-chat overrides of the default access mode, keyed by session id. */
export const VOLT_ACCESS_CHATS_STORAGE_KEY = 'volt.runtime.accessChats';
export const VOLT_ACCESS_PROJECT_RULES_STORAGE_KEY = 'volt.runtime.accessProjectRules';
export const VOLT_ACCESS_SAVED_RULES_STORAGE_KEY = 'volt.runtime.accessSavedRules';

export function isVoltAccessMode(value: unknown): value is VoltAccessMode {
	return typeof value === 'string' && (VOLT_ACCESS_MODES as readonly string[]).includes(value);
}

export function normalizeVoltAccessMode(value: string | undefined): VoltAccessMode {
	return isVoltAccessMode(value) ? value : DEFAULT_ACCESS_MODE;
}

export interface IAccessModeOption {
	readonly id: VoltAccessMode;
	readonly label: string;
	readonly description: string;
}

export const ACCESS_MODE_OPTIONS: readonly IAccessModeOption[] = [
	{
		id: 'full-access',
		label: 'Full access',
		description: 'Allows commands and edits without prompts.',
	},
	{
		id: 'auto',
		label: 'Auto',
		description: 'Supported providers approve routine actions; others still ask.',
	},
	{
		id: 'auto-accept-edits',
		label: 'Auto-accept edits',
		description: 'Auto-approve edits, ask before other actions.',
	},
	{
		id: 'supervised',
		label: 'Supervised',
		description: 'Ask before commands and file changes.',
	},
];

export function accessModeOption(mode: VoltAccessMode): IAccessModeOption {
	return ACCESS_MODE_OPTIONS.find(option => option.id === mode) ?? ACCESS_MODE_OPTIONS[ACCESS_MODE_OPTIONS.length - 1];
}
