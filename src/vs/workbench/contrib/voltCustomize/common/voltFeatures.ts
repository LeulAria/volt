/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ContextKeyExpr, ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CODE_INTELLIGENCE_TOOLS } from '../../../services/voltRuntime/common/codeIntelligence.js';
import { CAPTURE_TOOL_NAMES, DEVICE_TOOL_NAMES } from '../../../services/voltRuntime/common/deviceTools.js';
import { DESKTOP_TOOL_NAMES } from '../../../services/voltRuntime/common/desktopTools.js';
import { ASK_QUESTION_TOOL_NAME, AUTOMATION_TOOL_NAMES, AWAIT_ANSWERS_TOOL_NAME, BROWSER_DESIGN_TOOL_NAMES, BROWSER_TOOL_NAMES, COMMIT_PLAN_TOOL_NAMES, IMAGE_INSPECT_TOOL_NAME, PULL_REQUEST_TOOL_NAMES, THREAD_TOOL_NAMES, VISUAL_TOOL_NAMES } from '../../../services/voltRuntime/common/hostTools.js';
import { IDE_TOOL_NAMES } from '../../../services/voltRuntime/common/ide/ideTools.js';
import { JOB_WATCH_TOOL_NAMES } from '../../../services/voltRuntime/common/jobs/jobWatch.js';
import { MEMORY_TOOL_NAMES } from '../../../services/voltRuntime/common/memory/voltMemory.js';
import { AGENT_TASK_TOOL_NAMES } from '../../../services/voltRuntime/common/orchestration/agentTasks.js';
import { ORCHESTRA_TOOL_NAMES } from '../../../services/voltRuntime/common/orchestration/orchestra.js';
import { PLAYGROUND_TOOL_NAMES } from '../../../services/voltRuntime/common/playgroundTools.js';
import { TERMINAL_TOOL_NAMES } from '../../../services/voltRuntime/common/terminalTools.js';
import { IVoltPluginManifest, validateVoltContributes, VoltModuleCategory } from '../../../services/voltPlugins/common/voltContributions.js';
import { VOLT_FEATURE_MANIFESTS } from './voltFeatureManifests.generated.js';

/**
 * Volt's features, as the Capabilities tab lists them and as extensions turn them on and off.
 *
 * A feature with an `extensionId` comes with Volt as a built-in extension (a manifest under
 * `extensions/volt-*`) and is on while that extension is enabled. Its manifest is the source of
 * what it owns (`contributes.voltModule`, `voltTools`, `voltSlotItems`, ...); the catalog is
 * generated from the manifests (`scripts/volt-generate-features.mjs`). Disabling it in Extensions
 * (or Turn Off in Capabilities) takes away everything it lists: its agent tools (in the window and
 * on the agent server), its sidebar buttons, its Volt Settings pages, its side toolbar sections,
 * its entries in the right panel's "+" menu and its model providers. A feature with no extension is
 * Volt's core and always on.
 */

export type VoltFeatureCategoryId = VoltModuleCategory;

export interface IVoltFeatureCategory {
	readonly id: VoltFeatureCategoryId;
	readonly label: string;
	/** Codicon id. */
	readonly icon: string;
}

export const VOLT_FEATURE_CATEGORIES: readonly IVoltFeatureCategory[] = [
	{ id: 'agents', label: 'Agents', icon: 'hubot' },
	{ id: 'workspace', label: 'Workspace', icon: 'folder' },
	{ id: 'tools', label: 'Agent tools', icon: 'tools' },
	{ id: 'productivity', label: 'Automations and usage', icon: 'calendar' },
	{ id: 'resources', label: 'Skills and resources', icon: 'library' },
	{ id: 'providers', label: 'Providers and accounts', icon: 'account' },
	{ id: 'customize', label: 'Customize', icon: 'paintcan' },
];

/** Things a feature owns, by the id each place already uses for them. */
export type VoltFeaturePart =
	/** A Volt Settings page (`SettingsSection`). */
	| 'section'
	/** A sidebar button (`VOLT_SLOT_ITEMS`). */
	| 'item'
	/** An entry in the right panel's "+" menu (`agentSurfaceMenuItems`). */
	| 'surface'
	/** A side toolbar section or quick action (`agentDockSections`). */
	| 'dock'
	/** A model picker provider family (`providerFamily`). */
	| 'provider'
	/** An agent tool (the volt MCP server). */
	| 'tool';

export interface IVoltFeature {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly category: VoltFeatureCategoryId;
	/** Codicon id. */
	readonly icon: string;
	/** `volt.usage`: the built-in extension that carries it. None: core, always on. */
	readonly extensionId?: string;
	readonly tools?: readonly string[];
	readonly commands?: readonly string[];
	/** Setting keys, or prefixes ending in `.`. */
	readonly settings?: readonly string[];
	readonly items?: readonly string[];
	readonly sections?: readonly string[];
	readonly surfaces?: readonly string[];
	readonly dock?: readonly string[];
	readonly providers?: readonly string[];
}

const PROVIDERS: readonly { id: string; label: string; description: string }[] = [
	{ id: 'claude', label: 'Claude', description: 'Claude Code and Anthropic API models in the model picker and Providers & Models.' },
	{ id: 'codex', label: 'Codex', description: 'Codex (OpenAI\'s CLI) and OpenAI API models.' },
	{ id: 'cursor', label: 'Cursor', description: 'Cursor\'s agent over ACP.' },
	{ id: 'grok', label: 'Grok', description: 'Grok (xAI) models.' },
	{ id: 'opencode', label: 'OpenCode', description: 'OpenCode and OpenCode Go models.' },
	{ id: 'pi', label: 'Pi', description: 'The Pi coding agent.' },
	{ id: 'antigravity', label: 'Antigravity', description: 'Antigravity and Gemini models.' },
	{ id: 'kimi', label: 'Kimi', description: 'Kimi models.' },
	{ id: 'muse', label: 'Muse', description: 'Muse models.' },
	{ id: 'fx', label: 'FX', description: 'FX models.' },
	{ id: 'local', label: 'Local models', description: 'Ollama, LM Studio and any OpenAI-compatible server on your machine.' },
	{ id: 'openrouter', label: 'OpenRouter', description: 'Models through OpenRouter.' },
];

/**
 * Volt's core features: no manifest and no switch. `order` places them among the manifests'
 * features of their category (`voltModule.order`).
 */
const CORE = {
	// --- Agents ---
	threads: {
		id: 'threads', label: 'Chats and threads', category: 'agents', icon: 'comment-discussion',
		description: 'Chats, and agents that read, message, fork, merge back and launch other chats.',
		tools: THREAD_TOOL_NAMES.filter(name => name.startsWith('thread_') || name === 'orchestrator_capabilities'),
		commands: ['workbench.action.voltAgent.newChat'],
		settings: ['volt.agent.workflow'],
	},
	queue: {
		id: 'queue', label: 'Message queue', category: 'agents', icon: 'list-ordered',
		description: 'Messages queued behind a running turn: edit, reorder, cancel, send now. Agents manage other chats\' queues too.',
		tools: THREAD_TOOL_NAMES.filter(name => name.startsWith('queue_')),
	},
	subagents: {
		id: 'subagents', label: 'Subagents and tasks', category: 'agents', icon: 'type-hierarchy-sub',
		description: 'An agent hands work to other models (delegate_task), waits for it, messages it, or hands the chat off.',
		tools: AGENT_TASK_TOOL_NAMES,
	},
	runGroups: {
		id: 'runGroups', label: 'Run groups', category: 'agents', icon: 'versions',
		description: 'One prompt on two to four models side by side in worktrees; compare and pick a winner.',
		commands: ['volt.runGroup.open', 'volt.runGroup.stop', 'volt.runGroup.archive'],
	},
	questions: {
		id: 'questions', label: 'Questions and plans', category: 'agents', icon: 'question',
		description: 'Agents ask multiple-choice questions and propose plans for approval.',
		tools: [ASK_QUESTION_TOOL_NAME, AWAIT_ANSWERS_TOOL_NAME, 'propose_plan'],
	},
	// --- Workspace ---
	worktrees: {
		id: 'worktrees', label: 'Worktrees', category: 'workspace', icon: 'git-branch',
		description: 'Chats in their own git worktrees; agents read their status, list them and hand work between them.',
		tools: THREAD_TOOL_NAMES.filter(name => name.startsWith('worktree_')),
	},
	terminals: {
		id: 'terminals', label: 'Terminals and dev servers', category: 'workspace', icon: 'terminal',
		description: 'Long-running processes the user can watch, background jobs an agent waits on, Docker, and opening apps.',
		tools: [...TERMINAL_TOOL_NAMES, ...JOB_WATCH_TOOL_NAMES, 'docker_ensure', 'app_open'],
		settings: ['terminal.integrated.'],
	},
	workspaceContext: {
		id: 'workspaceContext', label: 'Workspace context', category: 'workspace', icon: 'eye',
		description: 'What is open beside the chat (tabs, simulator, terminals, git) sent to agents, and workspace_status.',
		tools: ['workspace_status'],
	},
	// --- Agent tools ---
	images: {
		id: 'images', label: 'Image inspection', category: 'tools', icon: 'file-media',
		description: 'Exact colors, block bounds and text bands from an image (building a page from a design).',
		tools: [IMAGE_INSPECT_TOOL_NAME],
	},
} satisfies Record<string, IVoltFeature>;

export const VOLT_CORE_FEATURES: readonly { readonly feature: IVoltFeature; readonly order: number }[] = [
	{ feature: CORE.threads, order: 10 },
	{ feature: CORE.queue, order: 20 },
	{ feature: CORE.subagents, order: 30 },
	{ feature: CORE.runGroups, order: 40 },
	{ feature: CORE.questions, order: 50 },
	{ feature: CORE.worktrees, order: 10 },
	{ feature: CORE.terminals, order: 20 },
	{ feature: CORE.workspaceContext, order: 30 },
	{ feature: CORE.images, order: 70 },
];

/**
 * The catalog as it was written by hand before the manifests became its source (M1). The
 * generated catalog must deep-equal it (voltFeatures.test.ts), and it stands in when the
 * manifests' data doesn't validate. Remove it once the manifests have been the source for a release.
 */
export const VOLT_FEATURES_HAND_WRITTEN: readonly IVoltFeature[] = [
	// --- Agents (core) ---
	CORE.threads,
	CORE.queue,
	CORE.subagents,
	{
		id: 'orchestra', label: 'Teams and councils', category: 'agents', icon: 'organization', extensionId: 'volt.orchestra',
		description: 'Agent teams with a shared board, councils that weigh a question across models, and runs on your other machines.',
		tools: [...ORCHESTRA_TOOL_NAMES],
		commands: ['volt.orchestra.measureCapacity'],
		settings: ['volt.orchestra.'],
		sections: ['orchestration'],
	},
	CORE.runGroups,
	CORE.questions,
	// --- Workspace (core) ---
	CORE.worktrees,
	CORE.terminals,
	CORE.workspaceContext,
	{
		id: 'codeIntelligence', label: 'Code intelligence', category: 'workspace', icon: 'symbol-class', extensionId: 'volt.code-intelligence',
		description: 'Volt\'s code index (instant grep, symbol and file search) and the editor\'s language servers (navigation, diagnostics, refactors) for agents.',
		tools: CODE_INTELLIGENCE_TOOLS.map(tool => tool.name),
		settings: ['volt.codeIntelligence.'],
		sections: ['codeIntelligence'],
	},
	{
		id: 'devEnvironment', label: 'Tests, debugging and tasks', category: 'workspace', icon: 'debug-alt', extensionId: 'volt.dev-environment',
		description: 'Agents run tests, debug programs, run tasks and use the editor\'s other services through the ide gateway.',
		tools: [...IDE_TOOL_NAMES],
		commands: ['volt.agentIde.openActivityTab'],
		settings: ['volt.agent.ide.'],
	},
	{
		id: 'gitGraph', label: 'Git Graph', category: 'workspace', icon: 'git-commit', extensionId: 'volt.git-graph',
		description: 'The Git Graph tab, file and line history.',
		commands: ['volt.gitGraph.open', 'volt.gitGraph.openInTools', 'volt.gitGraph.fileHistory', 'volt.gitGraph.lineHistory'],
		settings: ['volt.gitGraph.'],
		surfaces: ['gitGraph'],
	},
	{
		id: 'pullRequests', label: 'Pull requests', category: 'workspace', icon: 'git-pull-request', extensionId: 'volt.pull-requests',
		description: 'Pull request links, watching, stacks and the Pull Requests page.',
		tools: PULL_REQUEST_TOOL_NAMES,
		commands: ['volt.pullRequest.openPage', 'volt.pullRequest.showList'],
		settings: ['volt.pullRequests.', 'volt.sourceControl.hosts'],
		// Not the side toolbar's `pullRequests` section: it also holds Changes and the branch.
		items: ['volt.pullRequestsPage', 'volt.pullRequests'],
	},
	{
		id: 'commitReview', label: 'Commit review', category: 'workspace', icon: 'git-compare', extensionId: 'volt.commit-review',
		description: 'Agents propose commits for the user to review, and name a worktree\'s branch.',
		tools: COMMIT_PLAN_TOOL_NAMES,
	},
	{
		id: 'remoteDevices', label: 'Remote devices', category: 'workspace', icon: 'remote', extensionId: 'volt.remote-devices',
		description: 'Pair phones and browsers with this machine\'s agent server (Settings > Devices).',
		commands: ['volt.agentServer.pairDevice'],
		settings: ['volt.agentServer.'],
		sections: ['devices'],
	},
	// --- Agent tools ---
	{
		id: 'browser', label: 'Browser', category: 'tools', icon: 'globe', extensionId: 'volt.browser',
		description: 'The in-app browser, and the tools agents use to drive, test and audit pages in it.',
		tools: [...BROWSER_TOOL_NAMES, ...BROWSER_DESIGN_TOOL_NAMES],
		commands: ['workbench.action.openBrowser'],
		settings: ['volt.browser.'],
		surfaces: ['browser'],
		dock: ['browser'],
	},
	{
		id: 'playgrounds', label: 'Playgrounds', category: 'tools', icon: 'beaker', extensionId: 'volt.playgrounds',
		description: 'Throwaway pages agents build and check outside the project.',
		tools: PLAYGROUND_TOOL_NAMES,
	},
	{
		id: 'httpClient', label: 'HTTP client', category: 'tools', icon: 'send', extensionId: 'volt.http-client',
		description: 'Send and save requests in .http files and read the responses, from the right panel\'s + menu.',
		commands: ['volt.http.openInTools', 'volt.http.newRequest', 'volt.http.selectEnvironment', 'volt.http.refresh'],
		surfaces: ['http'],
	},
	{
		id: 'visuals', label: 'Charts, HTML and canvas', category: 'tools', icon: 'graph', extensionId: 'volt.visuals',
		description: 'Charts, HTML pages, mockups and the canvas, drawn in the chat.',
		tools: VISUAL_TOOL_NAMES.filter(name => name !== 'render_html' && name !== 'preview_html'),
		settings: ['volt.canvas.'],
		surfaces: ['canvas'],
	},
	{
		id: 'scratch', label: 'Scratch board', category: 'tools', icon: 'edit', extensionId: 'volt.scratch-board',
		description: 'The whiteboard before a new chat, and the tools agents draw on it with.',
		tools: ['scratch_read', 'scratch_draw'],
		commands: ['workbench.action.voltScratchBoard.open', 'workbench.action.voltScratchBoard.openFresh', 'workbench.action.voltScratchBoard.openInTools'],
		settings: ['volt.scratch.'],
		surfaces: ['scratch'],
		dock: ['scratch'],
	},
	{
		id: 'devices', label: 'Simulators and window capture', category: 'tools', icon: 'device-mobile', extensionId: 'volt.devices',
		description: 'iOS simulators and Android emulators agents can drive, and window capture and recording.',
		tools: [...DEVICE_TOOL_NAMES, ...CAPTURE_TOOL_NAMES],
		commands: ['volt.devices.openPreview'],
		settings: ['volt.devices.'],
		surfaces: ['device'],
	},
	{
		id: 'computerUse', label: 'Computer use', category: 'tools', icon: 'device-desktop', extensionId: 'volt.computer-use',
		description: 'Agents read and drive native apps on this Mac through accessibility.',
		tools: DESKTOP_TOOL_NAMES,
		settings: ['volt.computerUse.'],
	},
	CORE.images,
	// --- Automations and usage ---
	{
		id: 'automations', label: 'Automations', category: 'productivity', icon: 'calendar', extensionId: 'volt.automations',
		description: 'Scheduled and triggered runs, the calendar, and the tools agents manage them with.',
		tools: AUTOMATION_TOOL_NAMES,
		commands: ['voltAgent.automations.open', 'voltAgent.automations.new', 'voltAgent.automations.runs'],
		settings: ['volt.automations.'],
		items: ['volt.automations'],
		sections: ['automations'],
		surfaces: ['automations'],
		dock: ['automations'],
	},
	{
		id: 'usage', label: 'Usage', category: 'productivity', icon: 'pulse', extensionId: 'volt.usage',
		description: 'Usage limits and runway for every account, the Usage page and button, and its side toolbar section.',
		commands: ['workbench.action.voltAgent.usage'],
		items: ['volt.usage'],
		sections: ['usage'],
		dock: ['usage'],
	},
	{
		id: 'memory', label: 'Memory', category: 'productivity', icon: 'database', extensionId: 'volt.memory',
		description: 'Notes agents keep between chats, and skills they write for themselves.',
		tools: MEMORY_TOOL_NAMES,
	},
	// --- Skills and resources ---
	{
		id: 'skills', label: 'Skills & Plugins', category: 'resources', icon: 'extensions', extensionId: 'volt.skills-and-plugins',
		description: 'Skills, subagents, rules, hooks and MCP servers, and installing more from skills.sh and plugin marketplaces.',
		commands: ['workbench.action.voltAgent.customize', 'workbench.action.voltAgent.customize.marketplace'],
		items: ['volt.customize'],
		sections: ['customize'],
	},
	{
		id: 'agentResources', label: 'Agent Resources', category: 'resources', icon: 'library', extensionId: 'volt.agent-resources',
		description: 'What each harness loads (instructions, skills, agents, MCP) and in what order, in the files sidebar and its own page.',
		commands: ['volt.agent.openAgentResources'],
		settings: ['volt.agentResources.'],
		dock: ['resources'],
	},
	// --- Providers and accounts ---
	...PROVIDERS.map((provider): IVoltFeature => ({
		id: `provider.${provider.id}`, label: provider.label, category: 'providers', icon: 'hubot', extensionId: `volt.provider-${provider.id}`,
		description: provider.description,
		providers: [provider.id],
	})),
	{
		id: 'claudeAccounts', label: 'Claude accounts', category: 'providers', icon: 'person', extensionId: 'volt.claude-accounts',
		description: 'Several Claude logins with one switch, and switching when one runs out.',
		settings: ['volt.claude.'],
	},
	// --- Customize ---
	{
		id: 'customize', label: 'Customize Volt', category: 'customize', icon: 'paintcan', extensionId: 'volt.customize',
		description: 'Looks, layouts and slots, the Customize Volt page, and the Playground where agents change Volt.',
		commands: ['volt.customize.open', 'volt.customize.openPlayground', 'volt.customize.selectLayout', 'volt.customize.selectLook'],
		settings: ['volt.customize.', 'volt.look.'],
		sections: ['customizeVolt'],
	},
];

/** The feature a built-in extension's manifest describes (`contributes.voltModule` and the parts it contributes). */
export function voltFeatureFromManifest(manifest: IVoltPluginManifest): IVoltFeature | undefined {
	const contributes = manifest.contributes;
	const voltModule = contributes?.voltModule;
	if (!contributes || !voltModule) {
		return undefined;
	}
	const ids = (list: readonly { readonly id: string }[] | undefined) => list ? { ids: list.map(entry => entry.id) } : undefined;
	const tools = contributes.voltTools?.map(tool => tool.name);
	const items = ids(contributes.voltSlotItems);
	const sections = ids(contributes.voltSettingsPages);
	const surfaces = ids(contributes.voltSurfaces);
	const dock = ids(contributes.voltDock);
	const providers = ids(contributes.voltAgents);
	return {
		id: voltModule.feature,
		label: voltModule.label,
		category: voltModule.category,
		icon: voltModule.icon,
		extensionId: `${manifest.publisher}.${manifest.name}`,
		description: voltModule.description,
		...(tools ? { tools } : {}),
		...(voltModule.commands ? { commands: [...voltModule.commands] } : {}),
		...(voltModule.settings ? { settings: [...voltModule.settings] } : {}),
		...(items ? { items: items.ids } : {}),
		...(sections ? { sections: sections.ids } : {}),
		...(surfaces ? { surfaces: surfaces.ids } : {}),
		...(dock ? { dock: dock.ids } : {}),
		...(providers ? { providers: providers.ids } : {}),
	};
}

/**
 * The catalog: core features plus one per manifest, by category and then `order`. Throws when a
 * manifest's Volt contributions don't validate or two features share an id.
 */
export function generateVoltFeatures(manifests: readonly IVoltPluginManifest[], core: readonly { readonly feature: IVoltFeature; readonly order: number }[]): IVoltFeature[] {
	const entries: { feature: IVoltFeature; order: number }[] = [...core];
	for (const manifest of manifests) {
		const problems = validateVoltContributes(manifest.contributes);
		if (problems.length) {
			throw new Error(`${manifest.publisher}.${manifest.name}: ${problems.join('; ')}`);
		}
		const feature = voltFeatureFromManifest(manifest);
		if (feature) {
			entries.push({ feature, order: manifest.contributes!.voltModule!.order });
		}
	}
	const ids = new Set<string>();
	for (const { feature } of entries) {
		if (ids.has(feature.id)) {
			throw new Error(`Two features are called ${feature.id}`);
		}
		ids.add(feature.id);
	}
	const category = (id: VoltFeatureCategoryId) => VOLT_FEATURE_CATEGORIES.findIndex(entry => entry.id === id);
	// Array sort is stable: equal orders keep core first, then manifests by folder name.
	return entries.sort((a, b) => category(a.feature.category) - category(b.feature.category) || a.order - b.order).map(entry => entry.feature);
}

/** The catalog from these manifests, or the hand-written one (with the reason) when they don't make one. */
export function loadVoltFeatures(manifests: readonly IVoltPluginManifest[] = VOLT_FEATURE_MANIFESTS): { readonly features: readonly IVoltFeature[]; readonly source: 'manifests' | 'hand-written'; readonly error?: string } {
	try {
		return { features: generateVoltFeatures(manifests, VOLT_CORE_FEATURES), source: 'manifests' };
	} catch (error) {
		// A bad manifest must never take Volt apart: the hand-written list is today's catalog.
		return { features: VOLT_FEATURES_HAND_WRITTEN, source: 'hand-written', error: error instanceof Error ? error.message : String(error) };
	}
}

const LOADED = loadVoltFeatures();

/** Where `VOLT_FEATURES` came from, and why it fell back. */
export const VOLT_FEATURES_SOURCE: { readonly source: 'manifests' | 'hand-written'; readonly error?: string } = { source: LOADED.source, ...(LOADED.error ? { error: LOADED.error } : {}) };

/** Volt's features, generated from the `extensions/volt-*` manifests (`voltFeatureManifests.generated.ts`). */
export const VOLT_FEATURES: readonly IVoltFeature[] = LOADED.features;

const OWNERS = new Map<string, string>();
for (const feature of VOLT_FEATURES) {
	if (!feature.extensionId) {
		continue;
	}
	for (const [part, ids] of [['section', feature.sections], ['item', feature.items], ['surface', feature.surfaces], ['dock', feature.dock], ['provider', feature.providers], ['tool', feature.tools]] as const) {
		for (const id of ids ?? []) {
			OWNERS.set(`${part}:${id}`, feature.id);
		}
	}
}

/** The feature that can turn this off, if any (core parts have none). */
export function voltFeatureOwning(part: VoltFeaturePart, id: string): string | undefined {
	return OWNERS.get(`${part}:${id}`);
}

export function voltFeature(id: string): IVoltFeature | undefined {
	return VOLT_FEATURES.find(feature => feature.id === id);
}

export function voltFeatureSettingMatches(feature: IVoltFeature, key: string): boolean {
	return !!feature.settings?.some(setting => setting.endsWith('.') ? key.startsWith(setting) : key === setting);
}

/** `voltFeature.<id>`: the context key `IVoltFeatureService` keeps true while the feature is on. */
export function voltFeatureContextKey(featureId: string): string {
	return `voltFeature.${featureId}`;
}

/**
 * A when clause that holds while the feature is on, for the views, menus and commands of a feature
 * without a module. The feature service is eager and binds the key (true for a feature that is on,
 * or whose manifest is missing) when the window starts, in every workbench these parts are in.
 */
export function voltFeatureOn(featureId: string): ContextKeyExpression {
	return ContextKeyExpr.has(voltFeatureContextKey(featureId));
}

/**
 * Keeps what `create` makes (a controller, a provider registration) while the feature is on: made
 * now or when it turns on, disposed when it turns off, for a feature without a module.
 */
export function whileVoltFeatureOn(features: IVoltFeatureService, featureId: string, create: () => IDisposable): IDisposable {
	const store = new DisposableStore();
	const part = store.add(new MutableDisposable());
	const update = () => {
		if (!features.isEnabled(featureId)) {
			part.clear();
		} else if (!part.value) {
			part.value = create();
		}
	};
	update();
	store.add(features.onDidChange(update));
	return store;
}

/**
 * Which features are on. Volt's views ask it before they draw what a feature owns, and redraw on
 * change; nothing a feature doesn't own is ever off.
 */
export const IVoltFeatureService = createDecorator<IVoltFeatureService>('voltFeatureService');

export interface IVoltFeatureService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	isEnabled(featureId: string): boolean;
	/** Whether a page, button, menu entry, section, provider or tool is on (its feature is). */
	isOn(part: VoltFeaturePart, id: string): boolean;
	/** Enables or disables the feature's extension (globally). */
	setEnabled(featureId: string, enabled: boolean): Promise<void>;
}
