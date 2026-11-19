/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isVoltOAuthCallback } from '../../common/voltHttpOAuth.js';

suite('Volt HTTP OAuth sign-in window', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the callback is caught whatever the provider adds after it', () => {
		assert.ok(isVoltOAuthCallback('https://localhost/callback?code=abc&state=xyz', 'https://localhost/callback'));
		assert.ok(isVoltOAuthCallback('https://localhost/callback#access_token=t', 'https://localhost/callback'));
		assert.ok(isVoltOAuthCallback('https://LOCALHOST/callback/?code=abc', 'https://localhost/callback'));
		assert.ok(isVoltOAuthCallback('http://127.0.0.1:9985/cb?code=1', ' http://127.0.0.1:9985/cb?app=volt '));
		assert.ok(isVoltOAuthCallback('myapp://oauth/done?code=1', 'myapp://oauth/done'));
	});

	test('other addresses on the way are not the callback', () => {
		assert.ok(!isVoltOAuthCallback('https://localhost/callback-other?code=abc', 'https://localhost/callback'));
		assert.ok(!isVoltOAuthCallback('https://localhost/login?next=https://localhost/callback', 'https://localhost/callback'));
		assert.ok(!isVoltOAuthCallback('http://localhost/callback?code=abc', 'https://localhost/callback'));
		assert.ok(!isVoltOAuthCallback('https://localhost:8443/callback?code=abc', 'https://localhost/callback'));
		assert.ok(!isVoltOAuthCallback('https://example.com/authorize', ''));
	});
});
