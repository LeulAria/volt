/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { FileAccess } from '../../../../base/common/network.js';
import { join, relative, sep } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isSecretLikeEnvName } from '../../common/childEnv.js';

/**
 * Env lint (spec K.4, INV-24): Volt's code never puts a secret-looking variable into the environment
 * of a process it starts. It finds names assigned into an environment object (`env.X = ...`,
 * `childEnv['X'] = ...`) or written in one (`env: { X: ... }`, `const env = { X: ... }`).
 *
 * Known exceptions, each with why it is still there. A new site fails; an exception that no
 * longer matches fails too, so this list only shrinks.
 */
const KNOWN_EXCEPTIONS: readonly { readonly file: string; readonly name: string; readonly reason: string }[] = [
	{ file: 'vs/platform/voltPullRequests/node/voltPullRequestService.ts', name: 'GH_TOKEN', reason: '`gh` takes the chosen account\'s token only from its environment; moves to a secret ref with the secrets broker (spec I.3)' },
	{ file: 'vs/platform/voltPullRequests/node/voltPullRequestService.ts', name: 'GH_ENTERPRISE_TOKEN', reason: 'as GH_TOKEN, for GitHub Enterprise hosts' },
];

const ASSIGNED = /\b\w*[eE]nv\w*(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\])\s*=(?!=)/g;
const IN_LITERAL = [/\benv\s*:\s*\{([^{}]*)\}/g, /\b\w*[eE]nv\w*\s*(?::[^=;{]+)?=\s*\{([^{}]*)\}/g];
const LITERAL_KEY = /(?:^|[,{\s])['"]?([A-Z][A-Z0-9_]*)['"]?\s*:/g;

/** Secret-looking variable names `text` sets on a child's environment. */
function secretEnvNamesSet(text: string): string[] {
	const names: string[] = [];
	for (const match of text.matchAll(ASSIGNED)) {
		names.push(match[1] ?? match[2]);
	}
	for (const pattern of IN_LITERAL) {
		for (const match of text.matchAll(pattern)) {
			for (const key of match[1].matchAll(LITERAL_KEY)) {
				names.push(key[1]);
			}
		}
	}
	return [...new Set(names.filter(isSecretLikeEnvName))];
}

async function* sourceFiles(dir: string): AsyncGenerator<string> {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'test' && entry.name !== 'node_modules') {
				yield* sourceFiles(path);
			}
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
			yield path;
		}
	}
}

suite('Volt env lint: no secret-looking variable set on a spawn (K.4, INV-24)', function () {

	this.timeout(120_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the lint sees every form it claims to', () => {
		assert.deepStrictEqual(secretEnvNamesSet('env.GITHUB_TOKEN = token;'), ['GITHUB_TOKEN']);
		assert.deepStrictEqual(secretEnvNamesSet('childEnv[\'OPENAI_API_KEY\'] = key;'), ['OPENAI_API_KEY']);
		assert.deepStrictEqual(secretEnvNamesSet('spawn(cmd, args, { env: { ...process.env, NPM_TOKEN: t, PATH: p } })'), ['NPM_TOKEN']);
		assert.deepStrictEqual(secretEnvNamesSet('const env: Record<string, string> = { STRIPE_KEY: k };'), ['STRIPE_KEY']);
		assert.deepStrictEqual(secretEnvNamesSet('env: { GIT_TERMINAL_PROMPT: \'0\', SSH_AUTH_SOCK: s }'), []);
		assert.deepStrictEqual(secretEnvNamesSet('if (env.GH_TOKEN === undefined) { }'), []);
	});

	test('Volt\'s sources set no secret-looking variable outside the known exceptions', async () => {
		const src = join(FileAccess.asFileUri('').fsPath, '..', 'src');
		const found: string[] = [];
		let scanned = 0;
		for await (const file of sourceFiles(join(src, 'vs'))) {
			scanned++;
			const rel = relative(src, file).split(sep).join('/');
			for (const name of secretEnvNamesSet(await fs.readFile(file, 'utf8'))) {
				found.push(`${rel} ${name}`);
			}
		}
		assert.ok(scanned > 1000, `scanned only ${scanned} files under ${src}`);
		const known = KNOWN_EXCEPTIONS.map(entry => `${entry.file} ${entry.name}`);
		assert.deepStrictEqual(found.filter(entry => !known.includes(entry)), [], 'a new spawn sets a secret-looking variable: pass the secret another way (spec F.7.4)');
		assert.deepStrictEqual(known.filter(entry => !found.includes(entry)), [], 'a known exception is gone: remove it from KNOWN_EXCEPTIONS');
	});
});
