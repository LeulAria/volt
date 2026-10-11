/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	ACCESS_MODES, formatCode, type ICatalogItem, type IconName, type IEnvironmentDescriptor, type IPairedDevice, type IPairingCode, modelLabel, providerName, relativeTime, routeLabel, timer
} from '@volt/client-core';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useClient, useNow, useRuntime, useStatus } from '../app/client';
import { navigate } from '../app/router';
import { forgetEnvironment } from '../app/session';
import { setThemePreference, useThemePreference } from '../app/theme';
import { ConfirmDialog, type IMenuItem, MenuButton } from '../ui/overlays';
import { Button, Icon, IconButton, Segmented, Spinner, Toggle } from '../ui/primitives';
import { QRCode } from '../ui/QRCode';
import { ConnectionBadge } from '../home/Sidebar';

const SECTIONS: readonly { readonly id: string; readonly label: string; readonly icon: IconName }[] = [
	{ id: 'general', label: 'General', icon: 'laptop' },
	{ id: 'devices', label: 'Devices', icon: 'phone' },
	{ id: 'models', label: 'Models', icon: 'cpu' },
	{ id: 'appearance', label: 'Appearance', icon: 'contrast' },
];

function Section({ title, description, children, action }: { readonly title: string; readonly description?: ReactNode; readonly children: ReactNode; readonly action?: ReactNode }) {
	return (
		<section className="set-section">
			<div className="set-section-head">
				<div>
					<h2>{title}</h2>
					{description ? <p>{description}</p> : null}
				</div>
				{action}
			</div>
			<div className="set-card">{children}</div>
		</section>
	);
}

function Row({ label, detail, children }: { readonly label: ReactNode; readonly detail?: ReactNode; readonly children?: ReactNode }) {
	return (
		<div className="set-row">
			<div className="set-row-text">
				<div className="set-row-label">{label}</div>
				{detail ? <div className="set-row-detail">{detail}</div> : null}
			</div>
			{children ? <div className="set-row-control">{children}</div> : null}
		</div>
	);
}

export function Settings({ section, onSignedOut }: { readonly section: string; readonly onSignedOut: () => void }) {
	const active = SECTIONS.some(s => s.id === section) ? section : 'general';
	return (
		<div className="settings">
			<header className="settings-header">
				<IconButton className="back-btn" icon="chevronLeft" label="Back" onClick={() => navigate('/')} />
				<h1>Settings</h1>
			</header>
			<div className="settings-layout">
				<nav className="settings-nav">
					{SECTIONS.map(s => (
						<button key={s.id} type="button" className={s.id === active ? 'on' : undefined} onClick={() => navigate(`/settings/${s.id}`, { replace: true })}>
							<Icon name={s.icon} size={15} />{s.label}
						</button>
					))}
				</nav>
				<div className="settings-content">
					{active === 'general' ? <General onSignedOut={onSignedOut} /> : null}
					{active === 'devices' ? <Devices /> : null}
					{active === 'models' ? <Models /> : null}
					{active === 'appearance' ? <Appearance /> : null}
				</div>
			</div>
		</div>
	);
}

function General({ onSignedOut }: { readonly onSignedOut: () => void }) {
	const client = useClient();
	const status = useStatus();
	const runtime = useRuntime();
	const [info, setInfo] = useState<IEnvironmentDescriptor | undefined>();
	const [signingOut, setSigningOut] = useState(false);
	useEffect(() => {
		if (status.live) {
			void client.environmentInfo().then(setInfo);
		}
	}, [client, status.live]);
	const env = client.environment;
	const route = env.routes.find(r => r.baseUrl === status.baseUrl) ?? env.routes[0];
	const defaultModelItems: IMenuItem[] = (runtime.catalog ?? []).filter(item => runtime.enabledModels?.[item.ref] ?? item.enabled).map(item => ({
		id: item.ref, label: item.qualifier ? `${item.label} ${item.qualifier}` : item.label, detail: providerName(item.providerId), checked: item.ref === runtime.activeCatalogRef,
		onSelect: () => void client.setActiveModel(item.ref),
	}));
	const access = ACCESS_MODES.find(a => a.id === runtime.accessMode) ?? ACCESS_MODES[3];
	return (
		<>
			<Section title={env.label} description="The computer this browser follows. Chats run there, even with this page closed." action={<ConnectionBadge />}>
				<Row label="Address" detail={route ? routeLabel(route.kind) : undefined}><code className="set-code">{status.baseUrl ?? route?.baseUrl}</code></Row>
				{info ? <Row label="Volt" detail={`${info.platform.os} ${info.platform.arch}`}>Server {info.serverVersion}{info.network ? ' · on the network' : ' · this computer only'}</Row> : null}
				<Row label="This browser" detail={env.role === 'owner' ? 'Trusted like Volt on the computer' : 'Paired device'}>
					<Button size="sm" icon="refresh" onClick={() => client.reconnect()}>Reconnect</Button>
					<Button size="sm" variant="danger" icon="logOut" onClick={() => setSigningOut(true)}>Sign out</Button>
				</Row>
			</Section>
			<Section title="New chats" description="Defaults for chats started from any device.">
				<Row label="Model" detail="What a new chat starts on.">
					<MenuButton className="pill" items={defaultModelItems.length ? defaultModelItems : [{ id: 'none', label: 'No models', disabled: true }]} placement="bottom-end" width={300}>
						<Icon name="cpu" size={13} /><span className="pill-text">{modelLabel(runtime, runtime.activeCatalogRef)}</span><Icon name="chevronDown" size={11} />
					</MenuButton>
				</Row>
				<Row label="Access" detail={access.description}>
					<MenuButton className="pill" placement="bottom-end" width={300} items={ACCESS_MODES.map(a => ({ id: a.id, label: a.label, detail: a.description, checked: a.id === access.id, onSelect: () => void client.setAccessMode(a.id) }))}>
						<Icon name="shield" size={13} /><span className="pill-text">{access.label}</span><Icon name="chevronDown" size={11} />
					</MenuButton>
				</Row>
			</Section>
			<ConfirmDialog open={signingOut} title="Sign out of this browser?" body={`This browser forgets ${env.label} and its key is removed. Pair again with a code to come back.`} confirm="Sign out" danger
				onClose={() => setSigningOut(false)}
				onConfirm={() => {
					const done = () => {
						void client.clearCache();
						forgetEnvironment(env.environmentId);
						onSignedOut();
					};
					if (env.role === 'device' || env.deviceId !== 'owner') {
						void client.revokeDevice(env.deviceId).finally(done);
					} else {
						done();
					}
				}} />
		</>
	);
}

function deviceIcon(device: IPairedDevice): IconName {
	return device.kind === 'web' ? 'laptop' : 'phone';
}

function Devices() {
	const client = useClient();
	const status = useStatus();
	const [devices, setDevices] = useState<readonly IPairedDevice[] | undefined>();
	const [code, setCode] = useState<IPairingCode | undefined>();
	const [making, setMaking] = useState(false);
	const [removing, setRemoving] = useState<IPairedDevice | undefined>();
	const owner = client.environment.role === 'owner';
	const now = useNow(1000, !!code);

	const refresh = useCallback(() => {
		void client.listDevices().then(list => list && setDevices(list));
	}, [client]);
	useEffect(() => {
		if (status.live) {
			refresh();
			const timer = setInterval(refresh, 10_000);
			return () => clearInterval(timer);
		}
		return undefined;
	}, [status.live, refresh]);
	useEffect(() => {
		if (code && now > code.expiresAt) {
			setCode(undefined);
		}
	}, [code, now]);

	const makeCode = async () => {
		setMaking(true);
		setCode(await client.createPairingCode());
		setMaking(false);
	};
	const best = code?.urls.find(u => u.kind !== 'loopback') ?? code?.urls[0];
	return (
		<>
			<Section title="Pair a phone or browser" description="Scan the code with the Volt app, or open the link on the other device. Each device gets its own key.">
				{!owner ? (
					<Row label="Pair from your computer" detail="Only Volt on the computer, or a browser there, can make pairing codes." />
				) : code ? (
					<div className="pair-panel">
						<div className="pair-qr">{best ? <QRCode value={best.url} size={196} /> : null}</div>
						<div className="pair-info">
							<div className="pair-code-label">Pairing code</div>
							<div className="pair-code">{formatCode(code.code)}</div>
							<div className="pair-expiry"><Icon name="clock" size={12} />Expires in {timer(code.expiresAt - (now || Date.now()))}</div>
							{!code.network ? (
								<div className="pair-warning">
									<Icon name="wifiOff" size={14} />
									<div>Volt only listens on this computer right now. In Volt, run <b>Volt: Pair a Phone or Browser…</b> from the Command Palette to let your phone reach it.</div>
								</div>
							) : null}
							<div className="pair-urls">
								{code.urls.filter(u => u.kind !== 'loopback').map(u => (
									<button key={u.url} type="button" className="pair-url" onClick={() => void navigator.clipboard?.writeText(u.url).then(() => client.toast('success', 'Link copied'))}>
										<span className="pair-url-kind">{routeLabel(u.kind)}</span>
										<span className="pair-url-text">{u.url.replace(/#.*$/, '')}</span>
										<Icon name="copy" size={12} />
									</button>
								))}
							</div>
							<div className="pair-actions">
								<Button size="sm" icon="refresh" onClick={() => void makeCode()}>New code</Button>
								<Button size="sm" variant="ghost" onClick={() => setCode(undefined)}>Done</Button>
							</div>
						</div>
					</div>
				) : (
					<Row label="Show a pairing code" detail="Valid for 10 minutes, for one device.">
						<Button variant="primary" icon="qr" busy={making} onClick={() => void makeCode()}>Pair a device</Button>
					</Row>
				)}
			</Section>
			<Section title="Paired devices" description="Remove a device to sign it out at once." action={<IconButton icon="refresh" label="Refresh" onClick={refresh} />}>
				{!devices ? <div className="set-loading"><Spinner /></div> : devices.length ? devices.map(device => (
					<div key={device.id} className="device">
						<span className="device-icon"><Icon name={deviceIcon(device)} size={16} /></span>
						<div className="device-text">
							<div className="device-name">
								{device.label}
								{device.current ? <span className="tag">This browser</span> : null}
								{device.role === 'owner' ? <span className="tag dim">Trusted</span> : null}
							</div>
							<div className="device-sub">
								{device.connected ? <span className="device-live"><span className="conn-dot" />Connected</span> : device.lastSeenAt ? `Seen ${relativeTime(device.lastSeenAt)}` : 'Never connected'}
								{device.model || device.os ? ` · ${[device.model, device.os].filter(Boolean).join(' · ')}` : ''}
							</div>
						</div>
						{owner || device.current ? <Button size="sm" variant="ghost" onClick={() => setRemoving(device)}>Remove</Button> : null}
					</div>
				)) : <Row label="No devices yet" detail="Pair your phone to follow and steer chats from anywhere." />}
			</Section>
			<ConfirmDialog open={!!removing} title={`Remove ${removing?.label ?? 'device'}?`} body="It is signed out now and needs a new code to come back." confirm="Remove" danger
				onClose={() => setRemoving(undefined)}
				onConfirm={() => {
					if (removing) {
						void client.revokeDevice(removing.id).then(refresh);
					}
				}} />
		</>
	);
}

const STATE_LABEL: Record<string, string> = { authenticated: 'Signed in', available: 'Available', disabled: 'Off', missing: 'Not installed', checking: 'Checking…' };

function Models() {
	const client = useClient();
	const runtime = useRuntime();
	const [refreshing, setRefreshing] = useState(false);
	const providers = runtime.providerStatuses ?? [];
	const byProfile = new Map<string, ICatalogItem[]>();
	for (const item of runtime.catalog ?? []) {
		const list = byProfile.get(item.profileId) ?? [];
		list.push(item);
		byProfile.set(item.profileId, list);
	}
	return (
		<Section title="Models and providers" description="What the agents on your computer can use. Sign-ins and keys stay on the computer." action={
			<Button size="sm" icon="refresh" busy={refreshing} onClick={async () => {
				setRefreshing(true);
				await client.refreshProviders();
				setRefreshing(false);
			}}>Refresh</Button>
		}>
			{!providers.length ? <Row label={runtime.catalogLoading ? 'Loading…' : 'No providers'} detail="Connect a provider in Volt on your computer." /> : providers.map(provider => {
				const models = byProfile.get(provider.profileId) ?? provider.models ?? [];
				return (
					<div key={provider.profileId} className="provider">
						<div className="provider-head">
							<span className={`provider-state state-${provider.state}`} />
							<div className="provider-text">
								<div className="provider-name">{provider.label}</div>
								<div className="provider-sub">{STATE_LABEL[provider.state] ?? provider.state}{provider.account ? ` · ${provider.account}` : ''}{provider.plan ? ` · ${provider.plan}` : ''}{provider.version ? ` · v${provider.version}` : ''}</div>
							</div>
							<Toggle checked={provider.enabled} label={`${provider.label} enabled`} onChange={next => void client.setProfileEnabled(provider.profileId, next)} />
						</div>
						{provider.enabled && models.length ? (
							<div className="provider-models">
								{models.map(model => (
									<label key={model.ref} className="model-row">
										<span className="model-name">{model.qualifier ? `${model.label} ${model.qualifier}` : model.label}</span>
										{model.contextLabel ? <span className="model-detail">{model.contextLabel}</span> : null}
										<Toggle checked={runtime.enabledModels?.[model.ref] ?? model.enabled} label={`${model.label} enabled`} onChange={next => void client.setModelEnabled(model.ref, next)} />
									</label>
								))}
							</div>
						) : null}
					</div>
				);
			})}
		</Section>
	);
}

function Appearance() {
	const preference = useThemePreference();
	return (
		<Section title="Appearance" description="Volt's dark and light themes, as on the desktop.">
			<Row label="Theme">
				<Segmented value={preference} onChange={setThemePreference} options={[
					{ id: 'system', label: 'System', icon: 'contrast' },
					{ id: 'light', label: 'Light', icon: 'sun' },
					{ id: 'dark', label: 'Dark', icon: 'moon' },
				]} />
			</Row>
		</Section>
	);
}
