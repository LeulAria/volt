/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import type * as http from 'http';
import { VOLT_LOCAL_SESSION_PATH, VOLT_PAIR_PATH } from '../../../platform/voltAgentServer/common/protocol.js';
import { WORKBENCH_BASE_PATH, WORKBENCH_SESSION_PATH } from './serverWorkbench.js';

/** The pages a browser lands on before the workbench: the server's root and pairing links (`/pair#code=…`). */
const SIGN_IN_PATHS = new Set(['/', '/pair', '/index.html']);

export interface ISignInPageOptions {
	/** The computer's name, shown on the page. */
	readonly label: string;
	/** Whether this build carries the browser workbench. */
	readonly workbench: boolean;
	/** The browser already holds a paired device's session cookie. */
	readonly signedIn: (req: http.IncomingMessage) => boolean;
}

/**
 * Answers the browser's way into Volt: `/` and pairing links. A signed-in browser goes straight
 * to the workbench; otherwise a small page signs it in (an "Open in browser" token link, a pairing
 * code from the link or typed, or, on the computer itself, a local session) through the pairing
 * endpoints, sets the workbench's session cookie and goes on. Any other page path (an old web app
 * link) lands here too. Resolves false for paths it does not own.
 */
export function handleSignIn(req: http.IncomingMessage, res: http.ServerResponse, options: ISignInPageOptions): boolean {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return false;
	}
	const url = new URL(req.url ?? '/', 'http://localhost');
	const page = SIGN_IN_PATHS.has(url.pathname);
	// Old links into the web app (`/t/<chat>`, `/settings/…`): the workbench is the app now.
	const stray = !page && !/\.[a-z0-9]+$/i.test(url.pathname) && /text\/html/.test(req.headers.accept ?? '');
	if (!page && !stray) {
		return false;
	}
	const next = safeNext(url.searchParams.get('next'));
	if (options.workbench && options.signedIn(req)) {
		res.writeHead(302, { Location: next, 'Cache-Control': 'no-store' }).end();
		return true;
	}
	if (stray) {
		res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }).end();
		return true;
	}
	const nonce = randomBytes(16).toString('base64');
	res.writeHead(200, {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
		'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
		'Referrer-Policy': 'no-referrer',
	});
	res.end(req.method === 'HEAD' ? undefined : page_(options, next, nonce));
	return true;
}

/** Where to go once signed in: a workbench path the page was sent from, or the workbench. */
function safeNext(next: string | null): string {
	return next && new RegExp(`^${WORKBENCH_BASE_PATH}(/|$|\\?)`).test(next) && !next.includes('//') ? next : `${WORKBENCH_BASE_PATH}/`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!);
}

function page_(options: ISignInPageOptions, next: string, nonce: string): string {
	const label = escapeHtml(options.label);
	const boot = JSON.stringify({ next, workbench: options.workbench, pair: VOLT_PAIR_PATH, local: VOLT_LOCAL_SESSION_PATH, session: WORKBENCH_SESSION_PATH }).replace(/</g, '\\u003c');
	return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#141414">
<title>Volt</title>
<style nonce="${nonce}">
:root { color-scheme: dark; --bg: #141414; --raised: #1c1c1c; --fg: #f0f0f0; --fg2: rgba(240,240,240,.62); --fg3: rgba(240,240,240,.38); --stroke: rgba(255,255,255,.1); --danger: #fc6b83; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 14px/22px -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
main { width: min(360px, calc(100vw - 48px)); display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; }
.mark { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; background: var(--fg); color: var(--bg); margin-bottom: 14px; }
h1 { font-size: 17px; line-height: 24px; font-weight: 600; margin: 0; }
p { margin: 0; color: var(--fg2); font-weight: 300; }
form { width: 100%; display: flex; flex-direction: column; gap: 10px; margin-top: 18px; }
input { width: 100%; height: 44px; border-radius: 12px; border: 1px solid var(--stroke); background: var(--raised); color: var(--fg); font: 500 18px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: .18em; text-align: center; text-transform: uppercase; outline: none; }
input:focus { border-color: color-mix(in srgb, var(--fg) 28%, transparent); }
button { height: 40px; border-radius: 999px; border: 0; background: var(--fg); color: var(--bg); font: 500 14px/1 inherit; font-family: inherit; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
.error { color: var(--danger); min-height: 22px; font-weight: 400; }
.hint { color: var(--fg3); font-size: 12px; line-height: 18px; margin-top: 8px; }
.busy { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--fg3); border-top-color: var(--fg); animation: spin .8s linear infinite; margin-top: 18px; }
@keyframes spin { to { transform: rotate(360deg); } }
[hidden] { display: none !important; }
</style>
</head><body>
<main>
	<div class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor"/></svg></div>
	<h1>Volt on ${label}</h1>
	<p id="lead">Signing in…</p>
	<div class="busy" id="busy"></div>
	<form id="form" hidden autocomplete="off">
		<input id="code" name="code" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="Pairing code" aria-label="Pairing code" required>
		<button id="submit" type="submit">Pair this browser</button>
		<div class="error" id="error" role="alert"></div>
	</form>
	<p class="hint" id="hint" hidden>On ${label}, run <b>Volt: Pair a Phone or Browser…</b> and type the code it shows, or open its link here.</p>
</main>
<script nonce="${nonce}">
(() => {
	const BOOT = ${boot};
	const $ = id => document.getElementById(id);
	const label = (() => {
		const ua = navigator.userAgent;
		const browser = /Edg\\//.test(ua) ? 'Edge' : /Chrome\\//.test(ua) ? 'Chrome' : /Firefox\\//.test(ua) ? 'Firefox' : /Safari\\//.test(ua) ? 'Safari' : 'Browser';
		const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
		return os ? browser + ' on ' + os : browser;
	})();
	const post = async (path, body, token) => {
		const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: JSON.stringify(body ?? {}) });
		const json = await response.json().catch(() => ({}));
		if (!response.ok) {
			throw new Error(json.message || 'Volt said no (' + response.status + ').');
		}
		return json;
	};
	const open = async token => {
		if (!BOOT.workbench) {
			throw new Error("This Volt build doesn't include the browser workbench.");
		}
		await post(BOOT.session, {}, token);
		location.replace(BOOT.next);
	};
	const ask = (message) => {
		$('busy').hidden = true;
		$('form').hidden = false;
		$('hint').hidden = false;
		$('lead').textContent = 'Pair this browser to open your chats, files and terminals.';
		$('error').textContent = message || '';
		$('code').focus();
	};
	const pair = async code => {
		const paired = await post(BOOT.pair, { code: code.trim().toUpperCase(), client: { label, kind: 'web' } });
		await open(paired.token);
	};

	// A link's code or token rides after '#', which never reaches the server: read it here, then drop it.
	const fragment = new URLSearchParams(location.hash.slice(1));
	const query = new URLSearchParams(location.search);
	const code = fragment.get('code') || query.get('code');
	const token = fragment.get('token');
	// Volt on this computer opens the page with a one-time sign-in nonce (valid a minute, once).
	const local = fragment.get('local');
	if (location.hash) {
		history.replaceState(null, '', location.pathname + location.search);
	}
	$('form').addEventListener('submit', event => {
		event.preventDefault();
		$('submit').disabled = true;
		$('error').textContent = '';
		pair($('code').value).catch(err => ask(err.message)).finally(() => { $('submit').disabled = false; });
	});
	(async () => {
		if (token) {
			return open(token);
		}
		if (code) {
			return pair(code);
		}
		if (local) {
			const session = await post(BOOT.local, { nonce: local });
			return open(session.token);
		}
		ask();
	})().catch(err => ask(err.message));
})();
</script>
</body></html>`;
}
