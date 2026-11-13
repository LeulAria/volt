/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../../base/common/date.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IVoltConnectStatus, IVoltPairedDevice, IVoltTunnelStatus } from '../../../../platform/voltAgentServer/common/protocol.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IAgentServerClientService } from '../../../services/voltAgentServer/common/agentServerClient.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { IDevicesPage, IDevicesPageHost, VoltConnectionKind } from '../common/voltRemoteDevices.js';
import { kindLabel, showAddDeviceModal } from './addDeviceModal.js';

/** Desktop only (electron-browser): stops listening on the network. */
const STOP_NETWORK_COMMAND_ID = 'volt.agentServer.stopNetwork';

/**
 * Volt Settings > Devices: add a phone or browser (Add Device picks how it connects and shows the
 * QR code), see which ways in are on, and rename or remove the devices that can reach this
 * computer's agents. It talks to the agent server, so it works the same on the desktop and in the
 * browser workbench; connecting devices is for the computer's owner, a paired device sees the list.
 */
export class DevicesPage implements IDevicesPage {

	private readonly client: IAgentServerClientService | undefined;
	private readonly dialogs: IDialogService;
	private readonly quickInput: IQuickInputService;
	private readonly commands: ICommandService;
	private readonly layout: ILayoutService;
	/** Add Device opens on the next render (Remote Control's introduction asks for it). */
	private pendingAdd: VoltConnectionKind | true | undefined;
	private modalOpen = false;

	constructor(private readonly instantiationService: IInstantiationService, private readonly host: IDevicesPageHost) {
		const services = instantiationService.invokeFunction(accessor => ({
			client: accessor.getIfExists(IAgentServerClientService),
			dialogs: accessor.get(IDialogService),
			quickInput: accessor.get(IQuickInputService),
			commands: accessor.get(ICommandService),
			layout: accessor.get(ILayoutService),
		}));
		this.client = services.client;
		this.dialogs = services.dialogs;
		this.quickInput = services.quickInput;
		this.commands = services.commands;
		this.layout = services.layout;
	}

	/** Opens Add Device once the page is on screen. */
	requestAddDevice(kind?: VoltConnectionKind): void {
		this.pendingAdd = kind ?? true;
	}

	async render(isCurrent: () => boolean): Promise<void> {
		const client = this.client;
		if (!client) {
			this.host.empty(localize('devices.noServer', "Pairing runs through Volt's agent server. Run Volt: Pair a Phone or Browser… to turn it on."));
			return;
		}
		let devices: readonly IVoltPairedDevice[] = [];
		let listError: string | undefined;
		let status: IVoltConnectStatus | undefined;
		try {
			await client.whenReady;
			[devices, status] = await Promise.all([
				client.call<readonly IVoltPairedDevice[]>('pairing.devices'),
				// Only the computer's owner may connect devices; others get an error here and see the list.
				client.call<IVoltConnectStatus>('connect.status').catch(() => undefined),
			]);
		} catch (err) {
			listError = toErrorMessage(err);
		}
		if (!isCurrent()) {
			return;
		}
		if (status) {
			this.renderConnect();
			this.renderConnections(client, status);
		}
		this.renderDevices(client, devices, listError);
		if (this.pendingAdd && status) {
			const kind = this.pendingAdd === true ? undefined : this.pendingAdd;
			this.pendingAdd = undefined;
			this.openAddDevice(kind);
		}
	}

	private openAddDevice(kind?: VoltConnectionKind): void {
		if (this.modalOpen) {
			return;
		}
		this.modalOpen = true;
		showAddDeviceModal(this.layout.activeContainer, this.instantiationService, {
			kind,
			onDidPair: () => this.host.rerender(),
			onDidClose: () => {
				this.modalOpen = false;
				this.host.rerender();
			},
		});
	}

	private renderConnect(): void {
		const { host } = this;
		host.sectionLabel(localize('devices.connect', "Connect"));
		const group = host.settingsGroup();
		host.settingRow(
			group,
			localize('devices.add', "Add a phone or browser"),
			localize('devices.addDesc', "Scan a QR code with your phone or open a link in any browser. Connect over this Wi-Fi, Tailscale, a Cloudflare tunnel or SSH."),
			control => {
				const add = host.store.add(createVoltButton(control, 'primary'));
				add.label = localize('devices.addButton', "Add Device");
				host.store.add(add.onDidClick(() => this.openAddDevice()));
			},
		);
	}

	private renderConnections(client: IAgentServerClientService, status: IVoltConnectStatus): void {
		const { host } = this;
		host.sectionLabel(localize('devices.connections', "Connections"));
		const group = host.settingsGroup();
		const setUp = (control: HTMLElement, kind: VoltConnectionKind, label = localize('devices.setUp', "Set Up")) => {
			const button = host.store.add(createVoltButton(control, 'secondary'));
			button.label = label;
			host.store.add(button.onDidClick(() => this.openAddDevice(kind)));
		};

		const wifi = status.network
			? localize('devices.wifiOn', "On. Devices on this network reach {0}.", status.lanAddress ? `${status.lanAddress}:${status.port}` : localize('devices.thisComputer', "this computer"))
			: localize('devices.wifiOff', "Off. Volt only listens on this computer.");
		host.settingRow(group, localize('devices.wifi', "Same Wi-Fi"), wifi, control => {
			if (status.network && CommandsRegistry.getCommand(STOP_NETWORK_COMMAND_ID)) {
				const off = host.store.add(createVoltButton(control, 'secondary'));
				off.label = localize('devices.turnOff', "Turn Off");
				host.store.add(off.onDidClick(async () => {
					const { confirmed } = await this.dialogs.confirm({
						message: localize('devices.wifiOffConfirm', "Stop listening on your network?"),
						detail: localize('devices.wifiOffDetail', "Devices on Wi-Fi and Tailscale lose their connection until you allow it again. Tunnels keep working. Volt's server restarts; running chats pause and can be resumed."),
						primaryButton: localize('devices.turnOffButton', "Turn Off"),
					});
					if (confirmed) {
						await this.commands.executeCommand(STOP_NETWORK_COMMAND_ID);
						await client.whenReady;
						host.rerender();
					}
				}));
			} else {
				setUp(control, 'lan');
			}
		});

		const tailscale = status.tailscale;
		const tailscaleText = !tailscale.installed
			? localize('devices.tsMissing', "Not installed on this computer.")
			: !tailscale.running
				? localize('devices.tsOff', "Installed, not connected.")
				: status.network
					? localize('devices.tsOn', "On. Your tailnet reaches {0}.", tailscale.dnsName ?? tailscale.ip ?? '')
					: localize('devices.tsReady', "Connected as {0}. Allow tailnet connections to use it.", tailscale.dnsName ?? tailscale.ip ?? '');
		host.settingRow(group, 'Tailscale', tailscaleText, control => setUp(control, 'tailscale'));

		for (const tunnel of status.tunnels) {
			const title = tunnel.kind === 'cloudflare' ? localize('devices.cloudflare', "Cloudflare Tunnel") : localize('devices.ssh', "SSH Tunnel");
			host.settingRow(group, title, this.tunnelText(tunnel, status), control => {
				if (tunnel.state === 'off') {
					setUp(control, tunnel.kind);
					return;
				}
				if (tunnel.state === 'error') {
					setUp(control, tunnel.kind, localize('devices.fix', "Fix"));
				}
				const stop = host.store.add(createVoltButton(control, 'secondary'));
				stop.label = localize('devices.stop', "Stop");
				host.store.add(stop.onDidClick(async () => {
					await client.call('connect.stop', tunnel.kind).catch(err => this.dialogs.error(toErrorMessage(err)));
					host.rerender();
				}));
			});
		}
	}

	private tunnelText(tunnel: IVoltTunnelStatus, status: IVoltConnectStatus): string {
		switch (tunnel.state) {
			case 'on':
				return tunnel.reachable === false && tunnel.note
					? localize('devices.tunnelOnWarn', "On at {0}. {1}", tunnel.url ?? '', tunnel.note)
					: localize('devices.tunnelOn', "On at {0}.", tunnel.url ?? '');
			case 'starting':
				return tunnel.note ?? localize('devices.tunnelStarting', "Starting…");
			case 'error':
				return tunnel.error ?? localize('devices.tunnelError', "Stopped with an error.");
			default:
				return tunnel.kind === 'cloudflare'
					? status.cloudflared.installed
						? localize('devices.cfOff', "Off. An https link from anywhere, no account needed.")
						: localize('devices.cfMissing', "Off. Needs cloudflared, which Add Device can install.")
					: tunnel.ssh
						? localize('devices.sshOffLast', "Off. Last used with {0}.", tunnel.ssh.target)
						: localize('devices.sshOff', "Off. Reach this computer through a server you can SSH into.");
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
