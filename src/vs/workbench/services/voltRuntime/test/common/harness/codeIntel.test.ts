/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { impactOf, languageOf, rankFiles } from '../../../common/harness/codeIntel.js';

suite('Volt code intelligence', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ranks a named file above an unrelated one', () => {
		const hits = rankFiles('fix the login token check', [
			{ path: 'README.md' },
			{ path: 'src/login.ts', exported: ['checkToken'] },
			{ path: 'src/theme.css' },
		]);
		assert.ok(hits[0].path.endsWith('login.ts'));
		assert.ok(hits[0].score > 0);
	});

	test('impact walks reverse imports and finds the matching test', () => {
		const report = impactOf(['src/login.ts'], [
			{ path: 'src/login.ts', exported: ['checkToken'] },
			{ path: 'src/app.ts', imports: ['./login'] },
			{ path: 'src/login.test.ts' },
			{ path: 'src/unrelated.ts' },
		]);
		assert.ok(report.affected.includes('src/app.ts'));
		assert.ok(report.tests.includes('src/login.test.ts'));
		assert.ok(!report.affected.includes('src/unrelated.ts'));
	});

	test('languageOf maps common extensions', () => {
		assert.strictEqual(languageOf('a.tsx'), 'typescript');
		assert.strictEqual(languageOf('a.py'), 'python');
	});
});
