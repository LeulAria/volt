/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

/**
 * The agent server serves the built app from `out-volt-web` at the repository root. In
 * development, `VOLT_SERVER=http://127.0.0.1:<port> npm run dev` proxies the server's routes, so
 * the app runs same-origin exactly as it does when the server serves it.
 */
const server = process.env.VOLT_SERVER;

function proxy(ws = false): ProxyOptions {
	return {
		target: server,
		changeOrigin: true,
		ws,
		configure: p => {
			// The server only trusts its own origin (and signs loopback pages in): look like it.
			p.on('proxyReq', req => req.setHeader('origin', server!));
			p.on('proxyReqWs', req => req.setHeader('origin', server!));
		},
	};
}

export default defineConfig({
	plugins: [react()],
	base: '/',
	resolve: {
		alias: {
			'@volt/client-core': fileURLToPath(new URL('../client-core/src/index.ts', import.meta.url)),
		},
	},
	server: {
		port: 5178,
		fs: { allow: ['..'] },
		proxy: server ? {
			'/ws': proxy(true),
			'/api': proxy(),
			'/.well-known': proxy(),
		} : undefined,
	},
	worker: { format: 'es' },
	build: {
		outDir: fileURLToPath(new URL('../../out-volt-web', import.meta.url)),
		emptyOutDir: true,
		target: 'es2022',
		sourcemap: false,
		// The editor (Monaco) is its own lazily loaded chunk of a few MB; the chat app stays small.
		chunkSizeWarningLimit: 4000,
	},
});
