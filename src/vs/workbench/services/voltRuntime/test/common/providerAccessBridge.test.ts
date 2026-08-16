/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAccessDecision } from '../../common/access/accessTypes.js';
import { acpPermissionResponse, advertisedModeId, normalizeAcpPermission, pickAdvertised, selectAcpPermissionOption } from '../../common/access/providerAccessBridge.js';

suite('Volt provider access bridges', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const allowOnce: IAccessDecision = { requestId: '1', effect: 'allow', scope: 'once' };
	const allowAlways: IAccessDecision = { requestId: '1', effect: 'allow', scope: 'always' };
	const deny: IAccessDecision = { requestId: '1', effect: 'deny', scope: 'once' };

	const params = {
		options: [
			{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
			{ optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
			{ optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
		],
		toolCall: { kind: 'execute', title: 'Run', rawInput: { command: 'npm test' } },
	};

	test('selects option by kind instead of a hardcoded id', () => {
		assert.strictEqual(selectAcpPermissionOption(params, allowOnce), 'allow-once');
		assert.strictEqual(selectAcpPermissionOption(params, allowAlways), 'allow-always');
		assert.strictEqual(selectAcpPermissionOption(params, deny), 'reject-once');
	});

	test('falls back to name matching', () => {
		const named = { options: [{ optionId: 'yes', name: 'Approve' }, { optionId: 'no', name: 'Deny' }] };
		assert.strictEqual(selectAcpPermissionOption(named, allowOnce), 'yes');
		assert.strictEqual(selectAcpPermissionOption(named, deny), 'no');
	});

	test('normalize maps ACP execute to a shell request', () => {
		const request = normalizeAcpPermission('session/request_permission', params, {
			sessionId: 's',
			runId: 'r',
			providerId: 'codex',
		});
		assert.ok(request);
		assert.strictEqual(request.action, 'shell');
		assert.strictEqual(request.resource.value, 'npm test');
		assert.strictEqual(request.providerId, 'codex');
	});

	test('toNativeResponse never hardcodes allow-once when options exist', () => {
		const response = acpPermissionResponse(allowOnce, params) as { outcome: { optionId: string } };
		assert.strictEqual(response.outcome.optionId, 'allow-once');
	});

	test('pickAdvertised drops unknown ids', () => {
		assert.deepStrictEqual(
			pickAdvertised({ configOptions: [{ id: 'sandbox' }] }, [{ id: 'sandbox', value: 'read-only' }, { id: 'missing', value: 'x' }]),
			[{ id: 'sandbox', value: 'read-only' }],
		);
	});

	test('advertisedModeId matches aliases', () => {
		assert.strictEqual(advertisedModeId({ modes: [{ id: 'agent', name: 'Agent' }] }, ['implement', 'agent']), 'agent');
		assert.strictEqual(advertisedModeId({ modes: [] }, ['plan']), undefined);
	});

});
