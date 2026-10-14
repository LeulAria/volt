/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { rgPath } from '@vscode/ripgrep';
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createJsMatcher, matchText, translateUnicodeClasses } from '../../common/textMatch.js';

/** Text where ASCII and Unicode `\w \d \s \b` disagree. */
const LINES = [
	'caf\u00e9 na\u00efve r\u00e9sum\u00e9',
	'foo_bar foo-bar foo',
	'x = \u0663\u0664 (Arabic-Indic digits)',
	'a\u00a0x non-breaking space',
	'user.name@example.com',
	'\u65e5\u672c\u8a9e text',
	'tab\tx here',
	'\u00dcn\u00efc\u00f6d\u00e9 W\u00f6rter',
	'foo1 1foo afoo',
	'emoji \ud83d\ude00 foo',
	'plain ascii line 42',
	'\u0301combining mark start',
	'snake_case_name and CamelCase',
];

const PATTERNS = [
	'\\w+\u00e9', 'caf\\w', '\\d+', '\\s+x', '\\bfoo\\b', '[\\w.]+@\\w+', '\\Boo', '\\W+', '[^\\s]+\\s',
	'\\D\\d', '\\S+\\s+\\S+', '\\bna\u00efve\\b', 'x\\s*=\\s*\\d', '\\b\\w{5}\\b', '[\\d\\s]+', '\\w+_\\w+', '^\\W',
];

suite('Volt code index: Unicode classes match ripgrep', function () {

	this.timeout(30_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let file: string;
	const text = `${LINES.join('\n')}\n`;

	suiteSetup(async () => {
		dir = join(tmpdir(), `volt-unicode-${generateUuid()}`);
		await fs.mkdir(dir, { recursive: true });
		file = join(dir, 'sample.txt');
		await fs.writeFile(file, text);
	});

	suiteTeardown(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	function rgLines(pattern: string, flags: string[]): number[] {
		const result = spawnSync(rgPath, ['--no-config', '--no-heading', '-n', ...flags, '-e', pattern, file], { encoding: 'utf8' });
		assert.ok(result.status === 0 || result.status === 1, `ripgrep failed on ${pattern}: ${result.stderr}`);
		return result.stdout.split('\n').filter(Boolean).map(line => Number(line.split(':')[0]));
	}

	function jsLines(pattern: string, isRegExp: boolean, caseSensitive: boolean, wholeWord: boolean): number[] | undefined {
		const matcher = createJsMatcher(pattern, isRegExp, caseSensitive, false, wholeWord);
		return matcher && matchText(text, matcher, 0, 10_000, 10_000).lines.map(line => line.line);
	}

	for (const pattern of PATTERNS) {
		for (const caseSensitive of [true, false]) {
			test(`${pattern}${caseSensitive ? '' : ' (ignore case)'}`, () => {
				const js = jsLines(pattern, true, caseSensitive, false);
				assert.ok(js, 'answered in-process');
				assert.deepStrictEqual(js, rgLines(pattern, caseSensitive ? ['--case-sensitive'] : ['--ignore-case']));
			});
		}
	}

	for (const word of ['foo', 'na\u00efve', '\u65e5\u672c\u8a9e', 'CamelCase', 'snake_case_name']) {
		test(`whole word ${word}`, () => {
			const js = jsLines(word, false, true, true);
			assert.ok(js, 'answered in-process');
			assert.deepStrictEqual(js, rgLines(word, ['--case-sensitive', '--fixed-strings', '--word-regexp']));
		});
	}

	test('what has no JavaScript form is left to ripgrep', () => {
		assert.strictEqual(translateUnicodeClasses('[^\\W_]'), undefined, '\\W inside a class');
		assert.strictEqual(translateUnicodeClasses('[\\b]'), undefined, '\\b inside a class is backspace');
		assert.strictEqual(createJsMatcher('\\p{Greek}', true, true, false, false), undefined);
		assert.strictEqual(createJsMatcher('-foo-', false, true, false, true), undefined, '-w around non-word edges');
		assert.strictEqual(createJsMatcher('fo+', true, true, false, true), undefined, '-w on a regex');
	});
});
