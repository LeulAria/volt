/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { gunzipSync } from 'zlib';
import { homedir, tmpdir } from 'os';
import { basename, delimiter, join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../log/common/log.js';
import { androidKeycode, androidLaunchArgv, emulatorFailure, androidSdkCandidates, androidShell, androidTextChunks, avdLabel, fitWithin, gzipFrom, ICommand, IAdbDevice, IRawFrame, iosInputCommand, IosInputTool, isAlreadyBooted, isAlreadyShutdown, isXcodeLicenseError, jpegSize, looksFoldable, parseAdbDevices, parseAvdList, parseCurrentDeviceState, parseDeviceStates, parseEmuAvdName, parseNightMode, parseRawFrame, parseSimctlAppearance, parseSimctlDevices, parseSimctlScreen, pngFrom, pngSize, postureOfState, remoteScript, scpCommand, shellJoin, shellQuote, SYSTEM_SIMCTL, sshCommand, stateForPosture } from '../common/deviceCommands.js';
import { FileAccess } from '../../../base/common/network.js';
import { ANDROID_KEY_NUMBERS, ANDROID_UI_SERVER_COMMAND, ANDROID_UI_SERVER_JAR, AndroidUiServer } from './androidUiServer.js';
import { downscale, encodePng } from './frameEncoding.js';
import { IVoltDevice, IVoltDeviceHost, IVoltDeviceList, IVoltDevicePostures, IVoltDeviceRef, IVoltDeviceScreen, IVoltDevicesService, IVoltDeviceUi, VoltDeviceAppearance, VoltDeviceInput, VoltDevicePosture, VoltDeviceState } from '../common/voltDevices.js';

interface IRunResult {
	readonly stdout: Buffer;
	readonly stderr: string;
	readonly code: number;
}

interface IRunOptions {
	readonly timeout?: number;
	/** Resolve with the exit code instead of rejecting on a non-zero one. */
	readonly allowFail?: boolean;
}

const LIST_TIMEOUT = 20_000;
const ACTION_TIMEOUT = 30_000;
/** A capture that takes this long is stuck; the next one gets a fresh try. */
const SCREENSHOT_TIMEOUT = 10_000;
const INSTALL_TIMEOUT = 240_000;
const MAX_BUFFER = 96 * 1024 * 1024;

class ToolMissingError extends Error { }

interface IEmulatorLaunch {
	readonly logFile: string;
	/** The emulator's log once it exited. */
	exitedWith?: string;
	/** Being stopped to boot cold; `replacedBy` follows. */
	replacing?: boolean;
	/** The cold boot that took over after its snapshot failed. */
	replacedBy?: IEmulatorLaunch;
	/** Android reported the boot as done, and the launch waited a moment for a snapshot failure to show. */
	settled?: boolean;
}

function text(result: IRunResult): string {
	return result.stdout.toString('utf8');
}

function firstLine(value: string): string {
	return value.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
}

/**
 * Runs simctl, adb and the emulator for `IVoltDevicesService`: here, or on another machine
 * through `ssh` (keys only, never a password prompt). `env` resolves the user's shell environment,
 * so tools on their terminal's PATH are found.
 */
export class VoltDevicesService implements IVoltDevicesService {

	declare readonly _serviceBrand: undefined;

	/** Screen size and UI scale per simulator; they do not change while it exists. */
	private readonly iosScreens = new Map<string, { width: number; height: number; scale: number }>();
	private readonly iosTools = new Map<string, IosInputTool | null>();
	private readonly toolPaths = new Map<string, string | null>();
	private readonly adbServers = new Map<string, Promise<unknown>>();
	/** Hosts whose `xcrun` refused to run until Xcode's license is accepted, and until when simctl runs directly. */
	private readonly licenseBlockedUntil = new Map<string, number>();
	/** The adb serial of each running emulator, so a tap does not list every device first. */
	private readonly serials = new Map<string, string>();
	/** Hosts whose devices cannot gzip a capture on the device; they make PNGs there instead. */
	private readonly noRawCapture = new Set<string>();
	/** The UI reader running on each local Android device (by serial), and how often each one failed. */
	private readonly uiServers = new Map<string, AndroidUiServer>();
	private readonly uiServerFailures = new Map<string, number>();

	/**
	 * `encodeJpeg` turns RGBA pixels into a JPEG of the given size (the main process has a native
	 * one); without it, previews fall back to a shrunk PNG made here.
	 */
	constructor(
		private readonly env: () => Promise<NodeJS.ProcessEnv>,
		protected readonly logService: ILogService,
		private readonly encodeJpeg?: (frame: IRawFrame, width: number, height: number) => Buffer | undefined,
	) { }

	//#region Running commands

	private async exec(command: ICommand, options: IRunOptions = {}): Promise<IRunResult> {
		const env = await this.env();
		return new Promise<IRunResult>((resolve, reject) => {
			execFile(command.file, command.args as string[], { env, timeout: options.timeout ?? ACTION_TIMEOUT, maxBuffer: MAX_BUFFER, encoding: 'buffer' }, (error, stdout, stderr) => {
				const result: IRunResult = { stdout, stderr: stderr.toString('utf8'), code: typeof error?.code === 'number' ? error.code : error ? 1 : 0 };
				if (!error || options.allowFail && typeof error.code === 'number') {
					resolve(result);
					return;
				}
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					reject(new ToolMissingError(`${command.file} not found`));
					return;
				}
				if (error.killed) {
					reject(new Error(`${basename(command.file)} ${command.args.slice(0, 2).join(' ')} timed out`));
					return;
				}
				reject(new Error(firstLine(result.stderr) || firstLine(text(result)) || error.message));
			});
		});
	}

	/** An executable on the user's PATH, or undefined. */
	private async which(name: string): Promise<string | undefined> {
		const env = await this.env();
		for (const dir of (env.PATH ?? '').split(delimiter)) {
			if (!dir) {
				continue;
			}
			const candidate = join(dir, process.platform === 'win32' ? `${name}.exe` : name);
			try {
				await fs.access(candidate, fs.constants.X_OK);
				return candidate;
			} catch {
				// not here
			}
		}
		return undefined;
	}

	/** adb and the emulator: on PATH, else in the SDK (ANDROID_HOME, then the default install folder). */
	private async androidTool(host: IVoltDeviceHost, tool: 'adb' | 'emulator'): Promise<string> {
		const key = `${tool}:${host.androidSdk ?? ''}`;
		const cached = this.toolPaths.get(key);
		if (cached) {
			return cached;
		}
		const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
		const folder = tool === 'adb' ? 'platform-tools' : 'emulator';
		const env = await this.env();
		const sdks = host.androidSdk ? [host.androidSdk] : [];
		sdks.push(...androidSdkCandidates(process.platform, env, homedir()));
		const found = (host.androidSdk ? undefined : await this.which(tool)) ?? await this.firstExisting(sdks.map(sdk => join(sdk, folder, exe)));
		if (!found) {
			throw new ToolMissingError(tool === 'adb'
				? 'adb not found: install Android platform-tools (Android Studio > SDK Manager) or set ANDROID_HOME'
				: 'The Android emulator was not found: install it from Android Studio\'s SDK Manager or set ANDROID_HOME');
		}
		this.toolPaths.set(key, found);
		return found;
	}

	private async firstExisting(paths: readonly string[]): Promise<string | undefined> {
		for (const path of paths) {
			try {
				await fs.access(path, fs.constants.X_OK);
				return path;
			} catch {
				// keep looking
			}
		}
		return undefined;
	}

	/** Runs `argv` (a tool name first) on the host: directly here, or as a quoted command over SSH. */
	private async run(host: IVoltDeviceHost, argv: readonly string[], options?: IRunOptions): Promise<IRunResult> {
		if (host.ssh) {
			return this.exec(sshCommand(host.ssh, remoteScript(shellJoin(argv), host.androidSdk)), options).catch(err => {
				throw this.sshError(host, err);
			});
		}
		const [tool, ...args] = argv;
		const file = tool === 'adb' || tool === 'emulator' ? await this.androidTool(host, tool) : tool;
		return this.exec({ file, args }, options);
	}

	/** A shell script on a remote host (local hosts never need one). */
	private async remote(host: IVoltDeviceHost, script: string, options?: IRunOptions): Promise<IRunResult> {
		if (!host.ssh) {
			throw new Error('remote() needs an SSH host');
		}
		return this.exec(sshCommand(host.ssh, remoteScript(script, host.androidSdk)), options).catch(err => {
			throw this.sshError(host, err);
		});
	}

	private sshError(host: IVoltDeviceHost, err: unknown): Error {
		const message = err instanceof Error ? err.message : String(err);
		if (/Permission denied|Host key verification failed|Could not resolve hostname|Connection refused|Connection timed out|Operation timed out|No route to host/i.test(message)) {
			return new Error(`Could not reach ${host.label} over SSH: ${message}. Volt connects with keys only (BatchMode); check that \`ssh ${host.ssh?.user ? `${host.ssh.user}@` : ''}${host.ssh?.host}\` works without a password.`);
		}
		if (/command not found|not found/i.test(message) && /adb|emulator|xcrun|axe|idb/.test(message)) {
			return new ToolMissingError(`${message} on ${host.label}`);
		}
		return err instanceof Error ? err : new Error(message);
	}

	//#endregion

	//#region simctl

	/**
	 * `xcrun` refuses every tool after Xcode updates until its license is accepted with sudo, which
	 * Volt cannot do. simctl itself does not care, so run its system binary instead of failing.
	 */
	private async simctlRun(host: IVoltDeviceHost, args: readonly string[], options: IRunOptions = {}): Promise<IRunResult> {
		if (this.licenseBlocked(host)) {
			return this.run(host, [SYSTEM_SIMCTL, ...args], options);
		}
		try {
			const result = await this.run(host, ['xcrun', 'simctl', ...args], options);
			if (result.code === 0 || !isXcodeLicenseError(result.stderr)) {
				return result;
			}
		} catch (err) {
			if (!(err instanceof Error && isXcodeLicenseError(err.message))) {
				throw err;
			}
		}
		this.licenseBlockedUntil.set(host.id, Date.now() + 30_000);
		return this.run(host, [SYSTEM_SIMCTL, ...args], options);
	}

	private licenseBlocked(host: IVoltDeviceHost): boolean {
		return (this.licenseBlockedUntil.get(host.id) ?? 0) > Date.now();
	}

	//#endregion

	//#region Listing

	async listDevices(host: IVoltDeviceHost): Promise<IVoltDeviceList> {
		const problems: string[] = [];
		const [ios, android] = await Promise.all([
			this.listIos(host).catch(err => {
				// Not a Mac: no simulators, and nothing to report.
				if (!(err instanceof ToolMissingError && !host.ssh && process.platform !== 'darwin')) {
					problems.push(this.problem('iOS', err));
				}
				return [];
			}),
			this.listAndroid(host).catch(err => {
				problems.push(this.problem('Android', err));
				return [];
			}),
		]);
		if (this.licenseBlocked(host)) {
			problems.push('iOS: Xcode\'s license is not accepted, so only the simulators that are already installed are listed. For simulators from a newer Xcode (such as iPhone Fold), run `sudo xcodebuild -license accept` and `sudo xcodebuild -runFirstLaunch` in Terminal.');
		}
		return { devices: [...ios, ...android], problems };
	}

	private problem(what: string, err: unknown): string {
		const message = err instanceof Error ? err.message : String(err);
		if (what === 'iOS' && /xcrun not found|unable to find utility "simctl"/i.test(message)) {
			return 'iOS: Xcode is not installed (xcrun simctl not found)';
		}
		return `${what}: ${message}`;
	}

	private async listIos(host: IVoltDeviceHost): Promise<IVoltDevice[]> {
		if (!host.ssh && process.platform !== 'darwin') {
			throw new ToolMissingError('xcrun not found');
		}
		const result = await this.simctlRun(host, ['list', 'devices', '--json'], { timeout: LIST_TIMEOUT });
		return parseSimctlDevices(text(result), host.id);
	}

	private async listAndroid(host: IVoltDeviceHost): Promise<IVoltDevice[]> {
		const [running, avds] = await Promise.all([
			this.adbDevices(host),
			this.run(host, ['emulator', '-list-avds'], { timeout: LIST_TIMEOUT, allowFail: true }).then(result => parseAvdList(text(result))).catch(() => [] as string[]),
		]);
		const devices: IVoltDevice[] = [];
		const named = new Set<string>();
		await Promise.all(running.map(async entry => {
			const release = entry.device.state === 'booted' ? await this.androidRelease(host, entry.device.serial) : undefined;
			const id = entry.avd ?? entry.device.serial;
			named.add(id);
			devices.push({
				hostId: host.id,
				platform: 'android',
				id,
				name: entry.avd ? avdLabel(entry.avd) : entry.device.model ?? entry.device.serial,
				kind: entry.device.emulator ? 'emulator' : 'physical',
				state: entry.device.state,
				runtime: release,
				serial: entry.device.serial,
				model: entry.device.model,
				foldable: looksFoldable(entry.avd ?? entry.device.model ?? ''),
			});
		}));
		for (const avd of avds) {
			if (!named.has(avd)) {
				devices.push({ hostId: host.id, platform: 'android', id: avd, name: avdLabel(avd), kind: 'emulator', state: 'shutdown', foldable: looksFoldable(avd) });
			}
		}
		return devices.sort((a, b) => Number(b.state === 'booted') - Number(a.state === 'booted') || a.name.localeCompare(b.name, undefined, { numeric: true }));
	}

	/**
	 * adb starts its daemon on first use, and two commands racing to start it make one of them fail
	 * ("daemon not running; starting now"): start it once per host before anything else asks.
	 */
	private adbServer(host: IVoltDeviceHost): Promise<unknown> {
		let started = this.adbServers.get(host.id);
		if (!started) {
			started = this.run(host, ['adb', 'start-server'], { timeout: ACTION_TIMEOUT, allowFail: true }).catch(() => undefined);
			this.adbServers.set(host.id, started);
		}
		return started;
	}

	/** Every adb device, with the AVD name of the emulators. */
	private async adbDevices(host: IVoltDeviceHost): Promise<{ device: IAdbDevice; avd?: string }[]> {
		await this.adbServer(host);
		const devices = parseAdbDevices(text(await this.run(host, ['adb', 'devices', '-l'], { timeout: LIST_TIMEOUT })));
		return Promise.all(devices.map(async device => {
			if (!device.emulator || device.state === 'offline') {
				return { device };
			}
			const avd = await this.run(host, ['adb', '-s', device.serial, 'emu', 'avd', 'name'], { timeout: 5000, allowFail: true })
				.then(result => parseEmuAvdName(text(result)))
				.catch(() => undefined);
			return { device, avd };
		}));
	}

	private async androidRelease(host: IVoltDeviceHost, serial: string): Promise<string | undefined> {
		try {
			const result = await this.run(host, ['adb', '-s', serial, 'shell', 'getprop ro.build.version.release; getprop ro.build.version.sdk'], { timeout: 5000 });
			const [release, sdk] = text(result).split(/\r?\n/).map(line => line.trim());
			return release ? `Android ${release}${sdk ? ` (API ${sdk})` : ''}` : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * The adb serial of a running Android device: its AVD name or serial. Throws when it is not
	 * running. The answer is remembered (listing every device before each tap made the preview
	 * lag); `withSerial` forgets it when a command on it fails.
	 */
	private async serial(host: IVoltDeviceHost, device: IVoltDeviceRef): Promise<string> {
		const key = `${host.id}:${device.id}`;
		const known = this.serials.get(key);
		if (known) {
			return known;
		}
		const running = await this.adbDevices(host);
		const match = running.find(entry => entry.avd === device.id || entry.device.serial === device.id);
		if (!match) {
			throw new Error(`${avdLabel(device.id)} is not running. Boot it first (device_boot).`);
		}
		if (match.device.state === 'unauthorized') {
			throw new Error(`${match.device.serial} has not allowed USB debugging from this computer yet: accept the prompt on the device.`);
		}
		if (match.device.state !== 'booted') {
			throw new Error(`${match.device.serial} is ${match.device.state}.`);
		}
		this.serials.set(key, match.device.serial);
		return match.device.serial;
	}

	/** Runs `fn` with the device's serial; when that fails with a remembered serial, looks it up again once. */
	private async withSerial<T>(host: IVoltDeviceHost, device: IVoltDeviceRef, fn: (serial: string) => Promise<T>): Promise<T> {
		const key = `${host.id}:${device.id}`;
		try {
			return await fn(await this.serial(host, device));
		} catch (err) {
			if (!this.serials.delete(key)) {
				throw err;
			}
			return fn(await this.serial(host, device));
		}
	}

	//#endregion

	//#region Boot and shutdown

	async boot(host: IVoltDeviceHost, device: IVoltDeviceRef, timeoutMs = 120_000): Promise<VoltDeviceState> {
		const deadline = Date.now() + timeoutMs;
		if (device.platform === 'ios') {
			const booted = await this.simctlRun(host, ['boot', device.id], { allowFail: true, timeout: ACTION_TIMEOUT });
			if (booted.code !== 0 && !isAlreadyBooted(booted.stderr)) {
				throw new Error(firstLine(booted.stderr) || `Could not boot ${device.id}`);
			}
			// bootstatus returns once SpringBoard is up.
			const wait = Math.max(1000, deadline - Date.now());
			const status = await this.simctlRun(host, ['bootstatus', device.id], { allowFail: true, timeout: wait }).catch(() => undefined);
			return status?.code === 0 ? 'booted' : 'booting';
		}
		this.serials.delete(`${host.id}:${device.id}`);
		const running = await this.adbDevices(host).catch(() => []);
		let serial = running.find(entry => entry.avd === device.id || entry.device.serial === device.id)?.device.serial;
		let launch = serial ? undefined : await this.startEmulator(host, device.id, false);
		while (Date.now() < deadline) {
			while (launch?.replacedBy) {
				launch = launch.replacedBy;
			}
			if (launch?.exitedWith !== undefined && !launch.replacing) {
				const failure = emulatorFailure(launch.exitedWith);
				throw new Error(`The ${avdLabel(device.id)} emulator stopped while booting${failure && failure !== 'snapshot' ? `: ${failure}` : ''}. Its log: ${launch.logFile}`);
			}
			if (!serial) {
				serial = (await this.adbDevices(host).catch(() => [])).find(entry => entry.avd === device.id)?.device.serial;
			}
			if (serial) {
				const done = await this.run(host, ['adb', '-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 5000, allowFail: true }).catch(() => undefined);
				if (done && text(done).trim() === '1') {
					if (launch && !launch.settled) {
						// A Quick Boot snapshot with broken graphics reports booted, then logs GL errors: give the watcher a look.
						launch.settled = true;
						await new Promise(resolve => setTimeout(resolve, 2500));
						continue;
					}
					return 'booted';
				}
			}
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		return 'booting';
	}

	/**
	 * Starts an emulator detached, so it outlives Volt. Locally its output goes to a log file, and
	 * the launch watches it: a Quick Boot snapshot that does not load (the emulator was killed
	 * mid-save) hangs the emulator and then crashes it, so it is stopped and booted cold, once,
	 * whether or not anyone still waits for the boot. `cold` skips the snapshot.
	 */
	private async startEmulator(host: IVoltDeviceHost, avd: string, cold: boolean): Promise<IEmulatorLaunch | undefined> {
		const args = ['-avd', avd, '-no-boot-anim', ...(cold ? ['-no-snapshot-load'] : [])];
		if (host.ssh) {
			// Detached on the remote machine, with every stream closed so ssh does not wait for it.
			await this.remote(host, `nohup emulator ${shellJoin(args)} >/dev/null 2>&1 </dev/null &`, { timeout: 15_000 });
			return undefined;
		}
		const file = await this.androidTool(host, 'emulator');
		const env = await this.env();
		// A file, not a pipe: a pipe fills up and stalls the emulator once Volt stops reading it.
		const logFile = join(tmpdir(), `volt-emulator-${avd}.log`);
		const log = await fs.open(logFile, 'w');
		const launch: IEmulatorLaunch = { logFile };
		const child = spawn(file, args, { env, detached: true, stdio: ['ignore', log.fd, log.fd] });
		await log.close();
		let watch: ReturnType<typeof setInterval> | undefined;
		const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
		child.on('error', err => {
			this.logService.warn(`[volt-devices] emulator ${avd} failed to start`, err);
			launch.exitedWith = String(err);
		});
		child.on('exit', (code, signal) => {
			clearInterval(watch);
			void fs.readFile(logFile, 'utf8').catch(() => '').then(output => {
				if (!launch.replacing) {
					this.logService.warn(`[volt-devices] emulator ${avd} exited (${code ?? signal}); log: ${logFile}`);
				}
				launch.exitedWith = output;
			});
		});
		child.unref();
		if (!cold) {
			const started = Date.now();
			watch = setInterval(() => {
				if (Date.now() - started > 180_000) {
					clearInterval(watch);
					return;
				}
				void fs.readFile(logFile, 'utf8').then(async output => {
					if (launch.replacing || emulatorFailure(output) !== 'snapshot') {
						return;
					}
					launch.replacing = true;
					clearInterval(watch);
					this.logService.info(`[volt-devices] ${avd}: its Quick Boot snapshot did not load; booting it cold`);
					// One emulator per AVD: the hung one goes first.
					child.kill('SIGKILL');
					await exited;
					launch.replacedBy = await this.startEmulator(host, avd, true).catch(err => {
						launch.replacing = false;
						launch.exitedWith = String(err);
						return undefined;
					});
				}, () => undefined);
			}, 2000);
		}
		return launch;
	}

	async shutdown(host: IVoltDeviceHost, device: IVoltDeviceRef): Promise<void> {
		if (device.platform === 'ios') {
			const result = await this.simctlRun(host, ['shutdown', device.id], { allowFail: true });
			if (result.code !== 0 && !isAlreadyShutdown(result.stderr)) {
				throw new Error(firstLine(result.stderr) || `Could not shut down ${device.id}`);
			}
			return;
		}
		const serial = await this.serial(host, device);
		if (!serial.startsWith('emulator-')) {
			throw new Error('Volt only shuts down emulators, not physical devices.');
		}
		this.serials.delete(`${host.id}:${device.id}`);
		await this.run(host, ['adb', '-s', serial, 'emu', 'kill']);
	}

	//#endregion

	//#region Screen

	async screenshot(host: IVoltDeviceHost, device: IVoltDeviceRef, maxSide = 0): Promise<IVoltDeviceScreen> {
		if (device.platform === 'ios') {
			// A JPEG is made, read and sent several times cheaper than the PNG.
			const format = maxSide > 0 ? 'jpeg' : 'png';
			const image = await this.iosScreenshot(host, device.id, format);
			const size = format === 'jpeg' ? jpegSize(image) : pngSize(image);
			if (!size) {
				throw new Error('The simulator did not return a screenshot. Is it booted?');
			}
			const scale = (await this.iosScreen(host, device.id))?.scale ?? 1;
			return { imageBase64: image.toString('base64'), format, width: size.width, height: size.height, scale };
		}
		return this.withSerial(host, device, serial => this.androidScreenshot(host, serial, maxSide));
	}

	private async androidScreenshot(host: IVoltDeviceHost, serial: string, maxSide: number): Promise<IVoltDeviceScreen> {
		const frame = this.noRawCapture.has(host.id) ? undefined : await this.androidFrame(host, serial);
		if (!frame) {
			const png = Buffer.from(pngFrom((await this.run(host, ['adb', '-s', serial, 'exec-out', 'screencap', '-p'], { timeout: SCREENSHOT_TIMEOUT })).stdout));
			const size = pngSize(png);
			if (!size) {
				throw new Error('The device did not return a screenshot. Is it booted and unlocked?');
			}
			return { imageBase64: png.toString('base64'), format: 'png', width: size.width, height: size.height, scale: 1 };
		}
		const fit = fitWithin(frame.width, frame.height, maxSide);
		if (fit.width === frame.width && fit.height === frame.height) {
			return { imageBase64: encodePng(frame).toString('base64'), format: 'png', width: frame.width, height: frame.height, scale: 1 };
		}
		const jpeg = this.encodeJpeg?.(frame, fit.width, fit.height);
		const small = jpeg ? undefined : downscale(frame, fit.width, fit.height);
		return {
			imageBase64: (jpeg ?? encodePng(small!)).toString('base64'),
			format: jpeg ? 'jpeg' : 'png',
			width: frame.width,
			height: frame.height,
			imageWidth: fit.width,
			imageHeight: fit.height,
			scale: 1,
		};
	}

	/**
	 * The screen as RGBA pixels. The device gzips the raw capture: a PNG made on the emulator's own
	 * CPU took several seconds on a busy screen, the gzip a fraction of that. Undefined when the
	 * device cannot (no gzip), after which this host uses PNGs.
	 */
	private async androidFrame(host: IVoltDeviceHost, serial: string): Promise<IRawFrame | undefined> {
		const result = await this.run(host, ['adb', '-s', serial, 'exec-out', 'screencap | gzip -1'], { timeout: SCREENSHOT_TIMEOUT });
		const gzip = gzipFrom(result.stdout);
		if (!gzip) {
			this.logService.warn(`[volt-devices] ${serial} did not return a gzipped raw capture; using PNG captures on ${host.label}`);
			this.noRawCapture.add(host.id);
			return undefined;
		}
		let frame: IRawFrame | undefined;
		try {
			frame = parseRawFrame(gunzipSync(gzip));
		} catch {
			// cut short: handled below
		}
		if (!frame) {
			throw new Error('The device returned an unreadable screen capture. Try again.');
		}
		return frame;
	}

	/** simctl writes screenshots only to a file (`-` in Xcode 26 makes a file named "-"). */
	private async iosScreenshot(host: IVoltDeviceHost, udid: string, type: 'png' | 'jpeg'): Promise<Buffer> {
		if (host.ssh) {
			const shoot = (tool: string) => `${tool} io ${shellQuote(udid)} screenshot --type=${type} "$f" >/dev/null 2>&1`;
			const script = `f=$(mktemp /tmp/volt-shot.XXXXXX) || exit 1; { ${shoot('xcrun simctl')} || ${shoot(shellQuote(SYSTEM_SIMCTL))}; } && cat "$f"; s=$?; rm -f "$f"; exit $s`;
			return (await this.remote(host, script, { timeout: ACTION_TIMEOUT })).stdout;
		}
		const file = join(tmpdir(), `volt-shot-${generateUuid()}.${type === 'jpeg' ? 'jpg' : 'png'}`);
		try {
			await this.simctlRun(host, ['io', udid, 'screenshot', `--type=${type}`, file]);
			return await fs.readFile(file);
		} finally {
			await fs.rm(file, { force: true });
		}
	}

	private async iosScreen(host: IVoltDeviceHost, udid: string): Promise<{ width: number; height: number; scale: number } | undefined> {
		const key = `${host.id}:${udid}`;
		const cached = this.iosScreens.get(key);
		if (cached) {
			return cached;
		}
		const result = await this.simctlRun(host, ['io', udid, 'enumerate'], { timeout: 10_000, allowFail: true }).catch(() => undefined);
		const screen = result ? parseSimctlScreen(text(result)) : undefined;
		if (screen) {
			this.iosScreens.set(key, screen);
		}
		return screen;
	}

	//#endregion

	//#region Input

	async input(host: IVoltDeviceHost, device: IVoltDeviceRef, input: VoltDeviceInput): Promise<void> {
		if (device.platform === 'ios' && input.kind === 'clear') {
			// No select-all on the simulator's keyboard: backspace from the end, one key at a time.
			for (let i = 0; i < Math.min(80, input.count); i++) {
				await this.input(host, device, { kind: 'button', button: 'delete' });
			}
			return;
		}
		if (device.platform === 'ios' && input.kind !== 'clear') {
			// Buttons the simulator does not have fail before the tool check.
			iosInputCommand('axe', device.id, input);
			const tool = await this.iosInputTool(host);
			if (input.kind === 'type' && !input.text) {
				return;
			}
			const command = iosInputCommand(tool, device.id, input);
			await this.run(host, [command.file, ...command.args]);
			return;
		}
		await this.withSerial(host, device, serial => this.androidInput(host, serial, input));
	}

	/**
	 * The UI reader on a local Android device (see `UiServer.java`): one connection kept open, so a
	 * screen read takes milliseconds instead of `uiautomator dump`'s seconds. Undefined over SSH and
	 * after it failed twice on this device; callers then use adb's own tools.
	 */
	private async uiServer(host: IVoltDeviceHost, serial: string): Promise<AndroidUiServer | undefined> {
		if (host.ssh || (this.uiServerFailures.get(serial) ?? 0) >= 2) {
			return undefined;
		}
		let server = this.uiServers.get(serial);
		if (!server) {
			const adb = await this.androidTool(host, 'adb');
			const jar = FileAccess.asFileUri('vs/platform/voltDevices/node/android/volt-ui.jar').fsPath;
			server = new AndroidUiServer(async () => {
				await this.exec({ file: adb, args: ['-s', serial, 'push', jar, ANDROID_UI_SERVER_JAR] }, { timeout: 20_000 });
				return spawn(adb, ['-s', serial, 'shell', ANDROID_UI_SERVER_COMMAND], { env: await this.env() });
			});
			this.uiServers.set(serial, server);
		}
		return server;
	}

	/** Asks the device's UI reader; undefined (after noting the failure) when it cannot answer. */
	private async askUiServer(host: IVoltDeviceHost, serial: string, command: string, timeoutMs = 8000): Promise<string | undefined> {
		const server = await this.uiServer(host, serial).catch(() => undefined);
		if (!server) {
			return undefined;
		}
		try {
			const reply = await server.request(command, timeoutMs);
			if (reply.startsWith('ERR ')) {
				this.logService.trace('[volt-devices] UI reader:', reply);
				return undefined;
			}
			return reply;
		} catch (err) {
			this.logService.warn('[volt-devices] the UI reader failed; using adb tools', err instanceof Error ? err.message : String(err));
			server.dispose();
			this.uiServers.delete(serial);
			this.uiServerFailures.set(serial, (this.uiServerFailures.get(serial) ?? 0) + 1);
			return undefined;
		}
	}

	private async androidInput(host: IVoltDeviceHost, serial: string, input: VoltDeviceInput): Promise<void> {
		if (await this.androidInputFast(host, serial, input)) {
			return;
		}
		const shell = (argv: readonly string[]) => this.run(host, ['adb', '-s', serial, 'shell', androidShell(argv)]);
		const r = (value: number) => String(Math.round(value));
		switch (input.kind) {
			case 'tap':
				await shell(['input', 'tap', r(input.x), r(input.y)]);
				return;
			case 'swipe':
				await shell(['input', 'swipe', r(input.x1), r(input.y1), r(input.x2), r(input.y2), String(Math.round(input.durationMs ?? 300))]);
				return;
			case 'type':
				for (const chunk of androidTextChunks(input.text)) {
					await shell(chunk === null ? ['input', 'keyevent', 'KEYCODE_ENTER'] : ['input', 'text', chunk]);
				}
				return;
			case 'button':
				await shell(['input', 'keyevent', androidKeycode(input.button)]);
				return;
			case 'clear':
				// One command: jump to the end, then that many backspaces.
				await shell(['input', 'keyevent', 'KEYCODE_MOVE_END', ...Array.from({ length: Math.min(200, Math.max(0, input.count)) }, () => 'KEYCODE_DEL')]);
				return;
		}
	}

	/** Input through the UI reader (tens of ms instead of `input`'s start-up); false when it cannot. */
	private async androidInputFast(host: IVoltDeviceHost, serial: string, input: VoltDeviceInput): Promise<boolean> {
		const r = (value: number) => String(Math.round(value));
		switch (input.kind) {
			case 'tap':
				return !!await this.askUiServer(host, serial, `tap ${r(input.x)} ${r(input.y)}`);
			case 'swipe':
				return !!await this.askUiServer(host, serial, `swipe ${r(input.x1)} ${r(input.y1)} ${r(input.x2)} ${r(input.y2)} ${r(input.durationMs ?? 300)}`, 10_000);
			case 'type':
				// Newlines are Enter; text the keyboard map cannot type goes through `input text`.
				return !!await this.askUiServer(host, serial, `text ${Buffer.from(input.text, 'utf8').toString('base64')}`, 15_000);
			case 'button': {
				const code = ANDROID_KEY_NUMBERS[androidKeycode(input.button)];
				return code !== undefined && !!await this.askUiServer(host, serial, `key ${code}`);
			}
			case 'clear':
				return !!await this.askUiServer(host, serial, `keys ${[ANDROID_KEY_NUMBERS.KEYCODE_MOVE_END, ...Array.from({ length: Math.min(200, Math.max(0, input.count)) }, () => ANDROID_KEY_NUMBERS.KEYCODE_DEL)].join(' ')}`, 15_000);
		}
	}

	async describeUi(host: IVoltDeviceHost, device: IVoltDeviceRef): Promise<IVoltDeviceUi> {
		if (device.platform === 'ios') {
			const tool = await this.iosInputTool(host);
			const argv = tool === 'axe' ? ['axe', 'describe-ui', '--udid', device.id] : ['idb', 'ui', 'describe-all', '--udid', device.id, '--json'];
			return { format: tool, data: text(await this.run(host, argv, { timeout: ACTION_TIMEOUT })) };
		}
		return this.withSerial(host, device, async serial => {
			const fast = await this.askUiServer(host, serial, 'dump');
			if (fast?.includes('<hierarchy')) {
				return { format: 'uiautomator', data: fast };
			}
			let data = text(await this.run(host, ['adb', '-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: ACTION_TIMEOUT, allowFail: true }));
			if (!data.includes('<hierarchy')) {
				// Some system images cannot write the dump to the terminal: write a file and read it back.
				await this.run(host, ['adb', '-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/volt-ui.xml'], { timeout: ACTION_TIMEOUT });
				data = text(await this.run(host, ['adb', '-s', serial, 'exec-out', 'cat', '/sdcard/volt-ui.xml'], { timeout: ACTION_TIMEOUT }));
			}
			if (!data.includes('<hierarchy')) {
				throw new Error(firstLine(data) || 'uiautomator returned no screen (the device may be locked or animating)');
			}
			return { format: 'uiautomator', data: data.slice(data.indexOf('<?xml') >= 0 ? data.indexOf('<?xml') : data.indexOf('<hierarchy'), data.lastIndexOf('</hierarchy>') + '</hierarchy>'.length) };
		});
	}

	private async iosInputTool(host: IVoltDeviceHost): Promise<IosInputTool> {
		const cached = this.iosTools.get(host.id);
		if (cached) {
			return cached;
		}
		let tool: IosInputTool | undefined;
		if (host.ssh) {
			const found = text(await this.remote(host, 'command -v axe || command -v idb', { allowFail: true, timeout: 10_000 }));
			tool = /\/axe\s*$/m.test(found) ? 'axe' : /\/idb\s*$/m.test(found) ? 'idb' : undefined;
		} else {
			tool = await this.which('axe') ? 'axe' : await this.which('idb') ? 'idb' : undefined;
		}
		if (!tool) {
			throw new ToolMissingError(`Touches and typing on iOS simulators need AXe or idb${host.ssh ? ` on ${host.label}` : ''}: \`brew install cameroncooke/axe/axe\` (simctl itself has no touch input). Screenshots, boot, install and launch work without it.`);
		}
		this.iosTools.set(host.id, tool);
		return tool;
	}

	//#endregion

	//#region Apps

	async installApp(host: IVoltDeviceHost, device: IVoltDeviceRef, path: string): Promise<void> {
		const expected = device.platform === 'ios' ? /\.app\/?$/i : /\.(apk|apks|aab)$/i;
		if (!expected.test(path)) {
			throw new Error(device.platform === 'ios' ? 'Simulators install a built .app bundle (from a simulator build), not an .ipa.' : 'Pass an .apk to install on Android.');
		}
		await fs.access(path).catch(() => {
			throw new Error(`${path} does not exist on this computer.`);
		});
		let target = path;
		let cleanup: string | undefined;
		if (host.ssh) {
			cleanup = `/tmp/volt-install-${generateUuid()}`;
			await this.remote(host, `mkdir -p ${shellQuote(cleanup)}`);
			target = `${cleanup}/${basename(path.replace(/\/$/, ''))}`;
			await this.exec(scpCommand(host.ssh, path, target), { timeout: INSTALL_TIMEOUT }).catch(err => {
				throw this.sshError(host, err);
			});
		}
		try {
			if (device.platform === 'ios') {
				await this.simctlRun(host, ['install', device.id, target], { timeout: INSTALL_TIMEOUT });
			} else {
				const serial = await this.serial(host, device);
				const result = await this.run(host, ['adb', '-s', serial, 'install', '-r', target], { timeout: INSTALL_TIMEOUT });
				const out = text(result);
				if (/Failure \[/.test(out)) {
					throw new Error(firstLine(out.slice(out.indexOf('Failure ['))));
				}
			}
		} finally {
			if (cleanup) {
				await this.remote(host, `rm -rf ${shellQuote(cleanup)}`, { allowFail: true }).catch(() => undefined);
			}
		}
	}

	async launchApp(host: IVoltDeviceHost, device: IVoltDeviceRef, target: string): Promise<void> {
		const value = target.trim();
		if (!value) {
			throw new Error('Pass a bundle id, package name or URL.');
		}
		if (device.platform === 'ios') {
			const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(value);
			await this.simctlRun(host, isUrl ? ['openurl', device.id, value] : ['launch', device.id, value]);
			return;
		}
		const serial = await this.serial(host, device);
		const result = await this.run(host, ['adb', '-s', serial, 'shell', androidShell(androidLaunchArgv(value))]);
		const out = text(result);
		if (/No activities found|Error:|does not exist/i.test(out)) {
			throw new Error(firstLine(out.slice(out.search(/No activities found|Error:|does not exist/i))));
		}
	}

	//#endregion

	//#region Foldables

	async getPostures(host: IVoltDeviceHost, device: IVoltDeviceRef): Promise<IVoltDevicePostures> {
		if (device.platform !== 'android') {
			return { supported: [] };
		}
		const serial = await this.serial(host, device);
		const states = parseDeviceStates(text(await this.run(host, ['adb', '-s', serial, 'shell', 'cmd device_state print-states'], { allowFail: true, timeout: 8000 })));
		const supported = (['folded', 'halfOpen', 'open'] as const).filter(posture => stateForPosture(states, posture) !== undefined);
		if (!supported.length) {
			return { supported: looksFoldable(device.id) && serial.startsWith('emulator-') ? ['folded', 'open'] : [] };
		}
		const current = parseCurrentDeviceState(text(await this.run(host, ['adb', '-s', serial, 'shell', 'cmd device_state state'], { allowFail: true, timeout: 8000 })));
		return { supported, current: current ? postureOfState(current.name) : undefined };
	}

	async setPosture(host: IVoltDeviceHost, device: IVoltDeviceRef, posture: VoltDevicePosture): Promise<void> {
		if (device.platform !== 'android') {
			throw new Error('Only Android foldables have postures.');
		}
		const serial = await this.serial(host, device);
		const states = parseDeviceStates(text(await this.run(host, ['adb', '-s', serial, 'shell', 'cmd device_state print-states'], { allowFail: true, timeout: 8000 })));
		const id = stateForPosture(states, posture);
		if (id !== undefined) {
			await this.run(host, ['adb', '-s', serial, 'shell', `cmd device_state state ${id}`]);
			return;
		}
		// Older emulator images: the console's fold commands.
		if (serial.startsWith('emulator-') && posture !== 'halfOpen') {
			await this.run(host, ['adb', '-s', serial, 'emu', posture === 'folded' ? 'fold' : 'unfold']);
			return;
		}
		throw new Error(`${avdLabel(device.id)} has no ${posture === 'halfOpen' ? 'half-open' : posture} posture.`);
	}

	//#endregion

	//#region Appearance

	async getAppearance(host: IVoltDeviceHost, device: IVoltDeviceRef): Promise<VoltDeviceAppearance | undefined> {
		if (device.platform === 'ios') {
			const result = await this.simctlRun(host, ['ui', device.id, 'appearance'], { allowFail: true, timeout: 10_000 });
			return parseSimctlAppearance(text(result));
		}
		return this.withSerial(host, device, async serial => parseNightMode(text(await this.run(host, ['adb', '-s', serial, 'shell', 'cmd uimode night'], { allowFail: true, timeout: 8000 }))));
	}

	async setAppearance(host: IVoltDeviceHost, device: IVoltDeviceRef, appearance: VoltDeviceAppearance): Promise<void> {
		if (device.platform === 'ios') {
			const result = await this.simctlRun(host, ['ui', device.id, 'appearance', appearance], { allowFail: true, timeout: 10_000 });
			if (result.code !== 0) {
				throw new Error(firstLine(result.stderr) || `Could not switch ${device.id} to ${appearance} mode. Is it booted?`);
			}
			return;
		}
		await this.withSerial(host, device, async serial => {
			const out = text(await this.run(host, ['adb', '-s', serial, 'shell', `cmd uimode night ${appearance === 'dark' ? 'yes' : 'no'}`], { timeout: 8000 }));
			if (/Error|Unknown command/i.test(out)) {
				throw new Error(`${serial} cannot switch dark mode from adb (${firstLine(out)}); Android 10 or later can.`);
			}
		});
	}

	//#endregion
}
