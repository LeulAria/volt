/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { KeychainError, keychainSet, keychainSetCommand } from '../../node/claudeLogin.js';

suite('Claude keychain writes keep the secret out of argv (spec I.3, INV-24)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a credential goes to `security -i` on stdin, as hex the way Claude Code writes it', () => {
		const secret = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-canary', refreshToken: 'sk-ant-ort-canary' } });
		const line = keychainSetCommand('Claude Code-credentials', 'me', secret)!;
		assert.ok(line.endsWith('\n'));
		assert.ok(line.includes(`-X ${Buffer.from(secret, 'utf8').toString('hex')}`));
		assert.ok(!line.includes('sk-ant-oat-canary'));
	});

	test('a credential too long for hex goes quoted, still on stdin', () => {
		const secret = JSON.stringify({ claudeAiOauth: { accessToken: 'a'.repeat(2500) }, note: 'it\'s "quoted" \\ here' });
		const line = keychainSetCommand('svc', 'me', secret)!;
		assert.ok(line.includes(' -w "'), line.slice(0, 80));
		assert.ok(Buffer.byteLength(line) <= 4096);
	});

	test('a credential that fits no stdin line is refused, never passed in argv', async () => {
		const secret = 'x'.repeat(5000);
		assert.strictEqual(keychainSetCommand('svc', 'me', secret), undefined);
		// A value with a line break cannot go quoted either (it would end the command early).
		assert.strictEqual(keychainSetCommand('svc', 'me', `${'y'.repeat(2500)}\nadd-generic-password -s evil`), undefined);
		await assert.rejects(keychainSet('svc', 'me', secret), (err: unknown) => err instanceof KeychainError && /too large/.test(err.message));
	});
});
