/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { capToolText, guardToolText, redactSecrets } from '../../common/ide/toolOutput.js';

suite('Volt IDE tool output guard', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('credentials in env dumps, logs and responses are masked; code and ordinary text are not', () => {
		const text = [
			'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
			'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
			'STRIPE_SECRET_KEY="sk_live_abcdefghijklmnop1234"',
			'DATABASE_URL=postgres://admin:hunter2pass@db.internal:5432/app',
			'Authorization: Bearer abc.def.ghijklmnopqrstuvwxyz',
			'{"apiKey": "AIzaSyD-1234567890abcdefghijklmnopqrstu", "tokenizer": "cl100k_base", "maxTokens": 4096}',
			'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456',
			'const token = getToken();',
			'-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
			'Tests: 12 passed, 0 failed',
		].join('\n');
		const { text: out, count } = redactSecrets(text);
		for (const secret of ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAIOSFODNN7EXAMPLE', 'sk_live_abcdefghijklmnop1234', 'hunter2pass', 'abc.def.ghijklmnopqrstuvwxyz', 'AIzaSyD-1234567890abcdefghijklmnopqrstu', 'sk-proj-abcdefghijklmnopqrstuvwxyz123456', 'MIIEpAIBAAKCAQEA']) {
			assert.ok(!out.includes(secret), secret);
		}
		assert.ok(out.includes('GITHUB_TOKEN=[redacted]'), 'the name stays so the reader knows what was there');
		assert.ok(out.includes('postgres://admin:[redacted]@db.internal'));
		assert.ok(out.includes('"tokenizer": "cl100k_base"'), 'a key that only starts with a secret word is not a secret');
		assert.ok(out.includes('const token = getToken();'));
		assert.ok(out.includes('Tests: 12 passed, 0 failed'));
		assert.ok(count >= 8);
		assert.deepStrictEqual(redactSecrets('nothing to see').count, 0);
	});

	test('an over-long result keeps its head and tail and says how to ask for less', () => {
		const long = `HEAD${'x'.repeat(100_000)}TAIL`;
		const capped = capToolText(long, 1_000);
		assert.ok(capped.startsWith('HEAD'));
		assert.ok(capped.endsWith('TAIL'));
		assert.ok(capped.includes('characters omitted'));
		assert.ok(capped.length < 1_200);
		assert.strictEqual(capToolText('short'), 'short');
		assert.ok(guardToolText('KEY_TOKEN=abcdefgh').endsWith('[Volt masked 1 credential in this output.]'));
	});
});
