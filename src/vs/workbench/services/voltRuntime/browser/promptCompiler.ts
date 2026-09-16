/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { modePolicy, VoltMode } from '../common/modes.js';
import { IModelMessage } from '../common/providers.js';

export function compilePrompt(mode: VoltMode, history: IModelMessage[], userText: string, harnessHint?: string): IModelMessage[] {
	const policy = modePolicy(mode);
	const system = [
		'You are Volt, an AI coding assistant inside the Volt IDE.',
		`Mode: ${mode}.`,
		policy.allowWrites ? 'You may edit files.' : 'Read-only. Do not modify files.',
		policy.allowTerminal ? 'You may run terminal commands.' : 'Do not run terminal commands.',
		'Pass a short human title with each shell command. Be concise. Stream immediately.',
	].join(' ');
	return [
		{ role: 'system', content: system },
		...history.filter(m => m.role !== 'system'),
		{ role: 'user', content: harnessHint ? `${harnessHint}\n\n${userText}` : userText },
	];
}
