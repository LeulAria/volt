/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createRouteSocket, errorMessage, probeEnvironment, RemoteError, wsUrl } from '@volt/client-core';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { trustInWebViews } from '../../modules/volt-pinned-tls';
import { useTheme } from '../../src/theme/theme';
import { T } from '../../src/ui/core';

/**
 * Development builds only: checks the pinned transport against a running Volt server, for the
 * scripted simulator run in apps/mobile/scripts/pinnedTlsCheck.mjs. Open
 * `volt://dev/pinned-tls?url=https://<ip>:<tls port>&pin=<pin>&plain=http://<ip>:<port>`.
 * Each check prints `[volt-pin-check] <name> PASS|FAIL <detail>` to the console and shows it.
 *
 * - api: the environment descriptor over pinned HTTPS (client-core's probe);
 * - socket: a pinned WebSocket that opens, sends a hello and gets the server's answer;
 * - api-wrong-pin / socket-wrong-pin / webview-wrong-pin: the same with another pin are refused;
 * - webview: a page and its stylesheet from the server load in a WebView with the pin;
 * - plain-http: a plain HTTP network address is refused before anything is sent.
 */
export default function PinnedTlsCheck() {
	const params = useLocalSearchParams<{ url?: string; pin?: string; plain?: string }>();
	if (!__DEV__ || !params.url || !params.pin) {
		return <Redirect href="/" />;
	}
	return <Checks url={params.url} pin={params.pin} plain={params.plain} />;
}

type Result = { readonly name: string; readonly pass: boolean; readonly detail: string };

/** A pin for no certificate at all: 32 zero bytes. */
const WRONG_PIN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function socketCheck(url: string, pin: string, expectOpen: boolean): Promise<Result> {
	const name = expectOpen ? 'socket' : 'socket-wrong-pin';
	return new Promise(resolve => {
		let opened = false;
		let answer = '';
		const timer = setTimeout(() => resolve({ name, pass: false, detail: 'no answer in 10 s' }), 10_000);
		const finish = (result: Result) => {
			clearTimeout(timer);
			resolve(result);
		};
		try {
			const socket = createRouteSocket(wsUrl(url), pin, () => {
				throw new Error('an unpinned socket was asked for');
			});
			socket.onopen = () => {
				opened = true;
				// An unknown token: the server reads the hello over the pinned connection and says so.
				socket.send(JSON.stringify({ t: 'hello', protocol: 1, token: 'pinned-tls-check', client: { kind: 'mobile', id: 'pinned-tls-check' } }));
			};
			socket.onmessage = ev => {
				answer = String(ev.data).slice(0, 80);
			};
			socket.onclose = ev => {
				if (expectOpen) {
					finish({ name, pass: opened && ev.code !== 1015 && ev.code !== 1006, detail: `opened, server closed with ${ev.code} ${ev.reason || answer}` });
				} else {
					finish({ name, pass: !opened && ev.code === 1015, detail: `refused, close ${ev.code} ${ev.reason}` });
				}
			};
		} catch (err) {
			finish({ name, pass: false, detail: errorMessage(err) });
		}
	});
}

async function apiCheck(url: string, pin: string, expectOk: boolean): Promise<Result> {
	const name = expectOk ? 'api' : 'api-wrong-pin';
	try {
		const descriptor = await probeEnvironment(url, 6_000, pin);
		return { name, pass: expectOk, detail: `environment ${descriptor.environmentId}` };
	} catch (err) {
		const code = err instanceof RemoteError ? err.code : 'error';
		return { name, pass: !expectOk && code === 'PinMismatch', detail: `${code}: ${errorMessage(err)}` };
	}
}

async function plainCheck(plain: string): Promise<Result> {
	try {
		await probeEnvironment(plain, 6_000);
		return { name: 'plain-http', pass: false, detail: 'a plain HTTP network address answered' };
	} catch (err) {
		const code = err instanceof RemoteError ? err.code : 'error';
		return { name: 'plain-http', pass: code === 'InsecureAddress', detail: `${code}: ${errorMessage(err)}` };
	}
}

/** The page posts whether its stylesheet (a second request to the server) loaded. */
const PAGE_PROBE = `(function () {
	function report() {
		var rules = 0;
		try { rules = document.styleSheets[0] ? document.styleSheets[0].cssRules.length : -1; } catch (e) { rules = -2; }
		window.ReactNativeWebView.postMessage(JSON.stringify({ title: document.title, rules: rules, body: document.body ? document.body.innerText.slice(0, 60) : '' }));
	}
	if (document.readyState === 'complete') { report(); } else { window.addEventListener('load', report); }
})(); true;`;

/**
 * `wrong`: the server's page with another pin must fail. `page`: the server's page itself (a
 * top-level load). `subresource`: a page drawn from HTML with the server as its base (as the
 * chat's visuals are) loads the server's stylesheet.
 */
function WebViewCheck({ url, pin, mode, onResult }: { readonly url: string; readonly pin: string; readonly mode: 'wrong' | 'page' | 'subresource'; readonly onResult: (result: Result) => void }) {
	const name = mode === 'wrong' ? 'webview-wrong-pin' : mode === 'page' ? 'webview-page' : 'webview-subresource';
	const expectLoad = mode !== 'wrong';
	const [ready, setReady] = useState(false);
	const [done, setDone] = useState(false);
	useEffect(() => {
		trustInWebViews(url, pin);
		// The registry is set on the main thread before the WebView is made there.
		const timer = setTimeout(() => setReady(true), 50);
		return () => clearTimeout(timer);
	}, [url, pin]);
	useEffect(() => {
		if (!ready || done) {
			return;
		}
		const timer = setTimeout(() => {
			setDone(true);
			onResult({ name, pass: false, detail: 'no load or error in 15 s' });
		}, 15_000);
		return () => clearTimeout(timer);
	}, [ready, done, name, onResult]);
	if (!ready || done) {
		return null;
	}
	const report = (result: Result) => {
		if (!done) {
			setDone(true);
			onResult(result);
		}
	};
	const html = `<!doctype html><html><head><title>pinned page</title><link rel="stylesheet" href="${url}/vendor/katex/katex.min.css"></head><body>pinned page</body></html>`;
	return (
		<WebView
			style={{ height: 1, opacity: 0 }}
			originWhitelist={['*']}
			source={mode === 'subresource' ? { html, baseUrl: `${url}/` } : { uri: `${url}/.well-known/volt/environment` }}
			injectedJavaScript={PAGE_PROBE}
			onMessage={event => {
				let page: { title?: string; rules?: number; body?: string } = {};
				try {
					page = JSON.parse(event.nativeEvent.data);
				} catch {
					// not the probe
				}
				if (mode === 'subresource') {
					report({ name, pass: (page.rules ?? 0) > 0, detail: `page "${page.title}", server stylesheet rules ${page.rules}` });
				} else if (mode === 'page') {
					report({ name, pass: !!page.body?.includes('environmentId'), detail: `loaded: ${page.body}` });
				} else {
					report({ name, pass: false, detail: `loaded with the wrong pin: ${page.body}` });
				}
			}}
			onError={event => report({ name, pass: !expectLoad, detail: `load failed: ${event.nativeEvent.description} (${event.nativeEvent.code})` })}
			onHttpError={event => report({ name, pass: false, detail: `HTTP ${event.nativeEvent.statusCode}` })}
		/>
	);
}

function Checks({ url, pin, plain }: { readonly url: string; readonly pin: string; readonly plain?: string }) {
	const { p } = useTheme();
	const [results, setResults] = useState<Result[]>([]);
	const [stage, setStage] = useState<'transport' | 'wrong' | 'page' | 'subresource' | 'done'>('transport');

	const add = (result: Result) => {
		console.log(`[volt-pin-check] ${result.name} ${result.pass ? 'PASS' : 'FAIL'} ${result.detail}`);
		setResults(current => [...current, result]);
	};

	useEffect(() => {
		void (async () => {
			add(await apiCheck(url, pin, true));
			add(await apiCheck(url, WRONG_PIN, false));
			add(await socketCheck(url, pin, true));
			add(await socketCheck(url, WRONG_PIN, false));
			if (plain) {
				add(await plainCheck(plain));
			}
			setStage('wrong');
		})();
		// One run per opened link.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [url, pin, plain]);

	useEffect(() => {
		if (stage === 'done') {
			console.log(`[volt-pin-check] done ${results.filter(r => r.pass).length}/${results.length} passed`);
		}
	}, [stage, results]);

	return (
		<ScrollView contentContainerStyle={{ padding: 20, paddingTop: 80, gap: 10 }} style={{ backgroundColor: p.canvas }}>
			<T variant="title2" weight="700">Pinned TLS check</T>
			<T variant="small" mono color={p.fgTertiary}>{url}</T>
			{results.map(result => (
				<View key={result.name} testID={`pin-check-${result.name}`} accessible accessibilityLabel={`${result.name} ${result.pass ? 'PASS' : 'FAIL'}`}>
					<T variant="body" weight="700" color={result.pass ? p.success : p.danger}>{result.pass ? 'PASS' : 'FAIL'} {result.name}</T>
					<T variant="small" color={p.fgTertiary}>{result.detail}</T>
				</View>
			))}
			{stage === 'done' ? <T variant="body" weight="700" testID="pin-check-done">{`Done: ${results.filter(r => r.pass).length}/${results.length} passed`}</T> : null}
			{/* WebViews last, one at a time: the wrong pin first, so no trust from a good load is reused. */}
			{stage === 'wrong' || stage === 'page' || stage === 'subresource' ? <WebViewCheck key={stage} url={url} pin={stage === 'wrong' ? WRONG_PIN : pin} mode={stage} onResult={result => {
				add(result);
				setStage(stage === 'wrong' ? 'page' : stage === 'page' ? 'subresource' : 'done');
			}} /> : null}
		</ScrollView>
	);
}
