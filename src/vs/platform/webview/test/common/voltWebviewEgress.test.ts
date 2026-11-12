/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt P5 (spec I.10, INV-19), WEB-4: the session dispatcher's decision for webview egress. The
// dispatcher itself (`app.ts`, one onBeforeRequest listener for the windows' session) passes each
// request's frame chain, referrer and web contents here; it needs the running app and is not
// exercised by unit tests.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isEgressHostGranted, WebviewEgressRegistry } from '../../common/voltWebviewEgress.js';

const WINDOW = 1;
const CONTENTS = 7;
const BOX = 'boxorigin';
const OPEN = 'openorigin';
const boxFrames = [`vscode-webview://${BOX}/fake.html?id=1`, `vscode-webview://${BOX}/index.html?id=1`, 'vscode-file://vscode-app/out/vs/code/electron-browser/workbench/workbench.html'];

suite('Volt: webview egress dispatcher (WEB-4)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function registry(): WebviewEgressRegistry {
		const r = new WebviewEgressRegistry();
		r.set(WINDOW, 'webview-1', BOX, ['api.example.com']);
		return r;
	}

	test('WEB-4: a sandboxed extension\'s webview reaches only its granted hosts', () => {
		const r = registry();
		assert.deepStrictEqual(r.verdict(CONTENTS, { url: 'https://api.example.com/v1', frames: boxFrames }), { allow: true });
		const refused = r.verdict(CONTENTS, { url: 'https://exfil.example/?d=secret', frames: boxFrames });
		assert.strictEqual(refused.allow, false);
		assert.strictEqual(!refused.allow && refused.origin, BOX);
		assert.strictEqual(r.verdict(CONTENTS, { url: 'wss://exfil.example/socket', frames: boxFrames }).allow, false);
		// A frame the page embeds (even on a granted host) is still inside the webview.
		assert.strictEqual(r.verdict(CONTENTS, { url: 'http://exfil.example/', frames: ['https://api.example.com/embed', ...boxFrames] }).allow, false);
	});

	test('WEB-4: the workbench, unsandboxed webviews and non-network schemes are not judged', () => {
		const r = registry();
		assert.ok(r.verdict(CONTENTS, { url: 'https://update.example/', frames: ['vscode-file://vscode-app/workbench.html'] }).allow);
		assert.ok(r.verdict(CONTENTS, { url: 'https://cdn.example/x.js', frames: [`vscode-webview://${OPEN}/index.html`, 'vscode-file://vscode-app/workbench.html'] }).allow);
		assert.ok(r.verdict(CONTENTS, { url: `vscode-webview://${BOX}/index.html`, frames: boxFrames }).allow);
		assert.ok(r.verdict(CONTENTS, { url: 'data:text/plain,x', frames: boxFrames }).allow);
		// Electron main's own requests (no web contents).
		assert.ok(r.verdict(undefined, { url: 'https://exfil.example/', frames: undefined }).allow);
	});

	test('WEB-4: a request without a frame is denied unless it comes from the workbench', () => {
		const r = registry();
		// A worker of the sandboxed page (its referrer is the page, or a blob of it).
		assert.strictEqual(r.verdict(CONTENTS, { url: 'https://exfil.example/', frames: undefined, referrer: `vscode-webview://${BOX}/fake.html` }).allow, false);
		assert.strictEqual(r.verdict(CONTENTS, { url: 'https://exfil.example/', frames: undefined, referrer: `blob:vscode-webview://${BOX}/5f0c` }).allow, false);
		assert.ok(r.verdict(CONTENTS, { url: 'https://api.example.com/', frames: undefined, referrer: `vscode-webview://${BOX}/fake.html` }).allow);
		// A worker loaded from a resource URL can't be tied to its webview: refused.
		assert.strictEqual(r.verdict(CONTENTS, { url: 'https://exfil.example/', frames: undefined, referrer: 'https://file+.vscode-resource.vscode-cdn.net/ext/worker.js' }).allow, false);
		assert.strictEqual(r.verdict(CONTENTS, { url: 'https://exfil.example/', frames: undefined }).allow, false);
		assert.ok(r.verdict(CONTENTS, { url: 'https://marketplace.example/', frames: undefined, referrer: 'vscode-file://vscode-app/workbench.html' }).allow);
		// No sandboxed webview shown: nothing is judged.
		assert.ok(new WebviewEgressRegistry().verdict(CONTENTS, { url: 'https://exfil.example/', frames: undefined }).allow);
	});

	test('WEB-4: registrations follow the webview: replaced, removed, dropped with their window', () => {
		const r = registry();
		r.set(WINDOW, 'webview-2', BOX, ['api.example.com', 'other.example']);
		// Two instances of one origin disagree mid-update: a host counts only if both grant it.
		assert.strictEqual(r.verdict(CONTENTS, { url: 'https://other.example/', frames: boxFrames }).allow, false);
		r.set(WINDOW, 'webview-1', BOX, ['api.example.com', 'other.example']);
		assert.ok(r.verdict(CONTENTS, { url: 'https://other.example/', frames: boxFrames }).allow);
		r.delete('webview-1');
		r.delete('webview-2');
		assert.strictEqual(r.hasSandboxedWebviews, false);
		r.set(WINDOW, 'webview-3', BOX, []);
		r.set(2, 'webview-4', OPEN, []);
		r.deleteWindow(WINDOW);
		assert.ok(r.verdict(CONTENTS, { url: 'https://exfil.example/', frames: boxFrames }).allow, 'window 1 reloaded: its webview is gone');
		assert.strictEqual(r.verdict(CONTENTS, { url: 'https://exfil.example/', frames: [`vscode-webview://${OPEN}/index.html`] }).allow, false);
	});

	test('granted host patterns: exact, subdomains, ports, any', () => {
		assert.ok(isEgressHostGranted('https://api.example.com/x', ['api.example.com']));
		assert.ok(!isEgressHostGranted('https://api.example.com.evil.example/', ['api.example.com']));
		assert.ok(isEgressHostGranted('https://a.b.example.com/', ['*.example.com']));
		assert.ok(!isEgressHostGranted('https://example.com/', ['*.example.com']));
		assert.ok(!isEgressHostGranted('https://evilexample.com/', ['*.example.com']));
		assert.ok(isEgressHostGranted('http://localhost:3000/', ['localhost:3000']));
		assert.ok(!isEgressHostGranted('http://localhost:3001/', ['localhost:3000']));
		assert.ok(isEgressHostGranted('https://example.com/', ['example.com:443']));
		assert.ok(isEgressHostGranted('https://anything.example/', ['*']));
		assert.ok(!isEgressHostGranted('not a url', ['*']));
	});
});
