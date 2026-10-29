/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parse, ParseError } from '../../../../base/common/json.js';
import { localize } from '../../../../nls.js';

/**
 * Agent Resources: the files that configure coding agents (instructions, skills, subagents,
 * commands, hooks, MCP and other settings), found in a project and grouped by what they are.
 * A file belongs to one group, decided by its place and, for settings files, by what it
 * configures: `.mcp.json` is an Integration, `SKILL.md` a Skill, and AGENTS.md and CLAUDE.md
 * stay two separate files even though they do the same job.
 */

export type AgentResourceGroupId = 'instructions' | 'skills' | 'subagents' | 'commands' | 'hooks' | 'integrations' | 'config';

export type AgentResourceEcosystem = 'agents' | 'claude' | 'cursor' | 'gemini' | 'codex' | 'copilot' | 'windsurf' | 'cline' | 'opencode' | 'aider' | 'vscode' | 'volt';

/**
 * Where a file lives and who it is for. In the project: `project` (at the root, shared through the
 * repository), `nested` (under a subfolder) and `local` (personal, usually not committed). Outside it:
 * `global` (the user's home folder, every project), `external` (installed by a plugin or extension
 * manager) and `managed` (put there by an organization; read-only).
 */
export type AgentResourceScope = 'project' | 'nested' | 'local' | 'global' | 'external' | 'managed';

/** The four scopes the management page filters by. */
export type AgentResourceScopeKind = 'workspace' | 'global' | 'external' | 'managed';

export function agentResourceScopeKind(scope: AgentResourceScope): AgentResourceScopeKind {
	switch (scope) {
		case 'project':
		case 'nested':
		case 'local':
			return 'workspace';
		default:
			return scope;
	}
}

export const AGENT_RESOURCE_SCOPE_KIND_LABELS: Record<AgentResourceScopeKind, string> = {
	workspace: localize('agentResources.scopeKind.workspace', "Workspace"),
	global: localize('agentResources.scopeKind.global', "Global"),
	external: localize('agentResources.scopeKind.external', "External"),
	managed: localize('agentResources.scopeKind.managed', "Managed"),
};

export const AGENT_RESOURCE_SCOPE_KIND_DESCRIPTIONS: Record<AgentResourceScopeKind, string> = {
	workspace: localize('agentResources.scopeKind.workspaceDesc', "Belongs to this repository"),
	global: localize('agentResources.scopeKind.globalDesc', "Yours, in every project"),
	external: localize('agentResources.scopeKind.externalDesc', "Installed by a plugin or extension manager"),
	managed: localize('agentResources.scopeKind.managedDesc', "Set by your organization, read-only"),
};

export interface IAgentResourceStatus {
	readonly kind: 'ok' | 'warning' | 'error';
	readonly message?: string;
}

/** An SVG drawn in a 24 grid with round strokes: `[tag, attributes]` per shape. */
export type AgentResourceIconShapes = readonly (readonly [string, Record<string, string | number>])[];

export interface IAgentResourceGroup {
	readonly id: AgentResourceGroupId;
	readonly label: string;
	/** The group's files, for an empty list: "No skills". */
	readonly empty: string;
	readonly icon: AgentResourceIconShapes;
}

/** Lucide icons (via Aria Icons): scroll-text, sparkle, bot, square-slash, webhook, plug, sliders-horizontal. */
export const AGENT_RESOURCE_GROUPS: readonly IAgentResourceGroup[] = [
	{
		id: 'instructions',
		label: localize('agentResources.instructions', "Instructions"),
		empty: localize('agentResources.instructions.empty', "No instruction files"),
		icon: [
			['path', { d: 'M15 12h-5' }],
			['path', { d: 'M15 8h-5' }],
			['path', { d: 'M19 17V5a2 2 0 0 0-2-2H4' }],
			['path', { d: 'M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3' }],
		],
	},
	{
		id: 'skills',
		label: localize('agentResources.skills', "Skills"),
		empty: localize('agentResources.skills.empty', "No skills"),
		// One four-point star (lucide sparkle): the three-part sparkles read as noise at 15px.
		icon: [
			['path', { d: 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z' }],
		],
	},
	{
		id: 'subagents',
		label: localize('agentResources.subagents', "Subagents"),
		empty: localize('agentResources.subagents.empty', "No subagents"),
		icon: [
			['path', { d: 'M12 8V4H8' }],
			['rect', { width: 16, height: 12, x: 4, y: 8, rx: 2 }],
			['path', { d: 'M2 14h2' }],
			['path', { d: 'M20 14h2' }],
			['path', { d: 'M15 13v2' }],
			['path', { d: 'M9 13v2' }],
		],
	},
	{
		id: 'commands',
		label: localize('agentResources.commands', "Commands & Prompts"),
		empty: localize('agentResources.commands.empty', "No commands or prompts"),
		icon: [
			['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2 }],
			['line', { x1: 9, x2: 15, y1: 15, y2: 9 }],
		],
	},
	{
		id: 'hooks',
		label: localize('agentResources.hooks', "Hooks & Automation"),
		empty: localize('agentResources.hooks.empty', "No hooks or automations"),
		icon: [
			['path', { d: 'M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2' }],
			['path', { d: 'm6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06' }],
			['path', { d: 'm12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8' }],
		],
	},
	{
		id: 'integrations',
		label: localize('agentResources.integrations', "Integrations"),
		empty: localize('agentResources.integrations.empty', "No MCP or plugin configuration"),
		icon: [
			['path', { d: 'M12 22v-5' }],
			['path', { d: 'M15 8V2' }],
			['path', { d: 'M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z' }],
			['path', { d: 'M9 8V2' }],
		],
	},
	{
		id: 'config',
		label: localize('agentResources.config', "Other Agent Config"),
		empty: localize('agentResources.config.empty', "No other agent settings"),
		icon: [
			['path', { d: 'M10 5H3' }],
			['path', { d: 'M12 19H3' }],
			['path', { d: 'M14 3v4' }],
			['path', { d: 'M16 17v4' }],
			['path', { d: 'M21 12h-9' }],
			['path', { d: 'M21 19h-5' }],
			['path', { d: 'M21 5h-7' }],
			['path', { d: 'M8 10v4' }],
			['path', { d: 'M8 12H3' }],
		],
	},
];

/** The files sidebar's filter button (lucide list-filter). */
export const AGENT_RESOURCE_FILTER_ICON: AgentResourceIconShapes = [
	['path', { d: 'M3 6h18' }],
	['path', { d: 'M7 12h10' }],
	['path', { d: 'M10 18h4' }],
];

export function agentResourceGroup(id: AgentResourceGroupId): IAgentResourceGroup {
	return AGENT_RESOURCE_GROUPS.find(group => group.id === id)!;
}

export const AGENT_RESOURCE_ECOSYSTEM_LABELS: Record<AgentResourceEcosystem, string> = {
	// AGENTS.md and .agents/ are read by many agents (Codex, Cursor, Amp, ...), not one.
	agents: 'Shared',
	claude: 'Claude Code',
	cursor: 'Cursor',
	gemini: 'Gemini CLI',
	codex: 'Codex',
	copilot: 'GitHub Copilot',
	windsurf: 'Windsurf',
	cline: 'Cline',
	opencode: 'OpenCode',
	aider: 'Aider',
	vscode: 'VS Code',
	volt: 'Volt',
};

export function agentResourceScopeLabel(scope: AgentResourceScope, relativePath: string): string {
	switch (scope) {
		case 'project': return localize('agentResources.scope.project', "Project");
		case 'local': return localize('agentResources.scope.local', "Local, not shared");
		case 'global': return localize('agentResources.scope.global', "Global");
		case 'external': return localize('agentResources.scope.external', "External");
		case 'managed': return localize('agentResources.scope.managed', "Managed");
		case 'nested': {
			const folder = nestedFolder(relativePath);
			return folder
				? localize('agentResources.scope.nestedIn', "Folder {0}", folder)
				: localize('agentResources.scope.nested', "Subfolder");
		}
	}
}

/** The agent config folders and whose they are. `.github` only counts for the Copilot files below. */
const CONFIG_DIRS: Record<string, AgentResourceEcosystem> = {
	'.claude': 'claude',
	'.cursor': 'cursor',
	'.gemini': 'gemini',
	'.codex': 'codex',
	'.agents': 'agents',
	'.volt': 'volt',
	'.windsurf': 'windsurf',
	'.opencode': 'opencode',
	'.clinerules': 'cline',
	// Copilot's home folder (~/.copilot): instructions, agents, skills, hooks, mcp-config.json.
	'.copilot': 'copilot',
};

/** Plugin manifests: `.claude-plugin/plugin.json` and the like. */
const PLUGIN_DIRS: Record<string, AgentResourceEcosystem> = {
	'.claude-plugin': 'claude',
	'.cursor-plugin': 'cursor',
	'.volt-plugin': 'volt',
	'.codex-plugin': 'codex',
};

/**
 * What the workspace search lists before {@link classifyAgentResource} decides. Broad on purpose:
 * every file under a config folder is listed, and the classifier keeps the ones it knows.
 */
export const AGENT_RESOURCE_INCLUDE_GLOBS: readonly string[] = [
	'**/AGENTS.md', '**/AGENTS.override.md', '**/CLAUDE.md', '**/CLAUDE.local.md', '**/GEMINI.md',
	'**/.cursorrules', '**/.windsurfrules', '**/.clinerules', '**/.cursorignore', '**/.cursorindexingignore', '**/.geminiignore',
	'**/.aiderignore', '**/.aider.conf.yml', '**/.mcp.json', '**/opencode.json', '**/opencode.jsonc',
	...Object.keys(CONFIG_DIRS).map(dir => `**/${dir}/**`),
	...Object.keys(PLUGIN_DIRS).map(dir => `**/${dir}/*.json`),
	'**/.github/copilot-instructions.md', '**/.github/instructions/**', '**/.github/prompts/**', '**/.github/chatmodes/**', '**/.github/agents/**',
	'**/.github/workflows/*.yml', '**/.github/workflows/*.yaml', '**/.github/hooks/*.json',
	'**/.vscode/mcp.json', '**/skills/*/SKILL.md',
];

/** Never searched: dependencies, build output, and the worktrees agents keep inside their config folders. */
export const AGENT_RESOURCE_EXCLUDE_GLOBS: readonly string[] = [
	'**/node_modules/**', '**/.git/**', '**/.build/**', '**/out/**', '**/dist/**', '**/.next/**', '**/target/**',
	'**/.venv/**', '**/venv/**', '**/vendor/**', '**/Pods/**', '**/DerivedData/**',
	'**/.claude/worktrees/**', '**/.claude/projects/**', '**/.volt/worktrees/**', '**/.cursor/worktrees/**', '**/.codex/sessions/**',
];

/** What a path says about a file before its content is read. */
export interface IAgentResourceMatch {
	readonly group: AgentResourceGroupId;
	readonly ecosystem: AgentResourceEcosystem;
	/** "Rule", "Skill", "Settings": the file's type within its group. */
	readonly kind: string;
	readonly scope: AgentResourceScope;
	/**
	 * How the content is read. `settings` files move to Hooks or Integrations when they define
	 * hooks or MCP servers; `workflow` files only count when they run an agent.
	 */
	readonly format: 'markdown' | 'frontmatter' | 'json' | 'settings' | 'toml' | 'workflow' | 'text';
}

/** A classified file, without its location. */
export interface IAgentResourceInfo {
	readonly group: AgentResourceGroupId;
	readonly ecosystem: AgentResourceEcosystem;
	readonly kind: string;
	readonly scope: AgentResourceScope;
	readonly status: IAgentResourceStatus;
	/** The name it goes by when it has one (a skill's `name`), else undefined. */
	readonly name?: string;
	/** One line about it: a description from front matter, "3 MCP servers". */
	readonly description?: string;
}

/** Claude Code warns past this: instruction files are loaded on every turn. */
const LARGE_INSTRUCTIONS_CHARS = 40_000;

const AGENT_WORKFLOW_PATTERN = /anthropics\/claude-code-action|anthropics\/claude-code-base-action|openai\/codex-action|google-github-actions\/run-gemini-cli|cursor-agent|@anthropic-ai\/claude-code|claude\s+-p\b|codex\s+exec\b|gemini\s+-p\b|copilot-swe-agent/i;

function segmentsOf(relativePath: string): string[] {
	return relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
}

function nestedFolder(relativePath: string): string | undefined {
	const segments = segmentsOf(relativePath);
	const configIndex = segments.findIndex(segment => segment in CONFIG_DIRS || segment in PLUGIN_DIRS || segment === '.github' || segment === '.vscode');
	const folder = segments.slice(0, configIndex >= 0 ? configIndex : segments.length - 1);
	return folder.length ? folder.join('/') : undefined;
}

/**
 * Classifies `relativePath` (from the project root, `/`-separated) by where it sits, or returns
 * undefined for a file that is not an agent resource.
 */
export function matchAgentResource(relativePath: string): IAgentResourceMatch | undefined {
	const segments = segmentsOf(relativePath);
	const file = segments[segments.length - 1];
	if (!file) {
		return undefined;
	}
	const lower = file.toLowerCase();
	const local = /\.local\.[^.]+$/i.test(file);
	// The innermost config folder decides whose a file is.
	let configIndex = -1;
	for (let index = segments.length - 2; index >= 0; index--) {
		if (segments[index] in CONFIG_DIRS || segments[index] in PLUGIN_DIRS) {
			configIndex = index;
			break;
		}
	}
	const atRoot = configIndex >= 0 ? configIndex === 0 : segments.length === 1;
	const scope: AgentResourceScope = local ? 'local' : atRoot ? 'project' : 'nested';
	const match = (group: AgentResourceGroupId, ecosystem: AgentResourceEcosystem, kind: string, format: IAgentResourceMatch['format']): IAgentResourceMatch => ({ group, ecosystem, kind, scope, format });

	// Skills: SKILL.md in a skill's own folder under a skills directory (config folder or plugin).
	if (file === 'SKILL.md' && segments.length >= 3 && segments[segments.length - 3] === 'skills') {
		const ecosystem = configIndex >= 0
			? (CONFIG_DIRS[segments[configIndex]] ?? PLUGIN_DIRS[segments[configIndex]])
			: segments[segments.length - 4] === '.github' ? 'copilot' : 'agents';
		return match('skills', ecosystem, localize('agentResources.kind.skill', "Skill"), 'frontmatter');
	}

	if (configIndex >= 0) {
		const dir = segments[configIndex];
		if (dir in PLUGIN_DIRS) {
			return lower.endsWith('.json') && configIndex === segments.length - 2
				? match('integrations', PLUGIN_DIRS[dir], lower === 'marketplace.json' ? localize('agentResources.kind.marketplace', "Plugin marketplace") : localize('agentResources.kind.plugin', "Plugin manifest"), 'json')
				: undefined;
		}
		return matchInConfigDir(dir, segments.slice(configIndex + 1), match);
	}

	// Copilot keeps its files under .github.
	const githubIndex = segments.lastIndexOf('.github');
	if (githubIndex >= 0 && githubIndex < segments.length - 1) {
		const sub = segments.slice(githubIndex + 1);
		const githubScope: AgentResourceScope = githubIndex === 0 ? 'project' : 'nested';
		const copilot = (group: AgentResourceGroupId, kind: string, format: IAgentResourceMatch['format']): IAgentResourceMatch => ({ group, ecosystem: 'copilot', kind, scope: githubScope, format });
		if (sub.length === 1 && file === 'copilot-instructions.md') {
			return copilot('instructions', localize('agentResources.kind.instructions', "Instructions"), 'markdown');
		}
		if (sub[0] === 'instructions' && lower.endsWith('.instructions.md')) {
			return copilot('instructions', localize('agentResources.kind.scopedInstructions', "Scoped instructions"), 'frontmatter');
		}
		if (sub[0] === 'prompts' && lower.endsWith('.prompt.md')) {
			return copilot('commands', localize('agentResources.kind.prompt', "Prompt file"), 'frontmatter');
		}
		if ((sub[0] === 'chatmodes' && lower.endsWith('.chatmode.md')) || (sub[0] === 'agents' && lower.endsWith('.agent.md'))) {
			return copilot('subagents', localize('agentResources.kind.customAgent', "Custom agent"), 'frontmatter');
		}
		if (sub[0] === 'hooks' && sub.length === 2 && lower.endsWith('.json')) {
			return copilot('hooks', localize('agentResources.kind.hooks', "Hooks"), 'json');
		}
		if (sub[0] === 'workflows' && sub.length === 2 && /\.ya?ml$/.test(lower)) {
			// Which agent runs it is only known from the content; GitHub Actions is the vehicle.
			return { group: 'hooks', ecosystem: 'copilot', kind: localize('agentResources.kind.workflow', "Agent workflow"), scope: githubScope, format: 'workflow' };
		}
		return undefined;
	}

	if (segments.length >= 2 && segments[segments.length - 2] === '.vscode' && file === 'mcp.json') {
		return match('integrations', 'vscode', localize('agentResources.kind.mcp', "MCP servers"), 'json');
	}

	switch (file) {
		case 'AGENTS.md':
		case 'AGENTS.override.md':
			return match('instructions', file === 'AGENTS.override.md' ? 'codex' : 'agents', localize('agentResources.kind.instructions', "Instructions"), 'markdown');
		case 'CLAUDE.md':
		case 'CLAUDE.local.md':
			return match('instructions', 'claude', localize('agentResources.kind.memory', "Memory file"), 'markdown');
		case 'GEMINI.md':
			return match('instructions', 'gemini', localize('agentResources.kind.context', "Context file"), 'markdown');
		case '.cursorrules':
			return match('instructions', 'cursor', localize('agentResources.kind.legacyRules', "Rules (legacy)"), 'text');
		case '.windsurfrules':
			return match('instructions', 'windsurf', localize('agentResources.kind.rules', "Rules"), 'text');
		case '.clinerules':
			return match('instructions', 'cline', localize('agentResources.kind.rules', "Rules"), 'text');
		case '.mcp.json':
			return match('integrations', 'claude', localize('agentResources.kind.mcp', "MCP servers"), 'json');
		case 'opencode.json':
		case 'opencode.jsonc':
			return match('config', 'opencode', localize('agentResources.kind.settings', "Settings"), 'settings');
		case '.cursorignore':
		case '.cursorindexingignore':
			return match('config', 'cursor', localize('agentResources.kind.ignore', "Ignore file"), 'text');
		case '.geminiignore':
			return match('config', 'gemini', localize('agentResources.kind.ignore', "Ignore file"), 'text');
		case '.aiderignore':
			return match('config', 'aider', localize('agentResources.kind.ignore', "Ignore file"), 'text');
		case '.aider.conf.yml':
			return match('config', 'aider', localize('agentResources.kind.settings', "Settings"), 'text');
	}
	return undefined;
}

function matchInConfigDir(
	dir: string,
	sub: readonly string[],
	match: (group: AgentResourceGroupId, ecosystem: AgentResourceEcosystem, kind: string, format: IAgentResourceMatch['format']) => IAgentResourceMatch,
): IAgentResourceMatch | undefined {
	const ecosystem = CONFIG_DIRS[dir];
	const file = sub[sub.length - 1];
	const lower = file.toLowerCase();
	const markdown = lower.endsWith('.md') || lower.endsWith('.mdc');
	// `.clinerules/` is itself the rules folder.
	if (dir === '.clinerules') {
		return markdown ? match('instructions', ecosystem, localize('agentResources.kind.rule', "Rule"), 'markdown') : undefined;
	}
	if (sub.length === 1) {
		switch (lower) {
			case 'claude.md':
			case 'agents.md':
			case 'gemini.md':
				return match('instructions', ecosystem, localize('agentResources.kind.instructions', "Instructions"), 'markdown');
			case 'agents.override.md':
				// Codex reads it in place of AGENTS.md.
				return match('instructions', ecosystem, localize('agentResources.kind.override', "Instructions override"), 'markdown');
			case 'mcp.json':
			case 'mcp-config.json':
				return match('integrations', ecosystem, localize('agentResources.kind.mcp', "MCP servers"), 'json');
			case 'requirements.toml':
				return match('config', ecosystem, localize('agentResources.kind.requirements', "Requirements (enforced)"), 'toml');
			case 'managed_config.toml':
				return match('config', ecosystem, localize('agentResources.kind.managedDefaults', "Managed defaults"), 'toml');
			case 'hooks.json':
				return match('hooks', ecosystem, localize('agentResources.kind.hooks', "Hooks"), 'json');
			case 'settings.json':
			case 'settings.local.json':
			case 'cli.json':
			case 'cli-config.json':
			case 'opencode.json':
			case 'environment.json':
				return match('config', ecosystem, localize('agentResources.kind.settings', "Settings"), 'settings');
			case 'config.toml':
				return match('config', ecosystem, localize('agentResources.kind.settings', "Settings"), 'toml');
			case 'keybindings.json':
				return match('config', ecosystem, localize('agentResources.kind.keybindings', "Keybindings"), 'json');
		}
		return undefined;
	}
	switch (sub[0]) {
		case 'rules':
			if (markdown) {
				return match('instructions', ecosystem, localize('agentResources.kind.rule', "Rule"), 'frontmatter');
			}
			// Codex's exec policy (Starlark): which commands run, ask, or are forbidden.
			return lower.endsWith('.rules') ? match('config', ecosystem, localize('agentResources.kind.commandRules', "Command rules"), 'text') : undefined;
		case 'instructions':
			return lower.endsWith('.instructions.md') || markdown ? match('instructions', ecosystem, localize('agentResources.kind.scopedInstructions', "Scoped instructions"), 'frontmatter') : undefined;
		case 'extensions':
			// A Gemini CLI extension's manifest; what it ships is the extension's own.
			return sub.length === 3 && lower === 'gemini-extension.json' ? match('integrations', ecosystem, localize('agentResources.kind.extension', "Extension"), 'json') : undefined;
		case 'agents':
		case 'agent':
			if (markdown) {
				return match('subagents', ecosystem, localize('agentResources.kind.subagent', "Subagent"), 'frontmatter');
			}
			return lower.endsWith('.toml') ? match('subagents', ecosystem, localize('agentResources.kind.subagent', "Subagent"), 'toml') : undefined;
		case 'commands':
		case 'command':
			if (markdown) {
				return match('commands', ecosystem, localize('agentResources.kind.command', "Slash command"), 'markdown');
			}
			// Gemini CLI commands are TOML.
			return lower.endsWith('.toml') ? match('commands', ecosystem, localize('agentResources.kind.command', "Slash command"), 'toml') : undefined;
		case 'prompts':
			return markdown ? match('commands', ecosystem, localize('agentResources.kind.prompt', "Prompt file"), 'markdown') : undefined;
		case 'workflows':
			// Windsurf workflows are slash-invoked prompts.
			return markdown ? match('commands', ecosystem, localize('agentResources.kind.workflowPrompt', "Workflow"), 'markdown') : undefined;
		case 'hooks':
			return match('hooks', ecosystem, localize('agentResources.kind.hookScript', "Hook script"), 'text');
		case 'output-styles':
			return markdown ? match('config', ecosystem, localize('agentResources.kind.outputStyle', "Output style"), 'frontmatter') : undefined;
	}
	return undefined;
}

/** The `---` block at the top of a Markdown file, as lowercased keys and raw values; undefined without one. */
export function readFrontmatter(text: string): Record<string, string> | undefined {
	// A byte order mark (U+FEFF) before the front matter.
	const normalized = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, '\n');
	if (!normalized.startsWith('---\n')) {
		return undefined;
	}
	const end = normalized.indexOf('\n---', 3);
	if (end === -1) {
		return undefined;
	}
	const data: Record<string, string> = {};
	let key: string | undefined;
	for (const line of normalized.slice(4, end).split('\n')) {
		const entry = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (entry) {
			key = entry[1].toLowerCase();
			// `>` and `|` start a folded or literal block: the value is the lines under it.
			const value = entry[2].trim();
			data[key] = /^[>|][+-]?$/.test(value) ? '' : unquote(value);
		} else if (key && /^\s+\S/.test(line)) {
			// A folded block or list under the last key.
			data[key] = `${data[key]} ${line.trim()}`.trim();
		}
	}
	return data;
}

function unquote(value: string): string {
	return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
}

function ok(): IAgentResourceStatus {
	return { kind: 'ok' };
}

function countLabel(count: number, one: string, many: string): string {
	return count === 1 ? one : many.replace('{0}', String(count));
}

/**
 * Decides a file's group, type and status. `content` undefined means it could not be read
 * (too big, or gone): the path alone decides, and the status says so.
 */
export function classifyAgentResource(relativePath: string, content: string | undefined): IAgentResourceInfo | undefined {
	const match = matchAgentResource(relativePath);
	return match ? classifyAgentResourceMatch(match, relativePath, content) : undefined;
}

/** {@link classifyAgentResource} for a file whose type is already known (an organization's managed files). */
export function classifyAgentResourceMatch(match: IAgentResourceMatch, relativePath: string, content: string | undefined): IAgentResourceInfo | undefined {
	const base: { -readonly [K in keyof IAgentResourceInfo]: IAgentResourceInfo[K] } = { group: match.group, ecosystem: match.ecosystem, kind: match.kind, scope: match.scope, status: ok() };
	if (content === undefined) {
		if (match.format === 'workflow') {
			return undefined;
		}
		base.status = { kind: 'warning', message: localize('agentResources.status.unread', "Not read: the file is too large") };
		return base;
	}
	if (!content.trim()) {
		if (match.format === 'workflow') {
			return undefined;
		}
		base.status = { kind: 'warning', message: localize('agentResources.status.empty', "Empty file") };
		return base;
	}
	switch (match.format) {
		case 'markdown':
		case 'frontmatter': {
			const front = readFrontmatter(content);
			base.name = front?.name || undefined;
			base.description = front?.description || undefined;
			if (match.group === 'skills' || match.group === 'subagents') {
				if (!front) {
					base.status = { kind: 'warning', message: localize('agentResources.status.noFrontmatter', "No front matter: agents cannot tell when to use it") };
				} else if (!front.description) {
					base.status = { kind: 'warning', message: localize('agentResources.status.noDescription', "No description in the front matter") };
				} else if (match.group === 'skills' && !front.name) {
					base.status = { kind: 'warning', message: localize('agentResources.status.noName', "No name in the front matter") };
				}
			} else if (match.group === 'instructions' && relativePath.toLowerCase().endsWith('.mdc')) {
				// A Cursor rule with none of these is never applied.
				if (!front || (!front.description && !front.globs && front.alwaysapply !== 'true')) {
					base.status = { kind: 'warning', message: localize('agentResources.status.ruleNeverApplied', "Never applied: no description, globs, or alwaysApply") };
				}
			} else if (match.group === 'instructions' && content.length > LARGE_INSTRUCTIONS_CHARS) {
				base.status = { kind: 'warning', message: localize('agentResources.status.large', "Large: {0}k characters are read on every turn", Math.round(content.length / 1000)) };
			}
			return base;
		}
		case 'json':
		case 'settings': {
			const errors: ParseError[] = [];
			const value = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
			if (errors.length || typeof value !== 'object' || value === null || Array.isArray(value)) {
				base.status = { kind: 'error', message: localize('agentResources.status.invalidJson', "Invalid JSON") };
				return base;
			}
			const object = value as Record<string, unknown>;
			const servers = objectKeys(object.mcpServers) ?? objectKeys(object.servers) ?? objectKeys(object.mcp);
			const hooks = objectKeys(object.hooks);
			if (match.format === 'settings') {
				// What a settings file configures decides its group; hooks first, as they run code.
				if (hooks?.length) {
					base.group = 'hooks';
					base.kind = localize('agentResources.kind.settingsHooks', "Hooks in settings");
				} else if (servers?.length) {
					base.group = 'integrations';
					base.kind = localize('agentResources.kind.settingsMcp', "MCP servers in settings");
				}
			}
			if (base.group === 'integrations' && servers) {
				base.description = countLabel(servers.length, localize('agentResources.oneServer', "1 MCP server"), localize('agentResources.servers', "{0} MCP servers"));
			} else if (base.group === 'integrations' && typeof object.name === 'string') {
				base.name = object.name;
				base.description = typeof object.description === 'string' ? object.description : undefined;
			} else if (base.group === 'hooks' && hooks) {
				base.description = countLabel(hooks.length, localize('agentResources.oneHookEvent', "1 hook event"), localize('agentResources.hookEvents', "{0} hook events"));
			}
			return base;
		}
		case 'toml': {
			if (match.group === 'config' && /^\s*\[mcp_servers[.\]]/m.test(content)) {
				base.group = 'integrations';
				base.kind = localize('agentResources.kind.settingsMcp', "MCP servers in settings");
				const names = new Set([...content.matchAll(/^\s*\[mcp_servers\.([^.\]\s]+)/gm)].map(entry => entry[1]));
				base.description = countLabel(names.size, localize('agentResources.oneServer', "1 MCP server"), localize('agentResources.servers', "{0} MCP servers"));
			} else if (match.group === 'commands') {
				base.description = /^\s*description\s*=\s*["'](.+?)["']/m.exec(content)?.[1];
			}
			return base;
		}
		case 'workflow': {
			// A CI workflow only counts when it runs an agent; which one comes from the action it uses.
			const runs = AGENT_WORKFLOW_PATTERN.exec(content);
			if (!runs) {
				return undefined;
			}
			const used = runs[0].toLowerCase();
			base.ecosystem = used.includes('claude') ? 'claude' : used.includes('codex') ? 'codex' : used.includes('gemini') ? 'gemini' : used.includes('cursor') ? 'cursor' : 'copilot';
			base.description = /^name:\s*(.+)$/m.exec(content)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
			return base;
		}
		case 'text':
			return base;
	}
}

function objectKeys(value: unknown): string[] | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : undefined;
}
