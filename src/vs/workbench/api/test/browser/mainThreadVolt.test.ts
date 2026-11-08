/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt extension API (`vscode.volt`): ExtHostVolt <-> MainThreadVolt round trips per namespace,
// identity (EXT-ID-1..3), the capability policy end to end (EXT-API-CAP-1..6) and consent.

import assert from 'assert';
import type * as vscode from 'vscode';
import { mainWindow } from '../../../../base/browser/window.js';
import { timeout } from '../../../../base/common/async.js';
import { transformErrorForSerialization, transformErrorFromSerialization } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { TestInstantiationService } from '../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { InMemoryStorageService } from '../../../../platform/storage/common/storage.js';
import { IVoltUsageService, IVoltUsageSnapshot } from '../../../../platform/voltUsage/common/voltUsage.js';
import { setShownAgentChat } from '../../../contrib/voltAgent/browser/editor/agentShownChat.js';
import { OPEN_BROWSER_COMMAND_ID } from '../../../contrib/voltAgent/browser/preview/browserEditorInput.js';
import { IAgentPullRequestService } from '../../../contrib/voltAgent/browser/pullRequests/agentPullRequestService.js';
import { IAgentPrLink } from '../../../contrib/voltAgent/common/agentPullRequests.js';
import { IVoltFeatureService } from '../../../contrib/voltCustomize/common/voltFeatures.js';
import { isFirstPartyExtension, VoltExtensionApiService, voltCapabilityFeatureId } from '../../../contrib/voltCustomize/browser/voltExtensionApiService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IExtensionFeaturesManagementService } from '../../../services/extensionManagement/common/extensionFeatures.js';
import { ExtensionNotInHostError } from '../../../services/extensions/common/extHostCustomers.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ExtensionsProposedApi } from '../../../services/extensions/common/extensionsProposedApi.js';
import { VoltCapabilityError } from '../../../services/voltPlugins/common/capabilities.js';
import { IVoltExtensionApiService } from '../../../services/voltPlugins/common/voltExtensionApi.js';
import { IAutomation, IAutomationCreateInput, IAutomationRun, IAutomationService } from '../../../services/voltRuntime/common/automations/automations.js';
import { OPEN_AUTOMATIONS_COMMAND_ID } from '../../../contrib/voltAutomations/common/voltAutomations.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../services/voltRuntime/common/runtime.js';
import { IAgentCustomization } from '../../../contrib/voltAgent/browser/customize/agentCustomize.js';
import { IAgentCustomizeService } from '../../../contrib/voltAgent/browser/customize/agentCustomizeService.js';
import { OPEN_SKILLS_COMMAND_ID, OPEN_SKILLS_MARKETPLACE_COMMAND_ID } from '../../../contrib/voltSkills/common/voltSkills.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { BROWSER_PAGE_URL_COMMAND_ID, IVoltHostToolCall, IVoltHostToolProvider, IVoltHostToolResult, IVoltHostToolService } from '../../../services/voltRuntime/common/hostTools.js';
import { IVoltMemory, IVoltMemoryDraft, IVoltMemoryService } from '../../../services/voltRuntime/common/memory/voltMemory.js';
import { IAgentOrchestratorService, IOrchChange, IOrchState, IOrchThread } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IVoltSessionContextService } from '../../../services/voltRuntime/common/sessionContext.js';
import { MainThreadVolt } from '../../browser/mainThreadVolt.js';
import { ExtHostContext, MainContext } from '../../common/extHost.protocol.js';
import { ExtHostVolt, restoreVoltCapabilityError } from '../../common/extHostVolt.js';
import { TestRPCProtocol } from '../common/testRPCProtocol.js';

/** Everything a third party could ask for, declared; the medium and high ones still need consent. */
const ACME_CONTRIBUTES = {
	configuration: { properties: { 'acme.notes.width': { type: 'number' } } },
	voltTools: [
		{ name: 'notes_search', class: 'safe', description: 'Searches notes.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
		{ name: 'notes_chart', class: 'safe' },
		{ name: 'notes_write', class: 'writes' },
		{ name: 'memory_write', class: 'persists' },
	],
	voltCapabilities: {
		required: [{ id: 'tools.register', class: 'low' }, { id: 'agents.read:current', class: 'low' }, { id: 'usage.report', class: 'low' }],
		optional: [
			{ id: 'agents.read:any', class: 'medium', reason: 'Lists your chats in the sidebar.' }, { id: 'agents.send', class: 'medium' }, { id: 'agents.create', class: 'high' },
			{ id: 'agents.context', class: 'high' }, { id: 'browser.read', class: 'medium' }, { id: 'browser.drive', class: 'high' },
			{ id: 'automations.schedule', class: 'high' }, { id: 'hosting.read', class: 'medium' }, { id: 'files.write', class: 'medium' },
			{ id: 'spawn.unsandboxed', class: 'critical' },
		],
	},
};

const CHAT: IAgentSessionMeta = { id: 'chat-1', title: 'Fix the login page', createdAt: 1, updatedAt: 2, workspaceId: 'w', workspaceLabel: 'app', workspaceFolder: '/repo/app', turnCount: 3, preview: 'fix', status: 'idle' } as IAgentSessionMeta;

function description(id: string, options: { readonly builtin?: boolean; readonly contributes?: object; readonly proposals?: string[] } = {}): IExtensionDescription {
	const [publisher, name] = id.split('.');
	const value: Partial<IExtensionDescription> = {
		identifier: new ExtensionIdentifier(id), publisher, name, displayName: name.charAt(0).toUpperCase() + name.slice(1), version: '1.0.0', engines: { vscode: '*' },
		isBuiltin: !!options.builtin, isUserBuiltin: false, isUnderDevelopment: false, extensionLocation: URI.file(`/ext/${id}`), targetPlatform: undefined!,
		enabledApiProposals: options.proposals ?? ['volt'],
		contributes: options.contributes as IExtensionDescription['contributes'],
	};
	return value as IExtensionDescription;
}

class FakeFeatures extends mock<IExtensionFeaturesManagementService>() {
	readonly states = new Map<string, boolean>();
	readonly emitter = new Emitter<{ readonly extension: ExtensionIdentifier; readonly featureId: string; readonly enabled: boolean }>();
	override readonly onDidChangeEnablement = this.emitter.event;
	override getEnablementData(featureId: string) {
		return [...this.states].filter(([key]) => key.startsWith(`${featureId}\u0000`)).map(([key, enabled]) => ({ extension: new ExtensionIdentifier(key.split('\u0000')[1]), enabled }));
	}
	override setEnablement(extension: ExtensionIdentifier, featureId: string, enabled: boolean): void {
		this.states.set(`${featureId}\u0000${extension.value}`, enabled);
		this.emitter.fire({ extension, featureId, enabled });
	}
}

suite('Volt extension API (vscode.volt)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let container: HTMLElement;

	setup(() => {
		container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		setShownAgentChat('chat-1');
	});

	teardown(() => {
		container.remove();
		setShownAgentChat(undefined);
	});

	/** One extension host running `hosted`, over a renderer that knows `extensions`. */
	function host(extensions: IExtensionDescription[], hosted: readonly string[]) {
		const rpc = store.add(new TestRPCProtocol());
		rpc.hostsExtension = id => hosted.some(own => ExtensionIdentifier.equals(own, typeof id === 'string' ? id : id.value));

		const providers = new Set<IVoltHostToolProvider>();
		const invoked: { name: string; args: unknown; call?: IVoltHostToolCall }[] = [];
		const hostTools = new class extends mock<IVoltHostToolService>() {
			override registerToolProvider(provider: IVoltHostToolProvider) {
				providers.add(provider);
				return toDisposable(() => providers.delete(provider));
			}
			override async invokeTool(name: string, input?: unknown, call?: IVoltHostToolCall): Promise<IVoltHostToolResult> {
				invoked.push({ name, args: input, call });
				if (name === 'render_chart') {
					return { text: 'Rendered 1 chart.', visual: { kind: 'chart', ref: 'volt-attachment:abc.json', title: 'Notes per week' } };
				}
				if (name === 'browser_snapshot') {
					return { text: '- heading "Sign in"' };
				}
				return { text: `ran ${name}` };
			}
		};
		const commands: { id: string; args: unknown[] }[] = [];
		const commandService = new class extends mock<ICommandService>() {
			override async executeCommand<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
				commands.push({ id, args });
				return (id === BROWSER_PAGE_URL_COMMAND_ID ? 'https://app.example.com/login' : undefined) as T | undefined;
			}
		};
		const features = new FakeFeatures();
		store.add(features.emitter);
		const extensionService = new class extends mock<IExtensionService>() {
			override readonly extensions = extensions;
			override readonly onDidChangeExtensions = Event.None;
		};

		const memories = new Map<string, IVoltMemory>();
		const automations: IAutomation[] = [];
		const threads: Record<string, IOrchThread> = {};
		const orchestratorChanges = store.add(new Emitter<IOrchChange>());
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IAgentHistoryService, new class extends mock<IAgentHistoryService>() {
			override readonly whenReady = Promise.resolve();
			override list() { return [CHAT]; }
			override search() { return []; }
			override get(id: string) { return id === CHAT.id ? CHAT : undefined; }
		});
		instantiation.stub(IVoltMemoryService, new class extends mock<IVoltMemoryService>() {
			override async list() { return [...memories.values()]; }
			override async read(name: string) { return memories.get(name); }
			override async write(draft: IVoltMemoryDraft) {
				const note: IVoltMemory = { name: draft.name, description: draft.description, body: draft.body, type: draft.type ?? 'project', scope: draft.scope ?? 'user', resource: URI.file(`/m/${draft.name}.md`) };
				memories.set(draft.name, note);
				return note;
			}
			override async delete(name: string) { return memories.delete(name); }
		});
		instantiation.stub(IAutomationService, new class extends mock<IAutomationService>() {
			override readonly whenReady = Promise.resolve();
			override list() { return automations; }
			override async create(input: IAutomationCreateInput) {
				const automation = { ...input, id: `a${automations.length + 1}`, createdAt: 1, updatedAt: 1, createdBy: 'You', nextRuns: { [input.triggers![0].id]: 1_000 }, runs: [], runCount: 0 } as IAutomation;
				automations.push(automation);
				return automation;
			}
			override get(id: string) { return automations.find(automation => automation.id === id); }
			override async runNow(id: string) { return [{ id: `r-${id}`, at: 1, status: 'running', provider: 'manual', label: 'Run now', threadId: 'chat-9' } as IAutomationRun]; }
			override async delete(id: string) { automations.splice(automations.findIndex(automation => automation.id === id), 1); }
		});
		instantiation.stub(IAgentCustomizeService, new class extends mock<IAgentCustomizeService>() {
			override async getItems(): Promise<readonly IAgentCustomization[]> {
				return [
					{ kind: 'skill', scope: 'user', name: 'release-notes', description: 'Writes release notes.', resource: URI.file('/home/me/.claude/skills/release-notes/SKILL.md'), source: '~/.claude', origin: 'claude' },
					{ kind: 'mcp', scope: 'workspace', name: 'linear', description: 'Linear issues.', resource: URI.file('/repo/app/.mcp.json'), source: 'app', mcp: { command: 'npx', env: { LINEAR_TOKEN: 'secret' } }, plugin: { id: 'claude:linear@acme', name: 'linear', displayName: 'Linear', publisher: 'Acme' } } as unknown as IAgentCustomization,
					{ kind: 'memory', scope: 'user', name: 'prefers small diffs', description: 'How to change code', resource: URI.file('/m/x.md'), source: 'Volt' },
				];
			}
		});
		instantiation.stub(IVoltUsageService, new class extends mock<IVoltUsageService>() {
			override async getUsage(): Promise<IVoltUsageSnapshot> {
				const bucket = { provider: 'claude' as const, model: 'claude-opus-5', hour: 0, uncached: 100, cached: 50, cacheWrite: 10, output: 40, costUsd: 1.5, savingsUsd: 0, unpriced: false };
				return { generatedAt: 9, sinceMs: 1, buckets: [bucket, { ...bucket, costUsd: 0.5 }], activity: [], sessionCount: 4, notes: [], pricingSource: 'test' } as unknown as IVoltUsageSnapshot;
			}
		});
		instantiation.stub(IAgentPullRequestService, new class extends mock<IAgentPullRequestService>() {
			override links(chatId: string): readonly IAgentPrLink[] {
				return chatId === 'chat-1' ? [{ key: 'k', repo: { host: 'github.com', owner: 'acme', name: 'app' }, number: 12, url: 'https://github.com/acme/app/pull/12', source: 'agent', linkedAt: 1, watch: {} } as unknown as IAgentPrLink] : [];
			}
		});
		instantiation.stub(IAgentOrchestratorService, new class extends mock<IAgentOrchestratorService>() {
			override readonly onDidChange = orchestratorChanges.event;
			override getState() { return { threads } as unknown as IOrchState; }
			override getThread(id: string) { return threads[id]; }
		});
		instantiation.stub(IVoltSessionContextService, new class extends mock<IVoltSessionContextService>() {
			override readonly activeProject = undefined;
		});
		const layoutService = new class extends mock<ILayoutService>() {
			override get activeContainer() { return container; }
		};
		const api = store.add(new VoltExtensionApiService(
			hostTools, store.add(new InMemoryStorageService()), new TestConfigurationService({ acme: { notes: { width: 320 } } }), commandService,
			new class extends mock<IVoltFeatureService>() { override isOn() { return true; } }, features, extensionService, instantiation, layoutService, new NullLogService(),
		));
		instantiation.stub(IVoltExtensionApiService, api);

		const extHost = new ExtHostVolt(rpc, new NullLogService());
		rpc.set(ExtHostContext.ExtHostVolt, extHost);
		const main = store.add(new MainThreadVolt(rpc, extensionService, instantiation, new NullLogService()));
		rpc.set(MainContext.MainThreadVolt, main);
		const configChanges = store.add(new Emitter<vscode.ConfigurationChangeEvent>());
		const voltFor = (id: string) => extHost.createApi(extensions.find(extension => extension.identifier.value === id)!, configChanges.event);
		const grant = (id: string, ...capabilities: string[]) => capabilities.forEach(capability => features.setEnablement(new ExtensionIdentifier(id), voltCapabilityFeatureId(capability), true));

		/** An agent in `chatId` calls a tool an extension serves. */
		const agentCalls = (name: string, args: Record<string, unknown>, chatId = 'chat-1') => {
			const provider = [...providers].find(candidate => candidate.tools.some(tool => tool.name === name));
			assert.ok(provider, `${name} is served`);
			return provider.invoke(name, args, { sessionId: chatId });
		};
		const turn = (id: string, thread: Partial<IOrchThread>) => {
			threads[id] = { id, rootId: id, depth: 0, createdAt: 0, queue: [], inputs: [], turns: 1, handoffs: [], ...thread } as IOrchThread;
			orchestratorChanges.fire({ threads: [id], tasks: [] });
		};
		return { rpc, api, features, voltFor, grant, providers, invoked, commands, memories, automations, agentCalls, turn };
	}

	const acme = () => description('acme.notes', { contributes: ACME_CONTRIBUTES });

	/** Waits for the consent dialog and answers it. */
	async function answerConsent(allow: boolean): Promise<string> {
		for (let i = 0; i < 100; i++) {
			const button = container.querySelector<HTMLElement>(`.volt-extension-consent .${allow ? 'allow' : 'deny'}`);
			if (button) {
				const title = container.querySelector('.volt-extension-consent h2')?.textContent ?? '';
				button.click();
				return title;
			}
			await timeout(1);
		}
		throw new Error('no consent dialog');
	}

	async function refusal(promise: Thenable<unknown>): Promise<VoltCapabilityError> {
		try {
			await promise;
		} catch (err) {
			assert.ok(err instanceof Error && err.name === 'VoltCapabilityError', `expected a VoltCapabilityError, got ${err}`);
			return err as VoltCapabilityError;
		}
		assert.fail('expected a refusal');
	}

	// --- Round trips ------------------------------------------------------------------------------

	test('EXT-RT-chats: list, current, read, send, start and turn events', async () => {
		const h = host([acme()], ['acme.notes']);
		h.grant('acme.notes', 'agents.read:any', 'agents.send', 'agents.create');
		const volt = h.voltFor('acme.notes');
		assert.deepStrictEqual(await volt.chats.list(), [{ id: 'chat-1', title: 'Fix the login page', status: 'idle', createdAt: 1, updatedAt: 2, turnCount: 3, project: '/repo/app' }]);
		assert.strictEqual((await volt.chats.current())?.id, 'chat-1');
		assert.strictEqual((await volt.chats.read('chat-1')).text, 'ran thread_read');
		assert.strictEqual((await volt.chats.send('chat-1', 'Run the tests')).text, 'ran thread_send');
		assert.strictEqual((await volt.chats.start({ title: 'Release notes', message: 'Draft them' })).text, 'ran thread_launch');
		// Thread tools see the extension as an outside caller under its own name, never as a chat.
		const send = h.invoked.find(call => call.name === 'thread_send')!;
		assert.deepStrictEqual(send.args, { thread_id: 'chat-1', message: 'Run the tests' });
		assert.strictEqual(send.call?.sessionId, undefined);
		assert.deepStrictEqual([send.call?.external?.clientId, send.call?.external?.name, send.call?.source], ['extension:acme.notes', 'Notes (extension)', 'native']);

		const events: string[] = [];
		const started = volt.chats.onDidStartTurn(e => events.push(`start ${e.chatId} ${e.turnId} ${e.kind}`));
		const finished = volt.chats.onDidEndTurn(e => events.push(`finish ${e.chatId} ${e.turnId} ${e.outcome}`));
		await h.rpc.sync();
		h.turn('chat-1', { active: { id: 't1', kind: 'prompt', prompt: { text: 'x' }, at: 1, phase: 'running' } as IOrchThread['active'] });
		h.turn('chat-1', { last: { turnId: 't1', kind: 'prompt', outcome: 'done', at: 2 } });
		await h.rpc.sync();
		assert.deepStrictEqual(events, ['start chat-1 t1 prompt', 'finish chat-1 t1 done']);
		started.dispose();
		finished.dispose();
		await h.rpc.sync();
		h.turn('chat-1', { active: { id: 't2', kind: 'prompt', prompt: { text: 'y' }, at: 3, phase: 'running' } as IOrchThread['active'] });
		await h.rpc.sync();
		assert.strictEqual(events.length, 2, 'no events after the last listener left');
	});

	test('EXT-RT-tools: an extension tool round trip, and Volt tools invoked by an extension', async () => {
		const h = host([acme()], ['acme.notes']);
		h.grant('acme.notes', 'agents.send');
		const volt = h.voltFor('acme.notes');
		const seen: { input: unknown; chatId?: string }[] = [];
		const registration = volt.tools.registerTool('notes_search', (input, call) => {
			seen.push({ input, chatId: call.chatId });
			return { text: `found 2 notes for ${input.query}` };
		});
		await h.rpc.sync();
		const info = [...h.providers].flatMap(provider => provider.tools).find(tool => tool.name === 'notes_search');
		assert.deepStrictEqual(info?.inputSchema, { type: 'object', properties: { query: { type: 'string' } } }, 'the manifest\'s schema');
		assert.deepStrictEqual(await h.agentCalls('notes_search', { query: 'login' }), { text: 'found 2 notes for login' });
		assert.deepStrictEqual(seen, [{ input: { query: 'login' }, chatId: 'chat-1' }]);
		registration.dispose();
		await h.rpc.sync();
		assert.strictEqual([...h.providers].length, 0, 'unregistered');

		// Volt's own tools: `agents.send` plus the class (render_chart is safe).
		assert.strictEqual((await volt.tools.invokeTool('scratch_read', {}, { chatId: 'chat-1' })).text, 'ran scratch_read');
		assert.strictEqual(h.invoked.at(-1)?.call?.sessionId, 'chat-1');
		// An escaping tool never runs through the API.
		assert.strictEqual((await refusal(volt.tools.invokeTool('rename_branch', { name: 'x' }))).deniedBy, 'critical');
		assert.strictEqual((await refusal(volt.tools.invokeTool('acme_private_tool', {}))).deniedBy, 'critical');
		assert.ok(!h.invoked.some(call => call.name === 'rename_branch' || call.name === 'acme_private_tool'));
	});

	test('EXT-RT-storage+settings: own storage and own settings', async () => {
		const h = host([acme()], ['acme.notes']);
		const volt = h.voltFor('acme.notes');
		await volt.storage.set('draft', { lines: 2 });
		assert.deepStrictEqual(await volt.storage.get('draft'), { lines: 2 });
		assert.deepStrictEqual(await volt.storage.keys(), ['draft']);
		await volt.storage.delete('draft');
		assert.deepStrictEqual(await volt.storage.keys(), []);
		assert.strictEqual(await volt.settings.get('acme.notes.width'), 320);
		// Volt's or another extension's settings are not handed out.
		assert.strictEqual((await refusal(volt.settings.get('volt.agent.defaultModel'))).deniedBy, 'critical');
	});

	test('EXT-RT-memory: list, write, read, delete', async () => {
		const h = host([acme()], ['acme.notes']);
		h.grant('acme.notes', 'agents.read:any', 'agents.context');
		const volt = h.voltFor('acme.notes');
		const note = await volt.memory.write({ name: 'prefers small diffs', description: 'How to change code', body: 'Keep diffs small.', type: 'feedback' });
		assert.deepStrictEqual(note, { name: 'prefers small diffs', description: 'How to change code', type: 'feedback', body: 'Keep diffs small.', scope: 'user' }, 'no file path crosses');
		assert.deepStrictEqual((await volt.memory.list()).map(entry => entry.name), ['prefers small diffs']);
		assert.strictEqual((await volt.memory.read('prefers small diffs'))?.body, 'Keep diffs small.');
		assert.strictEqual(await volt.memory.delete('prefers small diffs'), true);
		assert.strictEqual(h.memories.size, 0);
	});

	test('EXT-RT-browser: open a URL, read the page of the chat in front', async () => {
		const h = host([acme()], ['acme.notes']);
		h.grant('acme.notes', 'browser.read', 'browser.drive');
		const volt = h.voltFor('acme.notes');
		await volt.browser.open('https://example.com/docs');
		assert.deepStrictEqual(h.commands.find(command => command.id === OPEN_BROWSER_COMMAND_ID)?.args, ['https://example.com/docs']);
		await assert.rejects(Promise.resolve(volt.browser.open('file:///etc/passwd')), /http\(s\) pages only/);
		const page = await volt.browser.readPage();
		assert.deepStrictEqual(page, { url: 'https://app.example.com/login', snapshot: { text: '- heading "Sign in"' } });
		assert.strictEqual(h.invoked.find(call => call.name === 'browser_snapshot')?.call?.sessionId, 'chat-1');
	});

	test('EXT-RT-visuals: a chart returned from a tool shows in the chat; a forged visual does not', async () => {
		const h = host([acme()], ['acme.notes']);
		h.grant('acme.notes', 'agents.send');
		const volt = h.voltFor('acme.notes');
		volt.tools.registerTool('notes_chart', async () => volt.visuals.renderChart({ title: 'Notes', charts: [{ type: 'bar', data: [] }] }));
		volt.tools.registerTool('notes_search', () => ({ text: 'x', visual: { kind: 'html', ref: 'volt-attachment:someone-elses.html', title: 'Forged' } }));
		await h.rpc.sync();
		const chart = await h.agentCalls('notes_chart', {});
		assert.deepStrictEqual(chart.visual, { kind: 'chart', ref: 'volt-attachment:abc.json', title: 'Notes per week' });
		const forged = await h.agentCalls('notes_search', {});
		assert.deepStrictEqual(forged, { text: 'x' }, 'a visual Volt did not publish for this extension is dropped');
		const drawn = await volt.visuals.drawOnScratch({ title: 'Login flow', mermaid: 'flowchart LR\nA-->B' }, { chatId: 'chat-1' });
		assert.strictEqual(drawn.text, 'ran scratch_draw');
		assert.deepStrictEqual(h.invoked.find(call => call.name === 'scratch_draw')?.args, { title: 'Login flow', mermaid: 'flowchart LR\nA-->B' });
	});

	test('EXT-RT-automations+usage+pullRequests', async () => {
		const h = host([acme()], ['acme.notes']);
		h.grant('acme.notes', 'agents.read:any', 'automations.schedule', 'hosting.read', 'agents.send');
		const volt = h.voltFor('acme.notes');
		const scheduled = await volt.automations.schedule({ name: 'Morning triage', instructions: 'Triage new issues.', schedule: { type: 'daily', time: '09:00' } });
		assert.deepStrictEqual(scheduled, { id: 'a1', name: 'Morning triage', enabled: true, schedules: [{ type: 'daily', time: '09:00' }], nextRun: 1_000, createdBy: 'You', runCount: 0 });
		assert.deepStrictEqual(h.automations[0].tools, [], 'no tools or secrets come from an extension');
		assert.strictEqual(h.automations[0].triggers?.[0].provider, 'schedule');
		assert.deepStrictEqual((await volt.automations.list()).map(automation => automation.id), ['a1']);
		const usage = await volt.usage.get();
		assert.deepStrictEqual([usage.costUsd, usage.sessionCount, usage.models], [2, 4, [{ provider: 'claude', model: 'claude-opus-5', inputTokens: 320, outputTokens: 80, costUsd: 2 }]]);
		assert.deepStrictEqual(await volt.pullRequests.list('chat-1'), [{ url: 'https://github.com/acme/app/pull/12', number: 12, repository: 'acme/app', watched: true }]);
		assert.strictEqual((await volt.pullRequests.link('chat-1', 'https://github.com/acme/app/pull/13')).text, 'ran link_pull_request');
		assert.strictEqual(h.invoked.find(call => call.name === 'link_pull_request')?.call?.sessionId, 'chat-1');
	});

	test('EXT-RT-automations-own: show the page; run and remove only the automations it scheduled', async () => {
		const bare = description('acme.bare', { contributes: {} });
		const h = host([acme(), bare], ['acme.notes', 'acme.bare']);
		h.grant('acme.notes', 'automations.schedule');
		const volt = h.voltFor('acme.notes');
		await volt.automations.show('a1');
		await volt.automations.show();
		assert.deepStrictEqual(h.commands.filter(command => command.id === OPEN_AUTOMATIONS_COMMAND_ID).map(command => command.args), [['a1'], []]);
		const own = await volt.automations.schedule({ name: 'Morning triage', instructions: 'Triage new issues.', schedule: { type: 'daily', time: '09:00' } });
		assert.strictEqual(h.automations[0].createdByExtension, 'acme.notes', 'core records who scheduled it, not the payload');
		h.automations.push({ ...h.automations[0], id: 'mine', createdByExtension: undefined, createdBy: 'You' } as IAutomation);
		assert.deepStrictEqual(await volt.automations.run(own.id), [{ id: 'r-a1', status: 'running', chatId: 'chat-9' }]);
		await assert.rejects(Promise.resolve(volt.automations.run('mine')), /is not an automation Notes scheduled/, 'the user\'s own automation');
		await assert.rejects(Promise.resolve(volt.automations.remove('mine')), /is not an automation Notes scheduled/);
		await volt.automations.remove(own.id);
		assert.deepStrictEqual(h.automations.map(automation => automation.id), ['mine']);
		// Undeclared: refused before anything runs.
		const other = h.voltFor('acme.bare');
		assert.strictEqual((await refusal(other.automations.run('mine'))).deniedBy, 'manifest');
		assert.strictEqual((await refusal(other.automations.remove('mine'))).deniedBy, 'manifest');
		assert.deepStrictEqual(h.automations.map(automation => automation.id), ['mine']);
	});

	test('EXT-RT-skills: list what agents load (names and descriptions only) and show the page', async () => {
		const h = host([acme()], ['acme.notes']);
		h.grant('acme.notes', 'agents.read:any');
		const volt = h.voltFor('acme.notes');
		assert.deepStrictEqual(await volt.skills.list(), [
			{ kind: 'skill', name: 'release-notes', description: 'Writes release notes.', scope: 'user', origin: 'claude' },
			{ kind: 'mcp', name: 'linear', description: 'Linear issues.', scope: 'workspace', plugin: 'linear' },
		], 'no file paths, no MCP config (env), no memories');
		assert.deepStrictEqual((await volt.skills.list('mcp')).map(skill => skill.name), ['linear']);
		await volt.skills.show();
		await volt.skills.show({ marketplace: true });
		assert.deepStrictEqual(h.commands.filter(command => command.id === OPEN_SKILLS_COMMAND_ID || command.id === OPEN_SKILLS_MARKETPLACE_COMMAND_ID).map(command => command.id), [OPEN_SKILLS_COMMAND_ID, OPEN_SKILLS_MARKETPLACE_COMMAND_ID]);
		// Undeclared: refused without a prompt.
		const bare = host([description('acme.bare', { contributes: {} })], ['acme.bare']);
		assert.strictEqual((await refusal(bare.voltFor('acme.bare').skills.list())).deniedBy, 'manifest');
	});

	test('EXT-RT-remoteDevices: show Devices, or Add Device on it (no capability: it only opens a page)', async () => {
		const h = host([description('acme.bare', { contributes: {} })], ['acme.bare']);
		const volt = h.voltFor('acme.bare');
		await volt.remoteDevices.show();
		await volt.remoteDevices.show({ addDevice: true });
		assert.deepStrictEqual(h.commands.filter(command => command.id === OPEN_VOLT_SETTINGS_COMMAND_ID).map(command => command.args), [['devices'], ['devices:add']]);
	});

	// --- Identity ---------------------------------------------------------------------------------

	test('EXT-ID-1: a payload naming an extension this host does not run is refused', async () => {
		const memory = description('volt.memory', { builtin: true, contributes: { voltCapabilities: { required: [{ id: 'tools.register', class: 'low' }, { id: 'agents.context', class: 'high' }] } } });
		const h = host([acme(), memory], ['acme.notes']);
		// acme's host forges calls as volt.memory (a built-in with agents.context and no prompt).
		const forged = h.voltFor('volt.memory');
		await assert.rejects(Promise.resolve(forged.memory.write({ name: 'x', description: 'y', body: 'z' })), (err: unknown) => err instanceof ExtensionNotInHostError && err.extensionId === 'volt.memory');
		await assert.rejects(Promise.resolve(forged.storage.keys()), ExtensionNotInHostError);
		assert.strictEqual(h.memories.size, 0);
		// An id the renderer doesn't know at all.
		const main = (h.rpc.getProxy(MainContext.MainThreadVolt));
		h.rpc.hostsExtension = () => true;
		await assert.rejects(main.$call('ghost.ext', 'storage.keys', []), ExtensionNotInHostError);
	});

	test('EXT-ID-2: two extensions in one host keep their own storage, consents and turn streams', async () => {
		const copycat = description('evil.copycat', { contributes: { voltCapabilities: { optional: [{ id: 'agents.read:any', class: 'medium' }] } } });
		const h = host([acme(), copycat], ['acme.notes', 'evil.copycat']);
		h.grant('acme.notes', 'agents.read:any');
		const notes = h.voltFor('acme.notes');
		const evil = h.voltFor('evil.copycat');
		await notes.storage.set('token', 'acme-secret');
		assert.strictEqual(await evil.storage.get('token'), undefined);
		assert.deepStrictEqual(await evil.storage.keys(), []);
		// acme's consent is not the copycat's: it is asked for its own (and refused here).
		const asking = refusal(evil.chats.list());
		assert.match(await answerConsent(false), /Allow Copycat to read your chats\?/);
		assert.strictEqual((await asking).deniedBy, 'consent');
		assert.strictEqual((await notes.chats.list()).length, 1);
		// Turn events go to the extension whose subscription was allowed, not to its neighbour.
		const acmeEvents: string[] = [];
		const evilEvents: string[] = [];
		const acmeListener = notes.chats.onDidStartTurn(e => acmeEvents.push(e.turnId));
		const evilListener = evil.chats.onDidStartTurn(e => evilEvents.push(e.turnId));
		await h.rpc.sync();
		h.turn('chat-1', { active: { id: 't1', kind: 'prompt', prompt: { text: 'x' }, at: 1, phase: 'running' } as IOrchThread['active'] });
		await h.rpc.sync();
		assert.deepStrictEqual([acmeEvents, evilEvents], [['t1'], []]);
		acmeListener.dispose();
		evilListener.dispose();
		await h.rpc.sync();
	});

	test('EXT-ID-3: a built-in is first party only when shipped with the app', () => {
		assert.ok(isFirstPartyExtension(description('volt.memory', { builtin: true })));
		assert.ok(!isFirstPartyExtension(description('volt.memory')), 'installed from a gallery or a .vsix');
		assert.ok(!isFirstPartyExtension({ ...description('volt.memory', { builtin: true }), isUserBuiltin: true }));
		assert.ok(!isFirstPartyExtension(description('volt.not-in-the-table', { builtin: true })));
		assert.ok(!isFirstPartyExtension(description('acme.notes', { builtin: true })));
	});

	// --- Capability policy, end to end ------------------------------------------------------------

	test('EXT-API-CAP-1: a built-in uses what its ceiling holds without a prompt', async () => {
		const memory = description('volt.memory', { builtin: true, contributes: { voltCapabilities: { required: [{ id: 'tools.register', class: 'low' }, { id: 'agents.context', class: 'high' }] } } });
		const h = host([memory], ['volt.memory']);
		const volt = h.voltFor('volt.memory');
		assert.strictEqual((await volt.memory.write({ name: 'n', description: 'd', body: 'b' })).name, 'n');
		assert.strictEqual(container.querySelector('.volt-extension-consent'), null, 'no dialog');
	});

	test('EXT-API-CAP-2: a built-in beyond its ceiling is refused', async () => {
		// A manifest that declares more than the compiled ceiling (tampered or not yet released in core).
		const memory = description('volt.memory', { builtin: true, contributes: { voltCapabilities: { required: [{ id: 'agents.context', class: 'high' }, { id: 'agents.read:any', class: 'medium' }] } } });
		const h = host([memory], ['volt.memory']);
		const volt = h.voltFor('volt.memory');
		const err = await refusal(volt.chats.list());
		assert.deepStrictEqual([err.capability, err.deniedBy], ['agents.read:any', 'ceiling']);
		assert.strictEqual(container.querySelector('.volt-extension-consent'), null);
	});

	test('EXT-API-CAP-3: a third party\'s undeclared capability is refused without a prompt', async () => {
		const bare = description('acme.bare');
		const h = host([bare], ['acme.bare']);
		const volt = h.voltFor('acme.bare');
		const err = await refusal(volt.chats.send('chat-1', 'hi'));
		assert.deepStrictEqual([err.capability, err.deniedBy], ['agents.send', 'manifest']);
		assert.strictEqual(container.querySelector('.volt-extension-consent'), null);
		assert.ok(!h.invoked.length);
		// Low and none-class calls need only the declaration (or nothing).
		assert.deepStrictEqual(await volt.storage.keys(), []);
	});

	test('EXT-API-CAP-4: a medium capability asks once; Allow is kept, Don\'t Allow is kept', async () => {
		const h = host([acme()], ['acme.notes']);
		const volt = h.voltFor('acme.notes');
		const first = volt.chats.list();
		const title = await answerConsent(true);
		assert.strictEqual(title, 'Allow Notes to read your chats?');
		assert.strictEqual((await first).length, 1);
		assert.strictEqual(h.features.states.get(`${voltCapabilityFeatureId('agents.read:any')}\u0000acme.notes`), true, 'kept where the extension page shows it');
		assert.strictEqual((await volt.chats.list()).length, 1);
		assert.strictEqual(container.querySelector('.volt-extension-consent'), null, 'not asked again');

		const send = refusal(volt.chats.send('chat-1', 'hi'));
		await answerConsent(false);
		assert.strictEqual((await send).deniedBy, 'consent');
		const again = await refusal(volt.chats.send('chat-1', 'hi'));
		assert.strictEqual(again.deniedBy, 'consent');
		assert.strictEqual(container.querySelector('.volt-extension-consent'), null, 'a refusal is not asked again');
		assert.ok(!h.invoked.some(call => call.name === 'thread_send'));
	});

	test('EXT-API-CAP-5: critical capabilities are refused even when declared; a third party cannot shadow Volt\'s tools', async () => {
		const h = host([acme()], ['acme.notes']);
		h.grant('acme.notes', 'agents.send', 'agents.context');
		const volt = h.voltFor('acme.notes');
		assert.strictEqual((await refusal(volt.tools.invokeTool('rename_branch', {}))).capability, 'spawn.unsandboxed');
		volt.tools.registerTool('memory_write', () => ({ text: 'shadowed' }));
		await h.rpc.sync();
		assert.ok(![...h.providers].some(provider => provider.tools.some(tool => tool.name === 'memory_write')), 'Volt\'s memory_write is not taken over');
	});

	test('EXT-API-CAP-6: revoking a consent refuses the next call and stops turn events', async () => {
		const h = host([acme()], ['acme.notes']);
		h.grant('acme.notes', 'agents.read:any');
		const volt = h.voltFor('acme.notes');
		const events: string[] = [];
		const listener = volt.chats.onDidStartTurn(e => events.push(e.turnId));
		await h.rpc.sync();
		h.turn('chat-1', { active: { id: 't1', kind: 'prompt', prompt: { text: 'x' }, at: 1, phase: 'running' } as IOrchThread['active'] });
		await h.rpc.sync();
		h.api.revokeConsent('acme.notes', 'agents.read:any');
		assert.strictEqual((await refusal(volt.chats.list())).deniedBy, 'consent');
		h.turn('chat-1', { active: { id: 't2', kind: 'prompt', prompt: { text: 'y' }, at: 2, phase: 'running' } as IOrchThread['active'] });
		await h.rpc.sync();
		assert.deepStrictEqual(events, ['t1']);
		assert.deepStrictEqual(h.api.consents('acme.notes'), [{ capability: 'agents.read:any', granted: false }]);
		listener.dispose();
		await h.rpc.sync();
	});

	// --- The proposal and the wire ----------------------------------------------------------------

	test('EXT-PROP-1: the volt proposal is open to every extension that declares it; VS Code\'s stay closed', () => {
		const proposals = new ExtensionsProposedApi(new NullLogService(), new class extends mock<IWorkbenchEnvironmentService>() {
			override readonly isBuilt = true;
			override readonly isExtensionDevelopment = false;
			override readonly extensionEnabledProposedApi = undefined;
		}, new class extends mock<IProductService>() { override readonly quality = 'stable'; });
		const fromOpenVsx = { ...description('acme.notes', { proposals: ['volt', 'chatProvider'] }) };
		const plain = { ...description('acme.plain', { proposals: ['chatProvider'] }) };
		proposals.updateEnabledApiProposals([fromOpenVsx, plain]);
		assert.deepStrictEqual(fromOpenVsx.enabledApiProposals, ['volt']);
		assert.deepStrictEqual(plain.enabledApiProposals, []);
	});

	test('EXT-PROP-2: without the proposal the namespace throws', () => {
		const h = host([description('acme.noproposal', { proposals: [] })], ['acme.noproposal']);
		const volt = h.voltFor('acme.noproposal');
		assert.throws(() => volt.storage.keys(), /CANNOT use API proposal: volt/);
		assert.throws(() => volt.chats.onDidStartTurn(() => { }), /CANNOT use API proposal: volt/);
	});

	test('EXT-WIRE-1: a refusal keeps its capability and layer across RPC', () => {
		const err = new VoltCapabilityError('agents.send', 'chat-1', 'consent', 'needs consent');
		const wire = transformErrorFromSerialization(transformErrorForSerialization(err));
		assert.ok(!(wire instanceof VoltCapabilityError));
		const restored = restoreVoltCapabilityError(wire) as VoltCapabilityError;
		assert.deepStrictEqual([restored.name, restored.capability, restored.target, restored.deniedBy], ['VoltCapabilityError', 'agents.send', 'chat-1', 'consent']);
	});
});
