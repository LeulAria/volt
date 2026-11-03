/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds the phone's diff and file viewer (entry.js) into one script; build-diffs.mjs turns it
// into src/files/diffsBundle.ts. Uses this folder's packages (`npm install` here).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(here, 'stub.js');

export default {
	root: here,
	logLevel: 'warn',
	resolve: {
		// Highlights only: Shiki, its grammars and the theme catalogs stay out of the bundle.
		alias: [
			{ find: /^shiki(\/.*)?$/, replacement: stub },
			{ find: /^@pierre\/theming\/themes$/, replacement: stub },
			{ find: /^@pierre\/highlights\/themes\/loader$/, replacement: stub },
		],
	},
	build: {
		outDir: path.join(here, 'dist'),
		emptyOutDir: true,
		minify: true,
		target: 'safari16',
		lib: { entry: path.join(here, 'entry.js'), name: 'VoltDiffs', formats: ['iife'], fileName: () => 'diffs.js' },
	},
};
