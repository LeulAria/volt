/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { accessBridgeFor } from '../../browser/agents/bridges/accessBridges.js';
import { compilePolicy } from '../../common/access/policyCompiler.js';
import { presetRules } from '../../common/access/accessPresets.js';

suite('Volt provider access bridges (browser)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

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

	test('Claude: Full access switches the adapter\'s `mode` to bypassPermissions (it starts in auto, which holds MCP calls to the message\'s end)', () => {
		// claude-agent-acp 0.106: the permission mode is the `mode` config option and the session's modes.
		const caps = {
			configOptions: [{ id: 'model' }, { id: 'mode' }, { id: 'effort' }],
			modes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].map(id => ({ id })),
		};
		const claude = accessBridgeFor('claude-code');
		assert.deepStrictEqual(claude.translate(compilePolicy({ preset: presetRules('full-access') }), caps), { configOptions: [{ id: 'mode', value: 'bypassPermissions' }] });
		assert.deepStrictEqual(claude.translate(compilePolicy({ preset: presetRules('supervised') }), caps).configOptions?.map(item => item.id), ['mode']);
		// Bypass not offered (the adapter started without it): nothing is sent.
		assert.deepStrictEqual(claude.translate(compilePolicy({ preset: presetRules('full-access') }), { ...caps, modes: caps.modes.filter(mode => mode.id !== 'bypassPermissions') }), { configOptions: [] });
		// Modes but no config option: session/set_mode.
		assert.deepStrictEqual(claude.translate(compilePolicy({ preset: presetRules('full-access') }), { modes: caps.modes }), { configOptions: [], sessionModeId: 'bypassPermissions' });
		// An adapter that names it permissionMode keeps getting that.
		assert.deepStrictEqual(claude.translate(compilePolicy({ preset: presetRules('full-access') }), { configOptions: [{ id: 'permissionMode' }] }), { configOptions: [{ id: 'permissionMode', value: 'bypassPermissions' }] });
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
