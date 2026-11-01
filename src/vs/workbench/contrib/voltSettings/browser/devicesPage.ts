/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/devicesPage.css';
import { $, append } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { fromNow } from '../../../../base/common/date.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IVoltPairedDevice, IVoltPairingCode } from '../../../../platform/voltAgentServer/common/protocol.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IAgentServerClientService } from '../../../services/voltAgentServer/common/agentServerClient.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { qrcode } from './vendor/qrcode.js';

export interface IDevicesPageHost {
	readonly store: DisposableStore;
	target(): HTMLElement;
	sectionLabel(label: string): void;
	settingsGroup(): HTMLElement;
	settingRow(parent: HTMLElement, title: string, desc: string | undefined, renderControl?: (host: HTMLElement) => void): HTMLElement;
	empty(text: string): void;
	rerender(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A QR code as one SVG path, black on a white tile with a quiet zone (any camera, or Volt's phone app). */
function renderQrCode(parent: HTMLElement, value: string, size: number): void {
	const qr = qrcode(0, 'M');
	qr.addData(value);
	qr.make();
	const count = qr.getModuleCount();
	let d = '';
	for (let row = 0; row < count; row++) {
		for (let col = 0; col < count; col++) {
			if (qr.isDark(row, col)) {
				d += `M${col} ${row}h1v1h-1z`;
			}
		}
	}
	const quiet = 2;
	const svg = mainWindow.document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('viewBox', `${-quiet} ${-quiet} ${count + quiet * 2} ${count + quiet * 2}`);
	svg.setAttribute('shape-rendering', 'crispEdges');
	svg.setAttribute('role', 'img');
	svg.setAttribute('aria-label', localize('devices.qr', "Pairing QR code"));
	const tile = mainWindow.document.createElementNS(SVG_NS, 'rect');
	tile.setAttribute('x', String(-quiet));
	tile.setAttribute('y', String(-quiet));
	tile.setAttribute('width', String(count + quiet * 2));
	tile.setAttribute('height', String(count + quiet * 2));
	tile.setAttribute('rx', '2');
	tile.setAttribute('fill', '#fff');
	const path = mainWindow.document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', d);
	path.setAttribute('fill', '#111');
	svg.append(tile, path);
	append(parent, svg);
}

function kindLabel(device: IVoltPairedDevice): string {
	const kind = device.kind === 'web' ? localize('devices.kindWeb', "Browser") : device.kind === 'tablet' ? localize('devices.kindTablet', "Tablet") : localize('devices.kindPhone', "Phone");
	return [kind, device.model, device.os].filter(Boolean).join(' · ');
}

/**
 * Volt Settings > Devices: pair a phone or a browser with a one-time code (typed, scanned from the
 * QR code, or opened as a link), and see, rename or remove the devices that can reach this
 * computer's agents. It talks to the agent server, so it works the same on the desktop and in the
 * browser workbench; making codes is for the computer's owner, a paired device sees the list.
 */
export class DevicesPage {

	private readonly client: IAgentServerClientService | undefined;
	private readonly clipboard: IClipboardService;
	private readonly dialogs: IDialogService;
	private readonly quickInput: IQuickInputService;
	/** The code on screen, kept across renders until it expires. */
	private code: IVoltPairingCode | undefined;
	private codeError: string | undefined;

	constructor(instantiationService: IInstantiationService, private readonly host: IDevicesPageHost) {
		const services = instantiationService.invokeFunction(accessor => ({
			client: accessor.getIfExists(IAgentServerClientService),
			clipboard: accessor.get(IClipboardService),
			dialogs: accessor.get(IDialogService),
			quickInput: accessor.get(IQuickInputService),
		}));
		this.client = services.client;
		this.clipboard = services.clipboard;
		this.dialogs = services.dialogs;
		this.quickInput = services.quickInput;
	}

	async render(isCurrent: () => boolean): Promise<void> {
		const client = this.client;
		if (!client) {
			this.host.empty(localize('devices.noServer', "Pairing runs through Volt's agent server. Run Volt: Pair a Phone or Browser… to turn it on."));
			return;
		}
		let devices: readonly IVoltPairedDevice[] = [];
		let listError: string | undefined;
		try {
			await client.whenReady;
			devices = await client.call<readonly IVoltPairedDevice[]>('pairing.devices');
		} catch (err) {
			listError = toErrorMessage(err);
		}
		if (!isCurrent()) {
			return;
		}
		this.renderPairing(client);
		this.renderDevices(client, devices, listError);
	}

	private renderPairing(client: IAgentServerClientService): void {
		const { host } = this;
		host.sectionLabel(localize('devices.pair', "Pair a phone or browser"));
		const group = host.settingsGroup();
		const code = this.code && this.code.expiresAt > Date.now() ? this.code : undefined;
		host.settingRow(
			group,
			localize('devices.code', "Pairing code"),
			code
				? localize('devices.codeDesc', "Scan the QR code with Volt on your phone or any camera, open a link on the device, or type the code where Volt asks for it. It works once.")
				: localize('devices.codeNone', "A one-time code lets a phone or another browser reach your chats, files and terminals here. Each device gets its own key, which you can remove below."),
			control => {
				const make = host.store.add(createVoltButton(control, code ? 'secondary' : 'primary'));
				make.label = code ? localize('devices.newCode', "New Code") : localize('devices.makeCode', "Make a Code");
				host.store.add(make.onDidClick(async () => {
					make.enabled = false;
					try {
						this.code = await client.call<IVoltPairingCode>('pairing.createCode');
						this.codeError = undefined;
					} catch (err) {
						this.codeError = toErrorMessage(err);
					}
					host.rerender();
				}));
			},
		);
		if (this.codeError) {
			append(host.target(), $('.volt-devices-error')).textContent = this.codeError;
		}
		if (!code) {
			return;
		}
		const card = append(host.target(), $('.volt-devices-code-card'));
		const best = code.urls.find(u => u.kind !== 'loopback') ?? code.urls[0];
		if (best) {
			renderQrCode(append(card, $('.volt-devices-qr')), best.url, 168);
		}
		const side = append(card, $('.volt-devices-code-side'));
		append(side, $('.volt-devices-code')).textContent = code.code.replace(/(.{4})(?=.)/g, '$1 ');
		const expiry = append(side, $('.volt-devices-expiry'));
		const tick = () => {
			const left = Math.max(0, code.expiresAt - Date.now());
			if (!left) {
				host.rerender();
				return;
			}
			const minutes = Math.floor(left / 60_000);
			const seconds = Math.floor((left % 60_000) / 1000);
			expiry.textContent = localize('devices.expires', "Expires in {0}:{1}", minutes, String(seconds).padStart(2, '0'));
		};
		tick();
		const timer = mainWindow.setInterval(tick, 1000);
		host.store.add(toDisposable(() => mainWindow.clearInterval(timer)));
		if (!code.network) {
			append(side, $('.volt-devices-note')).textContent = localize('devices.loopbackOnly', "Only this computer can reach Volt right now. Allow network access (Volt: Pair a Phone or Browser… on the computer) to pair devices on your Wi-Fi or Tailscale.");
		}
		const links = append(side, $('.volt-devices-links'));
		for (const url of code.urls) {
			const row = append(links, $('.volt-devices-link'));
			append(row, $('span.kind')).textContent = url.kind === 'loopback' ? localize('devices.thisComputer', "This computer") : url.kind === 'tailnet' ? 'Tailscale' : localize('devices.network', "Network");
			append(row, $('span.url')).textContent = url.url;
			const copy = host.store.add(createVoltButton(row, 'secondary'));
			copy.label = localize('devices.copy', "Copy");
			host.store.add(copy.onDidClick(() => void this.clipboard.writeText(url.url)));
		}
	}

	private renderDevices(client: IAgentServerClientService, devices: readonly IVoltPairedDevice[], error: string | undefined): void {
		const { host } = this;
		host.sectionLabel(localize('devices.paired', "Paired devices"));
		if (error) {
			host.empty(error);
			return;
		}
		if (!devices.length) {
			host.empty(localize('devices.none', "No phones or browsers yet."));
			return;
		}
		const group = host.settingsGroup();
		for (const device of devices) {
			const seen = device.connected ? localize('devices.connected', "Connected now") : device.lastSeenAt ? localize('devices.lastSeen', "Last seen {0}", fromNow(device.lastSeenAt, true)) : localize('devices.never', "Not connected yet");
			const title = device.current ? localize('devices.current', "{0} (this one)", device.label) : device.label;
			host.settingRow(group, title, `${kindLabel(device)} · ${seen}`, control => {
				const rename = host.store.add(createVoltButton(control, 'secondary'));
				rename.label = localize('devices.rename', "Rename");
				host.store.add(rename.onDidClick(async () => {
					const label = await this.quickInput.input({ value: device.label, prompt: localize('devices.renamePrompt', "A name for this device") });
					if (label?.trim() && label.trim() !== device.label) {
						await client.call('pairing.rename', device.id, label.trim()).catch(err => this.dialogs.error(toErrorMessage(err)));
						host.rerender();
					}
				}));
				const remove = host.store.add(createVoltButton(control, 'danger'));
				remove.label = device.current ? localize('devices.signOut', "Sign Out") : localize('devices.remove', "Remove");
				host.store.add(remove.onDidClick(async () => {
					const { confirmed } = await this.dialogs.confirm({
						message: device.current ? localize('devices.signOutConfirm', "Sign this browser out of Volt?") : localize('devices.removeConfirm', "Remove {0}?", device.label),
						detail: localize('devices.removeDetail', "It loses access at once. Pair it again with a new code to bring it back."),
						primaryButton: device.current ? localize('devices.signOutButton', "Sign Out") : localize('devices.removeButton', "Remove"),
					});
					if (!confirmed) {
						return;
					}
					await client.call('pairing.revoke', device.id).catch(err => this.dialogs.error(toErrorMessage(err)));
					host.rerender();
				}));
			});
		}
	}
}
