/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/addDeviceModal.css';
import { $, addDisposableListener, append, clearNode, EventType, isKeyboardEvent } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { VOLT_ALLOW_NETWORK_COMMAND_ID as ALLOW_NETWORK_COMMAND_ID } from '../../../../platform/voltAgentServer/common/agentServerService.js';
import { IVoltConnectStatus, IVoltPairedDevice, IVoltPairingCode, IVoltSshTunnelOptions, IVoltTunnelStatus } from '../../../../platform/voltAgentServer/common/protocol.js';
import { IAgentServerClientService } from '../../../services/voltAgentServer/common/agentServerClient.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { IRemoteModal, openRemoteModal, renderVoltMark } from '../../voltAgent/browser/remote/voltRemoteIntro.js';
import { createVoltDropdown } from '../../voltAgent/browser/ui/dropdown/voltDropdown.js';
import { qrcode } from '../../voltSettings/browser/vendor/qrcode.js';
import type { VoltConnectionKind } from '../common/voltRemoteDevices.js';

type SshMode = 'reverse' | 'forward';

const POLL_MS = 1500;
const ROW_HEIGHT = 52;
const QR_SIZE = 180;
const DEFAULT_SSH_PORT = 8799;
const SVG_NS = 'http://www.w3.org/2000/svg';
const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';
const CLOUDFLARED_DOWNLOAD = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
const MAC_SHARING_SETTINGS = 'x-apple.systempreferences:com.apple.Sharing-Settings.extension';
const SPIN = ThemeIcon.modify(Codicon.loading, 'spin');

export function kindLabel(device: IVoltPairedDevice): string {
	const kind = device.kind === 'web' ? localize('devices.kindWeb', "Browser") : device.kind === 'tablet' ? localize('devices.kindTablet', "Tablet") : localize('devices.kindPhone', "Phone");
	return [kind, device.model, device.os].filter(Boolean).join(' · ');
}

/**
 * A QR code as one SVG path, dark on a white tile with a quiet zone. With `logo`, the middle is
 * left clear for the Volt mark (high error correction reads through it).
 */
export function renderQrCode(parent: HTMLElement, value: string, size: number, logo = false): void {
	const qr = qrcode(0, logo ? 'H' : 'M');
	qr.addData(value);
	qr.make();
	const count = qr.getModuleCount();
	let hole = 0;
	if (logo) {
		hole = Math.ceil(count * 0.24);
		hole += (count - hole) % 2;
	}
	const from = (count - hole) / 2;
	let d = '';
	for (let row = 0; row < count; row++) {
		for (let col = 0; col < count; col++) {
			const inHole = hole && row >= from && row < from + hole && col >= from && col < from + hole;
			if (!inHole && qr.isDark(row, col)) {
				d += `M${col} ${row}h1v1h-1z`;
			}
		}
	}
	const quiet = 2;
	const span = count + quiet * 2;
	const doc = parent.ownerDocument;
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('viewBox', `${-quiet} ${-quiet} ${span} ${span}`);
	svg.setAttribute('shape-rendering', 'crispEdges');
	svg.setAttribute('role', 'img');
	svg.setAttribute('aria-label', localize('devices.qr', "Pairing QR code"));
	const tile = doc.createElementNS(SVG_NS, 'rect');
	tile.setAttribute('x', String(-quiet));
	tile.setAttribute('y', String(-quiet));
	tile.setAttribute('width', String(span));
	tile.setAttribute('height', String(span));
	tile.setAttribute('rx', '2');
	tile.setAttribute('fill', '#fff');
	const path = doc.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', d);
	path.setAttribute('fill', '#111');
	svg.append(tile, path);
	const holder = append(parent, $('.volt-qr'));
	holder.style.width = holder.style.height = `${size}px`;
	holder.appendChild(svg);
	if (logo) {
		const px = (hole / span) * size;
		const mark = append(holder, $('.volt-qr-logo'));
		mark.style.width = mark.style.height = `${px}px`;
		renderVoltMark(mark, Math.round(px * 0.86));
	}
}

/** Tailscale's nine dots. */
function tailscaleGlyph(): SVGElement {
	const document = mainWindow.document;
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.classList.add('volt-tailscale-glyph');
	const bright = new Set([3, 4, 5, 7]);
	for (let i = 0; i < 9; i++) {
		const dot = document.createElementNS(SVG_NS, 'circle');
		dot.setAttribute('cx', String(3 + (i % 3) * 5));
		dot.setAttribute('cy', String(3 + Math.floor(i / 3) * 5));
		dot.setAttribute('r', '1.7');
		dot.setAttribute('fill', 'currentColor');
		dot.setAttribute('opacity', bright.has(i) ? '1' : '0.3');
		svg.appendChild(dot);
	}
	return svg;
}

/** Cloudflare's cloud, as an outline to sit with the codicons. */
function cloudflareGlyph(): SVGElement {
	const document = mainWindow.document;
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '18');
	svg.setAttribute('height', '18');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.25');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	for (const d of ['M13.031 7.007c2.469 -.007 3.295 1.293 3.969 2.993c4 0 4.994 3.825 5 6h-20c-.001 -1.64 1.36 -2.954 3 -3c0 -1.5 1 -3 3 -3c.66 -1.942 2.562 -2.986 5.031 -2.993z', 'M12 13h6', 'M17 10l-2.5 6']) {
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	return svg;
}

/**
 * Writes `text` with each of `secrets` in it (addresses, host names, the account) in a span the
 * CSS blurs until hovered, so a shared screen does not show them.
 */
function appendPrivateText(parent: HTMLElement, text: string, secrets: readonly string[]): void {
	const found = secrets.filter(secret => secret.length > 2 && text.includes(secret)).sort((a, b) => b.length - a.length);
	if (!found.length) {
		parent.append(text);
		return;
	}
	const pattern = new RegExp(found.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		const at = match.index ?? 0;
		if (at > last) {
			parent.append(text.slice(last, at));
		}
		append(parent, $('span.volt-private')).textContent = match[0];
		last = at + match[0].length;
	}
	if (last < text.length) {
		parent.append(text.slice(last));
	}
}

//#region The connection list

type ConnectionTone = 'ready' | 'off' | 'busy' | 'error';

interface IConnectionItem {
	readonly kind: VoltConnectionKind;
	readonly label: string;
	readonly description: string;
	readonly icon: ThemeIcon | (() => SVGElement);
	/** Its state on this computer, on the right of the row. */
	readonly tone: ConnectionTone;
	readonly statusText: string;
}

interface IConnectionTemplate {
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly description: HTMLElement;
	readonly status: HTMLElement;
}

class ConnectionDelegate implements IListVirtualDelegate<IConnectionItem> {
	getHeight(): number {
		return ROW_HEIGHT;
	}
	getTemplateId(): string {
		return ConnectionRenderer.TEMPLATE_ID;
	}
}

class ConnectionRenderer implements IListRenderer<IConnectionItem, IConnectionTemplate> {
	static readonly TEMPLATE_ID = 'voltConnection';
	readonly templateId = ConnectionRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IConnectionTemplate {
		const row = append(container, $('.volt-connect-row'));
		const icon = append(row, $('span.volt-connect-icon'));
		const text = append(row, $('span.volt-connect-text'));
		return {
			icon,
			label: append(text, $('span.volt-connect-label')),
			description: append(text, $('span.volt-connect-desc')),
			status: append(row, $('span.volt-connect-status')),
		};
	}

	renderElement(item: IConnectionItem, _index: number, template: IConnectionTemplate): void {
		template.icon.replaceChildren(ThemeIcon.isThemeIcon(item.icon) ? renderIcon(item.icon) : item.icon());
		template.label.textContent = item.label;
		template.description.textContent = item.description;
		template.status.className = `volt-connect-status ${item.tone}`;
		template.status.replaceChildren();
		if (item.statusText) {
			if (item.tone === 'busy') {
				template.status.appendChild(renderIcon(SPIN));
			} else {
				append(template.status, $('span.dot'));
			}
			append(template.status, $('span')).textContent = item.statusText;
		}
	}

	disposeTemplate(): void { }
}

const CONNECTIONS: readonly Pick<IConnectionItem, 'kind' | 'label' | 'description' | 'icon'>[] = [
	{ kind: 'lan', label: localize('addDevice.lan', "Same Wi-Fi"), description: localize('addDevice.lanDesc', "Phones and computers on this network"), icon: Codicon.radioTower },
	{ kind: 'tailscale', label: 'Tailscale', description: localize('addDevice.tailscaleDesc', "Your own devices, from any network"), icon: tailscaleGlyph },
	{ kind: 'cloudflare', label: localize('addDevice.cloudflare', "Cloudflare Tunnel"), description: localize('addDevice.cloudflareDesc', "A private https link, no account needed"), icon: cloudflareGlyph },
	{ kind: 'ssh', label: localize('addDevice.ssh', "SSH Tunnel"), description: localize('addDevice.sshDesc', "Through a server you can SSH into"), icon: Codicon.terminal },
];

function tunnelState(tunnel: IVoltTunnelStatus | undefined): Pick<IConnectionItem, 'tone' | 'statusText'> | undefined {
	switch (tunnel?.state) {
		case 'on': return { tone: 'ready', statusText: localize('addDevice.statusOn', "On") };
		case 'starting': return { tone: 'busy', statusText: localize('addDevice.statusStarting', "Starting") };
		case 'error': return { tone: 'error', statusText: localize('addDevice.statusError', "Stopped") };
		default: return undefined;
	}
}

/** What each way in needs on this computer, in a word or two. */
function connectionState(kind: VoltConnectionKind, status: IVoltConnectStatus | undefined): Pick<IConnectionItem, 'tone' | 'statusText'> {
	if (!status) {
		return { tone: 'off', statusText: '' };
	}
	const ready = { tone: 'ready' as const, statusText: localize('addDevice.statusReady', "Ready") };
	const off = { tone: 'off' as const, statusText: localize('addDevice.statusOff', "Off") };
	switch (kind) {
		case 'lan':
			return status.network && status.lanAddress ? ready : off;
		case 'tailscale':
			return !status.tailscale.installed ? { tone: 'off', statusText: localize('addDevice.statusNotInstalled', "Not installed") }
				: !status.tailscale.running ? { tone: 'off', statusText: localize('addDevice.statusSignedOut', "Signed out") }
					: status.network ? ready : off;
		case 'cloudflare':
			return tunnelState(status.tunnels.find(tunnel => tunnel.kind === 'cloudflare'))
				?? (status.cloudflared.installed ? off : { tone: 'off', statusText: localize('addDevice.statusNotInstalled', "Not installed") });
		case 'ssh':
			return tunnelState(status.tunnels.find(tunnel => tunnel.kind === 'ssh')) ?? off;
	}
}

//#endregion

//#region Steps

type StepState = 'done' | 'current' | 'todo' | 'error';

interface IStepAction {
	readonly label: string;
	readonly kind?: 'primary' | 'secondary' | 'ghost';
	readonly run: () => unknown;
}

interface IStepDef {
	readonly title: string;
	/** Whether this step is behind the user. */
	readonly done: boolean;
	/** Under the title while it is the step to do. */
	readonly detail?: string;
	/** Under the title once it is done. */
	readonly doneDetail?: string;
	readonly actions?: readonly IStepAction[];
	/** Buttons on the step once it is done (Stop Tunnel). */
	readonly doneActions?: readonly IStepAction[];
	/** It failed: why. */
	readonly error?: string;
	/** Working on it (a tunnel starting, an install): shown with a spinner instead of the buttons. */
	readonly working?: string;
	/** A warning on a done step (the tunnel is up but not reachable from outside). */
	readonly warning?: string;
	/** A command to copy (`ssh -L`). */
	readonly command?: string;
	/** The last step: waits for a device while it is the one to do. */
	readonly waits?: boolean;
}

interface IStep extends IStepDef {
	readonly state: StepState;
}

/** The steps for a way in, as a checklist: what is done, the one to do now, and what comes after. */
interface IView {
	readonly steps: readonly IStep[];
	/** Set when the connection works: a code's link can be shown for it. */
	readonly route?: string;
}

/** Done steps, then the first step not done (current, or failed), then the rest still to do. */
function sequence(defs: readonly IStepDef[]): IStep[] {
	let reached = false;
	return defs.map(def => {
		if (def.done && !reached) {
			return { ...def, state: 'done' as const };
		}
		if (!reached) {
			reached = true;
			return { ...def, state: def.error ? 'error' as const : 'current' as const };
		}
		return { ...def, state: 'todo' as const };
	});
}

//#endregion

export interface IAddDeviceOptions {
	readonly kind?: VoltConnectionKind;
	/** A device paired (the Devices page lists it). */
	readonly onDidPair?: () => void;
	readonly onDidClose?: () => void;
}

/**
 * Add Device: pick how the phone or browser reaches this computer from a list (this Wi-Fi,
 * Tailscale, a Cloudflare tunnel, SSH), follow its steps right here, then scan the QR code on the
 * left or open the link. Turns green when the device pairs. Codes renew on their own while open.
 */
export function showAddDeviceModal(container: HTMLElement, instantiationService: IInstantiationService, options: IAddDeviceOptions = {}): void {
	instantiationService.createInstance(AddDeviceModal, container, options);
}

class AddDeviceModal {

	private readonly modal: IRemoteModal;
	private readonly store: DisposableStore;
	private readonly list: WorkbenchList<IConnectionItem>;
	private kind: VoltConnectionKind;
	private sshMode: SshMode = 'reverse';
	private status: IVoltConnectStatus | undefined;
	private statusError: string | undefined;
	private code: IVoltPairingCode | undefined;
	/** The route the current code was made for: a code without its link is not made again for it. */
	private codeRoute: string | undefined;
	private creatingCode = false;
	private known: Set<string> | undefined;
	private paired: IVoltPairedDevice | undefined;
	private busy: string | undefined;
	private actionError: string | undefined;
	private restarting = false;
	private copied: 'link' | 'command' | false = false;
	/** The link and the ssh command show as dots until their eye is clicked. */
	private readonly revealed = new Set<'link' | 'command'>();
	private ssh: { target: string; remotePort: string; publicUrl: string } = { target: '', remotePort: String(DEFAULT_SSH_PORT), publicUrl: '' };
	private sshPrefilled = false;
	private rendered = '';
	private listed = '';
	private readonly renderStore = new DisposableStore();
	private readonly formStore = new DisposableStore();

	private readonly heroStage: HTMLElement;
	private readonly form: HTMLElement;
	private readonly steps: HTMLElement;
	private readonly link: HTMLElement;
	private readonly actions: HTMLElement;

	constructor(
		container: HTMLElement,
		private readonly options: IAddDeviceOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IAgentServerClientService private readonly client: IAgentServerClientService,
		@IContextViewService private readonly contextView: IContextViewService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IOpenerService private readonly opener: IOpenerService,
		@ICommandService private readonly commands: ICommandService,
	) {
		this.kind = options.kind ?? 'lan';
		this.modal = openRemoteModal(container, 'volt-add-device', () => options.onDidClose?.(), { split: true });
		this.store = this.modal.store;
		this.store.add(this.renderStore);
		this.store.add(this.formStore);
		const { body, hero } = this.modal;

		this.heroStage = append(hero, $('.stage'));

		const head = append(body, $('.head'));
		const title = append(head, $('h2'));
		title.textContent = localize('addDevice.title', "Add a device");
		this.modal.labelWith(title);
		append(head, $('p.subtitle')).textContent = localize('addDevice.subtitle', "Choose how your phone or browser reaches this computer, then scan the code.");

		append(body, $('.section-label')).textContent = localize('addDevice.connectOver', "Connect over");
		const listHost = append(body, $('.volt-connect-list'));
		listHost.style.height = `${CONNECTIONS.length * ROW_HEIGHT}px`;
		this.list = this.store.add(instantiationService.createInstance(WorkbenchList<IConnectionItem>, 'voltAddDeviceConnections', listHost, new ConnectionDelegate(), [new ConnectionRenderer()], {
			identityProvider: { getId: (item: IConnectionItem) => item.kind },
			multipleSelectionSupport: false,
			horizontalScrolling: false,
			alwaysConsumeMouseWheel: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('addDevice.connectionsAria', "How the device connects"),
				getAriaLabel: (item: IConnectionItem) => item.statusText ? `${item.label}, ${item.statusText}` : item.label,
			},
		}));
		this.list.layout(CONNECTIONS.length * ROW_HEIGHT);
		this.updateList();
		const index = CONNECTIONS.findIndex(connection => connection.kind === this.kind);
		this.list.setSelection([index]);
		this.list.setFocus([index]);
		this.store.add(this.list.onDidOpen(e => e.element && this.pick(e.element.kind)));
		// Arrow keys move the selection too: the steps follow the row in focus.
		this.store.add(this.list.onDidChangeFocus(e => {
			const item = e.elements[0];
			if (item && e.browserEvent && isKeyboardEvent(e.browserEvent)) {
				this.list.setSelection([...e.indexes]);
				this.pick(item.kind);
			}
		}));

		const detail = append(body, $('.detail'));
		this.form = append(detail, $('.connect-form'));
		this.steps = append(detail, $('ol.volt-connect-steps'));
		this.link = append(detail, $('.connect-link'));
		this.actions = append(body, $('.actions'));

		this.renderForm();
		this.render(true);
		const timer = this.modal.window.setInterval(() => void this.tick(), POLL_MS);
		const clock = this.modal.window.setInterval(() => this.updateExpiry(), 1000);
		this.store.add(toDisposable(() => {
			this.modal.window.clearInterval(timer);
			this.modal.window.clearInterval(clock);
		}));
		this.modal.window.requestAnimationFrame(() => this.list.domFocus());
		void this.start();
	}

	private get closed(): boolean {
		return this.store.isDisposed;
	}

	private pick(kind: VoltConnectionKind): void {
		if (kind === this.kind) {
			return;
		}
		this.kind = kind;
		this.actionError = undefined;
		this.renderForm();
		this.render(true);
		void this.tick();
	}

	private updateList(): void {
		const items = CONNECTIONS.map(connection => ({ ...connection, ...connectionState(connection.kind, this.status) }));
		const key = JSON.stringify(items.map(item => [item.tone, item.statusText]));
		if (key === this.listed) {
			return;
		}
		this.listed = key;
		this.list.splice(0, this.list.length, items);
	}

	private async start(): Promise<void> {
		try {
			await this.client.whenReady;
			const devices = await this.client.call<readonly IVoltPairedDevice[]>('pairing.devices');
			this.known = new Set(devices.map(device => device.id));
		} catch {
			this.known = new Set();
		}
		await this.tick();
	}

	private async tick(): Promise<void> {
		if (this.closed) {
			return;
		}
		try {
			this.status = await this.client.call<IVoltConnectStatus>('connect.status');
			this.statusError = undefined;
			this.restarting = false;
		} catch (err) {
			// While the server restarts (network access changed) calls fail for a few seconds.
			this.statusError = this.restarting ? undefined : toErrorMessage(err);
		}
		if (this.closed) {
			return;
		}
		// `ssh -L` from another computer forwards to the tunnel listener: open it for the command.
		if (this.kind === 'ssh' && this.sshMode === 'forward' && this.status?.remoteLogin && !this.status.tunnelPort) {
			try {
				const tunnelPort = await this.client.call<number>('connect.listener');
				this.status = { ...this.status, tunnelPort };
			} catch (err) {
				this.actionError = toErrorMessage(err);
			}
		}
		this.prefillSsh();
		await this.ensureCode();
		await this.watchPairing();
		this.updateList();
		this.render();
	}

	/** The SSH fields start from the tunnel used last time. */
	private prefillSsh(): void {
		if (this.sshPrefilled || !this.status) {
			return;
		}
		this.sshPrefilled = true;
		const saved = this.status.tunnels.find(tunnel => tunnel.kind === 'ssh')?.ssh;
		if (saved) {
			this.ssh = { target: saved.target, remotePort: String(saved.remotePort), publicUrl: saved.publicUrl ?? '' };
		}
		if (this.kind === 'ssh') {
			this.renderForm();
		}
	}

	private tunnel(kind: 'cloudflare' | 'ssh'): IVoltTunnelStatus | undefined {
		return this.status?.tunnels.find(tunnel => tunnel.kind === kind);
	}

	/** The pairing link for the picked connection, from the code's links. */
	private linkFor(code: IVoltPairingCode | undefined): string | undefined {
		if (!code) {
			return undefined;
		}
		const status = this.status;
		switch (this.kind) {
			case 'lan': {
				const lan = code.urls.filter(url => url.kind === 'lan' && !url.via);
				return (lan.find(url => status?.lanAddress && url.url.includes(`//${status.lanAddress}:`)) ?? lan[0])?.url;
			}
			case 'tailscale':
				return code.urls.find(url => url.kind === 'tailnet')?.url;
			case 'cloudflare':
				return code.urls.find(url => url.via === 'cloudflare')?.url;
			case 'ssh':
				if (this.sshMode === 'forward') {
					return status?.tunnelPort ? `http://localhost:${status.tunnelPort}/pair#code=${code.code}` : undefined;
				}
				return code.urls.find(url => url.via === 'ssh')?.url;
		}
	}

	private async ensureCode(): Promise<void> {
		const route = this.view().route;
		if (!route || this.creatingCode || this.paired || this.closed) {
			return;
		}
		const fresh = !!this.code && this.code.expiresAt - Date.now() > 15_000;
		if (fresh && (this.linkFor(this.code) || this.codeRoute === route)) {
			return;
		}
		this.creatingCode = true;
		try {
			this.code = await this.client.call<IVoltPairingCode>('pairing.createCode');
			this.codeRoute = route;
			this.copied = false;
		} catch (err) {
			this.actionError = toErrorMessage(err);
		} finally {
			this.creatingCode = false;
		}
	}

	/** A device that was not there when the dialog opened has paired. */
	private async watchPairing(): Promise<void> {
		if (!this.code || !this.known || this.paired) {
			return;
		}
		try {
			const devices = await this.client.call<readonly IVoltPairedDevice[]>('pairing.devices');
			const added = devices.find(device => !this.known!.has(device.id) && device.role === 'device');
			if (added) {
				this.paired = added;
				this.code = undefined;
				this.options.onDidPair?.();
			}
		} catch {
			// next tick
		}
	}

	private async act(label: string, run: () => Promise<unknown>): Promise<void> {
		this.busy = label;
		this.actionError = undefined;
		this.render();
		try {
			await run();
		} catch (err) {
			this.actionError = toErrorMessage(err);
		} finally {
			this.busy = undefined;
		}
		await this.tick();
	}

	private open(url: string): void {
		void this.opener.open(URI.parse(url), { openExternal: true });
	}

	private allowNetwork(label: string): IStepAction[] {
		if (!CommandsRegistry.getCommand(ALLOW_NETWORK_COMMAND_ID)) {
			return [];
		}
		return [{
			label, kind: 'primary', run: () => this.act(localize('addDevice.restarting', "Restarting Volt's server…"), async () => {
				this.restarting = true;
				await this.commands.executeCommand(ALLOW_NETWORK_COMMAND_ID);
			}),
		}];
	}

	private allowDetail(): string {
		return CommandsRegistry.getCommand(ALLOW_NETWORK_COMMAND_ID)
			? localize('addDevice.allowDetail', "Volt restarts its server to listen on the network. Running chats pause and can be resumed.")
			: localize('addDevice.allowOnComputer', "Allow it from Volt on the computer it runs on.");
	}

	private scanStep(done: boolean, detail: string): IStepDef {
		return { title: localize('addDevice.scan', "Scan the code with your phone"), done, detail, waits: true };
	}

	private tunnelStep(tunnel: IVoltTunnelStatus | undefined, start: () => Promise<unknown>, startDetail: string, startingText: string): IStepDef {
		const state = tunnel?.state ?? 'off';
		const startAction = { label: localize('addDevice.startTunnel', "Start Tunnel"), kind: 'primary' as const, run: () => this.act(startingText, start) };
		const stop = { label: localize('addDevice.stopTunnel', "Stop"), kind: 'ghost' as const, run: () => this.act(localize('addDevice.stopping', "Stopping the tunnel…"), () => this.client.call('connect.stop', tunnel?.kind)) };
		return {
			title: state === 'on' ? localize('addDevice.tunnelOpen', "Tunnel open") : localize('addDevice.startTheTunnel', "Start the tunnel"),
			done: state === 'on',
			detail: startDetail,
			doneDetail: tunnel?.url?.replace(/^https?:\/\//, ''),
			warning: tunnel?.reachable === false ? tunnel.note : undefined,
			actions: state === 'error' ? [{ ...startAction, label: localize('addDevice.tryAgain', "Try Again") }] : [startAction],
			doneActions: [stop],
			error: state === 'error' ? tunnel?.error : undefined,
			working: state === 'starting' ? (tunnel?.note ?? startingText) : undefined,
		};
	}

	private view(): IView {
		const status = this.status;
		if (!status) {
			return {
				steps: [{
					state: this.statusError ? 'error' : 'current',
					title: localize('addDevice.checking', "Checking this computer"),
					done: false,
					...(this.statusError ? { error: this.statusError } : { working: localize('addDevice.checkingDetail', "Looking for Wi-Fi, Tailscale and tunnels…") }),
				}],
			};
		}
		switch (this.kind) {
			case 'lan': {
				const noLan = status.network && !status.lanAddress;
				return {
					steps: sequence([
						{
							title: localize('addDevice.allowLan', "Allow connections on this network"),
							done: status.network && !!status.lanAddress,
							detail: this.allowDetail(),
							doneDetail: localize('addDevice.lanListening', "Listening at {0}", `${status.lanAddress}:${status.port}`),
							actions: this.allowNetwork(localize('addDevice.allow', "Allow")),
							error: noLan ? localize('addDevice.noLan', "This computer is not on a local network. Join Wi-Fi, or pick Tailscale or a tunnel.") : undefined,
						},
						this.scanStep(false, localize('addDevice.lanScan', "Or open the link in a browser on the same Wi-Fi.")),
					]),
					route: status.network && status.lanAddress ? `lan:${status.lanAddress}` : undefined,
				};
			}
			case 'tailscale': {
				const tailscale = status.tailscale;
				const name = tailscale.dnsName ?? tailscale.ip ?? '';
				const checkAgain = { label: localize('addDevice.checkAgain', "Check Again"), run: () => this.tick() };
				return {
					steps: sequence([
						{
							title: localize('addDevice.tsInstall', "Install Tailscale"),
							done: tailscale.installed,
							detail: localize('addDevice.tsInstallDetail', "On this computer and on your phone."),
							actions: [{ label: localize('addDevice.getTailscale', "Get Tailscale"), kind: 'primary', run: () => this.open(TAILSCALE_DOWNLOAD) }, checkAgain],
						},
						{
							title: localize('addDevice.tsSignIn', "Sign in to Tailscale"),
							done: tailscale.running,
							detail: localize('addDevice.tsSignInDetail', "Open Tailscale on this computer and sign in."),
							doneDetail: tailscale.tailnet ? localize('addDevice.tsSignedIn', "{0} on {1}", name, tailscale.tailnet) : name,
							actions: [checkAgain],
						},
						{
							title: localize('addDevice.tsAllow', "Allow connections from your tailnet"),
							done: status.network,
							detail: this.allowDetail(),
							doneDetail: localize('addDevice.tsListening', "Listening at {0}", `${tailscale.ip ?? name}:${status.port}`),
							actions: this.allowNetwork(localize('addDevice.allow', "Allow")),
						},
						this.scanStep(false, localize('addDevice.tsScan', "Turn on Tailscale on the phone, signed in to the same account.")),
					]),
					route: tailscale.running && status.network && tailscale.ip ? `tailnet:${tailscale.ip}` : undefined,
				};
			}
			case 'cloudflare': {
				const cloudflared = status.cloudflared;
				const tunnel = this.tunnel('cloudflare');
				return {
					steps: sequence([
						{
							title: localize('addDevice.cfInstall', "Install cloudflared"),
							done: cloudflared.installed || tunnel?.state === 'on',
							detail: localize('addDevice.cfInstallDetail', "A small free tool from Cloudflare. No account or domain needed."),
							actions: cloudflared.canInstall
								? [{ label: localize('addDevice.installCf', "Install"), kind: 'primary', run: () => this.act(localize('addDevice.installing', "Installing with Homebrew…"), () => this.client.call('connect.installCloudflared')) }]
								: [{ label: localize('addDevice.downloadCf', "Download"), kind: 'primary', run: () => this.open(CLOUDFLARED_DOWNLOAD) }, { label: localize('addDevice.checkAgain', "Check Again"), run: () => this.tick() }],
							working: cloudflared.installing ? localize('addDevice.installing', "Installing with Homebrew…") : undefined,
							error: cloudflared.installError,
						},
						this.tunnelStep(tunnel, () => this.client.call('connect.start', 'cloudflare'),
							localize('addDevice.cfStartDetail', "Cloudflare gives this computer a random https address. Only devices you pair can use it."),
							localize('addDevice.cfStarting', "Opening a tunnel through Cloudflare…")),
						this.scanStep(false, localize('addDevice.cfScan', "Works from any network. Scan again if the tunnel restarts: its address changes.")),
					]),
					route: tunnel?.state === 'on' ? tunnel.url : undefined,
				};
			}
			case 'ssh': {
				if (this.sshMode === 'forward') {
					const command = status.tunnelPort ? `ssh -N -L ${status.tunnelPort}:127.0.0.1:${status.tunnelPort} ${status.user}@${status.hostname}` : undefined;
					return {
						steps: sequence([
							{
								title: localize('addDevice.remoteLogin', "Turn on Remote Login"),
								done: status.remoteLogin,
								detail: localize('addDevice.remoteLoginDetail', "System Settings > General > Sharing, so the other computer can SSH in."),
								actions: [{ label: localize('addDevice.openSharing', "Open Sharing Settings"), kind: 'primary', run: () => this.open(MAC_SHARING_SETTINGS) }, { label: localize('addDevice.checkAgain', "Check Again"), run: () => this.tick() }],
							},
							{
								title: localize('addDevice.forwardRun', "On the other computer, run this and open the link"),
								done: false,
								detail: localize('addDevice.forwardDetail', "Keep the command running while you use Volt there."),
								command,
								waits: true,
								working: command ? undefined : localize('addDevice.preparing', "Preparing…"),
							},
						]),
						route: command ? `forward:${status.tunnelPort}` : undefined,
					};
				}
				const tunnel = this.tunnel('ssh');
				return {
					steps: sequence([
						this.tunnelStep(tunnel, () => this.client.call('connect.start', 'ssh', this.sshOptions()),
							localize('addDevice.sshStartDetail', "Volt runs ssh -R with your keys, never a password, and reconnects when the network changes."),
							localize('addDevice.sshStarting', "Connecting to {0}…", this.ssh.target || localize('addDevice.server', "the server"))),
						this.scanStep(false, localize('addDevice.sshScan', "Works from anywhere that can reach your server.")),
					]),
					route: tunnel?.state === 'on' ? tunnel.url : undefined,
				};
			}
		}
	}

	private sshOptions(): IVoltSshTunnelOptions {
		const target = this.ssh.target.trim();
		if (!target) {
			throw new Error(localize('addDevice.sshNeedTarget', "Enter the server to connect to."));
		}
		return { target, remotePort: Number(this.ssh.remotePort) || DEFAULT_SSH_PORT, ...(this.ssh.publicUrl.trim() ? { publicUrl: this.ssh.publicUrl.trim() } : {}) };
	}

	/** The SSH fields: made again only when the connection or SSH mode changes, so typing is kept. */
	private renderForm(): void {
		this.formStore.clear();
		clearNode(this.form);
		this.form.classList.toggle('empty', this.kind !== 'ssh');
		if (this.kind !== 'ssh') {
			return;
		}
		const field = (label: string) => {
			const row = append(this.form, $('.field'));
			append(row, $('label.field-label')).textContent = label;
			return append(row, $('.field-control'));
		};
		createVoltDropdown<SshMode>(field(localize('addDevice.sshMode', "Direction")), this.contextView, {
			options: [
				{ id: 'reverse', label: localize('addDevice.sshReverse', "Through my server"), description: localize('addDevice.sshReverseDesc', "This computer opens a tunnel to your server; devices open the server's address"), icon: Codicon.server },
				{ id: 'forward', label: localize('addDevice.sshForward', "From a computer that can SSH here"), description: localize('addDevice.sshForwardDesc', "The other computer forwards a port to this one with ssh -L"), icon: Codicon.remote },
			],
			value: this.sshMode,
			ariaLabel: localize('addDevice.sshModeAria', "SSH direction"),
			width: 360,
			onChange: value => {
				this.sshMode = value;
				this.actionError = undefined;
				this.renderForm();
				this.render(true);
				void this.tick();
			},
		}, this.formStore);
		if (this.sshMode === 'forward') {
			return;
		}
		const input = (control: HTMLElement, label: string, value: string, placeholder: string, set: (value: string) => void) => {
			const box = this.formStore.add(new InputBox(append(control, $('.volt-add-device-input')), this.contextView, { placeholder, ariaLabel: label, inputBoxStyles: defaultInputBoxStyles }));
			box.value = value;
			this.formStore.add(box.onDidChange(next => set(next)));
			return box;
		};
		const serverControl = field(localize('addDevice.sshServer', "Server"));
		const server = input(serverControl, localize('addDevice.sshServer', "Server"), this.ssh.target, 'you@server.example.com', value => this.ssh.target = value);
		const hosts = this.status?.sshHosts ?? [];
		if (hosts.length) {
			createVoltDropdown<string>(serverControl, this.contextView, {
				options: [{ id: '', label: localize('addDevice.sshSaved', "Saved") }, ...hosts.map(host => ({ id: host, label: host, icon: Codicon.server }))],
				value: '',
				ariaLabel: localize('addDevice.sshSavedAria', "Pick a host from ~/.ssh/config"),
				align: 'right',
				width: 240,
				onChange: host => {
					if (host) {
						this.ssh.target = host;
						server.value = host;
					}
				},
			}, this.formStore);
		}
		const pair = field(localize('addDevice.sshPort', "Server port"));
		pair.classList.add('pair');
		input(pair, localize('addDevice.sshPort', "Server port"), this.ssh.remotePort, String(DEFAULT_SSH_PORT), value => this.ssh.remotePort = value.replace(/\D/g, ''));
		input(pair, localize('addDevice.sshPublic', "Public address"), this.ssh.publicUrl, localize('addDevice.sshPublicPlaceholder', "Public URL (optional)"), value => this.ssh.publicUrl = value);
	}

	/** Paints what changed: the left panel, the steps and the link (the list and the form keep themselves). */
	private render(force = false): void {
		if (this.closed) {
			return;
		}
		const view = this.withProgress(this.view());
		const link = this.linkFor(this.code);
		const key = JSON.stringify([this.kind, this.sshMode, view, link, this.code?.code, this.paired?.id, this.copied, [...this.revealed]]);
		if (!force && key === this.rendered) {
			return;
		}
		this.rendered = key;
		this.renderStore.clear();
		this.renderHero(view, link);
		this.renderSteps(view);
		this.renderLink(link);
		this.renderActions();
	}

	/** The step being worked on shows what is running, or what went wrong; a paired device ticks off the last one. */
	private withProgress(view: IView): IView {
		const steps = view.steps.map(step => {
			if (this.paired) {
				return step.waits
					? { ...step, state: 'done' as const, title: localize('addDevice.pairedTitle', "{0} paired", this.paired.label), doneDetail: localize('addDevice.pairedDetail', "It has its own key. Rename or remove it in Settings > Devices.") }
					: { ...step, state: 'done' as const };
			}
			if (step.state !== 'current' && step.state !== 'error') {
				return step;
			}
			if (this.busy) {
				return { ...step, state: 'current' as const, error: undefined, working: this.busy };
			}
			if (this.actionError) {
				return { ...step, state: 'error' as const, error: this.actionError };
			}
			return step;
		});
		return { ...view, steps };
	}

	private renderHero(view: IView, link: string | undefined): void {
		const stage = this.heroStage;
		clearNode(stage);
		stage.classList.toggle('paired', !!this.paired);
		if (this.paired) {
			append(stage, $('.paired-mark')).appendChild(renderIcon(Codicon.check));
			append(stage, $('.paired-name')).textContent = this.paired.label;
			append(stage, $('.paired-detail')).textContent = localize('addDevice.pairedJustNow', "{0} · Paired just now", kindLabel(this.paired));
			return;
		}
		const forward = this.kind === 'ssh' && this.sshMode === 'forward';
		const showQr = !!link && !forward;
		const tile = append(stage, $('.qr-tile'));
		if (showQr) {
			renderQrCode(tile, link!, QR_SIZE, true);
		} else {
			tile.classList.add('placeholder');
			append(tile, $('.ghost'));
			const icon = forward ? Codicon.terminal : view.steps.some(step => step.working) ? SPIN : Codicon.lock;
			append(tile, $('.badge')).appendChild(renderIcon(icon));
		}
		const caption = append(stage, $('.caption'));
		if (showQr) {
			append(caption, $('span.live-dot'));
		}
		append(caption, $('span')).textContent = showQr
			? localize('addDevice.heroScan', "Scan with your phone's camera")
			: forward && link
				? localize('addDevice.heroForward', "Open the link on the other computer")
				: localize('addDevice.heroSteps', "Finish the steps to get a code");
		const code = this.code;
		if (code && link) {
			const codeBlock = append(stage, $('.hero-code'));
			append(codeBlock, $('.hero-code-label')).textContent = localize('addDevice.orCode', "Or enter the code");
			append(codeBlock, $('.hero-code-value')).textContent = code.code.replace(/(.{4})(?=.)/g, '$1 ');
			append(codeBlock, $('.expiry'));
			this.updateExpiry();
		}
	}

	private renderSteps(view: IView): void {
		const list = this.steps;
		clearNode(list);
		view.steps.forEach((step, index) => {
			const item = append(list, $(`li.step.${step.state}`));
			const marker = append(item, $('span.step-marker'));
			if (step.state === 'done') {
				marker.appendChild(renderIcon(Codicon.check));
			} else if (step.state === 'current' && (step.working || (step.waits && !this.paired && this.linkFor(this.code)))) {
				marker.appendChild(renderIcon(SPIN));
			} else if (step.state === 'error') {
				marker.textContent = '!';
			} else {
				marker.textContent = String(index + 1);
			}
			const body = append(item, $('.step-body'));
			append(body, $('.step-title')).textContent = step.title;
			const detail = step.state === 'done' ? step.doneDetail
				: step.state === 'error' ? step.error
					: step.state === 'current' ? (step.working ?? (step.waits && this.linkFor(this.code) ? localize('addDevice.waiting', "Waiting for a device…") : step.detail))
						: undefined;
			const secrets = this.secrets();
			if (detail) {
				appendPrivateText(append(body, $('.step-detail')), detail, secrets);
			}
			if (step.state === 'current' && step.waits && step.detail && this.linkFor(this.code)) {
				appendPrivateText(append(body, $('.step-detail')), step.detail, secrets);
			}
			if (step.state === 'done' && step.warning) {
				const warning = append(body, $('.step-warning'));
				warning.appendChild(renderIcon(Codicon.warning));
				appendPrivateText(append(warning, $('span')), step.warning, secrets);
			}
			if ((step.state === 'current' || step.state === 'error') && step.command) {
				this.renderSecretField(append(body, $('.step-command')), 'command', step.command, Codicon.terminal, localize('addDevice.copy', "Copy"));
			}
			const actions = step.state === 'done' ? step.doneActions : (step.state === 'current' || step.state === 'error') && !step.working ? step.actions : undefined;
			if (actions?.length && !this.paired) {
				const host = append(step.state === 'done' ? item : body, $(step.state === 'done' ? '.step-side' : '.step-actions'));
				for (const action of actions) {
					const button = this.renderStore.add(createVoltButton(host, action.kind ?? 'secondary'));
					button.label = action.label;
					this.renderStore.add(button.onDidClick(() => void action.run()));
				}
			}
		});
	}

	private renderLink(link: string | undefined): void {
		clearNode(this.link);
		const show = !!link && !!this.code && !this.paired;
		this.link.classList.toggle('empty', !show);
		if (!show) {
			return;
		}
		this.renderSecretField(append(this.link, $('.link-box')), 'link', link!, Codicon.link, localize('addDevice.copyLink', "Copy Link"));
	}

	/** Addresses, host names and the account: blurred in the steps until hovered. */
	private secrets(): string[] {
		const status = this.status;
		if (!status) {
			return [];
		}
		const hosts = status.tunnels.flatMap(tunnel => [tunnel.url?.replace(/^https?:\/\//, ''), tunnel.ssh?.target, tunnel.ssh?.publicUrl?.replace(/^https?:\/\//, '')]);
		return [status.lanAddress, status.tailscale.ip, status.tailscale.dnsName, status.tailscale.tailnet, status.hostname, this.ssh.target.trim(), ...hosts]
			.filter((value): value is string => !!value);
	}

	/**
	 * A value to copy (the pairing link, the ssh command), shown as dots like a password until its
	 * eye is clicked. Copying works either way.
	 */
	private renderSecretField(box: HTMLElement, id: 'link' | 'command', value: string, icon: ThemeIcon, copyLabel: string): void {
		box.classList.add('volt-secret-field');
		const shown = this.revealed.has(id);
		append(box, $('span.secret-icon')).appendChild(renderIcon(icon));
		const text = append(box, $('span.secret-value'));
		text.classList.toggle('masked', !shown);
		text.textContent = shown ? value : '•'.repeat(Math.min(value.length, 32));
		text.title = shown ? value : '';
		const eye = append(box, $('button.secret-eye')) as HTMLButtonElement;
		eye.type = 'button';
		const eyeLabel = shown ? localize('addDevice.hide', "Hide") : localize('addDevice.show', "Show");
		eye.title = eyeLabel;
		eye.setAttribute('aria-label', eyeLabel);
		eye.setAttribute('aria-pressed', String(shown));
		eye.appendChild(renderIcon(shown ? Codicon.eyeClosed : Codicon.eye));
		this.renderStore.add(addDisposableListener(eye, EventType.CLICK, () => {
			if (shown) {
				this.revealed.delete(id);
			} else {
				this.revealed.add(id);
			}
			this.render();
		}));
		const copy = this.renderStore.add(createVoltButton(box, 'secondary'));
		copy.label = this.copied === id ? localize('addDevice.copied', "Copied") : copyLabel;
		this.renderStore.add(copy.onDidClick(async () => {
			await this.clipboard.writeText(value);
			this.copied = id;
			this.render();
			const timer = this.modal.window.setTimeout(() => {
				this.copied = false;
				this.render();
			}, 1600);
			this.renderStore.add(toDisposable(() => this.modal.window.clearTimeout(timer)));
		}));
	}

	private updateExpiry(): void {
		const expiry = this.heroStage.querySelector<HTMLElement>('.expiry');
		const code = this.code;
		if (!expiry || !code) {
			return;
		}
		const left = Math.max(0, code.expiresAt - Date.now());
		const minutes = Math.floor(left / 60_000);
		const seconds = Math.floor((left % 60_000) / 1000);
		expiry.textContent = left ? localize('addDevice.expires', "Expires in {0}:{1}", minutes, String(seconds).padStart(2, '0')) : localize('addDevice.renewing', "Making a new code…");
	}

	private renderActions(): void {
		clearNode(this.actions);
		append(this.actions, $('span.footnote')).textContent = localize('addDevice.footnote', "Each device gets its own key. Codes work once.");
		if (this.paired) {
			const another = this.renderStore.add(createVoltButton(this.actions, 'secondary'));
			another.label = localize('addDevice.another', "Add Another");
			this.renderStore.add(another.onDidClick(() => {
				this.known?.add(this.paired!.id);
				this.paired = undefined;
				this.render(true);
				void this.tick();
			}));
		}
		const done = this.renderStore.add(createVoltButton(this.actions, this.paired ? 'primary' : 'secondary'));
		done.label = localize('addDevice.done', "Done");
		this.renderStore.add(done.onDidClick(() => this.modal.close()));
	}
}
