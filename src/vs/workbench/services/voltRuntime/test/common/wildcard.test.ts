/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { alwaysAllowPattern, compilePattern, matchWildcard } from '../../common/access/wildcard.js';

suite('Volt wildcard', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('literal match', () => {
		assert.strictEqual(matchWildcard('git status', 'git status'), true);
		assert.strictEqual(matchWildcard('git push', 'git status'), false);
	});

	test('trailing prefix star uses startsWith', () => {
		const match = compilePattern('git push*');
		assert.strictEqual(match('git push origin main'), true);
		assert.strictEqual(match('git push --force origin main'), true);
		assert.strictEqual(match('git status'), false);
	});

	test('star matches anything', () => {
		assert.strictEqual(matchWildcard('anything', '*'), true);
	});

	test('path ** matches nested files', () => {
		assert.strictEqual(matchWildcard('src/components/AgentPanel.tsx', 'src/**'), true);
		assert.strictEqual(matchWildcard('src/components/AgentPanel.tsx', 'lib/**'), false);
		assert.strictEqual(matchWildcard('foo/.env', '**/.env'), true);
	});

	test('normalizes backslashes', () => {
		assert.strictEqual(matchWildcard('src\\foo.ts', 'src/foo.ts'), true);
	});

	test('always-allow pattern for shell uses command prefix', () => {
		assert.strictEqual(alwaysAllowPattern('shell', 'git status --short'), 'git status *');
		assert.strictEqual(alwaysAllowPattern('shell', 'ls -la'), 'ls *');
	});

	test('always-allow pattern for edits uses directory', () => {
		assert.strictEqual(alwaysAllowPattern('edit', 'src/components/AgentPanel.tsx'), 'src/components/**');
	});
});
