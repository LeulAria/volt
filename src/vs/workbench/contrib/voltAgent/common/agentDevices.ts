/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseSshTarget } from '../../../../platform/voltDevices/common/deviceCommands.js';
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

/** Dragging by (dx, dy) CSS px from `start` turns the device; a full stage width is ~180°. */
export function orbitAfterDrag(start: IOrbit, dx: number, dy: number, stageWidth: number): IOrbit {
	const perPixel = 180 / Math.max(200, stageWidth);
	const clamp = (value: number, max: number) => Math.max(-max, Math.min(max, value));
	return { yaw: clamp(start.yaw + dx * perPixel, MAX_YAW), pitch: clamp(start.pitch - dy * perPixel, MAX_PITCH) };
}

/** The hinge angle drawn for a posture: 0 flat, 180 closed. */
export function hingeAngle(posture: VoltDevicePosture | undefined): number {
	return posture === 'halfOpen' ? 90 : posture === 'folded' ? 180 : 0;
}
