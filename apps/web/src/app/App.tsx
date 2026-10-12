/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, type ISavedEnvironment, VoltClient } from '@volt/client-core';
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { ChatView, openPathInEditor } from '../chat/ChatView';
import { LightboxHost } from '../chat/Lightbox';
import { ChangesView } from '../ide/ChangesView';
import { Explorer } from '../ide/Explorer';
import { Workbench } from '../ide/WorkbenchView';
import { NewChat } from '../home/NewChat';
import { Sidebar } from '../home/Sidebar';
import { PairPage } from '../pair/PairPage';
import { Settings } from '../settings/Settings';
import { Toasts } from '../ui/overlays';
import { Button, EmptyState, Icon, IconButton, Spinner } from '../ui/primitives';
import { ClientProvider, useClient, useStatus } from './client';
import { navigate, type Route, useRoute } from './router';
import { bootstrap, type BootResult, clientId, forgetEnvironment, serverOrigin, webStorage } from './session';
import { useAppliedTheme } from './theme';

export function App() {
	useAppliedTheme();
	const [boot, setBoot] = useState<BootResult | undefined>();
	useEffect(() => {
		void bootstrap().then(setBoot);
	}, []);
	if (!boot) {
		return <Splash />;
	}
	if (boot.kind === 'pair') {
		return <PairPage code={boot.code} error={boot.error} onPaired={environment => setBoot({ kind: 'ready', environment })} />;
	}
	return <Connected key={boot.environment.environmentId + boot.environment.token} environment={boot.environment} onSignedOut={() => setBoot({ kind: 'pair' })} />;
}

function Splash() {
	return (
		<div className="splash">
			<div className="splash-mark"><Icon name="bolt" size={26} /></div>
			<Spinner size={16} />
		</div>
	);
}

function Connected({ environment, onSignedOut }: { readonly environment: ISavedEnvironment; readonly onSignedOut: () => void }) {
	const [client, setClient] = useState<VoltClient | undefined>();
	useEffect(() => {
		const next = new VoltClient({
			environment,
			clientKind: 'web',
			clientId: clientId(),
			storage: webStorage,
			// The page is served by the server it talks to.
			resolveBaseUrl: () => Promise.resolve(serverOrigin()),
		});
		setClient(next);
		void next.start();
		const online = () => next.setNetworkAvailable(true);
		const offline = () => next.setNetworkAvailable(false);
		const visibility = () => document.visibilityState === 'visible' ? next.resume() : next.suspend();
		const pagehide = () => next.suspend();
		window.addEventListener('online', online);
		window.addEventListener('offline', offline);
		document.addEventListener('visibilitychange', visibility);
		window.addEventListener('pagehide', pagehide);
		return () => {
			window.removeEventListener('online', online);
			window.removeEventListener('offline', offline);
			document.removeEventListener('visibilitychange', visibility);
			window.removeEventListener('pagehide', pagehide);
			next.dispose();
		};
	}, [environment]);
	if (!client) {
		return <Splash />;
	}
	return (
		<ClientProvider client={client}>
			<Shell onSignedOut={onSignedOut} />
			<Toasts />
			<LightboxHost />
		</ClientProvider>
	);
}

const WIDE = '(min-width: 900px)';

/** Wide windows get the IDE workbench; phones and narrow windows one pane at a time. */
function useWide(): boolean {
	return useSyncExternalStore(listener => {
		const query = window.matchMedia(WIDE);
		query.addEventListener('change', listener);
		return () => query.removeEventListener('change', listener);
	}, () => window.matchMedia(WIDE).matches, () => true);
}

const CodeEditorPane = lazy(() => import('../ide/monaco/Editors').then(m => ({ default: m.CodeEditorPane })));
const DiffEditorPane = lazy(() => import('../ide/monaco/Editors').then(m => ({ default: m.DiffEditorPane })));

/** A file, a diff or a review on a phone: full screen with a way back. */
function NarrowEditor({ route }: { readonly route: Extract<Route, { name: 'file' | 'diff' | 'changes' | 'files' }> }) {
	const client = useClient();
	const title = route.name === 'files' ? 'Files' : route.name === 'changes' ? 'Changes' : basename(route.path);
	return (
		<div className="narrow-editor">
			<header className="chat-header">
				<IconButton icon="chevronLeft" label="Back" onClick={() => window.history.length > 1 ? window.history.back() : navigate('/')} />
				<div className="chat-heading"><div className="chat-title">{title}</div>{route.name === 'file' || route.name === 'diff' ? <div className="chat-sub mono">{route.path}</div> : null}</div>
			</header>
			<div className="narrow-editor-body">
				{route.name === 'files' ? <Explorer /> : null}
				{route.name === 'changes' ? <ChangesView chatId={route.chatId} /> : null}
				{route.name === 'file' ? <Suspense fallback={<Spinner />}><CodeEditorPane client={client} path={route.path} /></Suspense> : null}
				{route.name === 'diff' ? <Suspense fallback={<Spinner />}><DiffEditorPane client={client} tab={{ id: `diff:${route.path}`, kind: 'diff', path: route.path, base: route.base }} /></Suspense> : null}
			</div>
		</div>
	);
}

function Shell({ onSignedOut }: { readonly onSignedOut: () => void }) {
	const route = useRoute();
	const status = useStatus();
	const client = useClient();
	const wide = useWide();

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) {
				e.preventDefault();
				document.querySelector<HTMLInputElement>('.sb-search input')?.focus();
			} else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
				e.preventDefault();
				navigate('/new');
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, []);

	if (status.connection.phase === 'blocked') {
		const removed = status.connection.error?.code === 'Unauthorized';
		return (
			<div className="blocked">
				<EmptyState
					icon={removed ? 'logOut' : 'alert'}
					title={removed ? 'This browser was signed out' : 'Volt needs an update'}
					body={status.connection.error?.message}
					action={removed ? <Button variant="primary" onClick={() => {
						forgetEnvironment(client.environment.environmentId);
						void client.clearCache();
						onSignedOut();
					}}>Pair again</Button> : <Button onClick={() => client.reconnect()}>Try again</Button>}
				/>
			</div>
		);
	}

	if (wide && route.name !== 'pair') {
		return <Workbench onSignedOut={onSignedOut} />;
	}

	const chatId = route.name === 'chat' ? route.id : undefined;
	if (route.name === 'file' || route.name === 'diff' || route.name === 'changes' || route.name === 'files') {
		return <NarrowEditor route={route} />;
	}
	return (
		<div className={`app route-${route.name}`}>
			<Sidebar activeChatId={chatId} />
			<main className="main">
				{!status.live && status.ready ? <OfflineBanner /> : null}
				{route.name === 'chat' ? <ChatView key={route.id} chatId={route.id} openPath={openPathInEditor} /> : null}
				{route.name === 'home' || route.name === 'new' ? <NewChat initialProjectId={route.name === 'new' ? route.projectId : undefined} /> : null}
				{route.name === 'settings' ? <Settings section={route.section} onSignedOut={onSignedOut} /> : null}
				{route.name === 'pair' ? <NewChat /> : null}
			</main>
		</div>
	);
}

function OfflineBanner() {
	const client = useClient();
	return (
		<div className="offline-banner">
			<Icon name="wifiOff" size={13} />
			<span>Showing what Volt last sent. Changes go out when {client.environment.label} is back.</span>
			<button type="button" onClick={() => client.reconnect()}>Retry now</button>
		</div>
	);
}
