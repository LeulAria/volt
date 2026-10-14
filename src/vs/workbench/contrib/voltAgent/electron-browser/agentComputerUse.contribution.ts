/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IVoltCaptureService } from '../../../../platform/voltCapture/common/voltCapture.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { COMPUTER_TOOLS, COMPUTER_USE_SETTING, formatComputerTree, IComputerNode, parseComputerActions, pickApp, VoltComputerToolName } from '../../../services/voltRuntime/common/computerTools.js';
import { IVoltHostToolResult, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.computerUse',
	title: localize('voltComputerUse.title', "Volt Computer Use"),
	type: 'object',
	properties: {
		[COMPUTER_USE_SETTING]: {
			type: 'boolean',
			default: false,
			markdownDescription: localize('voltComputerUse.enabled', "Let agents read and operate other apps on this Mac (accessibility tree, clicks, typing) with the `computer_*` tools. macOS also asks you to give Volt Accessibility access. Agents in Ask and Plan mode still need your approval for every action."),
		},
	},
});

interface IApp { readonly name: string; readonly bundleId: string; readonly pid: number; readonly active?: boolean; readonly hidden?: boolean }

const PERMISSION_HINT = 'Volt does not have macOS Accessibility access yet. Call computer_status with request: true; macOS then asks the user to allow Volt (System Settings → Privacy & Security → Accessibility). Continue once they have.';

class AgentComputerUseContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentComputerUse';

	private readonly provider = this._register(new MutableDisposable());

	constructor(
		@IVoltHostToolService private readonly hostTools: IVoltHostToolService,
		@IVoltCaptureService private readonly capture: IVoltCaptureService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this.update();
		this._register(configuration.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(COMPUTER_USE_SETTING)) {
				this.update();
			}
		}));
	}

	private update(): void {
		if (!this.configuration.getValue<boolean>(COMPUTER_USE_SETTING)) {
			this.provider.clear();
			return;
		}
		if (!this.provider.value) {
			this.provider.value = this.hostTools.registerToolProvider({
				tools: COMPUTER_TOOLS,
				invoke: (name, args) => this.invoke(name as VoltComputerToolName, args).catch((err): IVoltHostToolResult => ({ error: err instanceof Error ? err.message : String(err) })),
			});
		}
	}

	private async run(command: Record<string, unknown>): Promise<Record<string, unknown>> {
		const result = await this.capture.computer(command);
		if (result.error === 'accessibility') {
			throw new Error(PERMISSION_HINT);
		}
		if (typeof result.error === 'string') {
			throw new Error(result.error === 'stale' ? 'That element id is gone (the UI changed). Call computer_ui again and use a current id.' : result.error);
		}
		return result;
	}

	private async app(query: unknown): Promise<IApp> {
		const apps = (await this.run({ op: 'apps' })).apps as IApp[];
		const found = pickApp(apps, typeof query === 'string' ? query : typeof query === 'number' ? String(query) : undefined);
		if (!found) {
			throw new Error(`No running app matches ${JSON.stringify(query)}. Running: ${apps.map(app => app.name).join(', ')}.`);
		}
		return found;
	}

	private async tree(app: IApp, maxDepth: number, filter?: string): Promise<string> {
		const result = await this.run({ op: 'tree', pid: app.pid, maxDepth });
		return formatComputerTree(`${app.name} — ${String(result.title ?? '') || 'front window'}`, result.nodes as IComputerNode[], result.truncated === true, filter);
	}

	private async invoke(name: VoltComputerToolName, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
		switch (name) {
			case 'computer_status': {
				const s = await this.capture.computer({ op: 'status', request: args.request === true });
				if (typeof s.error === 'string') {
					return { error: s.error };
				}
				const screen = s.screen as { w: number; h: number } | undefined;
				return {
					text: [
						'### Computer access',
						`- Accessibility (read and operate apps): ${s.accessibility ? 'granted' : 'not granted'}`,
						`- Screen Recording (window_capture of other apps): ${s.screenRecording ? 'granted' : 'not granted'}`,
						`- Frontmost app: ${s.frontmost} (pid ${s.frontmostPid})`,
						screen ? `- Screen: ${screen.w}×${screen.h} points` : '',
						!s.accessibility ? (args.request === true ? '- macOS is asking the user now; call computer_status again after they answer.' : '- Call again with request: true to ask the user.') : '',
					].filter(Boolean).join('\n'),
				};
			}
			case 'computer_apps': {
				const apps = (await this.run({ op: 'apps' })).apps as IApp[];
				return { text: ['### Running apps', ...apps.map(app => `- ${app.name}${app.active ? ' (frontmost)' : ''}${app.hidden ? ' (hidden)' : ''} — ${app.bundleId}, pid ${app.pid}`)].join('\n') };
			}
			case 'computer_ui': {
				const app = await this.app(args.app);
				const depth = typeof args.max_depth === 'number' ? Math.max(1, Math.min(30, args.max_depth)) : 12;
				return { text: await this.tree(app, depth, typeof args.filter === 'string' ? args.filter : undefined) };
			}
			case 'computer_act': {
				const app = await this.app(args.app);
				const id = typeof args.id === 'string' ? args.id.trim() : '';
				const action = typeof args.action === 'string' ? args.action : '';
				if (!id || !action) {
					return { error: 'computer_act needs `id` (from computer_ui) and `action`.' };
				}
				const result = await this.run({ op: 'act', pid: app.pid, id, action, value: typeof args.value === 'string' ? args.value : undefined });
				await timeout(250);
				const after = await this.tree(app, 12).catch(() => '');
				const near = after.split('\n').filter(line => line.includes(`[${id}`)).slice(0, 12);
				return { text: [`### ${action} on ${id} in ${app.name}: ${result.ok ? 'done' : `the app refused it (AX error ${result.code})`}`, ...(near.length ? ['Element now:', ...near] : ['The element is gone now (the UI changed); call computer_ui to see the new state.'])].join('\n') };
			}
			case 'computer_input': {
				const { actions, errors } = parseComputerActions(args.actions);
				if (errors.length) {
					return { error: `computer_input did not run: ${errors.join('; ')}` };
				}
				const app = args.app !== undefined ? await this.app(args.app) : undefined;
				const result = await this.run({ op: 'input', pid: app?.pid, actions });
				const cursor = result.cursor as { x: number; y: number } | undefined;
				return { text: `### Ran ${result.done} input step(s)${app ? ` in ${app.name}` : ''}\n- Frontmost app now: ${result.frontmost}\n- Cursor at ${cursor?.x}, ${cursor?.y}\n- Check the result with computer_ui or window_capture.` };
			}
		}
	}
}

registerWorkbenchContribution2(AgentComputerUseContribution.ID, AgentComputerUseContribution, WorkbenchPhase.AfterRestored);
