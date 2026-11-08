/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier, IExtensionDescription, IExtensionManifest } from '../../../../platform/extensions/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { declarationsOutsideCeiling, firstPartyCeiling } from '../../../../platform/voltPlugins/common/firstPartyCeilings.js';
import { IVoltUsageService } from '../../../../platform/voltUsage/common/voltUsage.js';
import { Extensions, IExtensionFeatureMarkdownRenderer, IExtensionFeaturesManagementService, IExtensionFeaturesRegistry, IRenderedData } from '../../../services/extensionManagement/common/extensionFeatures.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { capabilityClass, IVoltPluginPrincipal, IWouldBeDenial } from '../../../services/voltPlugins/common/capabilities.js';
import { consentKey, IVoltConsentStore, VoltConsentState, VoltExtensionCapabilityPolicy } from '../../../services/voltPlugins/common/extensionCapabilityPolicy.js';
import { createVoltApi, IVoltApiBackend, IVoltApiCaller, IVoltAutomationSummary, IVoltChatSummary, IVoltMemoryNote, IVoltPluginContext, IVoltTurnEvent, IVoltUsageModelTotal, VoltAutomationSchedule } from '../../../services/voltPlugins/common/voltApi.js';
import { IVoltContributes, IVoltPluginManifest, pickVoltContributes, validateVoltContribution, VOLT_CONTRIBUTION_POINTS } from '../../../services/voltPlugins/common/voltContributions.js';
import { IVoltExtensionApiService, IVoltExtensionConsent } from '../../../services/voltPlugins/common/voltExtensionApi.js';
import { IAutomation, IAutomationService } from '../../../services/voltRuntime/common/automations/automations.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { POLICY_AUTHORITY_MODE_SETTING, readPolicyAuthorityMode } from '../../../services/voltRuntime/common/hostToolAuthority.js';
import { BROWSER_PAGE_URL_COMMAND_ID, IVoltHostToolCall, IVoltHostToolService, THREAD_TOOL_NAMES } from '../../../services/voltRuntime/common/hostTools.js';
import { IVoltMemoryService } from '../../../services/voltRuntime/common/memory/voltMemory.js';
import { IAgentOrchestratorService } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IVoltSessionContextService } from '../../../services/voltRuntime/common/sessionContext.js';
import { shownAgentChat } from '../../voltAgent/browser/editor/agentShownChat.js';
import { OPEN_BROWSER_COMMAND_ID } from '../../voltAgent/browser/preview/browserEditorInput.js';
import { IAgentPullRequestService } from '../../voltAgent/browser/pullRequests/agentPullRequestService.js';
import { IVoltFeatureService } from '../common/voltFeatures.js';
import { showVoltExtensionConsent, voltCapabilityCopy } from './voltExtensionConsent.js';

/** The extension feature a consent is kept under: the extension's page lists it with Allow / Revoke Access. */
export function voltCapabilityFeatureId(capability: string): string {
	return `volt.capability.${consentKey(capability)}`;
}

const THREAD_TOOLS: ReadonlySet<string> = new Set(THREAD_TOOL_NAMES);

/** Every declared capability of a manifest, required and optional. */
function declaredCapabilities(contributes: IVoltContributes): { readonly id: string; readonly targets?: readonly string[]; readonly reason?: string }[] {
	const declared = contributes.voltCapabilities;
	return [...declared?.required ?? [], ...declared?.optional ?? []];
}

/** The Volt points of an extension's own `package.json`, each validated (an invalid point is left out). */
export function voltManifestOf(extension: Pick<IExtensionDescription, 'publisher' | 'name' | 'engines' | 'contributes'>): IVoltPluginManifest {
	const picked = pickVoltContributes(extension.contributes) as Record<string, unknown>;
	const contributes: Record<string, unknown> = {};
	for (const point of VOLT_CONTRIBUTION_POINTS) {
		if (picked[point] !== undefined && validateVoltContribution(point, picked[point]).length === 0) {
			contributes[point] = picked[point];
		}
	}
	const engines: Readonly<Record<string, unknown>> = extension.engines ?? {};
	return { publisher: extension.publisher, name: extension.name, ...(typeof engines.volt === 'string' ? { engines: { volt: engines.volt } } : {}), contributes };
}

/** A built-in `volt.*` extension shipped with the app and named in the ceiling table; nothing installed counts. */
export function isFirstPartyExtension(extension: Pick<IExtensionDescription, 'identifier' | 'publisher' | 'isBuiltin' | 'isUserBuiltin'>): boolean {
	return extension.isBuiltin && !extension.isUserBuiltin && extension.publisher === 'volt' && !!firstPartyCeiling(extension.identifier.value);
}

/** The setting keys an extension contributes itself (`contributes.configuration`). */
function ownSettingsOf(extension: Pick<IExtensionDescription, 'contributes'>): string[] {
	const configuration = extension.contributes?.configuration;
	const sections = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
	return sections.flatMap(section => section && typeof section === 'object' && section.properties ? Object.keys(section.properties) : []);
}

/**
 * Consents in VS Code's extension features store: one feature per capability, which the
 * extension's page (Features) shows with Allow Access / Revoke Access. Never asked: no entry.
 */
class VoltConsentStore implements IVoltConsentStore {

	readonly onDidChange: Event<unknown>;

	constructor(private readonly features: IExtensionFeaturesManagementService) {
		this.onDidChange = Event.filter(features.onDidChangeEnablement, e => e.featureId.startsWith('volt.capability.'));
	}

	state(extensionId: string, capability: string): VoltConsentState {
		const featureId = voltCapabilityFeatureId(capability);
		if (!Registry.as<IExtensionFeaturesRegistry>(Extensions.ExtensionFeaturesRegistry).getExtensionFeature(featureId)) {
			return undefined;
		}
		const entry = this.features.getEnablementData(featureId).find(data => ExtensionIdentifier.equals(data.extension, extensionId));
		return entry === undefined ? undefined : entry.enabled ? 'granted' : 'refused';
	}
}

/** The Features tab entry for one capability: shown on a third party's page when it declares it. */
class VoltCapabilityFeatureRenderer extends Disposable implements IExtensionFeatureMarkdownRenderer {
	readonly type = 'markdown';

	constructor(private readonly capability: string) {
		super();
	}

	shouldRender(manifest: IExtensionManifest): boolean {
		return !firstPartyCeiling(`${manifest.publisher}.${manifest.name}`) && this.declaration(manifest) !== undefined;
	}

	render(manifest: IExtensionManifest): IRenderedData<MarkdownString> {
		const copy = voltCapabilityCopy(this.capability);
		const data = new MarkdownString();
		data.appendText(copy.detail);
		const reason = this.declaration(manifest)?.reason;
		if (reason) {
			data.appendMarkdown('\n\n');
			data.appendText(localize('voltCapability.reason', "The extension says: {0}", reason));
		}
		return { data, dispose: () => { } };
	}

	private declaration(manifest: IExtensionManifest) {
		return declaredCapabilities(pickVoltContributes(manifest.contributes)).find(entry => consentKey(entry.id) === consentKey(this.capability));
	}
}

export class VoltExtensionApiService extends Disposable implements IVoltExtensionApiService {

	declare readonly _serviceBrand: undefined;

	readonly policy: VoltExtensionCapabilityPolicy;
	private readonly _onDidChangeConsent = this._register(new Emitter<{ readonly extensionId: string; readonly capability: string }>());
	readonly onDidChangeConsent = this._onDidChangeConsent.event;
	private readonly asking = new Map<string, Promise<boolean>>();
	private readonly registered = new Set<string>();
	private readonly backend: IVoltApiBackend;

	constructor(
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@ICommandService commandService: ICommandService,
		@IVoltFeatureService featureService: IVoltFeatureService,
		@IExtensionFeaturesManagementService private readonly features: IExtensionFeaturesManagementService,
		@IExtensionService extensionService: IExtensionService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.policy = this._register(new VoltExtensionCapabilityPolicy(new VoltConsentStore(features), {
			mode: () => readPolicyAuthorityMode(configurationService.getValue(POLICY_AUTHORITY_MODE_SETTING)),
			onDiff: diff => logService.warn(`[volt policy authority] shadow diff in the extension API: ${diff.extensionId} ${diff.api} ${diff.capability}${diff.target !== undefined ? ` on ${diff.target}` : ''}: before ${diff.legacy ? `denied (${diff.legacy.deniedBy})` : 'allowed'}, the Authority ${diff.authority ? `denies (${diff.authority.deniedBy}): ${diff.decision.reason}` : 'allows'}`),
		}));
		this._register(features.onDidChangeEnablement(e => {
			if (e.featureId.startsWith('volt.capability.')) {
				this._onDidChangeConsent.fire({ extensionId: e.extension.value, capability: e.featureId.slice('volt.capability.'.length) });
			}
		}));
		// The extension pages list each declared medium and high capability, with its consent.
		const registerDeclared = () => {
			for (const extension of extensionService.extensions) {
				for (const declared of declaredCapabilities(voltManifestOf(extension).contributes ?? {})) {
					this.ensureFeature(declared.id);
				}
			}
		};
		registerDeclared();
		this._register(extensionService.onDidChangeExtensions(registerDeclared));

		const turns = this._register(new TurnEvents(() => this.get(IAgentOrchestratorService)));
		this.backend = {
			registerTool: (info, invoke, owner) => hostTools.registerToolProvider({
				tools: [info],
				invoke: (_name, args, call) => invoke(args, call?.sessionId),
				...(owner ? { owner } : {}),
			}),
			invokeTool: (name, args, caller) => hostTools.invokeTool(name, args, this.toolCall(name, caller)),
			storageGet: key => storageService.get(key, StorageScope.PROFILE),
			storageSet: (key, value) => value === undefined ? storageService.remove(key, StorageScope.PROFILE) : storageService.store(key, value, StorageScope.PROFILE, StorageTarget.MACHINE),
			storageKeys: prefix => storageService.keys(StorageScope.PROFILE, StorageTarget.MACHINE).filter(key => key.startsWith(prefix)),
			getSetting: key => configurationService.getValue(key),
			updateSetting: (key, value) => configurationService.updateValue(key, value),
			onDidChangeSettings: Event.map(configurationService.onDidChangeConfiguration, e => ({ affects: (key: string) => e.affectsConfiguration(key) })),
			executeCommand: (id, args) => commandService.executeCommand(id, ...args),
			// An extension's commands go through `vscode.commands`; the facade's are Volt-internal.
			registerCommand: (id, handler) => CommandsRegistry.registerCommand(id, (_accessor, ...args: unknown[]) => handler(...args), 'internal'),
			isOn: (part, id) => featureService.isOn(part, id),
			listChats: async options => {
				const history = this.get(IAgentHistoryService);
				await history.whenReady;
				const metas = options.query ? history.search(options.query) : history.list();
				return metas.slice(0, Math.max(1, Math.min(options.limit ?? 50, 200))).map(chatSummary);
			},
			currentChat: () => {
				const id = shownAgentChat();
				const meta = id ? this.get(IAgentHistoryService).get(id) : undefined;
				return id ? meta ? chatSummary(meta) : { id, title: '', status: 'idle', createdAt: 0, updatedAt: 0, turnCount: 0 } : undefined;
			},
			onDidStartTurn: turns.onDidStart,
			onDidFinishTurn: turns.onDidFinish,
			listMemories: async scope => (await this.get(IVoltMemoryService).list(scope)).map(memoryNote),
			readMemory: async (name, scope) => {
				const note = await this.get(IVoltMemoryService).read(name, scope);
				return note && memoryNote(note);
			},
			writeMemory: async note => memoryNote(await this.get(IVoltMemoryService).write(note)),
			deleteMemory: (name, scope) => this.get(IVoltMemoryService).delete(name, scope),
			openBrowser: async url => { await commandService.executeCommand(OPEN_BROWSER_COMMAND_ID, url); },
			browserPageUrl: chatId => commandService.executeCommand<string | undefined>(BROWSER_PAGE_URL_COMMAND_ID, chatId).catch(() => undefined),
			listAutomations: async () => {
				const automations = this.get(IAutomationService);
				await automations.whenReady;
				return automations.list().map(automationSummary);
			},
			scheduleAutomation: async options => {
				const automations = this.get(IAutomationService);
				await automations.whenReady;
				const project = options.chatId ? undefined : this.get(IVoltSessionContextService).activeProject;
				return automationSummary(await automations.create({
					name: options.name,
					instructions: options.instructions,
					enabled: options.enabled,
					triggers: [{ id: generateUuid(), provider: 'schedule', event: scheduleEvent(options.schedule), schedule: options.schedule }],
					repositories: project ? [{ root: project.root.toString(), name: project.displayName }] : [],
					tools: [],
					...(options.chatId ? { threadId: options.chatId } : {}),
				}));
			},
			readUsage: async () => {
				const snapshot = await this.get(IVoltUsageService).getUsage();
				const models = new Map<string, { -readonly [K in keyof IVoltUsageModelTotal]: IVoltUsageModelTotal[K] }>();
				for (const bucket of snapshot.buckets) {
					const key = `${bucket.provider}\u0000${bucket.model}`;
					const total = models.get(key) ?? { provider: bucket.provider, model: bucket.model, inputTokens: 0, outputTokens: 0, costUsd: 0 };
					total.inputTokens += bucket.uncached + bucket.cached + bucket.cacheWrite;
					total.outputTokens += bucket.output;
					total.costUsd += bucket.costUsd;
					models.set(key, total);
				}
				const list = [...models.values()].sort((a, b) => b.costUsd - a.costUsd);
				return { generatedAt: snapshot.generatedAt, since: snapshot.sinceMs, sessionCount: snapshot.sessionCount, costUsd: list.reduce((sum, model) => sum + model.costUsd, 0), models: list };
			},
			// Never forced, so an extension asking often is served the service's cached reading.
			readUsageLimits: async () => (await this.get(IVoltUsageService).getLimits(false)).map(group => ({
				provider: group.provider,
				...(group.plan ? { plan: group.plan } : {}),
				windows: group.windows.map(window => ({ label: window.label, usedPercent: window.usedPercent, ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}) })),
				...(group.error ? { error: group.error } : {}),
				checkedAt: group.checkedAt,
			})),
			listPullRequests: async chatId => this.get(IAgentPullRequestService).links(chatId).map(link => ({
				url: link.url,
				number: link.number,
				repository: `${link.repo.owner}/${link.repo.name}`,
				...(link.snapshot ? { title: link.snapshot.title, state: link.snapshot.state } : {}),
				watched: !!link.watch,
			})),
		};
	}

	createContext(extension: IExtensionDescription, subscriptions: DisposableStore): IVoltPluginContext {
		const manifest = voltManifestOf(extension);
		const firstParty = isFirstPartyExtension(extension);
		const contributes = manifest.contributes ?? {};
		if (firstParty) {
			// Tamper backstop (G.10): the policy refuses these anyway; say why once.
			for (const problem of declarationsOutsideCeiling(extension.identifier.value, declaredCapabilities(contributes))) {
				this.logService.error(`[volt extension api] ${problem}`);
			}
		}
		for (const declared of declaredCapabilities(contributes)) {
			this.ensureFeature(declared.id);
		}
		const principal: IVoltPluginPrincipal = {
			extensionId: extension.identifier.value,
			label: extension.displayName ?? extension.name,
			firstParty,
			capabilities: contributes.voltCapabilities ?? {},
			ownSettings: ownSettingsOf(extension),
		};
		return Object.freeze({
			extensionId: principal.extensionId,
			...(contributes.voltModule ? { featureId: contributes.voltModule.feature } : {}),
			manifest,
			volt: createVoltApi(principal, manifest, this.backend, this.policy, subscriptions),
			subscriptions,
		});
	}

	requestConsent(extension: IExtensionDescription, denial: IWouldBeDenial): Promise<boolean> {
		if (!denial.promptable || denial.deniedBy !== 'consent' || isFirstPartyExtension(extension)) {
			return Promise.resolve(false);
		}
		const capability = consentKey(denial.capability);
		const key = `${ExtensionIdentifier.toKey(extension.identifier)}\u0000${capability}`;
		let pending = this.asking.get(key);
		if (!pending) {
			const reason = declaredCapabilities(voltManifestOf(extension).contributes ?? {}).find(entry => consentKey(entry.id) === capability)?.reason;
			const dialog = this._register(new DisposableStore());
			pending = new Promise<boolean>(resolve => {
				dialog.add(showVoltExtensionConsent(this.layoutService, { extensionName: extension.displayName ?? extension.name, publisher: extension.publisher, capability, class: capabilityClass(capability) ?? 'high', reason }, resolve));
			}).then(granted => {
				if (this._store.isDisposed) {
					return false; // the window closed the dialog, not the user: nothing is recorded
				}
				this.ensureFeature(capability);
				this.features.setEnablement(extension.identifier, voltCapabilityFeatureId(capability), granted);
				return granted;
			}).finally(() => {
				this.asking.delete(key);
				this._store.delete(dialog);
			});
			this.asking.set(key, pending);
		}
		return pending;
	}

	consents(extensionId: string): readonly IVoltExtensionConsent[] {
		const result: IVoltExtensionConsent[] = [];
		for (const capability of this.registered) {
			const entry = this.features.getEnablementData(voltCapabilityFeatureId(capability)).find(data => ExtensionIdentifier.equals(data.extension, extensionId));
			if (entry) {
				result.push({ capability, granted: entry.enabled });
			}
		}
		return result;
	}

	revokeConsent(extensionId: string, capability: string): void {
		this.ensureFeature(capability);
		this.features.setEnablement(new ExtensionIdentifier(extensionId), voltCapabilityFeatureId(capability), false);
	}

	/** Registers the capability's extension feature (its consent and its row on extension pages) once. */
	private ensureFeature(capability: string): void {
		const key = consentKey(capability);
		const cls = capabilityClass(key);
		if (this.registered.has(key) || (cls !== 'medium' && cls !== 'high')) {
			return;
		}
		this.registered.add(key);
		const registry = Registry.as<IExtensionFeaturesRegistry>(Extensions.ExtensionFeaturesRegistry);
		if (registry.getExtensionFeature(voltCapabilityFeatureId(key))) {
			return;
		}
		const copy = voltCapabilityCopy(key);
		this._register(registry.registerExtensionFeature({
			id: voltCapabilityFeatureId(key),
			label: copy.title,
			description: copy.detail,
			access: { canToggle: true, requireUserConsent: true },
			renderer: new SyncDescriptor(VoltCapabilityFeatureRenderer, [key]),
		}));
	}

	/**
	 * How a tool call from an extension reaches Volt's tools. Thread tools see it as an outside
	 * caller (its own name on what it starts and sends, the outside-caller rate limits); the rest
	 * run for the chat it named, as Volt's own (`native`, so no agent tool row picks the result up).
	 */
	private toolCall(name: string, caller: IVoltApiCaller | undefined): IVoltHostToolCall {
		if (caller && THREAD_TOOLS.has(name)) {
			const id = `extension:${caller.extensionId}`;
			return { source: 'native', external: { grantId: id, clientId: id, name: localize('voltExtension.caller', "{0} (extension)", caller.label), scopes: [] } };
		}
		return { source: 'native', ...(caller?.chatId ? { sessionId: caller.chatId } : {}) };
	}

	/** Feature services resolve on first use: an extension that never asks never wakes them. */
	private get<T>(id: ServiceIdentifier<T>): T {
		return this.instantiationService.invokeFunction(accessor => accessor.get(id));
	}
}

/**
 * Turn started and finished events from the orchestrator's state: a thread whose active turn
 * changed started one, a thread whose last settled turn changed finished one. Subscribes only
 * while someone listens.
 */
class TurnEvents implements IDisposable {

	private readonly listening = new DisposableStore();
	private readonly seen = new Map<string, { readonly active?: string; readonly last?: string }>();
	private listeners = 0;
	private readonly _onDidStart = new Emitter<IVoltTurnEvent>({ onWillAddFirstListener: () => this.start(), onDidRemoveLastListener: () => this.stop() });
	readonly onDidStart = this._onDidStart.event;
	private readonly _onDidFinish = new Emitter<IVoltTurnEvent>({ onWillAddFirstListener: () => this.start(), onDidRemoveLastListener: () => this.stop() });
	readonly onDidFinish = this._onDidFinish.event;

	constructor(private readonly orchestrator: () => IAgentOrchestratorService) { }

	private start(): void {
		if (this.listeners++ > 0) {
			return;
		}
		const orchestrator = this.orchestrator();
		for (const [id, thread] of Object.entries(orchestrator.getState().threads)) {
			this.seen.set(id, { active: thread.active?.id, last: thread.last?.turnId });
		}
		this.listening.add(orchestrator.onDidChange(change => {
			for (const id of change.threads) {
				const thread = orchestrator.getThread(id);
				const before = this.seen.get(id);
				const active = thread?.active;
				const last = thread?.last;
				if (active && active.id !== before?.active) {
					this._onDidStart.fire({ chatId: id, turnId: active.id, kind: active.kind });
				}
				if (last && last.turnId !== before?.last) {
					this._onDidFinish.fire({ chatId: id, turnId: last.turnId, kind: last.kind, outcome: last.outcome });
				}
				if (thread) {
					this.seen.set(id, { active: active?.id, last: last?.turnId });
				} else {
					this.seen.delete(id);
				}
			}
		}));
	}

	private stop(): void {
		if (--this.listeners > 0) {
			return;
		}
		this.listening.clear();
		this.seen.clear();
	}

	dispose(): void {
		this.listening.dispose();
		this._onDidStart.dispose();
		this._onDidFinish.dispose();
	}
}

function chatSummary(meta: IAgentSessionMeta): IVoltChatSummary {
	return {
		id: meta.id,
		title: meta.title,
		status: meta.status,
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		turnCount: meta.turnCount,
		...(meta.workspaceFolder ? { project: meta.workspaceFolder } : {}),
	};
}

function memoryNote(note: IVoltMemoryNote): IVoltMemoryNote {
	return { name: note.name, description: note.description, type: note.type, body: note.body, scope: note.scope };
}

function automationSummary(automation: IAutomation): IVoltAutomationSummary {
	const next = Object.values(automation.nextRuns).filter(at => typeof at === 'number');
	return {
		id: automation.id,
		name: automation.name,
		enabled: automation.enabled,
		schedules: automation.triggers.flatMap(trigger => trigger.provider === 'schedule' && trigger.schedule ? [trigger.schedule as VoltAutomationSchedule] : []),
		...(next.length ? { nextRun: Math.min(...next) } : {}),
		createdBy: automation.createdBy,
		runCount: automation.runCount,
	};
}

/** The trigger event a schedule kind is filed under (as the automation templates write them). */
function scheduleEvent(schedule: VoltAutomationSchedule): string {
	return schedule.type === 'interval' ? 'minutes' : schedule.type;
}
