/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltDevice, IVoltSshTarget, VoltDeviceButton, VoltDevicePosture, VoltDeviceState } from './voltDevices.js';

/** A program and its arguments, run without a shell. */
export interface ICommand {
	readonly file: string;
	readonly args: readonly string[];
}

//#region Shell and SSH

/** POSIX single quotes; `'` becomes `'\''`. Also safe in fish, which reads `\'` outside quotes as a quote. */
export function shellQuote(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellJoin(argv: readonly string[]): string {
	return argv.map(shellQuote).join(' ');
}

/**
 * Where SSH sessions look for the tools: a non-interactive shell has a short PATH, without
 * Homebrew or the Android SDK.
 */
const REMOTE_PATH = '$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/Library/Android/sdk/platform-tools:$HOME/Library/Android/sdk/emulator:$HOME/Android/Sdk/platform-tools:$HOME/Android/Sdk/emulator';

/** A script for the remote machine: run by `sh` whatever the user's login shell is, with the tools on PATH. */
export function remoteScript(script: string, androidSdk?: string): string {
	const sdk = androidSdk ? `${shellQuote(`${androidSdk}/platform-tools`)}:${shellQuote(`${androidSdk}/emulator`)}:` : '';
	return `sh -c ${shellQuote(`PATH=${sdk}${REMOTE_PATH}; export PATH; ${script}`)}`;
}

function sshDestination(target: IVoltSshTarget): string {
	return target.user ? `${target.user}@${target.host}` : target.host;
}

/** `user@host`, `host`, `host:2222` or `user@host:2222` into a target. Undefined when it is not one. */
export function parseSshTarget(value: string): IVoltSshTarget | undefined {
	const match = /^(?:([^@\s:]+)@)?([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?$/.exec(value.trim());
	if (!match) {
		return undefined;
	}
	const port = match[3] ? Number(match[3]) : undefined;
	if (port !== undefined && (port < 1 || port > 65535)) {
		return undefined;
	}
	return { host: match[2].replace(/^\[|\]$/g, ''), user: match[1] || undefined, port };
}

/** Never prompts (keys or an agent only), gives up fast on a dead host, and keeps the connection warm for the next call. */
function sshOptions(target: IVoltSshTarget): string[] {
	const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/volt-ssh-%C', '-o', 'ControlPersist=60'];
	if (target.identityFile) {
		args.push('-i', target.identityFile);
	}
	return args;
}

/** `ssh … host -- <command>`: the command string is run by the remote login shell. */
export function sshCommand(target: IVoltSshTarget, remoteCommand: string): ICommand {
	const args = sshOptions(target);
	if (target.port) {
		args.push('-p', String(target.port));
	}
	args.push(sshDestination(target), '--', remoteCommand);
	return { file: 'ssh', args };
}

/** Copies a local file or folder (`.app` bundles are folders) to the remote path. */
export function scpCommand(target: IVoltSshTarget, localPath: string, remotePath: string): ICommand {
	const args = ['-r', '-q', ...sshOptions(target)];
	if (target.port) {
		args.push('-P', String(target.port));
	}
	// scp hands the remote path to the remote shell, so it is quoted for that shell.
	args.push(localPath, `${sshDestination(target)}:${shellQuote(remotePath)}`);
	return { file: 'scp', args };
}

//#endregion

//#region iOS simulators

interface ISimctlDevice {
	readonly udid?: string;
	readonly name?: string;
	readonly state?: string;
	readonly isAvailable?: boolean;
	readonly deviceTypeIdentifier?: string;
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-18-5` → `iOS 18.5`. */
export function simRuntimeLabel(key: string): string {
	const tail = key.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '');
	const match = /^([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(tail);
	return match ? `${match[1]} ${match[2].replace(/-/g, '.')}` : tail;
}

function simState(state: string | undefined): VoltDeviceState {
	switch (state) {
		case 'Booted': return 'booted';
		case 'Booting': return 'booting';
		case 'Shutdown': return 'shutdown';
		case 'Shutting Down': return 'shutdown';
		default: return 'unknown';
	}
}

/** Phones and tablets from `xcrun simctl list devices --json`; watches, TVs and headsets are left out. */
export function parseSimctlDevices(json: string, hostId: string): IVoltDevice[] {
	let parsed: { devices?: Record<string, ISimctlDevice[]> };
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	const devices: IVoltDevice[] = [];
	for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
		if (!/SimRuntime\.(iOS|iPadOS)-/.test(runtime) || !Array.isArray(list)) {
			continue;
		}
		for (const device of list) {
			if (!device.udid || !device.name || device.isAvailable === false) {
				continue;
			}
			devices.push({
				hostId,
				platform: 'ios',
				id: device.udid,
				name: device.name,
				kind: 'simulator',
				state: simState(device.state),
				runtime: simRuntimeLabel(runtime),
				model: device.deviceTypeIdentifier?.replace(/^com\.apple\.CoreSimulator\.SimDeviceType\./, ''),
			});
		}
	}
	// Booted first, then newest runtime, then by name.
	return devices.sort((a, b) => Number(b.state === 'booted') - Number(a.state === 'booted')
		|| (b.runtime ?? '').localeCompare(a.runtime ?? '', undefined, { numeric: true })
		|| a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** The main screen's pixel size and UI scale from `xcrun simctl io <udid> enumerate`. */
export function parseSimctlScreen(output: string): { width: number; height: number; scale: number } | undefined {
	const blocks = output.split(/\n(?=\s*\(\d+\)\s)/);
	const main = blocks.find(block => /Screen Type:\s*Integrated/.test(block) || /Unique ID:\s*PurpleMain/.test(block));
	if (!main) {
		return undefined;
	}
	const size = /Pixel Size:\s*\{(\d+),\s*(\d+)\}/.exec(main);
	const scale = /Preferred UI Scale:\s*(\d+(?:\.\d+)?)/.exec(main);
	if (!size) {
		return undefined;
	}
	return { width: Number(size[1]), height: Number(size[2]), scale: scale ? Number(scale[1]) : 1 };
}

export function simctl(...args: string[]): ICommand {
	return { file: 'xcrun', args: ['simctl', ...args] };
}

/** `simctl boot` on a booted device: already where we want it. */
export function isAlreadyBooted(stderr: string): boolean {
	return /current state: Booted/i.test(stderr);
}

export function isAlreadyShutdown(stderr: string): boolean {
	return /current state: Shutdown/i.test(stderr);
}

/**
 * simctl has no touch input. AXe (`brew install cameroncooke/axe/axe`) and Meta's idb send real
 * touches and keys to a simulator; Volt uses whichever is installed.
 */
export type IosInputTool = 'axe' | 'idb';

/** HID usage codes for keys the tools send by number. */
const HID_ENTER = 40;
const HID_BACKSPACE = 42;

export function iosInputCommand(tool: IosInputTool, udid: string, input: { kind: 'tap'; x: number; y: number } | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs?: number } | { kind: 'type'; text: string } | { kind: 'button'; button: VoltDeviceButton }): ICommand {
	const r = (value: number) => String(Math.round(value));
	if (tool === 'axe') {
		switch (input.kind) {
			case 'tap':
				return { file: 'axe', args: ['tap', '-x', r(input.x), '-y', r(input.y), '--udid', udid] };
			case 'swipe': {
				const args = ['swipe', '--start-x', r(input.x1), '--start-y', r(input.y1), '--end-x', r(input.x2), '--end-y', r(input.y2)];
				if (input.durationMs) {
					args.push('--duration', String(Math.max(0.05, input.durationMs / 1000)));
				}
				return { file: 'axe', args: [...args, '--udid', udid] };
			}
			case 'type':
				return { file: 'axe', args: ['type', input.text, '--udid', udid] };
			case 'button': {
				const key = iosKeyCode(input.button);
				if (key !== undefined) {
					return { file: 'axe', args: ['key', String(key), '--udid', udid] };
				}
				return { file: 'axe', args: ['button', iosButtonName(input.button, 'axe'), '--udid', udid] };
			}
		}
	}
	switch (input.kind) {
		case 'tap':
			return { file: 'idb', args: ['ui', 'tap', r(input.x), r(input.y), '--udid', udid] };
		case 'swipe': {
			const args = ['ui', 'swipe', r(input.x1), r(input.y1), r(input.x2), r(input.y2)];
			if (input.durationMs) {
				args.push('--duration', String(Math.max(0.05, input.durationMs / 1000)));
			}
			return { file: 'idb', args: [...args, '--udid', udid] };
		}
		case 'type':
			return { file: 'idb', args: ['ui', 'text', input.text, '--udid', udid] };
		case 'button': {
			const key = iosKeyCode(input.button);
			if (key !== undefined) {
				return { file: 'idb', args: ['ui', 'key', String(key), '--udid', udid] };
			}
			return { file: 'idb', args: ['ui', 'button', iosButtonName(input.button, 'idb'), '--udid', udid] };
		}
	}
}

function iosKeyCode(button: VoltDeviceButton): number | undefined {
	return button === 'enter' ? HID_ENTER : button === 'delete' ? HID_BACKSPACE : undefined;
}

/** The hardware button names each tool takes. Throws for buttons an iPhone simulator does not have. */
export function iosButtonName(button: VoltDeviceButton, tool: IosInputTool): string {
	const names: Partial<Record<VoltDeviceButton, [string, string]>> = {
		home: ['home', 'HOME'],
		lock: ['lock', 'LOCK'],
		siri: ['siri', 'SIRI'],
	};
	const pair = names[button];
	if (!pair) {
		throw new Error(`The iOS simulator has no "${button}" button. Use home, lock or siri.`);
	}
	return tool === 'axe' ? pair[0] : pair[1];
}

//#endregion

//#region Android

export interface IAdbDevice {
	readonly serial: string;
	readonly state: VoltDeviceState;
	readonly model?: string;
	readonly product?: string;
	readonly emulator: boolean;
}

function adbState(state: string): VoltDeviceState {
	switch (state) {
		case 'device': return 'booted';
		case 'offline': return 'offline';
		case 'unauthorized': return 'unauthorized';
		case 'authorizing':
		case 'connecting': return 'booting';
		default: return 'unknown';
	}
}

/** `adb devices -l`: one line per device, `serial  state  key:value…`. */
export function parseAdbDevices(output: string): IAdbDevice[] {
	const devices: IAdbDevice[] = [];
	for (const line of output.split(/\r?\n/)) {
		const match = /^(\S+)\s+(device|offline|unauthorized|authorizing|connecting|no permissions|bootloader|recovery|sideload)\b(.*)$/.exec(line.trim());
		if (!match || line.startsWith('List of devices') || line.startsWith('*')) {
			continue;
		}
		const props = new Map<string, string>();
		for (const pair of match[3].trim().split(/\s+/)) {
			const at = pair.indexOf(':');
			if (at > 0) {
				props.set(pair.slice(0, at), pair.slice(at + 1));
			}
		}
		devices.push({
			serial: match[1],
			state: adbState(match[2]),
			model: props.get('model')?.replace(/_/g, ' '),
			product: props.get('product'),
			emulator: match[1].startsWith('emulator-'),
		});
	}
	return devices;
}

/** `emulator -list-avds`: AVD names, one per line; log lines from the emulator itself are skipped. */
export function parseAvdList(output: string): string[] {
	return output.split(/\r?\n/).map(line => line.trim()).filter(line => /^[A-Za-z0-9._-]+$/.test(line) && !/^(INFO|WARNING|ERROR)$/.test(line));
}

/** `adb -s emulator-5554 emu avd name` prints the name, then `OK`. */
export function parseEmuAvdName(output: string): string | undefined {
	const first = output.split(/\r?\n/).map(line => line.trim()).find(line => line && line !== 'OK');
	return first && /^[A-Za-z0-9._-]+$/.test(first) ? first : undefined;
}

/** AVD names that Android Studio gives foldables, e.g. `Pixel_9_Pro_Fold`, `7.6_Fold-in_with_outer_display`. */
export function looksFoldable(name: string): boolean {
	return /fold|flip|duo/i.test(name);
}

/**
 * Why an emulator stopped, from its log: `snapshot` when its Quick Boot snapshot did not load
 * (booting with -no-snapshot-load fixes it), else the first fatal line, else undefined.
 */
export function emulatorFailure(log: string): string | undefined {
	if (/Failed to load snapshot|error while loading state|Error -?\d+ while loading VM state/i.test(log)) {
		return 'snapshot';
	}
	const fatal = log.split(/\r?\n/).map(line => line.trim()).find(line => /^(FATAL|ERROR)\s*\|/.test(line) || /^PANIC:/.test(line));
	return fatal?.replace(/^(FATAL|ERROR)\s*\|\s*/, '');
}

/** `Pixel_9_Pro_Fold` → `Pixel 9 Pro Fold`. */
export function avdLabel(name: string): string {
	return name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface IDeviceStateEntry {
	readonly id: number;
	readonly name: string;
}

/** `cmd device_state print-states`: `DeviceState{identifier=0, name='CLOSED', …}` per state. */
export function parseDeviceStates(output: string): IDeviceStateEntry[] {
	const states: IDeviceStateEntry[] = [];
	const re = /DeviceState\{identifier=(\d+),\s*name='([^']*)'/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(output))) {
		states.push({ id: Number(match[1]), name: match[2] });
	}
	return states;
}

/** `cmd device_state state`: the committed state line. */
export function parseCurrentDeviceState(output: string): IDeviceStateEntry | undefined {
	const committed = /Committed state:\s*DeviceState\{identifier=(\d+),\s*name='([^']*)'/.exec(output)
		?? /DeviceState\{identifier=(\d+),\s*name='([^']*)'/.exec(output);
	return committed ? { id: Number(committed[1]), name: committed[2] } : undefined;
}

/** Device state names across Android versions and OEMs, by posture. */
export function postureOfState(name: string): VoltDevicePosture | undefined {
	const upper = name.toUpperCase();
	if (/^(CLOSED|FOLDED|CLOSE)$/.test(upper)) {
		return 'folded';
	}
	if (/^(HALF_OPENED|HALF_FOLDED|HALF_OPEN|HALF-OPENED|TABLETOP|TENT)$/.test(upper)) {
		return 'halfOpen';
	}
	if (/^(OPENED|UNFOLDED|OPEN|FLAT)$/.test(upper)) {
		return 'open';
	}
	return undefined;
}

/** The state id to request for a posture; undefined when the device has none for it. */
export function stateForPosture(states: readonly IDeviceStateEntry[], posture: VoltDevicePosture): number | undefined {
	return states.find(state => postureOfState(state.name) === posture)?.id;
}

const ANDROID_KEYCODES: Record<VoltDeviceButton, string | undefined> = {
	home: 'KEYCODE_HOME',
	back: 'KEYCODE_BACK',
	appSwitch: 'KEYCODE_APP_SWITCH',
	lock: 'KEYCODE_POWER',
	volumeUp: 'KEYCODE_VOLUME_UP',
	volumeDown: 'KEYCODE_VOLUME_DOWN',
	siri: 'KEYCODE_ASSIST',
	enter: 'KEYCODE_ENTER',
	delete: 'KEYCODE_DEL',
};

export function androidKeycode(button: VoltDeviceButton): string {
	const code = ANDROID_KEYCODES[button];
	if (!code) {
		throw new Error(`Android has no "${button}" button.`);
	}
	return code;
}

/**
 * What to send for `text` with `input text`, in order: strings to type, and `null` for Enter
 * (newlines). Spaces become `%s`, the tool's only escape. A literal `%s` is typed as `%` then
 * `s` in two calls, because the tool would read it as a space. Callers quote each string for the
 * device's shell, which `adb shell` hands its arguments to.
 */
export function androidTextChunks(text: string): Array<string | null> {
	if (/[^\x20-\x7e\n\t]/.test(text)) {
		throw new Error('Android\'s `input text` only types plain ASCII. Paste other text from the app, or type it in parts.');
	}
	const out: Array<string | null> = [];
	text.split('\n').forEach((line, index) => {
		if (index > 0) {
			out.push(null);
		}
		const parts = line.replace(/\t/g, ' ').split('%s');
		parts.forEach((part, at) => {
			const typed = (at > 0 ? 's' : '') + part + (at < parts.length - 1 ? '%' : '');
			if (typed) {
				out.push(typed.replace(/ /g, '%s'));
			}
		});
	});
	return out;
}

/** The device-side command line for `adb shell`. */
export function androidShell(argv: readonly string[]): string {
	return shellJoin(argv);
}

/** Opens a package's launcher activity, a `package/.Activity`, or a URL. */
export function androidLaunchArgv(target: string): string[] {
	if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
		return ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', target];
	}
	if (target.includes('/')) {
		return ['am', 'start', '-n', target];
	}
	return ['monkey', '-p', target, '-c', 'android.intent.category.LAUNCHER', '1'];
}

/** Where the Android SDK usually is, in order: env, then the platform's default install folder. */
export function androidSdkCandidates(platform: NodeJS.Platform | string, env: Record<string, string | undefined>, home: string): string[] {
	const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
	if (platform === 'darwin') {
		candidates.push(`${home}/Library/Android/sdk`);
	} else if (platform === 'win32') {
		candidates.push(env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Android\\Sdk` : undefined);
	} else {
		candidates.push(`${home}/Android/Sdk`, `${home}/Android/sdk`);
	}
	return candidates.filter((path, index, all): path is string => !!path && all.indexOf(path) === index);
}

//#endregion

//#region Images and coordinates

/** Width and height from a PNG's IHDR chunk; undefined when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
	if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
		return undefined;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * A point in an image the agent or user saw (`imageWidth` px wide, a scaled copy of the
 * `screenWidth` px screen) in the device's input units (`scale` px each).
 */
export function imagePointToInput(x: number, y: number, image: { width: number; height: number }, screen: { width: number; height: number; scale: number }): { x: number; y: number } {
	const sx = screen.width / Math.max(1, image.width);
	const sy = screen.height / Math.max(1, image.height);
	const scale = screen.scale > 0 ? screen.scale : 1;
	const clamp = (value: number, max: number) => Math.min(Math.max(0, value), max);
	return {
		x: Math.round(clamp(x * sx, screen.width - 1) / scale),
		y: Math.round(clamp(y * sy, screen.height - 1) / scale),
	};
}

//#endregion
