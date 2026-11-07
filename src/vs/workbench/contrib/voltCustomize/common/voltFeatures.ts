/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { CODE_INTELLIGENCE_TOOLS } from '../../../services/voltRuntime/common/codeIntelligence.js';
import { CAPTURE_TOOL_NAMES, DEVICE_TOOL_NAMES } from '../../../services/voltRuntime/common/deviceTools.js';
import { DESKTOP_TOOL_NAMES } from '../../../services/voltRuntime/common/desktopTools.js';
import { ASK_QUESTION_TOOL_NAME, AUTOMATION_TOOL_NAMES, AWAIT_ANSWERS_TOOL_NAME, BROWSER_DESIGN_TOOL_NAMES, BROWSER_TOOL_NAMES, COMMIT_PLAN_TOOL_NAMES, IMAGE_INSPECT_TOOL_NAME, PULL_REQUEST_TOOL_NAMES, THREAD_TOOL_NAMES, VISUAL_TOOL_NAMES } from '../../../services/voltRuntime/common/hostTools.js';
import { MEMORY_TOOL_NAMES } from '../../../services/voltRuntime/common/memory/voltMemory.js';
import { AGENT_TASK_TOOL_NAMES } from '../../../services/voltRuntime/common/orchestration/agentTasks.js';
import { PLAYGROUND_TOOL_NAMES } from '../../../services/voltRuntime/common/playgroundTools.js';
import { TERMINAL_TOOL_NAMES } from '../../../services/voltRuntime/common/terminalTools.js';

/**
 * Volt's features, as the Capabilities tab lists them and as extensions turn them on and off.
 *
 * A feature with an `extensionId` comes with Volt as a built-in extension (a manifest under
 * `extensions/volt-*`) and is on while that extension is enabled. Disabling it in Extensions (or
 * Turn Off in Capabilities) takes away everything it lists: its agent tools, its sidebar buttons,
 * its Volt Settings pages, its side toolbar sections, its entries in the right panel's "+" menu and
 * its model providers. A feature with no extension is Volt's core and always on.
 */

export type VoltFeatureCategoryId = 'agents' | 'workspace' | 'tools' | 'productivity' | 'resources' | 'providers' | 'customize';

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

export const VOLT_FEATURES: readonly IVoltFeature[] = [
	// --- Agents (core) ---
	{
		id: 'threads', label: 'Chats and threads', category: 'agents', icon: 'comment-discussion',
		description: 'Chats, and agents that read, message, fork, merge back and launch other chats.',
		tools: THREAD_TOOL_NAMES.filter(name => name.startsWith('thread_') || name === 'orchestrator_capabilities'),
		commands: ['workbench.action.voltAgent.newChat'],
		settings: ['volt.agent.workflow'],
	},
	{
		id: 'queue', label: 'Message queue', category: 'agents', icon: 'list-ordered',
		description: 'Messages queued behind a running turn: edit, reorder, cancel, send now. Agents manage other chats\' queues too.',
		tools: THREAD_TOOL_NAMES.filter(name => name.startsWith('queue_')),
	},
	{
		id: 'subagents', label: 'Subagents and tasks', category: 'agents', icon: 'type-hierarchy-sub',
		description: 'An agent hands work to other models (delegate_task), waits for it, messages it, or hands the chat off.',
		tools: AGENT_TASK_TOOL_NAMES,
	},
	{
		id: 'runGroups', label: 'Run groups', category: 'agents', icon: 'versions',
		description: 'One prompt on two to four models side by side in worktrees; compare and pick a winner.',
		commands: ['volt.runGroup.open', 'volt.runGroup.stop', 'volt.runGroup.archive'],
	},
	{
		id: 'questions', label: 'Questions and plans', category: 'agents', icon: 'question',
		description: 'Agents ask multiple-choice questions and propose plans for approval.',
		tools: [ASK_QUESTION_TOOL_NAME, AWAIT_ANSWERS_TOOL_NAME, 'propose_plan'],
	},
	// --- Workspace (core) ---
	{
		id: 'worktrees', label: 'Worktrees', category: 'workspace', icon: 'git-branch',
		description: 'Chats in their own git worktrees; agents read their status, list them and hand work between them.',
		tools: THREAD_TOOL_NAMES.filter(name => name.startsWith('worktree_')),
	},
	{
		id: 'terminals', label: 'Terminals and dev servers', category: 'workspace', icon: 'terminal',
		description: 'Long-running processes the user can watch, Docker, and opening apps.',
		tools: [...TERMINAL_TOOL_NAMES, 'docker_ensure', 'app_open'],
		settings: ['terminal.integrated.'],
	},
	{
		id: 'workspaceContext', label: 'Workspace context', category: 'workspace', icon: 'eye',
		description: 'What is open beside the chat (tabs, simulator, terminals, git) sent to agents, and workspace_status.',
		tools: ['workspace_status'],
	},
	{
		id: 'codeIntelligence', label: 'Code intelligence', category: 'workspace', icon: 'symbol-class', extensionId: 'volt.code-intelligence',
		description: 'Volt\'s code index: instant grep, symbol and file search for agents.',
		tools: CODE_INTELLIGENCE_TOOLS.map(tool => tool.name),
		settings: ['volt.codeIntelligence.'],
		sections: ['codeIntelligence'],
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
	{
		id: 'images', label: 'Image inspection', category: 'tools', icon: 'file-media',
		description: 'Exact colors, block bounds and text bands from an image (building a page from a design).',
		tools: [IMAGE_INSPECT_TOOL_NAME],
	},
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
