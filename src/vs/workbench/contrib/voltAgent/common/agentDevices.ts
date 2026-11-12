/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, IConfigurationPropertySchema } from '../../../../platform/configuration/common/configurationRegistry.js';
import { isSafeSshUser, parseSshTarget } from '../../../../platform/voltDevices/common/deviceCommands.js';
import { IVoltDevice, IVoltDeviceHost, LOCAL_DEVICE_HOST_ID, VoltDevicePosture } from '../../../../platform/voltDevices/common/voltDevices.js';

/** Machines with simulators that Volt reaches over SSH. */
export const DEVICE_REMOTE_HOSTS_SETTING = 'volt.devices.remoteHosts';

/** One entry of `volt.devices.remoteHosts`. */
export interface IRemoteHostSetting {
	readonly name?: string;
	/** `host`, `user@host`, or `user@host:port`. */
	readonly host?: string;
	readonly user?: string;
	readonly port?: number;
	readonly identityFile?: string;
	readonly androidSdk?: string;
}

export function localDeviceHost(label: string): IVoltDeviceHost {
	return { id: LOCAL_DEVICE_HOST_ID, label };
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
}

/**
 * The setting's schema. Application scope: only the user's own settings may name machines Volt
 * runs ssh and scp against, never a repository's `.vscode/settings.json` (B-36, CFG-1).
 */
export const DEVICE_REMOTE_HOSTS_SCHEMA: IConfigurationPropertySchema = {
	type: 'array',
	default: [],
	scope: ConfigurationScope.APPLICATION,
	markdownDescription: localize('voltDevices.remoteHosts', "Other machines whose iOS simulators and Android emulators Volt (and its agents) can use, reached with `ssh` using keys (no passwords). Each needs Xcode and/or the Android SDK. Example: `[{ \"name\": \"Mac mini\", \"host\": \"me@mac-mini.local\" }]`. Only read from user settings."),
	items: {
		type: 'object',
		properties: {
			name: { type: 'string', description: localize('voltDevices.host.name', "Name shown in Volt.") },
			host: { type: 'string', description: localize('voltDevices.host.host', "host, user@host or user@host:port") },
			user: { type: 'string', pattern: '^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$' },
			port: { type: 'number' },
			identityFile: { type: 'string', description: localize('voltDevices.host.identity', "Private key file (ssh -i), as an absolute path or one under ~/.") },
			androidSdk: { type: 'string', description: localize('voltDevices.host.sdk', "Android SDK folder on that machine, if not ~/Library/Android/sdk or on its PATH.") },
		},
		required: ['host'],
	},
};

/** A private key path ssh takes as a file: absolute or under `~/`, never an option, no control characters. */
export function isSafeIdentityFile(path: string): boolean {
	return /^(?:\/|~\/|[A-Za-z]:[\\/])/.test(path) && !/[\u0000-\u001f\u007f]/.test(path);
}

/** A remote folder for the Android SDK: absolute or under `~/`, no control characters. */
function isSafeRemoteFolder(path: string): boolean {
	return /^(?:\/|~\/)/.test(path) && !/[\u0000-\u001f\u007f]/.test(path);
}

/**
 * The `volt.devices.remoteHosts` value a workspace's own settings file sets, if any (a parsed
 * `.vscode/settings.json` or the `settings` of a `.code-workspace`). Since the setting became
 * application-scoped it is ignored there; Volt shows the user what it would have used (B-AP-5).
 */
export function workspaceRemoteHosts(settings: unknown): unknown[] | undefined {
	const value = settings && typeof settings === 'object' ? (settings as Record<string, unknown>)[DEVICE_REMOTE_HOSTS_SETTING] : undefined;
	return Array.isArray(value) && value.length ? value : undefined;
}

/** Valid entries of the setting, each with a unique id; entries without a usable host are dropped. */
export function parseRemoteHosts(value: unknown): IVoltDeviceHost[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const hosts: IVoltDeviceHost[] = [];
	const ids = new Set<string>([LOCAL_DEVICE_HOST_ID]);
	for (const raw of value) {
		const entry = (typeof raw === 'string' ? { host: raw } : raw) as IRemoteHostSetting | undefined;
		if (!entry || typeof entry.host !== 'string') {
			continue;
		}
		const target = parseSshTarget(entry.host);
		if (!target) {
			continue;
		}
		// A user or key that ssh could read as an option drops the whole entry rather than guess.
		if ((typeof entry.user === 'string' && entry.user && !isSafeSshUser(entry.user))
			|| (typeof entry.identityFile === 'string' && entry.identityFile && !isSafeIdentityFile(entry.identityFile))
			|| (typeof entry.androidSdk === 'string' && entry.androidSdk && !isSafeRemoteFolder(entry.androidSdk))) {
			continue;
		}
		const user = typeof entry.user === 'string' && entry.user ? entry.user : target.user;
		const port = typeof entry.port === 'number' && entry.port > 0 && entry.port < 65536 ? entry.port : target.port;
		const label = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : target.host;
		let id = `ssh:${slug(label)}`;
		for (let n = 2; ids.has(id); n++) {
			id = `ssh:${slug(label)}-${n}`;
		}
		ids.add(id);
		hosts.push({
			id,
			label,
			ssh: { host: target.host, user, port, identityFile: typeof entry.identityFile === 'string' && entry.identityFile ? entry.identityFile : undefined },
			androidSdk: typeof entry.androidSdk === 'string' && entry.androidSdk ? entry.androidSdk : undefined,
		});
	}
	return hosts;
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

/** A host by id or label (case-insensitive). */
export function findHost(hosts: readonly IVoltDeviceHost[], query: string | undefined): IVoltDeviceHost | undefined {
	if (!query?.trim()) {
		return undefined;
	}
	const wanted = normalize(query);
	return hosts.find(host => host.id === query) ?? hosts.find(host => normalize(host.label) === wanted || normalize(host.ssh?.host ?? '') === wanted);
}

export type DeviceMatch =
	| { readonly kind: 'found'; readonly device: IVoltDevice }
	| { readonly kind: 'none' }
	| { readonly kind: 'ambiguous'; readonly candidates: readonly IVoltDevice[] };

/**
 * The device a tool call means: exact id, then exact name, then a name that contains the query.
 * Among several, the booted one wins; otherwise it is ambiguous. Without a query: the only booted device.
 */
export function findDevice(devices: readonly IVoltDevice[], query: string | undefined): DeviceMatch {
	const pick = (candidates: readonly IVoltDevice[]): DeviceMatch => {
		if (candidates.length === 1) {
			return { kind: 'found', device: candidates[0] };
		}
		const booted = candidates.filter(device => device.state === 'booted');
		if (booted.length === 1) {
			return { kind: 'found', device: booted[0] };
		}
		return candidates.length ? { kind: 'ambiguous', candidates } : { kind: 'none' };
	};
	if (!query?.trim()) {
		return pick(devices.filter(device => device.state === 'booted'));
	}
	const exactId = devices.filter(device => device.id === query.trim() || device.serial === query.trim());
	if (exactId.length) {
		return pick(exactId);
	}
	const wanted = normalize(query);
	const byName = devices.filter(device => normalize(device.name) === wanted);
	if (byName.length) {
		return pick(byName);
	}
	return pick(devices.filter(device => normalize(device.name).includes(wanted) || normalize(device.id).includes(wanted)));
}

/** `iPhone 16 · iOS 18.5 · booted` for lists the model reads. */
export function describeDevice(device: IVoltDevice, hostLabel: string): string {
	const parts = [device.platform === 'ios' ? 'iOS simulator' : device.kind === 'emulator' ? 'Android emulator' : 'Android device', device.runtime, device.state, device.foldable ? 'foldable' : undefined, `on ${hostLabel}`];
	return `- ${device.name} (id: ${device.id}) · ${parts.filter(Boolean).join(' · ')}`;
}

export function postureLabel(posture: VoltDevicePosture): string {
	return posture === 'halfOpen' ? 'Half open' : posture === 'folded' ? 'Folded' : 'Open';
}

/** How the 3D view turns a device: degrees around the vertical (yaw) and horizontal (pitch) axes. */
export interface IOrbit {
	readonly yaw: number;
	readonly pitch: number;
}

export const DEFAULT_ORBIT: IOrbit = { yaw: -22, pitch: 10 };
const MAX_YAW = 70;
const MAX_PITCH = 45;

/** Dragging by (dx, dy) CSS px from `start` turns the device; a full stage width is ~180 degrees. */
export function orbitAfterDrag(start: IOrbit, dx: number, dy: number, stageWidth: number): IOrbit {
	const perPixel = 180 / Math.max(200, stageWidth);
	const clamp = (value: number, max: number) => Math.max(-max, Math.min(max, value));
	return { yaw: clamp(start.yaw + dx * perPixel, MAX_YAW), pitch: clamp(start.pitch - dy * perPixel, MAX_PITCH) };
}

/** The hinge angle drawn for a posture: 0 flat, 180 closed. */
export function hingeAngle(posture: VoltDevicePosture | undefined): number {
	return posture === 'halfOpen' ? 90 : posture === 'folded' ? 180 : 0;
}
