/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The console talks to the Govern server same-origin; in dev, Vite proxies its routes. */
const server = process.env.VOLT_GOVERN_SERVER ?? 'http://localhost:4318';

export default defineConfig({
	plugins: [react()],
	root: 'src/web',
	publicDir: fileURLToPath(new URL('./public', import.meta.url)),
	resolve: {
		alias: {
			'@volt/client-core': fileURLToPath(new URL('../client-core/src/index.ts', import.meta.url)),
		},
	},
	server: {
		port: 5179,
		fs: { allow: ['../..', '../../../client-core'] },
		proxy: {
			'/api': { target: server, changeOrigin: false },
			'/gateway': { target: server, changeOrigin: false },
			'/.well-known/volt-govern': { target: server, changeOrigin: false },
		},
	},
	build: {
		outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
		emptyOutDir: true,
		target: 'es2022',
	},
});
