/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { assertHostsExtension, ExtensionNotInHostError, extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { VoltCapabilityError } from '../../services/voltPlugins/common/capabilities.js';
import { IVoltApi, IVoltPluginContext, VoltAutomationSchedule, VoltMemoryScope, VoltMemoryType } from '../../services/voltPlugins/common/voltApi.js';
import { IVoltExtensionApiService } from '../../services/voltPlugins/common/voltExtensionApi.js';
import { IVoltHostToolResult, IVoltVisualRef } from '../../services/voltRuntime/common/hostTools.js';
import { ExtHostContext, ExtHostVoltShape, IVoltToolOptionsDto, IVoltToolResultDto, MainContext, MainThreadVoltShape, VoltApiMethod } from '../common/extHost.protocol.js';

/** Distinct capabilities one call may ask the user for before it gives up. */
const MAX_CONSENTS_PER_CALL = 3;

function str(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value) {
		throw new Error(`volt: ${name} must be a non-empty string.`);
	}
	return value;
}

function optionalStr(value: unknown, name: string): string | undefined {
	return value === undefined || value === null ? undefined : str(value, name);
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (value === undefined || value === null) {
		return {};
	}
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`volt: ${name} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function memoryScope(value: unknown): VoltMemoryScope | undefined {
	return value === 'user' || value === 'project' ? value : undefined;
}

function finite(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`volt: ${name} must be a number.`);
	}
	return value;
}

/** An automation schedule, field by field for its type (the extension's object is never passed on). */
function automationSchedule(value: unknown): VoltAutomationSchedule {
	const schedule = record(value, 'schedule');
	switch (schedule.type) {
		case 'hourly': return { type: 'hourly', minute: finite(schedule.minute, 'schedule.minute') };
		case 'daily': return { type: 'daily', time: str(schedule.time, 'schedule.time') };
		case 'weekly': {
			const weekdays = schedule.weekdays;
			if (!Array.isArray(weekdays) || !weekdays.length || !weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) {
				throw new Error('volt: schedule.weekdays must list days from 0 (Sunday) to 6.');
			}
			return { type: 'weekly', weekdays: weekdays as number[], time: str(schedule.time, 'schedule.time') };
		}
		case 'cron': return { type: 'cron', expr: str(schedule.expr, 'schedule.expr') };
		case 'interval': {
			const everyMs = finite(schedule.everyMs, 'schedule.everyMs');
			if (everyMs < 60_000) {
				throw new Error('volt: an interval schedule runs at most once a minute.');
			}
			return { type: 'interval', everyMs };
		}
		case 'once': return { type: 'once', at: finite(schedule.at, 'schedule.at') };
	}
	throw new Error('volt: schedule.type must be hourly, daily, weekly, cron, interval or once.');
}

interface IExtensionEntry {
	readonly extension: IExtensionDescription;
	readonly context: IVoltPluginContext;
}

/**
 * The renderer half of `vscode.volt` for one extension host. A call names its extension; that name
 * is honoured only for an extension this host runs (B-08), and everything else about the caller
 * (built-in or not, what it declares) comes from the renderer's own registry. Each extension gets
 * one facade context (`IVoltExtensionApiService.createContext`), whose enforcing policy decides
 * every call; a refusal the user may answer asks once and retries.
 */
@extHostNamedCustomer(MainContext.MainThreadVolt)
export class MainThreadVolt extends Disposable implements MainThreadVoltShape {

	private readonly proxy: ExtHostVoltShape;
	private readonly entries = new Map<string, IExtensionEntry>();
	private readonly tools = this._register(new DisposableMap<number>());
	private readonly turnSubscriptions = this._register(new DisposableMap<string>());
	/** Visuals Volt published for an extension (`extension\0ref`): only those may come back in its tool results. */
	private readonly minted = new Map<string, IVoltVisualRef>();

	constructor(
		private readonly extHostContext: IExtHostContext,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.proxy = extHostContext.getProxy(ExtHostContext.ExtHostVolt);
	}

	/** Resolved on the first call: a host whose extensions never use `vscode.volt` never wakes it. */
	private get api(): IVoltExtensionApiService {
		return this.instantiationService.invokeFunction(accessor => accessor.get(IVoltExtensionApiService));
	}

	private entry(extensionId: unknown): IExtensionEntry {
		if (typeof extensionId !== 'string') {
			throw new ExtensionNotInHostError(String(extensionId));
		}
		assertHostsExtension(this.extHostContext, extensionId);
		const key = ExtensionIdentifier.toKey(extensionId);
		let entry = this.entries.get(key);
		if (!entry) {
			const extension = this.extensionService.extensions.find(candidate => ExtensionIdentifier.equals(candidate.identifier, extensionId));
			if (!extension) {
				throw new ExtensionNotInHostError(extensionId);
			}
			const subscriptions = this._register(new DisposableStore());
			const api = this.api;
			entry = { extension, context: api.createContext(extension, subscriptions) };
			this.entries.set(key, entry);
			this._register(api.onDidChangeConsent(e => {
				if (ExtensionIdentifier.equals(e.extensionId, extensionId) && this.turnSubscriptions.has(key)) {
					// A consent changed: keep the turn stream only if the policy still allows it.
					this.turnSubscriptions.deleteAndDispose(key);
					try {
						this.subscribe(entry!);
					} catch {
						// Revoked: no more turn events for it.
					}
				}
			}));
		}
		return entry;
	}

	/** Runs `fn` against the extension's facade; a refusal the user may answer is asked once, then retried. */
	private async run<T>(extensionId: string, fn: (volt: IVoltApi, entry: IExtensionEntry) => T | Promise<T>): Promise<T> {
		const entry = this.entry(extensionId);
		const asked = new Set<string>();
		for (; ;) {
			try {
				return await fn(entry.context.volt, entry);
			} catch (err) {
				if (!(err instanceof VoltCapabilityError) || err.deniedBy !== 'consent' || !err.promptable || asked.has(err.capability) || asked.size >= MAX_CONSENTS_PER_CALL) {
					throw err;
				}
				asked.add(err.capability);
				const granted = await this.api.requestConsent(entry.extension, {
					extensionId: entry.extension.identifier.value, api: 'volt', capability: err.capability, ...(err.target !== undefined ? { target: err.target } : {}),
					deniedBy: 'consent', reason: err.message, promptable: true,
				});
				if (!granted) {
					throw new VoltCapabilityError(err.capability, err.target, 'consent', `The user did not allow ${entry.extension.identifier.value} to use ${err.capability}.`);
				}
			}
		}
	}

	/** What crosses back to the extension: text, image, error, and a visual Volt published for it. */
	private result(extensionId: string, result: IVoltHostToolResult): IVoltToolResultDto {
		if (result.visual) {
			this.minted.set(`${ExtensionIdentifier.toKey(extensionId)}\u0000${result.visual.ref}`, result.visual);
		}
		return {
			...(result.text !== undefined ? { text: result.text } : {}),
			...(result.image !== undefined ? { image: result.image } : {}),
			...(result.error !== undefined ? { error: result.error } : {}),
			...(result.visual ? { visual: { ...result.visual } } : {}),
		};
	}

	$call(extensionId: string, method: VoltApiMethod, args: unknown[]): Promise<unknown> {
		const arg = (index: number) => Array.isArray(args) ? args[index] : undefined;
		return this.run(extensionId, async (volt): Promise<unknown> => {
			switch (method) {
				case 'chats.list': {
					const options = record(arg(0), 'options');
					return volt.agents.chats({ ...(typeof options.query === 'string' ? { query: options.query } : {}), ...(typeof options.limit === 'number' ? { limit: options.limit } : {}) });
				}
				case 'chats.current': return volt.agents.current();
				case 'chats.read': return this.result(extensionId, await volt.agents.read(str(arg(0), 'chatId')));
				case 'chats.send': return this.result(extensionId, await volt.agents.send(str(arg(0), 'chatId'), str(arg(1), 'message')));
				case 'chats.start': {
					const options = record(arg(0), 'options');
					return this.result(extensionId, await volt.agents.create({
						title: str(options.title, 'title'),
						...(optionalStr(options.message, 'message') ? { message: options.message as string } : {}),
						...(optionalStr(options.model, 'model') ? { model: options.model as string } : {}),
						...(optionalStr(options.project, 'project') ? { project: options.project as string } : {}),
					}));
				}
				case 'tools.invoke': {
					const chatId = optionalStr(arg(2), 'chatId');
					return this.result(extensionId, await volt.tools.invoke(str(arg(0), 'name'), record(arg(1), 'input'), chatId ? { chatId } : undefined));
				}
				case 'storage.get': return volt.storage.get(str(arg(0), 'key'));
				case 'storage.set': return volt.storage.set(str(arg(0), 'key'), arg(1));
				case 'storage.delete': return volt.storage.delete(str(arg(0), 'key'));
				case 'storage.keys': return volt.storage.keys();
				case 'settings.get': return volt.settings.get(str(arg(0), 'key'));
				case 'settings.update': return volt.settings.update(str(arg(0), 'key'), arg(1));
				case 'memory.list': {
					const scope = arg(0);
					return volt.memory.list(scope === 'all' ? 'all' : memoryScope(scope));
				}
				case 'memory.read': return volt.memory.read(str(arg(0), 'name'), memoryScope(arg(1)));
				case 'memory.write': {
					const note = record(arg(0), 'note');
					const type = note.type;
					return volt.memory.write({
						name: str(note.name, 'name'),
						description: str(note.description, 'description'),
						body: str(note.body, 'body'),
						...(type === 'user' || type === 'feedback' || type === 'project' || type === 'reference' ? { type: type as VoltMemoryType } : {}),
						...(memoryScope(note.scope) ? { scope: memoryScope(note.scope) } : {}),
					});
				}
				case 'memory.delete': return volt.memory.delete(str(arg(0), 'name'), memoryScope(arg(1)));
				case 'browser.open': return volt.browser.open(str(arg(0), 'url'));
				case 'browser.readPage': {
					const chatId = optionalStr(record(arg(0), 'options').chatId, 'chatId');
					const page = await volt.browser.readPage(chatId ? { chatId } : undefined);
					return { ...(page.url ? { url: page.url } : {}), snapshot: this.result(extensionId, page.snapshot) };
				}
				case 'visuals.renderChart': {
					const chart = record(arg(0), 'chart');
					if (!Array.isArray(chart.charts)) {
						throw new Error('volt: chart.charts must be an array of chart specs.');
					}
					return this.result(extensionId, await volt.visuals.renderChart({
						charts: chart.charts as object[],
						...(optionalStr(chart.title, 'title') ? { title: chart.title as string } : {}),
						...(optionalStr(chart.subtitle, 'subtitle') ? { subtitle: chart.subtitle as string } : {}),
					}));
				}
				case 'visuals.drawOnScratch': {
					const drawing = record(arg(0), 'drawing');
					const chatId = optionalStr(record(arg(1), 'options').chatId, 'chatId');
					return this.result(extensionId, await volt.visuals.drawOnScratch({ ...drawing, title: str(drawing.title, 'title') }, chatId ? { chatId } : undefined));
				}
				case 'automations.list': return volt.automations.list();
				case 'automations.schedule': {
					const options = record(arg(0), 'options');
					const chatId = optionalStr(options.chatId, 'chatId');
					return volt.automations.schedule({
						name: str(options.name, 'name'),
						instructions: str(options.instructions, 'instructions'),
						schedule: automationSchedule(options.schedule),
						...(chatId ? { chatId } : {}),
						...(options.enabled === false ? { enabled: false } : {}),
					});
				}
				case 'usage.get': return volt.usage.get();
				case 'pullRequests.list': return volt.pullRequests.list(str(arg(0), 'chatId'));
				case 'pullRequests.link': return this.result(extensionId, await volt.pullRequests.link(str(arg(0), 'chatId'), str(arg(1), 'url')));
				case 'gitGraph.open': {
					const options = record(arg(0), 'options');
					return volt.gitGraph.open({
						repositoryRoot: optionalStr(options.repositoryRoot, 'repositoryRoot'),
						query: optionalStr(options.query, 'query'),
						revealCommit: optionalStr(options.revealCommit, 'revealCommit'),
					});
				}
				case 'gitGraph.askAgent': {
					const options = record(arg(0), 'options');
					const action = options.action;
					if (action !== 'explain' && action !== 'review' && action !== 'ask') {
						throw new Error('volt: action must be explain, review or ask.');
					}
					const line = (value: unknown, name: string) => value === undefined || value === null ? undefined : finite(value, name);
					return volt.gitGraph.askAgent({
						action,
						repositoryRoot: optionalStr(options.repositoryRoot, 'repositoryRoot'),
						commit: optionalStr(options.commit, 'commit'),
						path: optionalStr(options.path, 'path'),
						startLine: line(options.startLine, 'startLine'),
						endLine: line(options.endLine, 'endLine'),
						question: optionalStr(options.question, 'question'),
					});
				}
				default: throw new Error(`volt: unknown method ${String(method)}`);
			}
		});
	}

	async $registerTool(extensionId: string, handle: number, name: string, options: IVoltToolOptionsDto | undefined): Promise<void> {
		const key = ExtensionIdentifier.toKey(extensionId);
		const registration = await this.run(extensionId, volt => volt.tools.register(str(name, 'name'), async (args, call) => {
			const result = await this.proxy.$invokeTool(handle, args, call.sessionId ? { chatId: call.sessionId } : {}, CancellationToken.None);
			// A visual is drawn in the chat: only one Volt published for this extension may come back,
			// exactly as Volt published it.
			const visual = result?.visual && typeof result.visual.ref === 'string' ? this.minted.get(`${key}\u0000${result.visual.ref}`) : undefined;
			return {
				...(typeof result?.text === 'string' ? { text: result.text } : {}),
				...(typeof result?.image === 'string' ? { image: result.image } : {}),
				...(typeof result?.error === 'string' ? { error: result.error } : {}),
				...(visual ? { visual } : {}),
			};
		}, options && {
			...(typeof options.title === 'string' ? { title: options.title } : {}),
			...(typeof options.description === 'string' ? { description: options.description } : {}),
			...(options.inputSchema && typeof options.inputSchema === 'object' ? { inputSchema: options.inputSchema } : {}),
		}));
		this.tools.set(handle, registration);
	}

	$unregisterTool(handle: number): void {
		this.tools.deleteAndDispose(handle);
	}

	async $subscribeTurns(extensionId: string): Promise<void> {
		await this.run(extensionId, (_volt, entry) => {
			if (!this.turnSubscriptions.has(ExtensionIdentifier.toKey(extensionId))) {
				this.subscribe(entry);
			}
		});
	}

	$unsubscribeTurns(extensionId: string): void {
		if (typeof extensionId === 'string' && this.extHostContext.hostsExtension(extensionId)) {
			this.turnSubscriptions.deleteAndDispose(ExtensionIdentifier.toKey(extensionId));
		}
	}

	/** Adds the facade listeners (their capability check throws on a refusal) and forwards to this extension only. */
	private subscribe(entry: IExtensionEntry): void {
		const id = entry.extension.identifier.value;
		const store = new DisposableStore();
		try {
			store.add(entry.context.volt.agents.onDidStartTurn(event => this.proxy.$onDidStartTurn([id], { ...event })));
			store.add(entry.context.volt.agents.onDidFinishTurn(event => this.proxy.$onDidFinishTurn([id], { ...event })));
		} catch (err) {
			store.dispose();
			throw err;
		}
		this.turnSubscriptions.set(ExtensionIdentifier.toKey(id), store);
		this.logService.trace(`[volt] ${id} receives turn events`);
	}
}
