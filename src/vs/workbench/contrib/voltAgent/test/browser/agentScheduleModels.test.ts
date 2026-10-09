/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { scheduleModelChoices } from '../../../../services/voltRuntime/common/schedules/agentSchedules.js';

suite('Volt scheduled task models', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('local and agent-provider models can run a task; disabled and other kinds cannot', () => {
		const choices = scheduleModelChoices([
			{ ref: 'agent:ollama:gemma4', kind: 'model', enabled: true, label: 'gemma4:26b' },
			{ ref: 'cursor-acp:grok-4.7', kind: 'agent', enabled: true, label: 'Grok 4.7' },
			{ ref: 'agent:cursor:off', kind: 'agent', enabled: false, label: 'Off' },
			{ ref: 'tool:x', kind: 'tool', enabled: true, label: 'Tool' },
		]);
		assert.deepStrictEqual(choices, [
			{ ref: 'agent:ollama:gemma4', label: 'gemma4:26b' },
			{ ref: 'cursor-acp:grok-4.7', label: 'Grok 4.7' },
		]);
	});

	test('an empty catalog offers nothing, so the dialog cannot save a task without a model', () => {
		assert.deepStrictEqual(scheduleModelChoices([]), []);
	});
});
