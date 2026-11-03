/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds the phone's Monaco (entry.js) into one script and one stylesheet; build-monaco.mjs
// turns them into src/files/monacoBundle.ts. Uses this folder's packages (`npm install` here).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
	root: here,
	logLevel: 'warn',
	resolve: { alias: { 'monaco-editor': path.join(here, 'node_modules/monaco-editor/esm/vs') } },
	worker: { format: 'iife' },
	build: {
		outDir: path.join(here, 'dist'),
		emptyOutDir: true,
		minify: true,
		// The codicon font goes into the stylesheet: the page has no files to fetch.
		assetsInlineLimit: 10_000_000,
		cssCodeSplit: false,
		lib: { entry: path.join(here, 'entry.js'), name: 'VoltMonaco', formats: ['iife'], fileName: () => 'monaco.js', cssFileName: 'monaco' },
	},
};
