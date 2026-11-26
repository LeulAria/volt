/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ISavedEnvironment } from '@volt/client-core/src/environments';
import Constants from 'expo-constants';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, Dimensions, Keyboard, Linking, Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type { DataDetectorTypes, ShouldStartLoadRequest, WebViewErrorEvent, WebViewHttpErrorEvent, WebViewMessageEvent, WebViewOpenWindowEvent } from 'react-native-webview/lib/WebViewTypes';
import { deliverScript, infoScript, isExternalUrl, type NativeMessage, parseWebMessage, roundInsets, sameOrigin } from './bridge';
import { startLiveClient } from '../state/liveClient';
import { checkToken, type IResolvedRoute, isSessionUrl, isSignInAttempt, isSignInPage, type ISignInSource, movedRoute, pathOf, rememberRoute, resolveRoute, signInSource, signOutScript } from './signIn';
import { hideSplash } from './splash';
import { palette, setShellTheme, useShellTheme } from './theme';
import { Button, haptic, styles } from './ui';

/** What the shell shows over the page when the page can't be shown. */
type Overlay =
	/** `auto: false`: trying again by itself would only repeat the problem (Retry still does). */
	| { readonly kind: 'unreachable'; readonly message: string; readonly auto?: false }
	| { readonly kind: 'removed' }
	| { readonly kind: 'outdated' };

interface ISignInOptions {
	/** A retry from the overlay: it stays up (Retry spins) until the page is ready, with no cover flashing in between. */
	readonly keepOverlay?: boolean;
	/** Already found (the computer moved to another address). */
	readonly route?: IResolvedRoute;
}

export interface IWorkbenchHandle {
	/** Signs in again (after a signed-out sheet closed without a choice). */
	signIn(): void;
	/** Drops the page's session cookie (before its computer is forgotten). */
	signOutPage(): void;
}

/**
 * Before the first sign-in. Inline HTML, not about:blank: react-native-webview loads a URL without
 * a host as a file, and WKWebView throws on it (an abort at launch once a session cookie makes the
 * cookie sync before the load asynchronous).
 */
const BLANK = { html: '' } as const;
/** Pages, plus the about:, data: and blob: frames a page makes; the navigation policy decides the rest. */
const ORIGINS = ['http://*', 'https://*', 'about:*', 'data:*', 'blob:*'];
/**
 * An array: Android's view manager (new architecture) casts this prop to one and aborts on a string.
 * One array for good: a new one each render counts as a change, which the WebView warns about.
 */
const NO_DATA_DETECTORS: DataDetectorTypes[] = ['none'];
const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
/** How long a sign-in may take before the page is shown as it is (the splash or the cover lifts). */
const COVER_MS = 8_000;
/** How long the page has to answer a back press. */
const BACK_ANSWER_MS = 300;
/** The waits between tries while the computer can't be reached (the last one repeats). */
const RETRY_MS = [2_000, 4_000, 8_000, 15_000];
/**
 * A sign-in whose page hasn't said it is ready by then failed without an error: the load hung, or
 * the server restarted halfway through it and the workbench never started. (Time in front only.)
 */
const STALL_MS = 30_000;
/** Away longer than this, the phone may be on another network, where the page's address is dead. */
const AWAY_MS = 10_000;
/** Whether the computer moved to another address is checked at most this often, */
const FOLLOW_MIN_MS = 5_000;
/** and this often while the page's own link to it is down. */
const FOLLOW_EVERY_MS = 15_000;

/** Development only: every message the page posted, valid or not. */
const devMessages: { at: number; url: string; data: string }[] = [];

function openExternal(url: string): void {
	if (__DEV__) {
		devMessages.push({ at: Date.now(), url, data: 'openURL' });
	}
	void Linking.openURL(url).catch(() => undefined);
}

/**
 * The computer's own Volt workbench (`/code/` on its agent server) in one long-lived WebView,
 * edge to edge: the page draws the safe areas from the injected insets. The WebView is mounted
 * once and kept; switching computers or signing in again only changes what it loads.
 */
export const WorkbenchScreen = forwardRef<IWorkbenchHandle, {
	readonly environment: ISavedEnvironment;
	/** The page or an overlay asked for the computers sheet. */
	readonly onComputers: () => void;
	/** The user signed out in the workbench. */
	readonly onSignedOut: () => void;
	readonly onPairAgain: () => void;
}>(function WorkbenchScreen({ environment, onComputers, onSignedOut, onPairAgain }, ref) {
	const theme = useShellTheme();
	const safe = roundInsets(useSafeAreaInsets());
	// Same numbers, same object: a re-render is not an insets change.
	const insets = useMemo(() => safe, [safe.top, safe.right, safe.bottom, safe.left]); // eslint-disable-line react-hooks/exhaustive-deps
	const web = useRef<WebView>(null);
	const [source, setSource] = useState<ISignInSource | typeof BLANK>(BLANK);
	const [overlay, setOverlay] = useState<Overlay | undefined>();
	const [readyKey, setReadyKey] = useState<string | undefined>();
	const [coverTimedOut, setCoverTimedOut] = useState(false);
	/** Retry spins: a try from the overlay is under way. */
	const [busy, setBusy] = useState(false);
	// At launch iOS may still say `inactive` (or `unknown`): the app is coming to the front.
	const [appActive, setAppActive] = useState(AppState.currentState !== 'background');
	/** The page says its own link to the computer is down and it is retrying. */
	const [pageDown, setPageDown] = useState(false);
	/** Bumped when an automatic retry found a try under way and must wait for it. */
	const [retryTick, setRetryTick] = useState(0);
	const [keyboard, setKeyboard] = useState(0);
	// Changes only when Android kills the page's renderer: a WebView can't be reused after that.
	const [webKey, setWebKey] = useState(0);

	const key = `${environment.environmentId}:${environment.token}`;
	const ready = readyKey === key;
	/** The address the page was signed in at; messages and navigations must come from it. */
	const base = useRef<string | undefined>(undefined);
	const attempt = useRef(0);
	/** An attempt is finding the computer, or its page is loading: no automatic retry on top of it. */
	const loading = useRef(false);
	/** Automatic retries since the computer last answered (how long the next one waits). */
	const failures = useRef(0);
	/** Ends an attempt whose page never says it is ready ({@link STALL_MS}). */
	const stallTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const reSignIns = useRef<number[]>([]);
	/** Signed out in the workbench: the sign-in page is not reopened until the user chooses. */
	const suspended = useRef(false);
	const backAnswer = useRef<((handled: boolean) => void) | undefined>(undefined);
	const lastKeyboard = useRef(-1);
	const appActiveRef = useRef(appActive);
	const backgroundedAt = useRef(0);
	const followedAt = useRef(0);
	const latest = useRef({ environment, insets, overlay, ready, onComputers, onSignedOut });
	latest.current = { environment, insets, overlay, ready, onComputers, onSignedOut };

	const send = useCallback((msg: NativeMessage) => {
		web.current?.injectJavaScript(deliverScript(msg));
	}, []);

	/** The attempt is over (the page is up, or it failed): Retry stops spinning. */
	const settle = useCallback(() => {
		loading.current = false;
		clearTimeout(stallTimer.current);
		setBusy(false);
	}, []);

	const fail = useCallback((next: Overlay) => {
		settle();
		setOverlay(next);
	}, [settle]);

	const signIn = useCallback(async (options: ISignInOptions = {}) => {
		const env = latest.current.environment;
		const n = ++attempt.current;
		suspended.current = false;
		loading.current = true;
		clearTimeout(stallTimer.current);
		// A new page: whatever the old one said about its link no longer holds.
		setPageDown(false);
		if (options.keepOverlay && latest.current.overlay) {
			setBusy(true);
		} else {
			setBusy(false);
			setOverlay(undefined);
			setCoverTimedOut(false);
		}
		let resolved: IResolvedRoute;
		try {
			resolved = options.route ?? await resolveRoute(env);
		} catch (err) {
			if (n === attempt.current) {
				fail({ kind: 'unreachable', message: err instanceof Error ? err.message : String(err) });
			}
			return;
		}
		if (n !== attempt.current) {
			return;
		}
		if (!resolved.descriptor.capabilities.workbench) {
			fail({ kind: 'outdated' });
			return;
		}
		base.current = resolved.route.baseUrl;
		setSource(signInSource(resolved.route.baseUrl, env.token, resolved.descriptor, n));
		// No error and no `ready` would leave the page as it is with nothing trying again (or Retry
		// spinning for good): after a while this attempt counts as failed, and the backoff takes over.
		stallTimer.current = setTimeout(function stalled() {
			if (n !== attempt.current || !loading.current) {
				return;
			}
			if (!appActiveRef.current) {
				// A page in the background doesn't load (iOS suspends it): wait for time in front.
				stallTimer.current = setTimeout(stalled, STALL_MS);
				return;
			}
			fail({ kind: 'unreachable', message: `Volt on ${env.label} took too long to open. Make sure it is still running.` });
		}, STALL_MS);
		if (!resolved.descriptor.capabilities.shellSignIn) {
			// The sign-in page can't tell the shell its token was refused; ask the same route here.
			void checkToken(resolved.route.baseUrl, env.token).then(status => {
				if (n === attempt.current && (status === 401 || status === 403)) {
					fail({ kind: 'removed' });
				}
			});
		}
	}, [fail]);

	/** The page lost its session (the cookie expired): sign in again, unless it keeps happening. */
	const reSignIn = useCallback(() => {
		const now = Date.now();
		reSignIns.current = reSignIns.current.filter(at => now - at < 60_000);
		if (reSignIns.current.length >= 3) {
			fail({ kind: 'unreachable', message: `Volt on ${latest.current.environment.label} keeps signing this phone out. Try again in a moment.`, auto: false });
			return;
		}
		reSignIns.current.push(now);
		void signIn();
	}, [fail, signIn]);

	/**
	 * The page's address may have stopped answering (the phone changed networks): sign in at the
	 * address the computer answers at now. Nothing changes while the page's own address works, or
	 * while nothing answers (the computer is off or restarting; the page keeps retrying by itself).
	 * Not after the user signed out in the workbench: that waits for their choice in the sheet.
	 */
	const followComputer = useCallback(async () => {
		const from = base.current;
		const now = Date.now();
		if (!from || suspended.current || !latest.current.ready || latest.current.overlay || loading.current || now - followedAt.current < FOLLOW_MIN_MS) {
			return;
		}
		followedAt.current = now;
		const n = attempt.current;
		const moved = await movedRoute(latest.current.environment, from);
		if (moved && n === attempt.current && base.current === from) {
			void signIn({ route: moved });
		}
	}, [signIn]);

	const retry = useCallback(() => {
		failures.current = 0;
		void signIn({ keepOverlay: true });
	}, [signIn]);

	useImperativeHandle(ref, () => ({
		signIn: () => void signIn(),
		signOutPage: () => web.current?.injectJavaScript(signOutScript()),
	}), [signIn]);

	// A new computer (or a new token for it): sign in there.
	useEffect(() => {
		base.current = undefined;
		reSignIns.current = [];
		failures.current = 0;
		void signIn();
	}, [key, signIn]);

	// While the computer can't be reached, try again by itself, less and less often (Retry stays).
	// Not in the background, and not on top of a try that is still finding it or loading the page.
	useEffect(() => {
		if (overlay?.kind !== 'unreachable' || overlay.auto === false || !appActive) {
			return;
		}
		const timer = setTimeout(() => {
			if (loading.current) {
				// Retry (or coming back to the front) started one: wait again rather than stop retrying.
				setRetryTick(tick => tick + 1);
				return;
			}
			failures.current++;
			void signIn({ keepOverlay: true });
		}, RETRY_MS[Math.min(failures.current, RETRY_MS.length - 1)]);
		return () => clearTimeout(timer);
	}, [overlay, appActive, retryTick, signIn]);

	useEffect(() => () => clearTimeout(stallTimer.current), []);

	// While the page's link is down, look again now and then: the phone may reach the computer at
	// another address only later (Tailscale comes up after the Wi-Fi left). Stops once it is back.
	useEffect(() => {
		if (!pageDown || !appActive || !ready || overlay) {
			return;
		}
		void followComputer();
		const timer = setInterval(() => void followComputer(), FOLLOW_EVERY_MS);
		return () => clearInterval(timer);
	}, [pageDown, appActive, ready, overlay, followComputer]);

	// The splash (or the cover, after a switch) waits for the page, but not forever.
	useEffect(() => {
		if (ready) {
			return;
		}
		const timer = setTimeout(() => {
			setCoverTimedOut(true);
			hideSplash();
		}, COVER_MS);
		return () => clearTimeout(timer);
	}, [ready, source]);

	useEffect(() => {
		if (overlay) {
			hideSplash();
		}
	}, [overlay]);

	// Live Activities (iOS) once the workbench is up, so they never slow its start.
	// (`liveClient.ios.ts`; Android's is a no-op, so its bundle carries no client.)
	useEffect(() => {
		return ready ? startLiveClient(latest.current.environment, () => base.current) : undefined;
	}, [ready, key]);

	useEffect(() => {
		send({ type: 'insets', insets });
	}, [insets, send]);

	// The WebView ends above the keyboard (the page sees a shorter viewport, like a native resize).
	useEffect(() => {
		const update = (height: number) => {
			const next = Math.max(0, Math.min(Math.round(height), Math.round(Dimensions.get('window').height)));
			if (next === lastKeyboard.current) {
				return;
			}
			lastKeyboard.current = next;
			setKeyboard(next);
			send({ type: 'keyboard', visible: next > 0, height: next });
		};
		const subscriptions = Platform.OS === 'ios'
			? [
				Keyboard.addListener('keyboardWillChangeFrame', event => {
					const { screenY, width } = event.endCoordinates;
					// iPad's floating keyboard sits over the page anywhere; it moves nothing (a docked one spans the screen).
					const floating = width < Dimensions.get('screen').width * 0.8;
					update(floating ? 0 : Dimensions.get('window').height - screenY);
				}),
				Keyboard.addListener('keyboardWillHide', () => update(0)),
			]
			: [
				// Android reports the keyboard above the navigation bar; the window runs edge to edge behind it.
				Keyboard.addListener('keyboardDidShow', event => update(event.endCoordinates.height + latest.current.insets.bottom)),
				Keyboard.addListener('keyboardDidHide', () => update(0)),
			];
		return () => subscriptions.forEach(subscription => subscription.remove());
	}, [send]);

	useEffect(() => {
		const subscription = AppState.addEventListener('change', state => {
			// iOS passes through `inactive` for Control Center, a call banner or the app switcher while
			// the page keeps running; only the background counts (the page drops its socket on return).
			if (state !== 'active' && state !== 'background') {
				return;
			}
			const active = state === 'active';
			if (active === appActiveRef.current) {
				return;
			}
			appActiveRef.current = active;
			setAppActive(active);
			send({ type: 'appState', active });
			if (!active) {
				backgroundedAt.current = Date.now();
				return;
			}
			const away = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0;
			backgroundedAt.current = 0;
			const current = latest.current.overlay;
			if (current?.kind === 'unreachable' || current?.kind === 'outdated') {
				// Back in front: the network (or an updated Volt) may be back. Try now, then on the backoff.
				retry();
			} else if (!current && away > AWAY_MS) {
				void followComputer();
			}
		});
		return () => subscription.remove();
	}, [send, retry, followComputer]);

	// Android's back: the page goes back first (closes a panel, leaves a chat); otherwise the app goes to the background.
	useEffect(() => {
		if (Platform.OS !== 'android') {
			return;
		}
		const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
			if (!ready || latest.current.overlay) {
				return false;
			}
			let answered = false;
			const answer = (handled: boolean) => {
				if (answered) {
					return;
				}
				answered = true;
				clearTimeout(timer);
				backAnswer.current = undefined;
				if (!handled) {
					BackHandler.exitApp();
				}
			};
			const timer = setTimeout(() => answer(false), BACK_ANSWER_MS);
			backAnswer.current = answer;
			send({ type: 'back' });
			return true;
		});
		return () => subscription.remove();
	}, [ready, send]);

	// Development only: a handle for driving the page from the JS debugger (tests, the README's recipes).
	useEffect(() => {
		if (!__DEV__) {
			return;
		}
		(globalThis as { __voltShellDev?: unknown }).__voltShellDev = {
			inject: (script: string) => web.current?.injectJavaScript(script),
			messages: devMessages,
			state: () => ({ base: base.current, attempt: attempt.current, ready, overlay, busy, pageDown, failures: failures.current, keyboard, insets }),
		};
	}, [ready, overlay, busy, pageDown, keyboard, insets]);

	const onMessage = useCallback((event: WebViewMessageEvent) => {
		if (__DEV__) {
			devMessages.push({ at: Date.now(), url: event.nativeEvent.url, data: event.nativeEvent.data });
			devMessages.splice(0, Math.max(0, devMessages.length - 200));
		}
		const msg = parseWebMessage(event.nativeEvent.data, event.nativeEvent.url, base.current);
		if (!msg) {
			return;
		}
		switch (msg.type) {
			case 'ready': {
				const env = latest.current.environment;
				setReadyKey(`${env.environmentId}:${env.token}`);
				setOverlay(current => current?.kind === 'unreachable' || current?.kind === 'outdated' ? undefined : current);
				settle();
				failures.current = 0;
				if (base.current) {
					rememberRoute(env.environmentId, base.current);
				}
				hideSplash();
				return;
			}
			case 'theme':
				setShellTheme({ background: msg.background, dark: msg.dark });
				return;
			case 'haptic':
				haptic(msg.style);
				return;
			case 'openExternal':
				openExternal(msg.url);
				return;
			case 'computers':
				latest.current.onComputers();
				return;
			case 'back':
				backAnswer.current?.(msg.handled);
				return;
			case 'signedOut':
				suspended.current = true;
				latest.current.onSignedOut();
				return;
			case 'connection':
				// `reconnecting` starts the checks for a moved computer (the effect above); `open` ends them.
				setPageDown(msg.state === 'reconnecting');
				if (msg.state === 'failed' && !suspended.current) {
					reSignIn();
				}
				return;
		}
	}, [settle, reSignIn]);

	const onShouldStartLoadWithRequest = useCallback((request: ShouldStartLoadRequest) => {
		const { url } = request;
		if (request.isTopFrame === false || /^(about|data|blob):/i.test(url)) {
			return true;
		}
		const current = base.current;
		if (current && sameOrigin(url, current)) {
			// The page lost its session and was sent to the sign-in page: the shell signs it in instead.
			if (isSignInPage(url) && !isSignInAttempt(url, attempt.current)) {
				if (!suspended.current) {
					reSignIn();
				}
				return false;
			}
			return true;
		}
		if (isExternalUrl(url)) {
			openExternal(url);
		}
		return false;
	}, [reSignIn]);

	const onOpenWindow = useCallback((event: WebViewOpenWindowEvent) => {
		const url = event.nativeEvent.targetUrl;
		if (base.current && sameOrigin(url, base.current)) {
			web.current?.injectJavaScript(`window.location.assign(${JSON.stringify(url)});true;`);
		} else if (isExternalUrl(url)) {
			openExternal(url);
		}
	}, []);

	const onError = useCallback((event: WebViewErrorEvent) => {
		// Not the library's own error page: the shell's overlay.
		event.preventDefault();
		const { url } = event.nativeEvent;
		if (!base.current || (url && !sameOrigin(url, base.current))) {
			return;
		}
		const label = latest.current.environment.label;
		fail({ kind: 'unreachable', message: `Can't reach ${label}. Make sure Volt is open on it and this phone is on the same network.` });
	}, [fail]);

	const onHttpError = useCallback((event: WebViewHttpErrorEvent) => {
		const { url, statusCode } = event.nativeEvent;
		if (!base.current || !sameOrigin(url, base.current)) {
			return;
		}
		if ((statusCode === 401 || statusCode === 403) && isSessionUrl(url)) {
			fail({ kind: 'removed' });
		} else if (statusCode === 404 && pathOf(url).startsWith('/code')) {
			fail({ kind: 'outdated' });
		} else {
			fail({ kind: 'unreachable', message: `Volt on ${latest.current.environment.label} answered ${statusCode}. Try again in a moment.` });
		}
	}, [fail]);

	const onContentProcessDidTerminate = useCallback(() => web.current?.reload(), []);
	const onRenderProcessGone = useCallback(() => setWebKey(n => n + 1), []);

	const injected = useMemo(() => infoScript({
		version: 1,
		platform: Platform.OS === 'ios' ? 'ios' : 'android',
		appVersion: APP_VERSION,
		insets,
		computer: { id: environment.environmentId, label: environment.label },
	}), [insets, environment.environmentId, environment.label]);

	// iOS: transparent until the page has painted (a fresh WKWebView paints white), opaque after.
	const webBackground = Platform.OS === 'ios' && !ready ? 'transparent' : theme.background;
	const p = palette(theme.dark);

	return (
		<View style={{ flex: 1, backgroundColor: theme.background, paddingBottom: keyboard }}>
			<StatusBar barStyle={theme.dark ? 'light-content' : 'dark-content'} />
			<WebView
				key={webKey}
				ref={web}
				source={source}
				style={{ flex: 1, backgroundColor: webBackground }}
				containerStyle={{ backgroundColor: theme.background }}
				applicationNameForUserAgent="VoltShell/1"
				originWhitelist={ORIGINS}
				injectedJavaScriptBeforeContentLoaded={injected}
				injectedJavaScriptBeforeContentLoadedForMainFrameOnly
				onMessage={onMessage}
				onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
				onOpenWindow={onOpenWindow}
				onError={onError}
				onHttpError={onHttpError}
				onContentProcessDidTerminate={onContentProcessDidTerminate}
				onRenderProcessGone={onRenderProcessGone}
				javaScriptEnabled
				javaScriptCanOpenWindowsAutomatically
				domStorageEnabled
				sharedCookiesEnabled
				thirdPartyCookiesEnabled={false}
				cacheEnabled
				allowFileAccess={false}
				allowsInlineMediaPlayback
				mediaPlaybackRequiresUserAction={false}
				mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
				allowsFullscreenVideo
				allowsBackForwardNavigationGestures={false}
				allowsLinkPreview={false}
				bounces={false}
				scrollEnabled={false}
				overScrollMode="never"
				showsHorizontalScrollIndicator={false}
				showsVerticalScrollIndicator={false}
				contentInsetAdjustmentBehavior="never"
				automaticallyAdjustContentInsets={false}
				automaticallyAdjustsScrollIndicatorInsets={false}
				hideKeyboardAccessoryView
				dataDetectorTypes={NO_DATA_DETECTORS}
				textZoom={100}
				setBuiltInZoomControls={false}
				setSupportMultipleWindows={false}
				pullToRefreshEnabled={false}
				androidLayerType="hardware"
				webviewDebuggingEnabled={__DEV__}
			/>
			{!ready && !coverTimedOut && !overlay ? (
				<View style={[StyleSheet.absoluteFill, cover.center, { backgroundColor: theme.background }]} pointerEvents="none">
					<ActivityIndicator color={p.fgSecondary} />
				</View>
			) : null}
			{overlay ? (
				<OverlayView
					overlay={overlay}
					label={environment.label}
					dark={theme.dark}
					background={theme.background}
					busy={busy}
					onRetry={retry}
					onComputers={onComputers}
					onPairAgain={onPairAgain}
				/>
			) : null}
		</View>
	);
});

function OverlayView({ overlay, label, dark, background, busy, onRetry, onComputers, onPairAgain }: {
	readonly overlay: Overlay;
	readonly label: string;
	readonly dark: boolean;
	readonly background: string;
	readonly busy: boolean;
	readonly onRetry: () => void;
	readonly onComputers: () => void;
	readonly onPairAgain: () => void;
}) {
	const p = palette(dark);
	const insets = useSafeAreaInsets();
	const [title, body] = overlay.kind === 'removed'
		? [`This phone was removed from ${label}`, `Pair it again from Volt Settings › Devices on ${label}.`]
		: overlay.kind === 'outdated'
			? [`Update Volt on ${label} to use it from your phone`, 'This version of Volt doesn\'t serve its workbench to phones yet.']
			: [`Can't reach ${label}`, overlay.message];
	return (
		<View style={[StyleSheet.absoluteFill, cover.overlay, { backgroundColor: background, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
			<View style={cover.content}>
				<Text accessibilityRole="header" style={[styles.title, { color: p.fg }]}>{title}</Text>
				<Text style={[styles.body, { color: p.fgSecondary }]}>{body}</Text>
				<View style={{ gap: 10, marginTop: 12 }}>
					{overlay.kind === 'removed'
						? <Button label="Pair Again" onPress={onPairAgain} colors={p} />
						: <Button label="Retry" onPress={onRetry} busy={busy} colors={p} />}
					<Button label="Computers" variant="secondary" onPress={onComputers} colors={p} />
				</View>
			</View>
		</View>
	);
}

const cover = StyleSheet.create({
	center: { alignItems: 'center', justifyContent: 'center' },
	overlay: { justifyContent: 'center', paddingHorizontal: 24 },
	content: { gap: 12, maxWidth: 480, width: '100%', alignSelf: 'center' },
});
