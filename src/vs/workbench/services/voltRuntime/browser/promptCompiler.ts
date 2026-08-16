/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { modePolicy, VoltMode } from '../common/modes.js';
import { IModelMessage } from '../common/providers.js';

export function compilePrompt(mode: VoltMode, history: IModelMessage[], userText: string): IModelMessage[] {
	const policy = modePolicy(mode);
	const system = [
		'You are Volt, an AI coding assistant inside the Volt IDE.',
		`Current mode: ${mode}.`,
		policy.allowWrites ? 'You may propose file edits.' : 'Do not write or modify files. Read-only.',
		policy.allowTerminal ? 'You may suggest terminal commands.' : 'Do not run or suggest destructive terminal commands.',
		'When running a shell command, include a short human title of what it does (for example: "List files sorted by size with human-readable sizes"), not the raw command. Pass it as "title" in the tool input when possible.',
		'Be concise. Stream useful answers immediately.',
	].join(' ');
	return [
		{ role: 'system', content: system },
		...history.filter(m => m.role !== 'system'),
		{ role: 'user', content: userText },
	];
}
