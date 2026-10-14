/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { consoleApi } from './api/console.js';
import { credentialsApi } from './api/credentials.js';
import { governanceApi } from './api/governance.js';
import { identityApi } from './api/identity.js';
import { insightsApi } from './api/insights.js';
import { playgroundApi } from './api/playground.js';
import { auth } from './auth.js';
import { db } from './db.js';
import { env } from './env.js';
import { gateway } from './gateway/index.js';
import { startRetention } from './lib/retention.js';
import { voltApi, wellKnown } from './volt/index.js';

const app = new Hono();

// In production the console is served from here: a strict CSP (no inline or third-party scripts; styles
// may be inline because React sets style attributes and the theme injects its variables).
app.use('*', secureHeaders({
	crossOriginResourcePolicy: 'same-origin',
	referrerPolicy: 'strict-origin-when-cross-origin',
	contentSecurityPolicy: env.production ? {
		defaultSrc: ["'self'"],
		scriptSrc: ["'self'"],
		styleSrc: ["'self'", "'unsafe-inline'"],
		imgSrc: ["'self'", 'data:', 'blob:'],
		fontSrc: ["'self'", 'data:'],
		connectSrc: ["'self'"],
		objectSrc: ["'none'"],
		baseUri: ["'self'"],
		formAction: ["'self'"],
		frameAncestors: ["'none'"],
	} : undefined,
}));

app.on(['GET', 'POST'], '/api/auth/*', c => auth.handler(c.req.raw));

// The console's cookie-authenticated API refuses cross-site writes: a wrong Origin is refused, and
// every write must be JSON, which a cross-site page cannot send without a CORS preflight (none is
// allowed). The session cookie is also SameSite=Lax.
const console_ = new Hono();
console_.use('*', csrf({ origin: [env.baseUrl, ...env.trustedOrigins] }));
console_.use('*', async (c, next) => {
	if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
		return c.json({ error: 'Console writes must be JSON' }, 415);
	}
	await next();
});
console_.route('/', consoleApi);
console_.route('/credentials', credentialsApi);
console_.route('/', governanceApi);
console_.route('/', insightsApi);
console_.route('/identity', identityApi);
console_.route('/playground', playgroundApi);
app.route('/api/govern', console_);

app.route('/api/volt', voltApi);
app.route('/.well-known/volt-govern', wellKnown);
app.route('/gateway', gateway);
app.get('/healthz', c => c.json({ ok: true }));

// The built console (vite build → dist/web), with the SPA's routes falling back to index.html.
// dist/server/server/app.js → dist/web; src/server/app.ts (dev) → dist/web after a build.
const webDir = ['../../web/', '../../dist/web/'].map(p => fileURLToPath(new URL(p, import.meta.url))).find(p => existsSync(`${p}/index.html`));
if (webDir) {
	const index = readFileSync(`${webDir}/index.html`, 'utf8');
	app.use('/assets/*', serveStatic({ root: webDir, onFound: (_path, c) => c.header('cache-control', 'public, max-age=31536000, immutable') }));
	app.use('/fonts/*', serveStatic({ root: webDir }));
	app.get('/favicon.svg', serveStatic({ root: webDir }));
	app.get('*', c => c.html(index));
}

startRetention();
const server = serve({ fetch: app.fetch, port: env.port }, info => {
	console.info(`[volt-govern] listening on ${env.baseUrl} (port ${info.port})`);
});

// Orchestrators stop with SIGTERM: finish in-flight requests (gateway streams included), close the
// database, then exit; give up after 10 seconds.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.once(signal, () => {
		console.info(`[volt-govern] ${signal}: shutting down`);
		setTimeout(() => process.exit(0), 10_000).unref();
		server.close(() => void db.destroy().finally(() => process.exit(0)));
	});
}
