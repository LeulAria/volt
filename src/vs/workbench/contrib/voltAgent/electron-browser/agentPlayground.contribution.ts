/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IVoltPlayground, parsePlaygroundFiles, parsePlaygroundMocks } from '../../../../platform/voltBrowser/common/browserAgent.js';
import { IVoltBrowserService } from '../../../../platform/voltBrowser/common/voltBrowser.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AUTOMATE_BROWSER_COMMAND_ID, IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { PLAYGROUND_TOOLS, VoltPlaygroundToolName } from '../../../services/voltRuntime/common/playgroundTools.js';

function describe(playground: IVoltPlayground): string {
	return `${playground.id} "${playground.title}" ${playground.url} — ${playground.files.length} file(s): ${playground.files.slice(0, 12).join(', ')}${playground.files.length > 12 ? ', …' : ''}${playground.mocks ? `; ${playground.mocks} mock endpoint(s)` : ''}; ${playground.requests} request(s) served`;
}

/** Serves the playground_* host tools: throwaway pages in temp folders, opened in the chat's browser. */
class AgentPlaygroundContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentPlayground';

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IVoltBrowserService private readonly browser: IVoltBrowserService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this._register(hostTools.registerToolProvider({
			tools: PLAYGROUND_TOOLS,
			invoke: (name, args, call) => this.invoke(name as VoltPlaygroundToolName, args, call).catch((err): IVoltHostToolResult => ({ error: err instanceof Error ? err.message : String(err) })),
		}));
	}

	private async invoke(name: VoltPlaygroundToolName, args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const sessionId = call?.sessionId;
		if (!sessionId) {
			return { error: 'Playgrounds belong to a Volt chat; call this from one.' };
		}
		switch (name) {
			case 'playground_create': {
				const { files, errors } = parsePlaygroundFiles(args.files, args.html);
				const mocks = parsePlaygroundMocks(args.mocks);
				if (errors.length || mocks.errors.length) {
					return { error: `playground_create: ${[...errors, ...mocks.errors].join('; ')}` };
				}
				if (!files['index.html'] && !Object.keys(files).some(path => path.endsWith('.html'))) {
					return { error: 'playground_create needs a page: pass `html`, or `files` with an index.html.' };
				}
				const playground = await this.browser.createPlayground({ sessionId, title: typeof args.title === 'string' ? args.title : undefined, files, mocks: mocks.mocks });
				const entry = files['index.html'] ? '' : Object.keys(files).find(path => path.endsWith('.html')) ?? '';
				const keep = args.keep !== false;
				const lines = [`### Playground ${playground.id} created`, `- ${describe(playground)}`, `- Folder (outside the project): ${playground.dir}`];
				if (keep) {
					lines.push('- When it has served its purpose: playground_delete.');
				}
				if (args.open === false) {
					return { text: lines.join('\n') };
				}
				const result = Array.isArray(args.steps) && args.steps.length
					? await this.test(sessionId, `${playground.url}${entry}`, args, call, lines)
					: await this.open(sessionId, `${playground.url}${entry}`, args, call, lines);
				if (!keep) {
					const removed = await this.browser.deletePlaygrounds({ id: playground.id });
					return { ...result, text: `${result.text ?? ''}\n\n- keep: false: playground ${playground.id} ${removed.length ? 'deleted (server stopped, folder removed; nothing was written to the project)' : 'was already gone'}.` };
				}
				return result;
			}
			case 'playground_update': {
				const id = typeof args.id === 'string' ? args.id : '';
				const { files, errors } = parsePlaygroundFiles(args.files, args.html);
				const mocks = args.mocks !== undefined ? parsePlaygroundMocks(args.mocks) : undefined;
				if (errors.length || mocks?.errors.length) {
					return { error: `playground_update: ${[...errors, ...(mocks?.errors ?? [])].join('; ')}` };
				}
				const playground = await this.browser.updatePlayground({ id, files, remove: Array.isArray(args.remove) ? args.remove.map(String) : undefined, mocks: mocks?.mocks });
				const lines = [`### Playground ${playground.id} updated`, `- ${describe(playground)}`];
				if (args.reload === false) {
					return { text: lines.join('\n') };
				}
				if (Array.isArray(args.steps) && args.steps.length) {
					const run = await this.commands.executeCommand<IVoltHostToolResult>(AUTOMATE_BROWSER_COMMAND_ID, sessionId, 'browser_run', { steps: [{ action: 'reload' }, ...args.steps], snapshot: 'none' }, { token: call?.token });
					return { text: [...lines, '', run?.text ?? run?.error ?? ''].join('\n').trim(), ...(run?.image ? { image: run.image } : {}) };
				}
				const reloaded = await this.commands.executeCommand<IVoltHostToolResult>(AUTOMATE_BROWSER_COMMAND_ID, sessionId, 'browser_reload', { snapshot: 'diff' }, { token: call?.token });
				return { text: [...lines, '', reloaded?.text ?? reloaded?.error ?? ''].join('\n').trim() };
			}
			case 'playground_list': {
				const list = await this.browser.listPlaygrounds(sessionId);
				return { text: list.length ? ['### Playgrounds', ...list.map(pg => `- ${describe(pg)}`)].join('\n') : 'This chat has no playgrounds.' };
			}
			case 'playground_delete': {
				const id = typeof args.id === 'string' ? args.id.trim() : '';
				if (!id && args.all !== true) {
					return { error: 'playground_delete needs an `id` (or all: true for every playground of this chat).' };
				}
				if (id && !(await this.browser.listPlaygrounds(sessionId)).some(pg => pg.id === id)) {
					return { error: `This chat has no playground ${id}.` };
				}
				const removed = await this.browser.deletePlaygrounds(id ? { id } : { sessionId });
				return { text: removed.length ? `Deleted ${removed.length} playground(s): ${removed.map(pg => pg.id).join(', ')} (servers stopped, folders removed).` : 'Nothing to delete.' };
			}
		}
	}

	/** Opens the playground and runs the agent's browser_run steps on it in the same call. */
	private async test(sessionId: string, url: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined, lines: string[]): Promise<IVoltHostToolResult> {
		const steps = [
			...(typeof args.width === 'number' ? [{ action: 'resize', width: args.width, height: typeof args.height === 'number' ? args.height : (args.width <= 480 ? 844 : 900) }] : []),
			...(args.steps as unknown[]),
		];
		const run = await this.commands.executeCommand<IVoltHostToolResult>(AUTOMATE_BROWSER_COMMAND_ID, sessionId, 'browser_run', { url, steps, snapshot: 'none', ...(args.screenshot === true ? { screenshot: true } : {}) }, { token: call?.token });
		if (run?.error) {
			lines.push(`- The steps did not run: ${run.error}`);
		}
		return { text: [...lines, '', run?.text ?? ''].join('\n').trim(), ...(run?.image ? { image: run.image } : {}) };
	}

	/** Opens the playground in the chat's browser (at a fixed size when asked) and returns the page state. */
	private async open(sessionId: string, url: string, args: Record<string, unknown>, call: IVoltHostToolCall | undefined, lines: string[]): Promise<IVoltHostToolResult> {
		const options = { token: call?.token };
		const opened = await this.commands.executeCommand<IVoltHostToolResult>(AUTOMATE_BROWSER_COMMAND_ID, sessionId, 'browser_navigate', { url }, options);
		let state = opened;
		if (!opened?.error && typeof args.width === 'number') {
			state = await this.commands.executeCommand<IVoltHostToolResult>(AUTOMATE_BROWSER_COMMAND_ID, sessionId, 'browser_resize', { width: args.width, height: typeof args.height === 'number' ? args.height : (args.width <= 480 ? 844 : 900), snapshot: 'full' }, options);
		}
		if (state?.error) {
			lines.push(`- Could not open it in the browser: ${state.error}`);
		}
		return { text: [...lines, '', state?.text ?? ''].join('\n').trim() };
	}
}

registerWorkbenchContribution2(AgentPlaygroundContribution.ID, AgentPlaygroundContribution, WorkbenchPhase.AfterRestored);
