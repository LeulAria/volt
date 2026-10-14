/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds Volt Agents (apps/desktop), the standalone Electron client of the agent server, into
// apps/desktop/out/. Its main process bundles the same server launcher Volt's main process uses.
// Usage: node build/volt/buildAgentDesktop.mjs [--watch]

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(path.join(root, 'build', 'package.json'));
const esbuild = require('esbuild');
const appDir = path.join(root, 'apps', 'desktop');
const outdir = path.join(appDir, 'out');
const watch = process.argv.includes('--watch');

/** Sources import each other as .js; esbuild must find the .ts next to them. */
const tsResolvePlugin = {
	name: 'volt-ts-resolve',
	setup(build) {
		build.onResolve({ filter: /^\.\.?\/.*\.js$/ }, args => {
			const ts = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
			return fs.existsSync(ts) ? { path: ts } : undefined;
		});
	},
};

/** The Volt logo as the dock and window icon. */
function copyResources() {
	const resources = path.join(outdir, 'resources');
	fs.mkdirSync(resources, { recursive: true });
	fs.copyFileSync(path.join(root, 'brand', 'volt-icon.png'), path.join(resources, 'icon.png'));
}

const options = {
	absWorkingDir: root,
	entryPoints: {
		main: path.join(appDir, 'src', 'main.ts'),
		preload: path.join(appDir, 'src', 'preload.ts'),
	},
	outdir,
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',
	external: ['electron'],
	sourcemap: true,
	logLevel: 'info',
	tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
	plugins: [tsResolvePlugin],
};

copyResources();
if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	await esbuild.build(options);
}
