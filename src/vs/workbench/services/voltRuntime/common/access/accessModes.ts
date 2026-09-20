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
export const VOLT_ACCESS_PROJECT_RULES_STORAGE_KEY = 'volt.runtime.accessProjectRules';
export const VOLT_ACCESS_SAVED_RULES_STORAGE_KEY = 'volt.runtime.accessSavedRules';

export function normalizeVoltAccessMode(value: string | undefined): VoltAccessMode {
	return (VOLT_ACCESS_MODES as readonly string[]).includes(value ?? '') ? value as VoltAccessMode : DEFAULT_ACCESS_MODE;
}

export interface IAccessModeOption {
	readonly id: VoltAccessMode;
	readonly label: string;
	readonly description: string;
}

export const ACCESS_MODE_OPTIONS: readonly IAccessModeOption[] = [
	{
		id: 'supervised',
		label: 'Supervised',
		description: 'Ask before risky commands and file changes.',
	},
	{
		id: 'auto-accept-edits',
		label: 'Auto-accept edits',
		description: 'Auto-approve edits, ask before other actions.',
	},
	{
		id: 'auto',
		label: 'Auto',
		description: 'An AI reviewer approves routine actions; risky ones still ask.',
	},
	{
		id: 'full-access',
		label: 'Full access',
		description: 'Allow commands and edits without prompts.',
	},
];

export function accessModeOption(mode: VoltAccessMode): IAccessModeOption {
	return ACCESS_MODE_OPTIONS.find(option => option.id === mode) ?? ACCESS_MODE_OPTIONS[0];
}
