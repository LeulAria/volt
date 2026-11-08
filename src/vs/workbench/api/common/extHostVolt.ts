/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { checkProposedApiEnabled } from '../../services/extensions/common/extensions.js';
import { ExtHostVoltShape, IVoltToolResultDto, IVoltTurnEventDto, MainContext, MainThreadVoltShape, VoltApiMethod } from './extHost.protocol.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { Disposable } from './extHostTypes.js';

/** `vscode.volt.version`: the API version Volt's facade serves (`VOLT_API_VERSION`). */
const VOLT_EXTENSION_API_VERSION = '1.0.0';

interface IToolEntry {
	readonly extension: IExtensionDescription;
	readonly handler: vscode.volt.ToolHandler;
}

interface ITurnListeners {
	readonly start: Emitter<vscode.volt.TurnEvent>;
	readonly finish: Emitter<vscode.volt.TurnEvent>;
	listeners: number;
}

/**
 * A refusal from the renderer arrives as a plain error named `VoltCapabilityError` whose `code`
 * carries the capability, target and layer; this puts them back as fields.
 */
export function restoreVoltCapabilityError(err: unknown): unknown {
	const code: unknown = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
	if (err instanceof Error && err.name === 'VoltCapabilityError' && typeof code === 'string') {
		try {
			const fields = JSON.parse(code) as { capability?: string; target?: string; deniedBy?: string };
			Object.assign(err, { capability: fields.capability, target: fields.target, deniedBy: fields.deniedBy });
		} catch {
			// Keep the error as it came.
		}
	}
	return err;
}

/** Only the fields a tool result has, so nothing else crosses back to Volt. */
function toolResult(value: unknown): IVoltToolResultDto {
	if (!value || typeof value !== 'object') {
		return { error: 'The tool returned no result.' };
	}
	const result = value as Record<string, unknown>;
	const visual = result.visual && typeof result.visual === 'object' ? result.visual as IVoltToolResultDto['visual'] : undefined;
	return {
		...(typeof result.text === 'string' ? { text: result.text } : {}),
		...(typeof result.image === 'string' ? { image: result.image } : {}),
		...(typeof result.error === 'string' ? { error: result.error } : {}),
		...(visual ? { visual } : {}),
	};
}

/**
 * The extension-host half of `vscode.volt`. Each extension gets its own namespace object whose
 * calls name it to the renderer; the renderer checks the name against the extensions this host
 * runs and decides the rest itself (`MainThreadVolt`).
 */
export class ExtHostVolt implements ExtHostVoltShape {

	private readonly proxy: MainThreadVoltShape;
	private handles = 0;
	private readonly tools = new Map<number, IToolEntry>();
	private readonly turns = new Map<string, ITurnListeners>();

	constructor(
		@IExtHostRpcService rpc: IExtHostRpcService,
		@ILogService private readonly logService: ILogService,
	) {
		this.proxy = rpc.getProxy(MainContext.MainThreadVolt);
	}

	createApi(extension: IExtensionDescription, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>): typeof vscode.volt {
		const id = extension.identifier.value;
		const gate = () => checkProposedApiEnabled(extension, 'volt');
		const call = <T>(method: VoltApiMethod, ...args: unknown[]): Promise<T> => {
			gate();
			return this.proxy.$call(id, method, args).then(value => value as T, err => { throw restoreVoltCapabilityError(err); });
		};
		const turnEvent = (which: 'start' | 'finish'): Event<vscode.volt.TurnEvent> => (listener, thisArgs, disposables) => {
			gate();
			return this.turnListeners(extension)[which].event(listener, thisArgs, disposables);
		};

		const tools: typeof vscode.volt.tools = {
			registerTool: (name, handler, options) => {
				gate();
				const handle = ++this.handles;
				this.tools.set(handle, { extension, handler });
				this.proxy.$registerTool(id, handle, name, options && { ...(options.title ? { title: options.title } : {}), ...(options.description ? { description: options.description } : {}), ...(options.inputSchema ? { inputSchema: options.inputSchema } : {}) }).catch(err => {
					this.tools.delete(handle);
					this.logService.error(`[volt] ${id} could not register tool ${name}: ${restoreVoltCapabilityError(err)}`);
				});
				return new Disposable(() => {
					if (this.tools.delete(handle)) {
						this.proxy.$unregisterTool(handle);
					}
				});
			},
			invokeTool: (name, input, options) => call('tools.invoke', name, input ?? {}, options?.chatId),
		};

		const chats: typeof vscode.volt.chats = {
			list: options => call('chats.list', options),
			current: () => call('chats.current'),
			read: chatId => call('chats.read', chatId),
			send: (chatId, message) => call('chats.send', chatId, message),
			start: options => call('chats.start', options),
			onDidStartTurn: turnEvent('start'),
			onDidEndTurn: turnEvent('finish'),
		};

		const storage: typeof vscode.volt.storage = {
			get: key => call('storage.get', key),
			set: (key, value) => call('storage.set', key, value),
			delete: key => call('storage.delete', key),
			keys: () => call('storage.keys'),
		};

		const settings: typeof vscode.volt.settings = {
			get: key => call('settings.get', key),
			update: (key, value) => call('settings.update', key, value),
			onDidChange: (listener, thisArgs, disposables) => {
				gate();
				return Event.map(onDidChangeConfiguration, e => ({ affects: (key: string) => e.affectsConfiguration(key) }))(listener, thisArgs, disposables);
			},
		};

		const memory: typeof vscode.volt.memory = {
			list: scope => call('memory.list', scope),
			read: (name, scope) => call('memory.read', name, scope),
			write: note => call('memory.write', note),
			delete: (name, scope) => call('memory.delete', name, scope),
		};

		const browser: typeof vscode.volt.browser = {
			open: url => call('browser.open', url),
			readPage: options => call('browser.readPage', options),
		};

		const visuals: typeof vscode.volt.visuals = {
			renderChart: chart => call('visuals.renderChart', chart),
			drawOnScratch: (drawing, options) => call('visuals.drawOnScratch', drawing, options),
		};

		const automations: typeof vscode.volt.automations = {
			list: () => call('automations.list'),
			schedule: options => call('automations.schedule', options),
		};

		const usage: typeof vscode.volt.usage = {
			get: () => call('usage.get'),
		};

		const pullRequests: typeof vscode.volt.pullRequests = {
			list: chatId => call('pullRequests.list', chatId),
			link: (chatId, url) => call('pullRequests.link', chatId, url),
		};

		return Object.freeze({ version: VOLT_EXTENSION_API_VERSION, tools, chats, storage, settings, memory, browser, visuals, automations, usage, pullRequests });
	}

	/** One pair of emitters per extension; the renderer is asked to stream while either has listeners. */
	private turnListeners(extension: IExtensionDescription): ITurnListeners {
		const key = ExtensionIdentifier.toKey(extension.identifier);
		let entry = this.turns.get(key);
		if (!entry) {
			const id = extension.identifier.value;
			const first = () => {
				if (entry!.listeners++ === 0) {
					this.proxy.$subscribeTurns(id).catch(err => this.logService.error(`[volt] ${id} gets no turn events: ${restoreVoltCapabilityError(err)}`));
				}
			};
			const last = () => {
				if (--entry!.listeners === 0) {
					this.proxy.$unsubscribeTurns(id);
				}
			};
			entry = {
				start: new Emitter<vscode.volt.TurnEvent>({ onWillAddFirstListener: first, onDidRemoveLastListener: last }),
				finish: new Emitter<vscode.volt.TurnEvent>({ onWillAddFirstListener: first, onDidRemoveLastListener: last }),
				listeners: 0,
			};
			this.turns.set(key, entry);
		}
		return entry;
	}

	async $invokeTool(handle: number, input: Record<string, unknown>, call: { readonly chatId?: string }, token: CancellationToken): Promise<IVoltToolResultDto> {
		const entry = this.tools.get(handle);
		if (!entry) {
			return { error: 'The extension that served this tool stopped.' };
		}
		try {
			return toolResult(await entry.handler(input ?? {}, call?.chatId ? { chatId: call.chatId } : {}, token));
		} catch (err) {
			this.logService.error(`[volt] tool of ${entry.extension.identifier.value} failed`, err);
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	$onDidStartTurn(extensionIds: string[], event: IVoltTurnEventDto): void {
		this.fireTurn(extensionIds, 'start', event);
	}

	$onDidFinishTurn(extensionIds: string[], event: IVoltTurnEventDto): void {
		this.fireTurn(extensionIds, 'finish', event);
	}

	/** Only to the extensions the renderer names: the ones whose subscription it allowed. */
	private fireTurn(extensionIds: string[], which: 'start' | 'finish', event: IVoltTurnEventDto): void {
		const turn: vscode.volt.TurnEvent = Object.freeze({ chatId: event.chatId, turnId: event.turnId, kind: event.kind, ...(event.outcome ? { outcome: event.outcome } : {}) });
		for (const id of extensionIds) {
			this.turns.get(ExtensionIdentifier.toKey(id))?.[which].fire(turn);
		}
	}
}
