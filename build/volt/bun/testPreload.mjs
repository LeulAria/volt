/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Preload for `bun test` (see build/volt/bun/test.mjs): runs the repo's mocha TDD tests straight
// from src/*.ts. Sources go through the same Oxc transform as `gulp watch-client` (Bun's own
// TypeScript transform calls legacy method decorators without a property descriptor), and the
// mocha globals (suite/test/setup/teardown, `this.timeout`) map onto bun:test.

import { plugin } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, describe, test as bunTest } from 'bun:test';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(path.join(root, 'build', 'package.json'));
const { transformSync } = require('oxc-transform');
const { inlineOxcRuntimeHelpers } = require(path.join(root, 'build', 'lib', 'tsb', 'transpiler.js'));
const srcRoot = path.join(root, 'src') + path.sep;

plugin({
	name: 'volt-oxc',
	setup(build) {
		build.onLoad({ filter: /\.ts$/ }, async args => {
			if (!args.path.startsWith(srcRoot)) {
				return undefined;
			}
			const source = await Bun.file(args.path).text();
			const result = transformSync(args.path, source, {
				lang: 'ts', sourceType: 'module', sourcemap: true, target: 'es2022',
				decorator: { legacy: true },
				typescript: { onlyRemoveTypeImports: false, removeClassFieldsWithoutInitializer: true, optimizeConstEnums: false },
				assumptions: { setPublicClassFields: true },
			});
			let code = inlineOxcRuntimeHelpers(result.code);
			if (args.path.endsWith('.test.ts')) {
				// bun test binds an undeclared `test` to its own; declare mocha's so `this.timeout()` works.
				code = `const test = globalThis.__voltMochaTest;\n${code}`;
			}
			if (result.map?.mappings) {
				code += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(result.map)).toString('base64')}`;
			}
			return { contents: code, loader: 'js' };
		});
	},
});

// Mocha's `this` in tests and hooks. Timeouts are Bun's (--timeout); the current test is unknown.
function context() {
	return {
		timeout() { return this; },
		slow() { return this; },
		retries() { return this; },
		skip() { throw new Error('this.skip() is not supported under bun test'); },
		currentTest: { state: undefined, title: '' },
	};
}

function wrap(fn) {
	return fn && (() => {
		const ctx = context();
		return fn.length > 0 ? new Promise((resolve, reject) => fn.call(ctx, err => err ? reject(err) : resolve())) : fn.call(ctx);
	});
}

const mochaTest = (name, fn) => fn ? bunTest(name, wrap(fn)) : bunTest.todo(name);
mochaTest.skip = (name, fn) => bunTest.skip(name, fn);
mochaTest.only = (name, fn) => bunTest.only(name, wrap(fn));

const suite = (name, fn) => describe(name, () => fn.call(context()));
suite.skip = (name, fn) => describe.skip(name, fn);
suite.only = (name, fn) => describe.only(name, fn);

Object.assign(globalThis, {
	__voltMochaTest: mochaTest,
	suite,
	setup: fn => beforeEach(wrap(fn)),
	teardown: fn => afterEach(wrap(fn)),
	suiteSetup: fn => beforeAll(wrap(fn)),
	suiteTeardown: fn => afterAll(wrap(fn)),
});
