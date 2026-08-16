/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAccessDecision } from '../../common/access/accessTypes.js';
import { accessBridgeFor } from '../../browser/agents/bridges/accessBridges.js';
import { compilePolicy } from '../../common/access/policyCompiler.js';
import { presetRules } from '../../common/access/accessPresets.js';

suite('Volt provider access bridges (browser)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const allowOnce: IAccessDecision = { requestId: '1', effect: 'allow', scope: 'once' };
	const params = {
		options: [
			{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
			{ optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
			{ optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
		],
		toolCall: { kind: 'execute', title: 'Run', rawInput: { command: 'npm test' } },
	};

	test('translate only emits advertised config ids', () => {
		const policy = compilePolicy({ preset: presetRules('full-access') });
		const config = accessBridgeFor('codex').translate(policy, {
			configOptions: [{ id: 'approval_policy' }, { id: 'sandbox' }],
		});
		assert.deepStrictEqual((config.configOptions ?? []).map(item => item.id).sort(), ['approval_policy', 'sandbox']);
	});

	test('provider with no native config gets an empty translation', () => {
		const policy = compilePolicy({ preset: presetRules('supervised') });
		const config = accessBridgeFor('acp-generic').translate(policy, {});
		assert.deepStrictEqual(config, {});
	});

	test('unknown providers still normalize through the default bridge', () => {
		const request = accessBridgeFor('future-agent').normalize('session/request_permission', params, {
			sessionId: 's',
			runId: 'r',
			providerId: 'future-agent',
		});
		assert.ok(request);
		assert.strictEqual(request.action, 'shell');
	});
});
