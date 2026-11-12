/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs Volt's sandbox test suites on a Windows runner without installing the whole repository:
// each test file is bundled with esbuild (TypeScript sources, `.js` import specifiers) and run
// with mocha's TDD interface, the same `suite`/`test` API the Electron test runner provides.
//
//   VOLT_TEST_TOOLS=<dir with node_modules/esbuild and node_modules/mocha>
//   node scripts/volt-sandbox-windows-test.mjs src/vs/.../a.test.ts [more.test.ts ...]

import { mkdirSync } from 'fs';
import { createRequire } from 'module';
import { basename, join, resolve } from 'path';

const tools = process.env.VOLT_TEST_TOOLS;
if (!tools) {
	throw new Error('Set VOLT_TEST_TOOLS to a folder with esbuild and mocha installed');
}
const require = createRequire(join(resolve(tools), 'package.json'));
const esbuild = require('esbuild');
const Mocha = require('mocha');

const files = process.argv.slice(2);
if (!files.length) {
	throw new Error('usage: volt-sandbox-windows-test.mjs <test.ts>...');
}
const outDir = resolve(process.env.RUNNER_TEMP ?? '.', 'volt-sandbox-tests');
mkdirSync(outDir, { recursive: true });

const mocha = new Mocha({ ui: 'tdd', timeout: 240_000, reporter: 'spec', color: false });
for (const file of files) {
	const outfile = join(outDir, basename(file).replace(/\.ts$/, '.mjs'));
	await esbuild.build({
		entryPoints: [resolve(file)],
		outfile,
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node22',
		sourcemap: 'inline',
		logLevel: 'warning',
		// Bundled CommonJS dependencies may call require(); give the ESM bundle one.
		banner: { js: 'import { createRequire as __voltCreateRequire } from "module"; const require = __voltCreateRequire(import.meta.url);' },
	});
	mocha.addFile(outfile);
}
await mocha.loadFilesAsync();
mocha.run(failures => {
	process.exitCode = failures ? 1 : 0;
});
