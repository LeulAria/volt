/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isAbsolute, join } from '../../../../../base/common/path.js';
import { localize } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { imagePointToInput } from '../../../../../platform/voltDevices/common/deviceCommands.js';
import { IVoltDevice, IVoltDeviceHost, IVoltDeviceList, IVoltDevicePostures, IVoltDevicesService, VoltDeviceAppearance, VoltDeviceButton, VoltDeviceInput, VoltDevicePosture, VoltDeviceState } from '../../../../../platform/voltDevices/common/voltDevices.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { scaleScreenshot } from '../../../../services/voltRuntime/browser/host/imageCodec.js';
import { DEVICE_TOOLS, VoltDeviceToolName } from '../../../../services/voltRuntime/common/deviceTools.js';
import { DeviceRefs, deviceView, IDeviceScreen, parseDeviceUi } from '../../../../services/voltRuntime/common/tools/deviceUi.js';
import { IPageView, observePage, renderPage } from '../../../../services/voltRuntime/common/tools/pageModel.js';
import { fileFlowStore, resolveActInput } from '../actFlows.js';
import { formatActRun, formatFlowRuns, IFlowRun, unsafeToSave } from '../preview/browserAct.js';
import { DeviceActRunner, IDeviceDriver } from './deviceAct.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { describeDevice, DEVICE_REMOTE_HOSTS_SETTING, findDevice, findHost, localDeviceHost, parseRemoteHosts, postureLabel } from '../../common/agentDevices.js';

export const IAgentDevicesService = createDecorator<IAgentDevicesService>('agentDevicesService');

export interface IHostDevices {
	readonly host: IVoltDeviceHost;
	readonly devices: readonly IVoltDevice[];
	readonly problems: readonly string[];
}

/** A device and the machine it runs on. */
export interface IDeviceTarget {
	readonly host: IVoltDeviceHost;
	readonly device: IVoltDevice;
}

export interface IDeviceShot {
	readonly dataUrl: string;
	readonly width: number;
	readonly height: number;
	/** The full screen in pixels and its pixels per input unit. */
	readonly screen: { readonly width: number; readonly height: number; readonly scale: number };
}

/** A device the user or an agent is acting on right now, so previews can show it. */
export interface IDeviceActivity {
	readonly key: string;
	readonly by: 'agent' | 'user';
}

/**
 * Simulators and emulators for the window: the machines from the settings, the devices on them,
 * screenshots in the coordinates the agent or user saw, and the device_* host tools.
 */
export interface IAgentDevicesService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeDevices: Event<void>;
	/** A device's screen changed through Volt (an agent tapped, booted, folded it). */
	readonly onDidAct: Event<IDeviceActivity>;
	hosts(): readonly IVoltDeviceHost[];
	list(force?: boolean): Promise<readonly IHostDevices[]>;
	cached(): readonly IHostDevices[];
	keyOf(target: IDeviceTarget): string;
	find(key: string): IDeviceTarget | undefined;
	boot(target: IDeviceTarget, timeoutMs?: number): Promise<VoltDeviceState>;
	shutdown(target: IDeviceTarget): Promise<void>;
	/**
	 * `maxSide` 0 keeps the full size (as PNG). `by` keeps the agent's and the preview's
	 * screenshots apart: each one's taps refer to the image it saw.
	 */
	screenshot(target: IDeviceTarget, maxSide: number, by: 'agent' | 'user'): Promise<IDeviceShot>;
	/** A tap or swipe in the coordinates of the last screenshot `by` took of `target`. */
	inputAt(target: IDeviceTarget, input: VoltDeviceInput, by: 'agent' | 'user'): Promise<void>;
	pressButton(target: IDeviceTarget, button: VoltDeviceButton, by: 'agent' | 'user'): Promise<void>;
	installApp(target: IDeviceTarget, path: string): Promise<void>;
	launchApp(target: IDeviceTarget, app: string): Promise<void>;
	postures(target: IDeviceTarget): Promise<IVoltDevicePostures>;
	setPosture(target: IDeviceTarget, posture: VoltDevicePosture, by: 'agent' | 'user'): Promise<void>;
	/** The device a tool call means: `device` (name or id), else the chat's last one, else the only booted one. */
	resolveTarget(device: string | undefined, host: string | undefined, call: IVoltHostToolCall | undefined): Promise<IDeviceTarget>;
	appearance(target: IDeviceTarget): Promise<VoltDeviceAppearance | undefined>;
	setAppearance(target: IDeviceTarget, appearance: VoltDeviceAppearance): Promise<void>;
	/** Runs device_act steps (a script, `${name}` vars, saved flows) and reports the run. */
	act(target: IDeviceTarget, script: string, options: { readonly vars?: Record<string, unknown>; readonly cwd?: string; readonly token: CancellationToken }): Promise<{ readonly ok: boolean; readonly lines: readonly string[] }>;
	/**
	 * A screenshot for a gallery: no bigger than `maxSide`, and kept apart from the agent's and the
	 * preview's screenshots, whose coordinates their taps refer to.
	 */
	capture(target: IDeviceTarget, maxSide: number): Promise<IDeviceShot>;
}

const LIST_TTL_MS = 3000;
/** Under the 60s agents give an MCP call. */
const AGENT_BOOT_MS = 50_000;
const SETTLE_MS = 600;

function errorText(err: unknown): string {
	return err instanceof Error ? err.message.replace(/^Error:\s*/, '') : String(err);
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class AgentDevicesService extends Disposable implements IAgentDevicesService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeDevices = this._register(new Emitter<void>());
	readonly onDidChangeDevices = this._onDidChangeDevices.event;
	private readonly _onDidAct = this._register(new Emitter<IDeviceActivity>());
	readonly onDidAct = this._onDidAct.event;

	private lists: readonly IHostDevices[] = [];
	private listedAt = 0;
	private listing: Promise<readonly IHostDevices[]> | undefined;
	/** Size of the last screenshot per device, which agent and user coordinates refer to. */
	private readonly shots = new Map<string, { image: { width: number; height: number }; screen: { width: number; height: number; scale: number } }>();
	/** The device each chat used last. */
	private readonly chatDevices = new Map<string, string>();
	/** Element refs per device, stable across reads of its screen. */
	private readonly refs = new Map<string, DeviceRefs>();
	/** The screen as the agent last read it per device, so the next result reports only what changed. */
	private readonly seen = new Map<string, IPageView>();

	constructor(
		@IVoltDevicesService private readonly devices: IVoltDevicesService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this._register(hostTools.registerToolProvider({
			tools: DEVICE_TOOLS,
			invoke: (name, args, call) => this.invokeTool(name as VoltDeviceToolName, args, call),
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(DEVICE_REMOTE_HOSTS_SETTING)) {
				this.listedAt = 0;
				void this.list(true);
			}
		}));
	}

	hosts(): readonly IVoltDeviceHost[] {
		return [localDeviceHost(localize('voltDevices.thisMachine', "This Computer")), ...parseRemoteHosts(this.configurationService.getValue(DEVICE_REMOTE_HOSTS_SETTING))];
	}

	cached(): readonly IHostDevices[] {
		return this.lists;
	}

	list(force = false): Promise<readonly IHostDevices[]> {
		if (!force && Date.now() - this.listedAt < LIST_TTL_MS) {
			return Promise.resolve(this.lists);
		}
		if (this.listing) {
			return this.listing;
		}
		this.listing = Promise.all(this.hosts().map(async host => {
			const list: IVoltDeviceList = await this.devices.listDevices(host).catch(err => ({ devices: [], problems: [errorText(err)] }));
			return { host, devices: list.devices, problems: list.problems };
		})).then(lists => {
			const changed = JSON.stringify(lists) !== JSON.stringify(this.lists);
			this.lists = lists;
			this.listedAt = Date.now();
			if (changed) {
				this._onDidChangeDevices.fire();
			}
			return lists;
		}).finally(() => this.listing = undefined);
		return this.listing;
	}

	keyOf(target: IDeviceTarget): string {
		return `${target.host.id}/${target.device.platform}/${target.device.id}`;
	}

	find(key: string): IDeviceTarget | undefined {
		for (const entry of this.lists) {
			for (const device of entry.devices) {
				if (this.keyOf({ host: entry.host, device }) === key) {
					return { host: entry.host, device };
				}
			}
		}
		return undefined;
	}

	private changed(): void {
		this.listedAt = 0;
		void this.list(true);
	}

	async boot(target: IDeviceTarget, timeoutMs?: number): Promise<VoltDeviceState> {
		const state = await this.devices.boot(target.host, target.device, timeoutMs);
		this.changed();
		this._onDidAct.fire({ key: this.keyOf(target), by: 'user' });
		return state;
	}

	async shutdown(target: IDeviceTarget): Promise<void> {
		await this.devices.shutdown(target.host, target.device);
		this.forgetShots(target);
		this.changed();
	}

	async screenshot(target: IDeviceTarget, maxSide: number, by: 'agent' | 'user'): Promise<IDeviceShot> {
		const screen = await this.devices.screenshot(target.host, target.device, maxSide);
		const full = `data:image/${screen.format ?? 'png'};base64,${screen.imageBase64}`;
		// The main process already shrank it when it knows the size; else scale here.
		const shot = screen.imageWidth && screen.imageHeight
			? { dataUrl: full, width: screen.imageWidth, height: screen.imageHeight }
			: maxSide > 0 ? await scaleScreenshot(full, { maxSide, format: 'jpeg', quality: 0.82 }) : { dataUrl: full, width: screen.width, height: screen.height };
		const geometry = { width: screen.width, height: screen.height, scale: screen.scale };
		this.shots.set(`${this.keyOf(target)}|${by}`, { image: { width: shot.width, height: shot.height }, screen: geometry });
		return { dataUrl: shot.dataUrl, width: shot.width, height: shot.height, screen: geometry };
	}

	/** Image coordinates to device input units, from the last screenshot (or the full screen when there is none). */
	private toInput(target: IDeviceTarget, x: number, y: number, by: 'agent' | 'user'): { x: number; y: number } {
		const shot = this.shots.get(`${this.keyOf(target)}|${by}`);
		if (!shot) {
			throw new Error('Take a device_screenshot first: tap and swipe coordinates are pixels in that image.');
		}
		return imagePointToInput(x, y, shot.image, shot.screen);
	}

	async inputAt(target: IDeviceTarget, input: VoltDeviceInput, by: 'agent' | 'user'): Promise<void> {
		let mapped = input;
		if (input.kind === 'tap') {
			mapped = { kind: 'tap', ...this.toInput(target, input.x, input.y, by) };
		} else if (input.kind === 'swipe') {
			const from = this.toInput(target, input.x1, input.y1, by);
			const to = this.toInput(target, input.x2, input.y2, by);
			mapped = { kind: 'swipe', x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs: input.durationMs };
		}
		await this.devices.input(target.host, target.device, mapped);
		this._onDidAct.fire({ key: this.keyOf(target), by });
	}

	async pressButton(target: IDeviceTarget, button: VoltDeviceButton, by: 'agent' | 'user'): Promise<void> {
		await this.devices.input(target.host, target.device, { kind: 'button', button });
		this._onDidAct.fire({ key: this.keyOf(target), by });
	}

	/** The screen's accessibility tree, parsed (refs stay stable per device). */
	private async readScreen(target: IDeviceTarget): Promise<IDeviceScreen> {
		const key = this.keyOf(target);
		let refs = this.refs.get(key);
		if (!refs) {
			this.refs.set(key, refs = new DeviceRefs());
		}
		const ui = await this.devices.describeUi(target.host, target.device);
		const screen = parseDeviceUi(ui.format, ui.data, refs);
		if (!screen) {
			throw new Error(`Could not read the screen of ${this.label(target)} (${ui.format} returned no elements).`);
		}
		return screen;
	}

	private driverFor(target: IDeviceTarget): IDeviceDriver {
		const input = (value: VoltDeviceInput) => this.devices.input(target.host, target.device, value);
		return {
			platform: target.device.platform,
			read: () => this.readScreen(target),
			tap: (x, y) => input({ kind: 'tap', x, y }),
			swipe: (x1, y1, x2, y2, durationMs) => input({ kind: 'swipe', x1, y1, x2, y2, durationMs }),
			type: text => input({ kind: 'type', text }),
			clear: count => input({ kind: 'clear', count }),
			press: button => input({ kind: 'button', button }),
			launch: app => this.devices.launchApp(target.host, target.device, app),
		};
	}

	/** Screen lines for the agent: all of it the first time (or in another app), else the changes since its last read. */
	private screenLines(target: IDeviceTarget, screen: IDeviceScreen, observe: 'auto' | 'full', unfold?: boolean): string[] {
		const key = this.keyOf(target);
		const view = deviceView(screen);
		const observation = observe === 'full' ? { lines: ['- Screen:', '```yaml', ...renderPage(view, { unfold }), '```'] } : observePage(this.seen.get(key), view, undefined, unfold);
		this.seen.set(key, view);
		return [`- App: ${screen.app || '(unknown)'} · screen ${screen.width}×${screen.height} (input units)`, ...observation.lines.map(line => line.replace(/^- Page Snapshot:$/, '- Screen:').replace(/^- Page changes since your last view/, '- Screen changes since your last read').replace(/^- Page: unchanged since your last view of it\.$/, '- Screen: unchanged since your last read.'))];
	}

	private forgetShots(target: IDeviceTarget): void {
		this.shots.delete(`${this.keyOf(target)}|agent`);
		this.shots.delete(`${this.keyOf(target)}|user`);
	}

	installApp(target: IDeviceTarget, path: string): Promise<void> {
		return this.devices.installApp(target.host, target.device, path);
	}

	async launchApp(target: IDeviceTarget, app: string): Promise<void> {
		await this.devices.launchApp(target.host, target.device, app);
		this._onDidAct.fire({ key: this.keyOf(target), by: 'user' });
	}

	postures(target: IDeviceTarget): Promise<IVoltDevicePostures> {
		return this.devices.getPostures(target.host, target.device);
	}

	async setPosture(target: IDeviceTarget, posture: VoltDevicePosture, by: 'agent' | 'user'): Promise<void> {
		await this.devices.setPosture(target.host, target.device, posture);
		// The screen changes size when the device folds: the old screenshot's coordinates no longer apply.
		this.forgetShots(target);
		this._onDidAct.fire({ key: this.keyOf(target), by });
	}

	resolveTarget(device: string | undefined, host: string | undefined, call: IVoltHostToolCall | undefined): Promise<IDeviceTarget> {
		return this.resolve({ device, host }, call);
	}

	appearance(target: IDeviceTarget): Promise<VoltDeviceAppearance | undefined> {
		return this.devices.getAppearance(target.host, target.device);
	}

	async setAppearance(target: IDeviceTarget, appearance: VoltDeviceAppearance): Promise<void> {
		await this.devices.setAppearance(target.host, target.device, appearance);
		this._onDidAct.fire({ key: this.keyOf(target), by: 'agent' });
	}

	async act(target: IDeviceTarget, script: string, options: { readonly vars?: Record<string, unknown>; readonly cwd?: string; readonly token: CancellationToken }): Promise<{ readonly ok: boolean; readonly lines: readonly string[] }> {
		const store = options.cwd ? fileFlowStore(this.fileService, URI.file(options.cwd)) : undefined;
		const input = await resolveActInput({ script, vars: options.vars }, store, 'act');
		if ('error' in input) {
			return { ok: false, lines: [input.error] };
		}
		const runner = new DeviceActRunner(this.driverFor(target), options.token);
		const lines: string[] = [];
		let ok = true;
		for (const plan of input.plans) {
			const run = await runner.run(plan.steps);
			ok &&= run.ok;
			lines.push(...formatActRun(run, 'act', { brief: run.ok }));
			if (!run.ok) {
				break;
			}
		}
		this._onDidAct.fire({ key: this.keyOf(target), by: 'agent' });
		return { ok, lines };
	}

	async capture(target: IDeviceTarget, maxSide: number): Promise<IDeviceShot> {
		const screen = await this.devices.screenshot(target.host, target.device, maxSide);
		const full = `data:image/${screen.format ?? 'png'};base64,${screen.imageBase64}`;
		const geometry = { width: screen.width, height: screen.height, scale: screen.scale };
		if (screen.imageWidth && screen.imageHeight) {
			return { dataUrl: full, width: screen.imageWidth, height: screen.imageHeight, screen: geometry };
		}
		// Same-size captures come back as PNG (Android) or a JPEG of the full screen (iOS): fit and re-encode.
		const shot = await scaleScreenshot(full, { maxSide, format: 'jpeg', quality: 0.86 });
		return { dataUrl: shot.dataUrl, width: shot.width, height: shot.height, screen: geometry };
	}

	//#region Host tools

	private async resolve(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IDeviceTarget> {
		const lists = await this.list();
		const hostQuery = str(args.host);
		const host = hostQuery ? findHost(this.hosts(), hostQuery) : undefined;
		if (hostQuery && !host) {
			throw new Error(`No machine named "${hostQuery}". Machines: ${this.hosts().map(entry => entry.label).join(', ')}.`);
		}
		const scoped = host ? lists.filter(entry => entry.host.id === host.id) : lists;
		const all = scoped.flatMap(entry => entry.devices.map(device => ({ host: entry.host, device })));
		let query = str(args.device);
		if (!query && call?.sessionId) {
			const last = this.chatDevices.get(call.sessionId);
			const known = last ? this.find(last) : undefined;
			if (known && all.some(entry => this.keyOf(entry) === last)) {
				return known;
			}
		}
		const match = findDevice(all.map(entry => entry.device), query);
		if (match.kind === 'found') {
			const target = all.find(entry => entry.device === match.device)!;
			if (call?.sessionId) {
				this.chatDevices.set(call.sessionId, this.keyOf(target));
			}
			return target;
		}
		const problems = scoped.flatMap(entry => entry.problems);
		if (match.kind === 'ambiguous') {
			query ??= 'booted devices';
			const sameIds = new Set(match.candidates.map(device => device.id)).size < match.candidates.length;
			throw new Error(`"${query}" matches several devices; pass ${sameIds ? '`host` (the same simulator is on several machines)' : 'one id'}:\n${match.candidates.map(device => describeDevice(device, scoped.find(entry => entry.devices.includes(device))?.host.label ?? '')).join('\n')}`);
		}
		const available = scoped.flatMap(entry => entry.devices.map(device => describeDevice(device, entry.host.label)));
		// Apple ships no foldable iPhone simulator: point at the foldables that exist instead of a dead end.
		const foldables = scoped.flatMap(entry => entry.devices.filter(device => device.foldable).map(device => describeDevice(device, entry.host.label)));
		const foldHint = query && /fold|flip|duo/i.test(query)
			? `\nThere is no foldable iPhone simulator.${foldables.length ? ` Foldable devices that exist here:\n${foldables.join('\n')}` : ' No foldable Android emulator is installed either (Android Studio > Device Manager > Pixel 9 Pro Fold).'}`
			: '';
		throw new Error(query
			? `No device matches "${query}".${available.length ? ` Devices:\n${available.join('\n')}` : ' There are no simulators or emulators.'}${foldHint}${problems.length ? `\n${problems.join('\n')}` : ''}`
			: `No device is booted. Pass \`device\` (see device_list), or boot one with device_boot.${problems.length ? `\n${problems.join('\n')}` : ''}`);
	}

	private async invokeTool(name: VoltDeviceToolName, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		try {
			return await this.runTool(name, args, call);
		} catch (err) {
			return { error: errorText(err) };
		}
	}

	private async withShot(target: IDeviceTarget, lines: string[], args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		if (args.screenshot === false) {
			return { text: lines.join('\n') };
		}
		await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
		const shot = await this.screenshot(target, 1024, 'agent').catch(() => undefined);
		if (!shot) {
			return { text: lines.join('\n') };
		}
		lines.push(`- Screenshot attached: ${shot.width}×${shot.height} (tap coordinates are pixels in this image)`);
		return { text: lines.join('\n'), image: shot.dataUrl };
	}

	private label(target: IDeviceTarget): string {
		return `${target.device.name}${target.host.ssh ? ` on ${target.host.label}` : ''}`;
	}

	/** The chat's project folder (its worktree), for saved flows. */
	private projectFolder(call: IVoltHostToolCall | undefined): string | undefined {
		return call?.cwd ?? (call?.sessionId ? this.runtime.getOrCreateSession(call.sessionId).worktreePath : undefined) ?? this.workspace.getWorkspace().folders[0]?.uri.fsPath;
	}

	private resolvePath(path: string, call: IVoltHostToolCall | undefined): string {
		if (isAbsolute(path)) {
			return path;
		}
		const cwd = call?.cwd ?? (call?.sessionId ? this.runtime.getOrCreateSession(call.sessionId).worktreePath : undefined) ?? this.workspace.getWorkspace().folders[0]?.uri.fsPath;
		if (!cwd) {
			throw new Error(`${path} is relative and no folder is open; pass an absolute path.`);
		}
		return join(cwd, path);
	}

	private async runTool(name: VoltDeviceToolName, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		switch (name) {
			case 'device_list': {
				const lists = await this.list(true);
				const host = str(args.host) ? findHost(this.hosts(), str(args.host)) : undefined;
				const lines = ['### Devices'];
				for (const entry of lists.filter(item => !host || item.host.id === host.id)) {
					lines.push(`#### ${entry.host.label}${entry.host.ssh ? ' (SSH)' : ''}`);
					lines.push(...(entry.devices.length ? entry.devices.map(device => describeDevice(device, entry.host.label)) : ['- (no simulators or emulators)']));
					lines.push(...entry.problems.map(problem => `- Note: ${problem}`));
				}
				return { text: lines.join('\n') };
			}
			case 'device_boot': {
				const target = await this.resolve(args, call);
				if (target.device.state === 'booted') {
					return this.withShot(target, [`### ${this.label(target)} is already booted`], args);
				}
				const state = await this.devices.boot(target.host, target.device, AGENT_BOOT_MS);
				this.changed();
				const booted = { ...target, device: { ...target.device, state } };
				if (state !== 'booted') {
					return { text: `### Booting ${this.label(target)}\n- Still booting after ${AGENT_BOOT_MS / 1000}s. Call device_screenshot in a few seconds.` };
				}
				this._onDidAct.fire({ key: this.keyOf(target), by: 'agent' });
				return this.withShot(booted, [`### Booted ${this.label(target)}`], args);
			}
			case 'device_shutdown': {
				const target = await this.resolve(args, call);
				await this.shutdown(target);
				return { text: `### Shut down ${this.label(target)}` };
			}
			case 'device_snapshot': {
				const target = await this.resolve(args, call);
				const screen = await this.readScreen(target);
				return { text: [`### Screen of ${this.label(target)}`, ...this.screenLines(target, screen, 'full', args.unfold === true)].join('\n') };
			}
			case 'device_act': {
				const target = await this.resolve(args, call);
				const root = this.projectFolder(call);
				const store = root ? fileFlowStore(this.fileService, URI.file(root)) : undefined;
				const input = await resolveActInput(args, store, 'device_act');
				if ('error' in input) {
					return { error: input.error };
				}
				const tool = `device_act on ${this.label(target)}`;
				const runner = new DeviceActRunner(this.driverFor(target), call?.token ?? CancellationToken.None);
				const runs: IFlowRun[] = [];
				for (const plan of input.plans) {
					runs.push({ label: plan.label ?? 'flow', run: await runner.run(plan.steps) });
				}
				this._onDidAct.fire({ key: this.keyOf(target), by: 'agent' });
				const ok = runs.every(entry => entry.run.ok);
				const single = input.plans.length === 1 && !input.plans[0].label;
				const lines = single ? formatActRun(runs[0].run, tool, { brief: args.observe === 'on_failure' && ok }) : formatFlowRuns(runs, tool);
				if (single && input.save && store) {
					const refused = ok ? unsafeToSave(runs[0].run, args.vars as Record<string, string> | undefined) : 'the run did not pass';
					lines.push(refused ? `- Not saved as flow ${input.save.name}: ${refused}.` : `- Saved as flow ${input.save.name} (${(await store.write(input.save.name, input.save.script)).fsPath}): re-run it with {"run": "${input.save.name}"}.`);
				}
				const observe = args.observe === 'none' || (args.observe === 'on_failure' && ok) ? 'none' : args.observe === 'full' ? 'full' : 'auto';
				if (observe !== 'none' && (single || !ok)) {
					const screen = runner.last ?? await this.readScreen(target).catch(() => undefined);
					if (screen) {
						lines.push('', ...this.screenLines(target, screen, observe));
					}
				}
				return { text: lines.join('\n') };
			}
			case 'device_screenshot': {
				const target = await this.resolve(args, call);
				const maxSide = Math.max(256, Math.min(2048, num(args.max_side) ?? 1024));
				const shot = await this.screenshot(target, maxSide, 'agent');
				return {
					text: [
						`### Screenshot of ${this.label(target)}`,
						`- Image: ${shot.width}×${shot.height}; the screen is ${shot.screen.width}×${shot.screen.height} px. device_tap and device_swipe take pixels in this image.`,
					].join('\n'),
					image: shot.dataUrl,
				};
			}
			case 'device_tap': {
				const target = await this.resolve(args, call);
				const x = num(args.x), y = num(args.y);
				if (x === undefined || y === undefined) {
					return { error: 'device_tap needs `x` and `y` (pixels in the latest device_screenshot).' };
				}
				await this.inputAt(target, { kind: 'tap', x, y }, 'agent');
				return this.withShot(target, [`### Tapped ${this.label(target)} at ${Math.round(x)}, ${Math.round(y)}`], args);
			}
			case 'device_swipe': {
				const target = await this.resolve(args, call);
				const [x1, y1, x2, y2] = [num(args.x1), num(args.y1), num(args.x2), num(args.y2)];
				if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
					return { error: 'device_swipe needs `x1`, `y1`, `x2` and `y2`.' };
				}
				await this.inputAt(target, { kind: 'swipe', x1, y1, x2, y2, durationMs: num(args.duration_ms) }, 'agent');
				return this.withShot(target, [`### Swiped on ${this.label(target)} from ${Math.round(x1)}, ${Math.round(y1)} to ${Math.round(x2)}, ${Math.round(y2)}`], args);
			}
			case 'device_type': {
				const target = await this.resolve(args, call);
				const text = typeof args.text === 'string' ? args.text : '';
				if (!text) {
					return { error: 'device_type needs `text`.' };
				}
				await this.devices.input(target.host, target.device, { kind: 'type', text });
				this._onDidAct.fire({ key: this.keyOf(target), by: 'agent' });
				return this.withShot(target, [`### Typed ${JSON.stringify(text.slice(0, 200))} on ${this.label(target)}`], args);
			}
			case 'device_press_button': {
				const target = await this.resolve(args, call);
				const button = str(args.button) as VoltDeviceButton | undefined;
				if (!button) {
					return { error: 'device_press_button needs `button`.' };
				}
				await this.pressButton(target, button, 'agent');
				return this.withShot(target, [`### Pressed ${button} on ${this.label(target)}`], args);
			}
			case 'device_install_app': {
				const target = await this.resolve(args, call);
				const path = str(args.path);
				if (!path) {
					return { error: 'device_install_app needs `path`.' };
				}
				const full = this.resolvePath(path, call);
				await this.installApp(target, full);
				return { text: `### Installed ${full} on ${this.label(target)}\n- Launch it with device_launch_app.` };
			}
			case 'device_launch_app': {
				const target = await this.resolve(args, call);
				const app = str(args.app);
				if (!app) {
					return { error: 'device_launch_app needs `app`.' };
				}
				await this.devices.launchApp(target.host, target.device, app);
				this._onDidAct.fire({ key: this.keyOf(target), by: 'agent' });
				return this.withShot(target, [`### Launched ${app} on ${this.label(target)}`], { ...args, screenshot: args.screenshot ?? true });
			}
			case 'device_set_posture': {
				const target = await this.resolve(args, call);
				const posture = str(args.posture) as VoltDevicePosture | undefined;
				if (posture !== 'folded' && posture !== 'halfOpen' && posture !== 'open') {
					return { error: 'device_set_posture needs `posture`: folded, halfOpen or open.' };
				}
				await this.setPosture(target, posture, 'agent');
				return this.withShot(target, [`### ${this.label(target)} is now ${postureLabel(posture).toLowerCase()}`], args);
			}
		}
	}

	//#endregion
}
