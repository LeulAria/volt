/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { acpRpcErrorMessage, noticesFromAcpPayload, noticesFromAcpUpdate } from '../../common/acpNotices.js';

suite('ACP provider notices', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the sentence Claude attaches after Internal error', () => {
		const message = acpRpcErrorMessage({
			message: 'Internal error: You\'ve hit your monthly spend limit · your session limit resets 3:20am (Asia/Dubai)',
			data: { errorKind: 'rate_limit' },
		});
		assert.strictEqual(message, 'You\'ve hit your monthly spend limit · your session limit resets 3:20am (Asia/Dubai)');
	});

	test('a bare internal error with a rate-limit kind still says the limit was reached', () => {
		assert.strictEqual(acpRpcErrorMessage({ message: 'Internal error', data: { errorKind: 'rate_limit' } }), 'Usage limit reached');
		assert.strictEqual(acpRpcErrorMessage({ message: 'Internal error' }), 'Internal error');
	});

	test('reads a session-failure title and a notice update', () => {
		const title = 'You\'ve hit your monthly spend limit · your session limit resets 3:20am (Asia/Dubai)';
		const fromFailure = noticesFromAcpPayload({
			stopReason: 'end_turn',
			_meta: {
				jetbrains: {
					air: {
						version: 1,
						sessionFailure: { severity: 'error', title, details: 'Continuing automatically at 3:20am' },
					},
				},
			},
		});
		assert.deepStrictEqual(fromFailure, [{ severity: 'error', title, description: 'Continuing automatically at 3:20am' }]);

		const fromNotice = noticesFromAcpUpdate({
			sessionUpdate: 'notice',
			severity: 'warning',
			title: 'Retrying Claude, attempt 1 of 10.',
		});
		assert.deepStrictEqual(fromNotice, [{ severity: 'warning', title: 'Retrying Claude, attempt 1 of 10.' }]);
	});

	test('formats a rejected rate limit and ignores an allowed one', () => {
		const resetsAt = Date.UTC(2026, 8, 27, 3, 20) / 1000;
		const rejected = noticesFromAcpUpdate({
			sessionUpdate: 'usage_update',
			used: 10,
			size: 200,
			_meta: { '_claude/rateLimit': { status: 'rejected', resetsAt } },
		}, { timeZone: 'UTC', locale: 'en-US' });
		assert.strictEqual(rejected[0]?.severity, 'error');
		assert.strictEqual(rejected[0]?.title.replace(/\s/g, ' '), 'Usage limit reached · resets 3:20 AM');

		const allowed = noticesFromAcpUpdate({
			sessionUpdate: 'usage_update',
			_meta: { '_claude/rateLimit': { status: 'allowed', resetsAt } },
		});
		assert.deepStrictEqual(allowed, []);
	});

	test('prefers the provider sentence over the shorter structured limit line', () => {
		const title = 'You\'ve hit your monthly spend limit · your session limit resets 3:20am (Asia/Dubai)';
		const notices = noticesFromAcpUpdate({
			sessionUpdate: 'usage_update',
			_meta: {
				'_claude/rateLimit': { status: 'rejected', message: 'Usage limit reached' },
				jetbrains: { air: { version: 1, sessionFailure: { severity: 'error', title } } },
			},
		});
		assert.deepStrictEqual(notices, [{ severity: 'error', title }]);
	});
});
