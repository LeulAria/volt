/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IVoltDesktopService, IVoltDesktopTree } from '../../../../../platform/voltDesktop/common/voltDesktop.js';
import type { VoltDeviceButton } from '../../../../../platform/voltDevices/common/voltDevices.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { DESKTOP_TOOLS, VoltDesktopToolName } from '../../../../services/voltRuntime/common/desktopTools.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { DeviceRefs, deviceView, IDeviceScreen, readDesktopScreen } from '../../../../services/voltRuntime/common/tools/deviceUi.js';
import { IPageView, observePage, renderPage } from '../../../../services/voltRuntime/common/tools/pageModel.js';
import { fileFlowStore, resolveActInput } from '../actFlows.js';
import { DeviceActRunner, IDeviceDriver } from '../devices/deviceAct.js';
import { formatActRun, formatFlowRuns, IFlowRun, unsafeToSave } from '../preview/browserAct.js';

const KEY_FOR_BUTTON: Partial<Record<VoltDeviceButton, string>> = { enter: 'enter', delete: 'delete', back: 'escape', home: 'cmd+h' };

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The desktop_* host tools: read a Mac app's window as an accessibility tree and drive it with
 * the same steps, locators, verification and saved flows as browser_act and device_act. The user
 * allows desktop control once per chat; macOS also needs the Accessibility permission for Volt.
 */
export class AgentDesktopTools extends Disposable {

	/** Element refs per app, stable across reads of its window. */
	private readonly refs = new Map<string, DeviceRefs>();
	/** Each app's window as the agent last read it, so the next result reports only what changed. */
	private readonly seen = new Map<string, IPageView>();
	/** Chats the user allowed to control the desktop. */
	private readonly allowed = new Set<string>();
	private prompted = false;

	constructor(
		@IVoltDesktopService private readonly desktop: IVoltDesktopService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
	) {
		super();
		this._register(hostTools.registerToolProvider({
			tools: DESKTOP_TOOLS,
			invoke: (name, args, call) => this.invoke(name as VoltDesktopToolName, args, call).catch(err => ({ error: errorText(err) })),
			needsApproval: async (name, args, call) => {
				if (name === 'desktop_apps' || (call?.sessionId && this.allowed.has(this.runtime.chatFor(call.sessionId)))) {
					return undefined;
				}
				const app = str(args.app);
				return `controls apps on your Mac for this chat (reads their windows, clicks and types${app ? `, starting with ${app}` : ''})`;
			},
			approved: (_name, _args, call) => {
				if (call.sessionId) {
					this.allowed.add(this.runtime.chatFor(call.sessionId));
				}
			},
		}));
	}

	/** The permission check every call makes; the first refusal asks macOS to show its prompt. */
	private async ready(): Promise<string | undefined> {
		const status = await this.desktop.status(false);
		if (!status.supported) {
			return status.error ?? 'Desktop control works on macOS for now.';
		}
		if (status.error) {
			return status.error;
		}
		if (!status.trusted) {
			if (!this.prompted) {
				this.prompted = true;
				await this.desktop.status(true).catch(() => undefined);
			}
			return 'Volt needs the Accessibility permission to read and control other apps. Ask the user to turn Volt on in System Settings > Privacy & Security > Accessibility (macOS has just shown its prompt), then try again.';
		}
		return undefined;
	}

	private refsFor(app: string): DeviceRefs {
		let refs = this.refs.get(app);
		if (!refs) {
			this.refs.set(app, refs = new DeviceRefs());
		}
		return refs;
	}

	private screenOf(tree: IVoltDesktopTree): IDeviceScreen {
		const screen = readDesktopScreen(tree, this.refsFor(tree.bundle || tree.app));
		if (!screen) {
			throw new Error(`${tree.app || 'The app'} has no open window to read.`);
		}
		return screen;
	}

	/** Window lines for the agent: all of it the first time, else the changes since its last read. */
	private windowLines(tree: IVoltDesktopTree, screen: IDeviceScreen, observe: 'auto' | 'full', unfold?: boolean): string[] {
		const key = tree.bundle || tree.app;
		const view = deviceView(screen);
		const observation = observe === 'full' ? { lines: ['- Window:', '```yaml', ...renderPage(view, { unfold }), '```'] } : observePage(this.seen.get(key), view, undefined, unfold);
		this.seen.set(key, view);
		const others = tree.windows.filter(title => title && title !== tree.window);
		return [
			`- App: ${tree.app} (${tree.bundle}) · window ${JSON.stringify(tree.window ?? '')}${others.length ? ` · other windows: ${others.slice(0, 8).map(title => JSON.stringify(title)).join(', ')}` : ''}${tree.truncated ? ' · long window: read in part' : ''}`,
			...observation.lines.map(line => line.replace(/^- Page Snapshot:$/, '- Window:').replace(/^- Page changes since your last view/, '- Window changes since your last read').replace(/^- Page: unchanged since your last view of it\.$/, '- Window: unchanged since your last read.')),
		];
	}

	private projectFolder(call: IVoltHostToolCall | undefined): string | undefined {
		return call?.cwd ?? (call?.sessionId ? this.runtime.getOrCreateSession(call.sessionId).worktreePath : undefined) ?? this.workspace.getWorkspace().folders[0]?.uri.fsPath;
	}

	private async invoke(name: VoltDesktopToolName, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		if (name === 'desktop_apps') {
			const status = await this.desktop.status(false);
			if (!status.supported) {
				return { error: status.error ?? 'Desktop control works on macOS for now.' };
			}
			const apps = await this.desktop.apps();
			return {
				text: [
					`### Apps on this Mac${status.trusted ? '' : ' (Volt cannot control them yet: it needs the Accessibility permission)'}`,
					...apps.map(app => `- ${app.name} (${app.bundle})${app.active ? ' · in front' : ''}${app.hidden ? ' · hidden' : ''}`),
				].join('\n'),
			};
		}
		const blocked = await this.ready();
		if (blocked) {
			return { error: blocked };
		}
		if (name === 'desktop_snapshot') {
			const tree = await this.desktop.tree({ app: str(args.app), window: str(args.window) });
			const screen = this.screenOf(tree);
			return { text: [`### Window of ${tree.app}`, ...this.windowLines(tree, screen, 'full', args.unfold === true)].join('\n') };
		}
		return this.act(args, call);
	}

	private async act(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const root = this.projectFolder(call);
		const store = root ? fileFlowStore(this.fileService, URI.file(root)) : undefined;
		const input = await resolveActInput(args, store, 'desktop_act');
		if ('error' in input) {
			return { error: input.error };
		}
		let app = str(args.app);
		let lastTree: IVoltDesktopTree | undefined;
		let front = false;
		const desktop = this.desktop;
		// Keys go to the app in front: bring the target there before the first keyboard step.
		const keyboard = async (fn: () => Promise<void>) => {
			if (!front && app) {
				await desktop.act({ kind: 'activate', app });
				await timeout(150);
			}
			front = true;
			await fn();
		};
		const driver: IDeviceDriver = {
			platform: 'desktop',
			read: async () => {
				lastTree = await desktop.tree({ app });
				app ??= lastTree.bundle || lastTree.app;
				return this.screenOf(lastTree);
			},
			tap: (x, y) => desktop.act({ kind: 'click', x, y }),
			swipe: (x1, y1, x2, y2) => desktop.act({ kind: 'scroll', x: x1, y: Math.round((y1 + y2) / 2), dx: x1 - x2, dy: y1 - y2 }),
			type: text => keyboard(() => desktop.act({ kind: 'type', text })),
			clear: () => keyboard(async () => {
				await desktop.act({ kind: 'key', combo: 'cmd+a' });
				await desktop.act({ kind: 'key', combo: 'delete' });
			}),
			press: button => keyboard(() => desktop.act({ kind: 'key', combo: KEY_FOR_BUTTON[button] ?? button })),
			launch: async target => {
				await desktop.act({ kind: 'activate', app: target });
				// A URL opens in the user's browser: read whichever app came to the front.
				app = /^[a-z][a-z0-9+.-]*:/i.test(target) ? undefined : target;
				front = true;
				await timeout(500);
			},
			activate: async element => {
				await desktop.act({ kind: 'press', h: element.handle! });
				return true;
			},
			setText: async (element, text) => {
				await desktop.act({ kind: 'setValue', h: element.handle!, value: text });
				return true;
			},
			key: combo => keyboard(() => desktop.act({ kind: 'key', combo })),
			menu: path => desktop.act({ kind: 'menu', app, path }),
		};
		const runner = new DeviceActRunner(driver, call?.token ?? CancellationToken.None);
		const runs: IFlowRun[] = [];
		for (const plan of input.plans) {
			runs.push({ label: plan.label ?? 'flow', run: await runner.run(plan.steps) });
		}
		const ok = runs.every(entry => entry.run.ok);
		const single = input.plans.length === 1 && !input.plans[0].label;
		const tool = `desktop_act${lastTree ? ` on ${lastTree.app}` : ''}`;
		const lines = single ? formatActRun(runs[0].run, tool, { brief: args.observe === 'on_failure' && ok }) : formatFlowRuns(runs, tool);
		if (single && input.save && store) {
			const refused = ok ? unsafeToSave(runs[0].run, args.vars as Record<string, string> | undefined) : 'the run did not pass';
			lines.push(refused ? `- Not saved as flow ${input.save.name}: ${refused}.` : `- Saved as flow ${input.save.name} (${(await store.write(input.save.name, input.save.script)).fsPath}): re-run it with {"run": "${input.save.name}"}.`);
		}
		const observe = args.observe === 'none' || (args.observe === 'on_failure' && ok) ? 'none' : args.observe === 'full' ? 'full' : 'auto';
		if (observe !== 'none' && (single || !ok)) {
			const tree = lastTree ?? await desktop.tree({ app }).catch(() => undefined);
			const screen = runner.last ?? (tree ? this.screenOf(tree) : undefined);
			if (tree && screen) {
				lines.push('', ...this.windowLines(tree, screen, observe));
			}
		}
		return { text: lines.join('\n') };
	}
}
