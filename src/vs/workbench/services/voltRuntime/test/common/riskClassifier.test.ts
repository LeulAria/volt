/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { classifyRisk, splitShellSegments } from '../../common/access/riskClassifier.js';

suite('Volt risk classifier', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('safe commands', () => {
		assert.strictEqual(classifyRisk('shell', 'git status'), 'safe');
		assert.strictEqual(classifyRisk('shell', 'git diff'), 'safe');
		assert.strictEqual(classifyRisk('shell', 'ls -la'), 'safe');
		assert.strictEqual(classifyRisk('search', 'TODO'), 'safe');
		assert.strictEqual(classifyRisk('read', 'src/foo.ts'), 'safe');
	});

	test('low risk tests', () => {
		assert.strictEqual(classifyRisk('shell', 'npm test'), 'low');
		assert.strictEqual(classifyRisk('shell', 'pnpm test'), 'low');
		assert.strictEqual(classifyRisk('edit', 'src/foo.ts'), 'low');
	});

	test('low risk run-project commands', () => {
		assert.strictEqual(classifyRisk('shell', 'python3 -m http.server 5500 --bind 127.0.0.1'), 'low');
		assert.strictEqual(classifyRisk('shell', 'npm run dev'), 'low');
		assert.strictEqual(classifyRisk('shell', 'npx vite'), 'low');
		assert.strictEqual(classifyRisk('shell', 'lsof -iTCP -sTCP:LISTEN'), 'safe');
		assert.strictEqual(classifyRisk('shell', 'curl http://127.0.0.1:5500/'), 'low');
		assert.strictEqual(classifyRisk('shell', 'open http://127.0.0.1:5500/'), 'low');
		assert.strictEqual(classifyRisk('browser', 'http://127.0.0.1:5500/'), 'low');
	});

	test('medium risk install and network', () => {
		assert.strictEqual(classifyRisk('shell', 'npm install lodash'), 'medium');
		assert.strictEqual(classifyRisk('shell', 'curl https://example.com'), 'medium');
		assert.strictEqual(classifyRisk('mcp', 'create_issue'), 'medium');
	});

	test('high and critical', () => {
		assert.strictEqual(classifyRisk('shell', 'git push origin main'), 'high');
		assert.strictEqual(classifyRisk('shell', 'git push --force origin main'), 'critical');
		assert.strictEqual(classifyRisk('shell', 'rm -rf /'), 'critical');
		assert.strictEqual(classifyRisk('read', '.env'), 'critical');
	});

	test('chained commands take the max risk', () => {
		assert.strictEqual(classifyRisk('shell', 'git status && git push origin main'), 'high');
		assert.strictEqual(classifyRisk('shell', 'ls | git push --force'), 'critical');
	});

	test('subshell substitution escalates', () => {
		assert.strictEqual(classifyRisk('shell', 'echo $(uname)'), 'high');
		assert.strictEqual(classifyRisk('shell', 'echo $(cat .ssh/id_rsa)'), 'critical');
	});

	test('splits quoted chains without breaking quotes', () => {
		assert.deepStrictEqual(splitShellSegments('echo "a && b" && ls'), ['echo ""', 'ls']);
	});
});
