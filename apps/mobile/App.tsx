/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// First: the splash stays up and the catalog and theme start loading before anything renders.
import { hideSplash } from './src/shell/splash';
import { activeEnvironment, type PairingTarget, parsePairingLink } from '@volt/client-core/src/environments';
import * as SystemUI from 'expo-system-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Modal, Platform, StatusBar, View } from 'react-native';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';
import { setNavigationBarStyle } from './modules/volt-system-bars';
import { ComputersSheet } from './src/shell/ComputersSheet';
import { ConnectScreen } from './src/shell/ConnectScreen';
import { startResolvingRoute } from './src/shell/signIn';
import { themeLoaded, useShellTheme } from './src/shell/theme';
import { usePalette } from './src/shell/ui';
import { type IWorkbenchHandle, WorkbenchScreen } from './src/shell/WorkbenchScreen';
import { activate, forget, loadEnvironments, storedCatalog, useEnvironments } from './src/state/environments';

const booted = Promise.all([loadEnvironments(), themeLoaded]);
// The search for the computer sends no token: it runs while the keychain is read and the first
// screen mounts, and the workbench's first sign-in takes its answer.
void storedCatalog().then(catalog => {
	const environment = activeEnvironment(catalog);
	if (environment) {
		startResolvingRoute(environment);
	}
}, () => undefined);

export default function App() {
	return (
		<SafeAreaProvider initialMetrics={initialWindowMetrics}>
			<Root />
		</SafeAreaProvider>
	);
}

/**
 * The shell: the workbench of the active computer, or the connect screen when none is paired.
 * Pairing another computer and the computers sheet open over the workbench, which stays loaded.
 */
function Root() {
	const [booting, setBooting] = useState(true);
	const { catalog } = useEnvironments();
	const theme = useShellTheme();
	const p = usePalette();
	const active = activeEnvironment(catalog);
	const workbench = useRef<IWorkbenchHandle>(null);
	/**
	 * The connect screen, with a link to confirm on it: over the workbench (pair another, a pairing
	 * link, pair again), or the whole app while no computer is paired.
	 */
	const [connect, setConnect] = useState<{ readonly link?: PairingTarget; readonly overWorkbench: boolean } | undefined>();
	const [sheet, setSheet] = useState<{ readonly signedOutOf?: string } | undefined>();
	const activeRef = useRef(active);
	activeRef.current = active;

	// Paired from the connect screen that was the whole app: it must not open again over the
	// workbench (iOS can't dismiss a modal that is still presenting, which leaves it over every tap).
	useEffect(() => {
		if (active && connect && !connect.overWorkbench) {
			setConnect(undefined);
		}
	}, [active, connect]);

	useEffect(() => {
		void booted.then(() => setBooting(false));
	}, []);

	// `volt://pair?url=<pairing link>` and pairing links: confirmed on the connect screen first.
	useEffect(() => {
		const open = (url: string | null) => {
			const target = url ? parsePairingLink(url) : undefined;
			if (target) {
				setSheet(undefined);
				setConnect({ link: target, overWorkbench: !!activeRef.current });
			}
		};
		void Linking.getInitialURL().then(open, () => undefined);
		const subscription = Linking.addEventListener('url', event => open(event.url));
		return () => subscription.remove();
	}, []);

	useEffect(() => {
		void SystemUI.setBackgroundColorAsync(active ? theme.background : p.canvas).catch(() => undefined);
	}, [active, theme.background, p.canvas]);

	// Android's navigation bar buttons follow what is drawn behind them: the workbench's theme, or
	// the system's under the connect screen.
	const barsDark = active ? theme.dark : p.dark;
	useEffect(() => {
		setNavigationBarStyle(barsDark);
	}, [barsDark]);

	// No computer: the connect screen is the app, and nothing waits behind the splash.
	useEffect(() => {
		if (!booting && !active) {
			hideSplash();
		}
	}, [booting, active]);

	const closeSheet = useCallback(() => {
		const signedOut = sheet?.signedOutOf;
		setSheet(undefined);
		// Closed after signing out without a choice: back into the same computer.
		if (signedOut && signedOut === active?.environmentId) {
			workbench.current?.signIn();
		}
	}, [sheet, active]);

	if (booting) {
		return <View style={{ flex: 1, backgroundColor: theme.background }} />;
	}

	if (!active) {
		return (
			<>
				<StatusBar barStyle={p.dark ? 'light-content' : 'dark-content'} />
				<ConnectScreen link={connect?.link} onPaired={() => setConnect(undefined)} onCancel={connect?.link ? () => setConnect(undefined) : undefined} />
			</>
		);
	}

	return (
		<View style={{ flex: 1, backgroundColor: theme.background }}>
			<WorkbenchScreen
				ref={workbench}
				environment={active}
				onComputers={() => setSheet({})}
				onSignedOut={() => setSheet({ signedOutOf: active.environmentId })}
				onPairAgain={() => setConnect({ overWorkbench: true })}
			/>
			<ComputersSheet
				visible={!!sheet}
				environments={catalog.environments}
				activeId={active.environmentId}
				signedOutOf={sheet?.signedOutOf}
				onSelect={environmentId => {
					setSheet(undefined);
					if (environmentId !== active.environmentId) {
						void activate(environmentId);
					} else if (sheet?.signedOutOf) {
						workbench.current?.signIn();
					}
				}}
				onPairAnother={() => {
					setSheet(undefined);
					// iOS presents one modal at a time: the sheet finishes closing first.
					setTimeout(() => setConnect({ overWorkbench: true }), Platform.OS === 'ios' ? 450 : 0);
				}}
				onForget={environmentId => {
					if (environmentId === active.environmentId) {
						workbench.current?.signOutPage();
					}
					setSheet(current => current && catalog.environments.length > 1 ? current : undefined);
					void forget(environmentId);
				}}
				onClose={closeSheet}
			/>
			<Modal visible={!!connect?.overWorkbench} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setConnect(undefined)} statusBarTranslucent navigationBarTranslucent>
				<StatusBar barStyle={p.dark ? 'light-content' : 'dark-content'} />
				<ConnectScreen link={connect?.link} onPaired={() => setConnect(undefined)} onCancel={() => setConnect(undefined)} />
			</Modal>
		</View>
	);
}
