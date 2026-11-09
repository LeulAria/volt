/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAdminPolicy } from '../../../../platform/voltSandbox/common/authority.js';
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
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Extensions, IExtensionFeatureMarkdownRenderer, IExtensionFeaturesManagementService, IExtensionFeaturesRegistry, IRenderedData } from '../../../services/extensionManagement/common/extensionFeatures.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { capabilityClass, IVoltPluginPrincipal, IWouldBeDenial } from '../../../services/voltPlugins/common/capabilities.js';
import { consentKey, IStoredConsents, IVoltConsentStore, VoltConsentState, VoltExtensionCapabilityPolicy } from '../../../services/voltPlugins/common/extensionCapabilityPolicy.js';
import { ILocalExtension } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { versionedCapability } from '../../../../platform/voltPlugins/common/capabilityCatalog.js';
import { consentsToGrants, IConsentRecord, IRefusal } from '../../../../platform/voltSandbox/common/grants.js';
import { extensionSubject, isPluginSubject, IUserGestureToken, SubjectKey, subjectExtensionId } from '../../../../platform/voltSandbox/common/principals.js';
import { signerChangeDrops, TrustGrantDraft } from '../../../../platform/voltSandbox/common/trust.js';
import { IWorkbenchExtensionManagementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IVoltTrustService } from '../../../services/voltTrust/common/voltTrust.js';
import { createVoltApi, IVoltApiBackend, IVoltApiCaller, IVoltAutomationSummary, IVoltChatSummary, IVoltMemoryNote, IVoltPluginContext, IVoltTurnEvent, IVoltUsageModelTotal, VoltAutomationSchedule } from '../../../services/voltPlugins/common/voltApi.js';
import { IVoltContributes, IVoltPluginManifest, pickVoltContributes, validateVoltContribution, VOLT_CONTRIBUTION_POINTS } from '../../../services/voltPlugins/common/voltContributions.js';
import { IVoltExtensionApiService, IVoltExtensionConsent } from '../../../services/voltPlugins/common/voltExtensionApi.js';
import { IAutomation, IAutomationService } from '../../../services/voltRuntime/common/automations/automations.js';
import { IAgentHistoryService, IAgentSessionMeta } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { POLICY_AUTHORITY_MODE_SETTING, readPolicyAuthorityMode } from '../../../services/voltRuntime/common/hostToolAuthority.js';
import { BROWSER_PAGE_URL_COMMAND_ID, IVoltHostToolCall, IVoltHostToolService, THREAD_TOOL_NAMES } from '../../../services/voltRuntime/common/hostTools.js';
import { IVoltMemoryService } from '../../../services/voltRuntime/common/memory/voltMemory.js';
import { IAgentOrchestratorService } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { OPEN_VOLT_SETTINGS_COMMAND_ID } from '../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../services/voltRuntime/common/sessionContext.js';
import { shownAgentChat } from '../../voltAgent/browser/editor/agentShownChat.js';
import { OPEN_BROWSER_COMMAND_ID } from '../../voltAgent/browser/preview/browserEditorInput.js';
import { IAgentPullRequestService } from '../../voltAgent/browser/pullRequests/agentPullRequestService.js';
import { GIT_GRAPH_ASK_AGENT_COMMAND_ID, GIT_GRAPH_FEATURE_ID, OPEN_GIT_GRAPH_COMMAND_ID } from '../../voltGitGraph/common/voltGitGraph.js';
import { IAgentResourcesService } from '../../voltAgent/browser/resources/agentResourcesService.js';
import { agentResourceScopeKind } from '../../voltAgent/common/agentResources.js';
import { IAgentCustomizeService } from '../../voltAgent/browser/customize/agentCustomizeService.js';
import { OPEN_AUTOMATIONS_COMMAND_ID } from '../../voltAutomations/common/voltAutomations.js';
import { OPEN_SKILLS_COMMAND_ID, OPEN_SKILLS_MARKETPLACE_COMMAND_ID } from '../../voltSkills/common/voltSkills.js';
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
 * Consents (P4): the grant store (`~/.volt/trust/grants.json`) holds them, as persistent user
 * grants and refusals of the extension's subject (`plugin:<id>@<signer>`). VS Code's extension
 * features store keeps a copy so the extension's page (Features) shows Allow Access / Revoke
 * Access; a toggle there is mirrored into the grant store. Before the grant store is read (or
 * without one: the web), the features store answers.
 */
class VoltConsentStore implements IVoltConsentStore {

	readonly onDidChange: Event<unknown>;
	private readonly touched = new Map<string, number>();

	constructor(
		private readonly features: IExtensionFeaturesManagementService,
		private readonly trust: IVoltTrustService | undefined,
		private readonly signerOf: (extensionId: string) => string,
		private readonly ready: () => boolean,
	) {
		const pages = Event.filter(features.onDidChangeEnablement, e => e.featureId.startsWith('volt.capability.'));
		this.onDidChange = trust ? Event.any<unknown>(pages, trust.onDidChange) : pages;
	}

	subject(extensionId: string): SubjectKey {
		return extensionSubject(extensionId, false, this.signerOf(extensionId));
	}

	stored(extensionId: string): IStoredConsents | undefined {
		if (!this.trust || !this.ready()) {
			return undefined;
		}
		const subject = this.subject(extensionId);
		const state = this.trust.state;
		return { subject, epoch: state.epoch, grants: state.grants.filter(grant => grant.subject === subject), refusals: state.refusals.filter(refusal => refusal.subject === subject) };
	}

	/** At most once a day per grant: G.4's 30-day unused expiry counts from the last use. */
	used(extensionId: string, capability: string): void {
		const stored = this.stored(extensionId);
		const now = Date.now();
		const touch = (stored?.grants ?? []).filter(grant => consentKey(grant.capability) === consentKey(capability) && now - Math.max(grant.lastUsedAt, this.touched.get(grant.id) ?? 0) > DAY_MS);
		if (touch.length) {
			touch.forEach(grant => this.touched.set(grant.id, now));
			void this.trust?.narrow({ touch: touch.map(grant => ({ id: grant.id, at: now })) }).catch(() => undefined);
		}
	}

	state(extensionId: string, capability: string): VoltConsentState {
		const stored = this.stored(extensionId);
		if (stored) {
			const key = consentKey(capability);
			return stored.grants.some(grant => consentKey(grant.capability) === key) ? 'granted' : stored.refusals.some(refusal => consentKey(refusal.capability) === key) ? 'refused' : undefined;
		}
		const featureId = voltCapabilityFeatureId(capability);
		if (!Registry.as<IExtensionFeaturesRegistry>(Extensions.ExtensionFeaturesRegistry).getExtensionFeature(featureId)) {
			return undefined;
		}
		const entry = this.features.getEnablementData(featureId).find(data => ExtensionIdentifier.equals(data.extension, extensionId));
		return entry === undefined ? undefined : entry.enabled ? 'granted' : 'refused';
	}
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Set once the extension pages' consents were moved into the grant store. */
const CONSENTS_MIGRATED_KEY = 'volt.trust.consentsMigrated';

/**
 * The signer a third-party extension's grants are pinned to (G.9 TOFU): the gallery publisher it
 * was installed from, else `local` (a `.vsix` or a folder). A change of it drops the grants.
 */
export function extensionSigner(local: Pick<ILocalExtension, 'source' | 'publisherId'> | undefined): string {
	return local?.source === 'gallery' && local.publisherId ? `gallery:${local.publisherId.toLowerCase()}` : 'local';
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
	private managedPolicy: IAdminPolicy | undefined;

	setManagedPolicy(policy: IAdminPolicy | undefined): void {
		this.managedPolicy = policy && Object.keys(policy).length ? policy : undefined;
	}
	private readonly _onDidChangeConsent = this._register(new Emitter<{ readonly extensionId: string; readonly capability: string }>());
	readonly onDidChangeConsent = this._onDidChangeConsent.event;
	private readonly asking = new Map<string, Promise<boolean>>();
	private readonly registered = new Set<string>();
	private readonly backend: IVoltApiBackend;
	private readonly consentStore: VoltConsentStore;
	/** Third-party extensions' signers (G.9), by lower-case id. */
	private readonly signers = new Map<string, string>();
	/** The grant store was read, consents moved into it, and signers checked. */
	private storeReady = false;
	/** The features store is being set from the grant store: not mirrored back. */
	private mirroring = false;

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
		// P4: the grant store, and the installs signers come from. Not given (a host built without them): the features store alone.
		@IVoltTrustService private readonly trust: IVoltTrustService,
		@IWorkbenchExtensionManagementService private readonly extensionManagement: IWorkbenchExtensionManagementService,
	) {
		super();
		this.consentStore = new VoltConsentStore(features, trust, id => this.signers.get(id.toLowerCase()) ?? 'local', () => this.storeReady);
		this.policy = this._register(new VoltExtensionCapabilityPolicy(this.consentStore, {
			mode: () => readPolicyAuthorityMode(configurationService.getValue(POLICY_AUTHORITY_MODE_SETTING)),
			admin: () => this.managedPolicy,
			onDiff: diff => logService.warn(`[volt policy authority] shadow diff in the extension API: ${diff.extensionId} ${diff.api} ${diff.capability}${diff.target !== undefined ? ` on ${diff.target}` : ''}: before ${diff.legacy ? `denied (${diff.legacy.deniedBy})` : 'allowed'}, the Authority ${diff.authority ? `denies (${diff.authority.deniedBy}): ${diff.decision.reason}` : 'allows'}`),
		}));
		this._register(features.onDidChangeEnablement(e => {
			if (e.featureId.startsWith('volt.capability.')) {
				this._onDidChangeConsent.fire({ extensionId: e.extension.value, capability: e.featureId.slice('volt.capability.'.length) });
				if (!this.mirroring) {
					void this.mirrorPageToggle(e.extension.value, e.featureId.slice('volt.capability.'.length), e.enabled);
				}
			}
		}));
		if (trust) {
			this._register(trust.onDidChange(state => {
				const subjects = new Set([...state.grants, ...state.refusals].map(entry => entry.subject).filter(isPluginSubject));
				for (const subject of subjects) {
					this._onDidChangeConsent.fire({ extensionId: subjectExtensionId(subject)!, capability: '*' });
				}
				this.mirrorStoreToPages();
			}));
			void this.adoptGrantStore(trust, storageService);
		}
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
		const gitGraphOn = () => {
			if (!featureService.isEnabled(GIT_GRAPH_FEATURE_ID)) {
				throw new Error('volt.gitGraph: the Git Graph is turned off (the volt.git-graph extension is disabled).');
			}
		};
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
			scheduleAutomation: async (options, caller) => {
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
					createdByExtension: caller.extensionId,
				}));
			},
			showAutomations: async automationId => { await commandService.executeCommand(OPEN_AUTOMATIONS_COMMAND_ID, ...(automationId ? [automationId] : [])); },
			runAutomation: async (automationId, caller) => {
				const automations = this.get(IAutomationService);
				await automations.whenReady;
				ownAutomation(automations.get(automationId), automationId, caller);
				return (await automations.runNow(automationId)).map(run => ({ id: run.id, status: run.status, ...(run.threadId ? { chatId: run.threadId } : {}) }));
			},
			deleteAutomation: async (automationId, caller) => {
				const automations = this.get(IAutomationService);
				await automations.whenReady;
				ownAutomation(automations.get(automationId), automationId, caller);
				await automations.delete(automationId);
			},
			listSkills: async () => (await this.get(IAgentCustomizeService).getItems()).filter(item => item.kind !== 'memory').map(item => ({
				kind: item.kind,
				name: item.name,
				description: item.description,
				scope: item.scope,
				...(item.origin ? { origin: item.origin } : {}),
				...(item.plugin && item.kind !== 'plugin' ? { plugin: item.plugin.name } : {}),
			})),
			showSkills: async marketplace => { await commandService.executeCommand(marketplace ? OPEN_SKILLS_MARKETPLACE_COMMAND_ID : OPEN_SKILLS_COMMAND_ID); },
			showRemoteDevices: async addDevice => { await commandService.executeCommand(OPEN_VOLT_SETTINGS_COMMAND_ID, addDevice ? 'devices:add' : 'devices'); },
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
			// The open project's own agent files: home, plugin and managed ones stay in Volt.
			listAgentResources: async () => {
				const folder = this.get(IWorkspaceContextService).getWorkspace().folders[0]?.uri;
				if (!folder) {
					return [];
				}
				const resources = this.get(IAgentResourcesService);
				const items = resources.get(folder) ?? await resources.load(folder);
				return items.filter(item => agentResourceScopeKind(item.scope) === 'workspace').map(item => ({
					group: item.group,
					ecosystem: item.ecosystem,
					kind: item.kind,
					path: item.relativePath,
					scope: item.scope,
					...(item.name ? { name: item.name } : {}),
					...(item.description ? { description: item.description } : {}),
				}));
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
			// The Git Graph's commands load its module on first use (voltFeatureModuleTable.ts).
			openGitGraph: async options => {
				gitGraphOn();
				await commandService.executeCommand(OPEN_GIT_GRAPH_COMMAND_ID, options);
			},
			askGitAgent: async options => {
				gitGraphOn();
				await commandService.executeCommand(GIT_GRAPH_ASK_AGENT_COMMAND_ID, options);
			},
		};
	}

	createContext(extension: IExtensionDescription, subscriptions: DisposableStore, options?: { readonly sandboxed?: boolean }): IVoltPluginContext {
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
			...(options?.sandboxed ? { sandboxed: true } : {}),
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
			const trust = this.storeReady ? this.trust : undefined;
			const subject = this.consentStore.subject(extension.identifier.value);
			// G.12: one prompt a minute and three a day per extension, none after two refusals until the Access page is opened.
			if (trust && !trust.budget.take(subject)) {
				this.logService.info(`[volt extension api] not asking about ${capability} for ${extension.identifier.value}: its prompt budget is spent`);
				return Promise.resolve(false);
			}
			const dialog = this._register(new DisposableStore());
			pending = new Promise<{ readonly granted: boolean; readonly gesture?: IUserGestureToken }>(resolve => {
				dialog.add(showVoltExtensionConsent(this.layoutService, {
					extensionName: extension.displayName ?? extension.name, publisher: extension.publisher, capability, class: capabilityClass(capability) ?? 'high', reason,
					...(trust ? { gesture: { registry: trust.gestures, principal: subject } } : {}),
				}, (granted, gesture) => resolve({ granted, ...(gesture ? { gesture } : {}) })));
			}).then(async ({ granted, gesture }) => {
				if (this._store.isDisposed) {
					return false; // the window closed the dialog, not the user: nothing is recorded
				}
				this.ensureFeature(capability);
				if (trust) {
					try {
						if (granted) {
							const at = Date.now();
							await trust.grant(subject, [{ id: `consent:${subject}:${versionedCapability(capability)}:${at}`, subject, capability: versionedCapability(capability), scope: {}, kind: 'persistent', source: 'user', grantedAt: at, lastUsedAt: at }], gesture);
						} else {
							trust.budget.refused(subject);
							await trust.narrow({ refuse: [{ subject, capability: versionedCapability(capability), at: Date.now() }] });
						}
					} catch (err) {
						this.logService.warn(`[volt extension api] ${extension.identifier.value} ${capability}: ${err instanceof Error ? err.message : err}`);
						return false;
					}
				}
				this.setPage(extension.identifier.value, capability, granted);
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
		const stored = this.consentStore.stored(extensionId);
		if (stored) {
			const answers = new Map<string, boolean>();
			stored.refusals.forEach(refusal => answers.set(consentKey(refusal.capability), false));
			stored.grants.forEach(grant => answers.set(consentKey(grant.capability), true));
			return [...answers].map(([capability, granted]) => ({ capability, granted }));
		}
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

	subjectOf(extensionId: string): SubjectKey {
		return this.consentStore.subject(extensionId);
	}

	/** The extension page's copy of a consent, set without mirroring it back into the grant store. */
	private setPage(extensionId: string, capability: string, granted: boolean): void {
		this.ensureFeature(capability);
		this.mirroring = true;
		try {
			this.features.setEnablement(new ExtensionIdentifier(extensionId), voltCapabilityFeatureId(capability), granted);
		} finally {
			this.mirroring = false;
		}
	}

	/**
	 * The grant store becomes where consents live (P4): read it, move the extension pages' earlier
	 * answers into it once, learn each installed extension's signer and drop the grants of a
	 * signer that changed (G.9), then answer from it.
	 */
	private async adoptGrantStore(trust: IVoltTrustService, storage: IStorageService): Promise<void> {
		await trust.whenReady;
		try {
			for (const local of await this.extensionManagement?.getInstalled() ?? []) {
				if (!local.isBuiltin) {
					this.signers.set(local.identifier.id.toLowerCase(), extensionSigner(local));
				}
			}
			if (this.extensionManagement) {
				this._register(this.extensionManagement.onDidInstallExtensions(results => {
					for (const result of results) {
						if (result.local && !result.local.isBuiltin) {
							this.signers.set(result.local.identifier.id.toLowerCase(), extensionSigner(result.local));
						}
					}
					void this.dropChangedSigners(trust);
				}));
			}
			if (!storage.getBoolean(CONSENTS_MIGRATED_KEY, StorageScope.APPLICATION, false) && trust.state.status !== 'newer') {
				const grants: TrustGrantDraft[] = [];
				const refusals: IRefusal[] = [];
				const at = Date.now();
				const byExtension = new Map<string, IConsentRecord[]>();
				for (const capability of this.registered) {
					for (const entry of this.features.getEnablementData(voltCapabilityFeatureId(capability))) {
						const list = byExtension.get(entry.extension.value) ?? [];
						list.push({ capability, granted: entry.enabled });
						byExtension.set(entry.extension.value, list);
					}
				}
				for (const [extensionId, records] of byExtension) {
					const moved = consentsToGrants(this.consentStore.subject(extensionId), records, at, 0);
					grants.push(...moved.grants);
					refusals.push(...moved.refusals);
				}
				if (grants.length || refusals.length) {
					await trust.record({ add: grants, refuse: refusals }, 'migration');
				}
				storage.store(CONSENTS_MIGRATED_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			}
			await this.dropChangedSigners(trust);
			this.storeReady = true;
			this.mirrorStoreToPages();
		} catch (err) {
			// Without the store the extension pages' consents keep answering, as before.
			this.logService.warn(`[volt extension api] consents stay on the extension pages: ${err instanceof Error ? err.message : err}`);
		}
	}

	/** G.9: an extension now signed by someone else starts with nothing. */
	private async dropChangedSigners(trust: IVoltTrustService): Promise<void> {
		const drops = [...this.signers].flatMap(([extensionId, signer]) => signerChangeDrops(trust.state, extensionId, signer));
		if (drops.length) {
			this.logService.warn(`[volt extension api] signer changed, permissions dropped: ${drops.join(', ')}`);
			await trust.narrow({ dropSubjects: drops });
		}
	}

	/** Allow Access or Revoke Access on an extension's Features page: the grant store follows. */
	private async mirrorPageToggle(extensionId: string, capability: string, enabled: boolean): Promise<void> {
		const trust = this.storeReady ? this.trust : undefined;
		const stored = this.consentStore.stored(extensionId);
		if (!trust || !stored) {
			return;
		}
		const key = consentKey(capability);
		const held = stored.grants.filter(grant => consentKey(grant.capability) === key);
		try {
			if (enabled && !held.length) {
				const at = Date.now();
				await trust.record({ add: [{ id: `consent:${stored.subject}:${versionedCapability(key)}:${at}`, subject: stored.subject, capability: versionedCapability(key), scope: {}, kind: 'persistent', source: 'user', grantedAt: at, lastUsedAt: at }], unrefuse: [{ subject: stored.subject, capability: key }] }, 'extension-page');
			} else if (!enabled && (held.length || !stored.refusals.some(refusal => consentKey(refusal.capability) === key))) {
				await trust.narrow({ revoke: held.map(grant => grant.id), refuse: [{ subject: stored.subject, capability: versionedCapability(key), at: Date.now() }] });
			}
		} catch (err) {
			this.logService.warn(`[volt extension api] could not record ${key} for ${extensionId}: ${err instanceof Error ? err.message : err}`);
		}
	}

	/** A grant revoked on the Access page (or dropped): the extension page shows it revoked too. */
	private mirrorStoreToPages(): void {
		if (!this.storeReady) {
			return;
		}
		for (const capability of this.registered) {
			for (const entry of this.features.getEnablementData(voltCapabilityFeatureId(capability))) {
				if (entry.enabled && this.consentStore.state(entry.extension.value, capability) !== 'granted') {
					this.setPage(entry.extension.value, capability, false);
				}
			}
		}
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

/** An extension runs or deletes only the automations it scheduled; the user's own (and other extensions') stay out of reach. */
function ownAutomation(automation: IAutomation | undefined, automationId: string, caller: IVoltApiCaller): void {
	if (!automation || automation.createdByExtension !== caller.extensionId) {
		throw new Error(`volt.automations: ${automationId} is not an automation ${caller.label} scheduled.`);
	}
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
