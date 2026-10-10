/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { basename, dirname, joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { frontmatterValue, isTruthy, parseFrontmatterDocument } from './agentFrontmatter.js';

/**
 * Discovery of agent customizations on disk: rules, skills, subagents,
 * commands, hooks, MCP servers and plugins, in the workspace and in the user home.
 *
 * Volt owns `.volt/`; the equivalent Claude Code, Cursor, Codex and `.agents`
 * layouts are read too (including their installed plugins) so an existing
 * setup is understood without migration.
 */

export type AgentCustomizationKind = 'rule' | 'skill' | 'subagent' | 'command' | 'hook' | 'mcp' | 'memory' | 'plugin';
export type AgentCustomizationScope = 'workspace' | 'user';
/** Whose folder layout an item was found in. */
export type AgentCustomizationOrigin = 'volt' | 'claude' | 'cursor' | 'codex' | 'agents' | 'builtin';
/** When a rule reaches the agent. */
export type AgentRuleMode = 'always' | 'intelligent' | 'files' | 'manual';

export interface IAgentPluginInfo {
	/** Stable across scans: `<origin>:<name>@<marketplace>`. */
	readonly id: string;
	readonly name: string;
	readonly displayName: string;
	/** Author or vendor, shown under the name ("AWS", "Cursor"). */
	readonly publisher: string;
	readonly description: string;
	readonly origin: AgentCustomizationOrigin;
	/** The installed plugin folder. */
	readonly root: URI;
	/** `plugin.json`, when the plugin has one. */
	readonly manifest?: URI;
	/** Logo image inside the plugin folder. */
	readonly logo?: URI;
	readonly marketplace?: string;
	readonly version?: string;
}

export interface IAgentMcpServerConfig {
	readonly command?: string;
	readonly args?: readonly string[];
	readonly url?: string;
	readonly type?: string;
	readonly disabled?: boolean;
	/** The server sends headers (often a token): it may need sign-in. */
	readonly hasHeaders?: boolean;
}

export interface IAgentCustomization {
	readonly kind: AgentCustomizationKind;
	readonly scope: AgentCustomizationScope;
	readonly name: string;
	readonly description: string;
	/** File to open. For MCP servers and hooks this is the config file; for a plugin, its manifest. */
	readonly resource: URI;
	/** Folder label the item was found in ("my-repo/.claude", "~/.cursor", a plugin's name). */
	readonly source: string;
	/** Source bytes when the file was read, used for context-window estimates. */
	readonly bytes?: number;
	/** Whose layout it came from. */
	readonly origin?: AgentCustomizationOrigin;
	/** The plugin that ships it. A `plugin` item describes the plugin itself. */
	readonly plugin?: IAgentPluginInfo;
	/** The workspace folder a workspace item belongs to. */
	readonly folder?: URI;
	/** Hooks: the command(s) the event runs. */
	readonly command?: string;
	readonly mcp?: IAgentMcpServerConfig;
	readonly ruleMode?: AgentRuleMode;
	readonly globs?: readonly string[];
	/** Subagents: the model it asks for (`inherit` when unset). */
	readonly model?: string;
}

export interface IAgentCustomizationKindInfo {
	readonly kind: AgentCustomizationKind;
	readonly label: string;
	readonly plural: string;
	readonly icon: ThemeIcon;
	/** Relative directory under `.volt/` where new items are created. */
	readonly newItemDir: string | undefined;
	readonly newItemFile: (name: string) => string;
	readonly template: (name: string) => string;
}

export const CUSTOMIZATION_KINDS: readonly IAgentCustomizationKindInfo[] = [
	{
		kind: 'plugin', label: localize('voltCustomize.plugin', "Plugin"), plural: localize('voltCustomize.plugins', "Plugins"), icon: Codicon.extensions,
		newItemDir: 'plugins', newItemFile: name => `${name}/.volt-plugin/plugin.json`,
		template: name => `{\n\t"name": "${name}",\n\t"displayName": "${name}",\n\t"version": "0.1.0",\n\t"description": "",\n\t"skills": "./skills/",\n\t"agents": "./agents/",\n\t"rules": "./rules/",\n\t"commands": "./commands/"\n}\n`,
	},
	{
		kind: 'mcp', label: localize('voltCustomize.mcp', "MCP"), plural: localize('voltCustomize.mcps', "MCPs"), icon: Codicon.server,
		newItemDir: undefined, newItemFile: () => 'mcp.json',
		template: () => `{\n\t"mcpServers": {\n\t}\n}\n`,
	},
	{
		kind: 'skill', label: localize('voltCustomize.skill', "Skill"), plural: localize('voltCustomize.skills', "Skills"), icon: Codicon.zap,
		newItemDir: 'skills', newItemFile: name => `${name}/SKILL.md`,
		template: name => `---\nname: ${name}\ndescription: Describe what this skill does and when the agent should use it.\n---\n\n# ${skillHeading(name)}\n\nStep-by-step instructions the agent follows when this skill applies.\n`,
	},
	{
		kind: 'subagent', label: localize('voltCustomize.subagent', "Subagent"), plural: localize('voltCustomize.subagents', "Subagents"), icon: Codicon.organization,
		newItemDir: 'agents', newItemFile: name => `${name}.md`,
		template: name => `---\nname: ${name}\ndescription: Describe when Agent should delegate to this subagent.\n---\n\nYou are a specialized subagent. Describe its role and how it should respond.\n`,
	},
	{
		kind: 'rule', label: localize('voltCustomize.rule', "Rule"), plural: localize('voltCustomize.rules', "Rules"), icon: Codicon.listUnordered,
		newItemDir: 'rules', newItemFile: name => `${name}.md`,
		template: name => `---\ndescription: ${name}\nalwaysApply: false\nglobs:\n---\n\n# ${skillHeading(name)}\n\nDescribe how the agent should behave when this rule applies.\n`,
	},
	{
		kind: 'command', label: localize('voltCustomize.command', "Command"), plural: localize('voltCustomize.commands', "Commands"), icon: Codicon.terminal,
		newItemDir: 'commands', newItemFile: name => `${name}.md`,
		template: name => `# ${name}\n\nWrite your command content here.\n\nThis command will be available in chat with /${name}\n`,
	},
	{
		kind: 'hook', label: localize('voltCustomize.hook', "Hook"), plural: localize('voltCustomize.hooks', "Hooks"), icon: Codicon.plug,
		newItemDir: undefined, newItemFile: () => 'hooks.json',
		template: () => `{\n\t"version": 1,\n\t"hooks": {\n\t\t"beforeShellExecution": [],\n\t\t"afterFileEdit": []\n\t}\n}\n`,
	},
	{
		// Saved notes come from the memory service, not from a scan: see the Customize editor.
		kind: 'memory', label: localize('voltCustomize.memory', "Memory"), plural: localize('voltCustomize.memories', "Memories"), icon: Codicon.bookmark,
		newItemDir: undefined, newItemFile: name => `${name}.md`,
		template: name => `---\nname: ${name}\ndescription: When this note is relevant.\ntype: user\n---\n\nThe fact to remember, and why it matters.\n`,
	},
];

export function kindInfo(kind: AgentCustomizationKind): IAgentCustomizationKindInfo {
	return CUSTOMIZATION_KINDS.find(info => info.kind === kind)!;
}

function skillHeading(name: string): string {
	return name.split(/[-_\s]+/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || name;
}

export const ORIGIN_LABELS: Record<AgentCustomizationOrigin, string> = {
	volt: 'Volt',
	claude: 'Claude',
	cursor: 'Cursor',
	codex: 'Codex',
	agents: 'Agents',
	builtin: 'Volt',
};

//#region Parsing

/** YAML-ish front matter: scalars and folded blocks are read; keys are lowercased. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
	const data: Record<string, string> = {};
	if (!text.startsWith('---')) {
		return { data, body: text };
	}
	const end = text.indexOf('\n---', 3);
	if (end === -1) {
		return { data, body: text };
	}
	const doc = parseFrontmatterDocument(text);
	if (doc.hasFrontmatter) {
		for (const entry of doc.entries) {
			if (entry.key) {
				data[entry.key.toLowerCase()] = entry.value;
			}
		}
	}
	const body = text.slice(end + 4).replace(/^[^\n]*\n?/, '');
	return { data, body };
}

/** Description for a markdown customization: front matter first, else the first prose line. */
export function describeMarkdown(text: string, fallback = ''): { name: string | undefined; description: string } {
	const { data, body } = parseFrontmatter(text);
	const name = data['name'] || data['title'] || undefined;
	if (data['description']) {
		return { name, description: data['description'] };
	}
	for (const raw of body.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith('<!--') || line.startsWith('```')) {
			continue;
		}
		return { name, description: truncate(line.replace(/[*_`>]/g, ''), 140) };
	}
	return { name, description: fallback };
}

/** How a rule file applies, from its front matter. Files without front matter always apply. */
export function ruleModeOf(text: string): { mode: AgentRuleMode; globs: string[] } {
	const doc = parseFrontmatterDocument(text);
	if (!doc.hasFrontmatter) {
		return { mode: 'always', globs: [] };
	}
	const globs = (frontmatterValue(doc, 'globs') ?? '').split(',').map(glob => glob.trim()).filter(Boolean);
	if (isTruthy(frontmatterValue(doc, 'alwaysApply'))) {
		return { mode: 'always', globs };
	}
	if (globs.length) {
		return { mode: 'files', globs };
	}
	return { mode: frontmatterValue(doc, 'description')?.trim() ? 'intelligent' : 'manual', globs };
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

interface IMcpServer {
	readonly name: string;
	readonly description: string;
}

/** Servers in an `mcp.json` (Cursor/Volt) or Claude `.mcp.json`/settings file. */
export function mcpServersFrom(json: unknown): IMcpServer[] {
	return mcpServerConfigsFrom(json).map(server => ({ name: server.name, description: server.description }));
}

/** Servers with their launch details, for status and sign-in hints. */
export function mcpServerConfigsFrom(json: unknown): (IMcpServer & { readonly config: IAgentMcpServerConfig })[] {
	if (!json || typeof json !== 'object') {
		return [];
	}
	const servers = (json as { mcpServers?: unknown; servers?: unknown }).mcpServers ?? (json as { servers?: unknown }).servers;
	if (!servers || typeof servers !== 'object') {
		return [];
	}
	const result: (IMcpServer & { config: IAgentMcpServerConfig })[] = [];
	for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
		const server = (raw ?? {}) as { command?: unknown; args?: unknown; url?: unknown; serverUrl?: unknown; type?: unknown; description?: unknown; disabled?: unknown; headers?: unknown };
		const url = typeof server.url === 'string' ? server.url : typeof server.serverUrl === 'string' ? server.serverUrl : undefined;
		const command = typeof server.command === 'string' ? server.command : undefined;
		const args = Array.isArray(server.args) ? server.args.filter((a): a is string => typeof a === 'string') : [];
		let description = typeof server.description === 'string' ? server.description : '';
		if (!description) {
			if (url) {
				description = url;
			} else if (command) {
				description = [command, ...args].join(' ');
			}
		}
		const headers = server.headers && typeof server.headers === 'object' ? Object.keys(server.headers as object) : [];
		result.push({
			name,
			description: truncate(description, 140),
			config: {
				command,
				args,
				url,
				type: typeof server.type === 'string' ? server.type : undefined,
				disabled: server.disabled === true,
				hasHeaders: headers.length > 0,
			},
		});
	}
	return result;
}

/** Hook event names with at least one handler in a `hooks.json` or Claude `settings.json`. */
export function hookEventsFrom(json: unknown): string[] {
	return hookHandlersFrom(json).map(hook => hook.event);
}

/** Hook events with the commands they run (Cursor/Volt flat handlers and Claude matcher groups). */
export function hookHandlersFrom(json: unknown): { event: string; commands: string[] }[] {
	if (!json || typeof json !== 'object') {
		return [];
	}
	const hooks = (json as { hooks?: unknown }).hooks;
	if (!hooks || typeof hooks !== 'object') {
		return [];
	}
	const result: { event: string; commands: string[] }[] = [];
	for (const [event, handlers] of Object.entries(hooks as Record<string, unknown>)) {
		if (Array.isArray(handlers) ? !handlers.length : !handlers) {
			continue;
		}
		const commands: string[] = [];
		const collect = (value: unknown) => {
			if (!value || typeof value !== 'object') {
				return;
			}
			const handler = value as { command?: unknown; prompt?: unknown; hooks?: unknown };
			if (typeof handler.command === 'string') {
				commands.push(handler.command);
			} else if (typeof handler.prompt === 'string') {
				commands.push(handler.prompt);
			}
			if (Array.isArray(handler.hooks)) {
				handler.hooks.forEach(collect);
			}
		};
		(Array.isArray(handlers) ? handlers : [handlers]).forEach(collect);
		result.push({ event, commands });
	}
	return result;
}

//#endregion

//#region Scanning

interface IRoot {
	readonly scope: AgentCustomizationScope;
	readonly uri: URI;
	readonly label: string;
}

/** Folders that hold agent customizations, relative to a root, in precedence order. */
export const CONFIG_DIRS: readonly string[] = ['.volt', '.agents', '.claude', '.cursor', '.codex'];
/** Matches a path inside any of the {@link CONFIG_DIRS}. */
export const CONFIG_DIR_PATTERN = /(^|[\\/])\.(volt|cursor|claude|agents|codex)([\\/]|$)/;

const ORIGIN_BY_DIR: Record<string, AgentCustomizationOrigin> = {
	'.volt': 'volt',
	'.agents': 'agents',
	'.claude': 'claude',
	'.cursor': 'cursor',
	'.codex': 'codex',
};

/** What a file under a config folder is, from where it sits. Undefined for anything else. */
export function customizationKindForResource(resource: URI): AgentCustomizationKind | undefined {
	const path = resource.path;
	const name = basename(resource);
	if (/^skill\.md$/i.test(name)) {
		return 'skill';
	}
	if (!/\.(md|mdc)$/i.test(name)) {
		return undefined;
	}
	if (/\.mdc$/i.test(name) && /[\\/]rules[\\/]/.test(path)) {
		return 'rule';
	}
	const segments = path.split('/');
	const inConfig = CONFIG_DIR_PATTERN.test(path) || segments.includes('plugins');
	if (!inConfig) {
		return undefined;
	}
	const parent = segments[segments.length - 2];
	if (parent === 'agents') {
		return 'subagent';
	}
	if (parent === 'commands' || (parent === 'prompts' && /[\\/]\.codex[\\/]/.test(path))) {
		return 'command';
	}
	if (segments.slice(0, -1).includes('rules')) {
		return 'rule';
	}
	return undefined;
}

/** Resolves a folder with its direct children; undefined when missing. */
async function stat(fileService: IFileService, uri: URI, metadata = false): Promise<IFileStat | undefined> {
	try {
		return await fileService.resolve(uri, { resolveMetadata: metadata });
	} catch {
		return undefined;
	}
}

async function readText(fileService: IFileService, uri: URI, maxBytes = 64 * 1024): Promise<string | undefined> {
	try {
		const content = await fileService.readFile(uri, { limits: { size: maxBytes } });
		return content.value.toString();
	} catch {
		return undefined;
	}
}

export async function readJsonFile(fileService: IFileService, uri: URI, maxBytes = 512 * 1024): Promise<unknown> {
	const text = await readText(fileService, uri, maxBytes);
	if (text === undefined) {
		return undefined;
	}
	try {
		return JSON.parse(stripJsonComments(text));
	} catch {
		return undefined;
	}
}

function stripJsonComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
}

interface IPluginLayout {
	readonly info: IAgentPluginInfo;
	readonly skills: readonly URI[];
	readonly agents: readonly URI[];
	readonly rules: readonly URI[];
	readonly commands: readonly URI[];
	readonly hooks: readonly URI[];
	readonly mcp: readonly URI[];
	/** `mcpServers` written inline in the manifest. */
	readonly inlineMcp?: unknown;
	readonly inlineHooks?: unknown;
}

const LOGO_CANDIDATES = ['assets/avatar.png', 'assets/logo.png', 'assets/logo.svg', 'assets/icon.png', 'logo.png', 'logo.svg', 'icon.png', 'icon.svg'];

export class AgentCustomizationScanner {

	constructor(private readonly fileService: IFileService) { }

	/** One pass over every root; bounded to the known folders so it stays cheap on large repos. */
	async scan(workspaceFolders: readonly URI[], userHome: URI | undefined): Promise<IAgentCustomization[]> {
		const roots: IRoot[] = workspaceFolders.map(uri => ({ scope: 'workspace' as const, uri, label: basename(uri) }));
		if (userHome) {
			roots.push({ scope: 'user', uri: userHome, label: '~' });
		}
		const [results, plugins] = await Promise.all([
			Promise.all(roots.map(root => this.scanRoot(root))),
			userHome ? this.scanPlugins(userHome, workspaceFolders) : Promise.resolve([]),
		]);
		return dedupe([...results.flat(), ...plugins]);
	}

	private async scanRoot(root: IRoot): Promise<IAgentCustomization[]> {
		const items: IAgentCustomization[] = [];
		const tasks: Promise<void>[] = [];
		const push = (found: IAgentCustomization | IAgentCustomization[] | undefined) => {
			if (Array.isArray(found)) {
				items.push(...found);
			} else if (found) {
				items.push(found);
			}
		};
		const folder = root.scope === 'workspace' ? root.uri : undefined;

		if (root.scope === 'workspace') {
			for (const [name, origin] of [['AGENTS.md', 'agents'], ['CLAUDE.md', 'claude'], ['.cursorrules', 'cursor']] as const) {
				tasks.push(this.markdownItem(root, joinPath(root.uri, name), 'rule', root.label, origin, folder).then(push));
			}
			tasks.push(this.mcpItems(root, joinPath(root.uri, '.mcp.json'), root.label, 'claude', folder).then(push));
		} else {
			tasks.push(this.markdownItem(root, joinPath(root.uri, '.claude', 'CLAUDE.md'), 'rule', '~/.claude', 'claude').then(push));
			tasks.push(this.markdownItem(root, joinPath(root.uri, '.codex', 'AGENTS.md'), 'rule', '~/.codex', 'codex').then(push));
			tasks.push(this.mcpItems(root, joinPath(root.uri, '.claude.json'), '~', 'claude').then(push));
		}

		for (const dirName of CONFIG_DIRS) {
			const dir = joinPath(root.uri, dirName);
			const origin = ORIGIN_BY_DIR[dirName];
			const source = root.scope === 'user' ? `~/${dirName}` : `${root.label}/${dirName}`;
			tasks.push(this.markdownDir(root, joinPath(dir, 'rules'), 'rule', source, origin, folder).then(push));
			tasks.push(this.skillDir(root, joinPath(dir, 'skills'), source, origin, folder).then(push));
			tasks.push(this.markdownDir(root, joinPath(dir, 'agents'), 'subagent', source, origin, folder).then(push));
			tasks.push(this.markdownDir(root, joinPath(dir, 'commands'), 'command', source, origin, folder).then(push));
			tasks.push(this.hookItems(root, joinPath(dir, 'hooks.json'), source, origin, folder).then(push));
			tasks.push(this.mcpItems(root, joinPath(dir, 'mcp.json'), source, origin, folder).then(push));
			if (dirName === '.claude') {
				tasks.push(this.hookItems(root, joinPath(dir, 'settings.json'), source, origin, folder).then(push));
				tasks.push(this.hookItems(root, joinPath(dir, 'settings.local.json'), source, origin, folder).then(push));
			}
			if (dirName === '.codex') {
				tasks.push(this.markdownDir(root, joinPath(dir, 'prompts'), 'command', source, origin, folder).then(push));
			}
		}

		await Promise.all(tasks);
		return items;
	}

	//#region Plugins

	/** Installed Claude Code, Cursor and Volt plugins, and everything they ship. */
	private async scanPlugins(home: URI, workspaceFolders: readonly URI[]): Promise<IAgentCustomization[]> {
		const layouts = (await Promise.all([
			this.claudePlugins(home, workspaceFolders),
			this.cursorPlugins(home),
			this.voltPlugins(home),
		])).flat();
		const seen = new Set<string>();
		const unique = layouts.filter(layout => {
			if (seen.has(layout.info.id)) {
				return false;
			}
			seen.add(layout.info.id);
			return true;
		});
		const items = await Promise.all(unique.map(layout => this.pluginItems(layout)));
		return items.flat();
	}

	private async claudePlugins(home: URI, workspaceFolders: readonly URI[]): Promise<IPluginLayout[]> {
		const base = joinPath(home, '.claude', 'plugins');
		const [installed, settings] = await Promise.all([
			readJsonFile(this.fileService, joinPath(base, 'installed_plugins.json')),
			readJsonFile(this.fileService, joinPath(home, '.claude', 'settings.json')),
		]);
		const plugins = (installed as { plugins?: Record<string, unknown> } | undefined)?.plugins;
		if (!plugins || typeof plugins !== 'object') {
			return [];
		}
		const enabled = ((settings as { enabledPlugins?: Record<string, unknown> } | undefined)?.enabledPlugins ?? {}) as Record<string, unknown>;
		const projects = new Set(workspaceFolders.map(folder => folder.fsPath));
		const layouts: IPluginLayout[] = [];
		await Promise.all(Object.entries(plugins).map(async ([key, entries]) => {
			if (enabled[key] === false || !Array.isArray(entries)) {
				return;
			}
			const entry = entries.find(candidate => {
				const record = candidate as { scope?: unknown; projectPath?: unknown };
				return record.scope !== 'project' || (typeof record.projectPath === 'string' && projects.has(record.projectPath));
			}) as { installPath?: unknown; version?: unknown } | undefined;
			if (!entry || typeof entry.installPath !== 'string') {
				return;
			}
			const [name, marketplace] = key.split('@');
			const layout = await this.pluginLayout(URI.file(entry.installPath), 'claude', name, marketplace, typeof entry.version === 'string' ? entry.version : undefined);
			if (layout) {
				layouts.push(layout);
			}
		}));
		return layouts;
	}

	private async cursorPlugins(home: URI): Promise<IPluginLayout[]> {
		const base = joinPath(home, '.cursor', 'plugins');
		const layouts: IPluginLayout[] = [];
		const cache = await stat(this.fileService, joinPath(base, 'cache'));
		const tasks: Promise<void>[] = [];
		for (const marketplace of cache?.children ?? []) {
			if (!marketplace.isDirectory) {
				continue;
			}
			tasks.push((async () => {
				const marketplaceDir = await stat(this.fileService, marketplace.resource);
				await Promise.all((marketplaceDir?.children ?? []).filter(child => child.isDirectory).map(async plugin => {
					const versions = await stat(this.fileService, plugin.resource, true);
					// Each version is a commit folder; the newest finished download wins.
					const candidates = (versions?.children ?? []).filter(child => child.isDirectory).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
					for (const candidate of candidates) {
						if (await this.fileService.exists(joinPath(candidate.resource, '.cache-complete'))) {
							const layout = await this.pluginLayout(candidate.resource, 'cursor', plugin.name, marketplace.name);
							if (layout) {
								layouts.push(layout);
							}
							return;
						}
					}
				}));
			})());
		}
		const local = await stat(this.fileService, joinPath(base, 'local'));
		for (const plugin of local?.children ?? []) {
			if (plugin.isDirectory) {
				tasks.push(this.pluginLayout(plugin.resource, 'cursor', plugin.name, 'local').then(layout => { if (layout) { layouts.push(layout); } }));
			}
		}
		await Promise.all(tasks);
		return layouts;
	}

	private async voltPlugins(home: URI): Promise<IPluginLayout[]> {
		const dir = await stat(this.fileService, joinPath(home, '.volt', 'plugins'));
		const layouts = await Promise.all((dir?.children ?? []).filter(child => child.isDirectory).map(child => this.pluginLayout(child.resource, 'volt', child.name, undefined)));
		return layouts.filter((layout): layout is IPluginLayout => !!layout);
	}

	/** Reads a plugin folder in any of the three manifest layouts. */
	private async pluginLayout(root: URI, origin: AgentCustomizationOrigin, folderName: string, marketplace: string | undefined, version?: string): Promise<IPluginLayout | undefined> {
		let manifestUri: URI | undefined;
		let manifest: Record<string, unknown> = {};
		for (const dir of ['.volt-plugin', '.cursor-plugin', '.claude-plugin', '.codex-plugin']) {
			const candidate = joinPath(root, dir, 'plugin.json');
			const json = await readJsonFile(this.fileService, candidate);
			if (json && typeof json === 'object') {
				manifestUri = candidate;
				manifest = json as Record<string, unknown>;
				break;
			}
		}
		const folder = await stat(this.fileService, root);
		if (!folder?.isDirectory) {
			return undefined;
		}
		const has = (name: string) => !!folder.children?.some(child => child.name === name);
		const str = (value: unknown) => typeof value === 'string' ? value : undefined;
		const paths = (value: unknown, fallback: string): URI[] => {
			const list = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : [];
			if (list.length) {
				return list.map(path => joinPath(root, path.replace(/^\.\//, '')));
			}
			return has(fallback) ? [joinPath(root, fallback)] : [];
		};
		const name = str(manifest.name) ?? folderName;
		const author = manifest.author;
		const publisher = (author && typeof author === 'object' ? str((author as { name?: unknown }).name) : str(author))
			?? str(manifest.publisher)
			?? (marketplace && marketplace !== 'local' ? marketplace : '')
			?? '';
		let logo: URI | undefined;
		const declaredLogo = str(manifest.logo) ?? str(manifest.icon);
		if (declaredLogo && !/^https?:/i.test(declaredLogo)) {
			logo = joinPath(root, declaredLogo.replace(/^\.\//, ''));
		} else {
			for (const candidate of LOGO_CANDIDATES) {
				const uri = joinPath(root, candidate);
				if (await this.fileService.exists(uri)) {
					logo = uri;
					break;
				}
			}
		}
		const mcpFiles = typeof manifest.mcpServers === 'string'
			? [joinPath(root, manifest.mcpServers.replace(/^\.\//, ''))]
			: ['.mcp.json', 'mcp.json'].filter(has).map(file => joinPath(root, file));
		const hookFiles = typeof manifest.hooks === 'string'
			? [joinPath(root, manifest.hooks.replace(/^\.\//, ''))]
			: [joinPath(root, 'hooks', 'hooks.json'), joinPath(root, 'hooks.json')];
		const info: IAgentPluginInfo = {
			id: `${origin}:${name}@${marketplace ?? 'local'}`,
			name,
			displayName: str(manifest.displayName) ?? skillHeading(name),
			publisher: publisher || ORIGIN_LABELS[origin],
			description: str(manifest.description) ?? '',
			origin,
			root,
			manifest: manifestUri,
			logo,
			marketplace,
			version: str(manifest.version) ?? version,
		};
		return {
			info,
			skills: paths(manifest.skills, 'skills'),
			agents: paths(manifest.agents, 'agents'),
			rules: paths(manifest.rules, 'rules'),
			commands: paths(manifest.commands, 'commands'),
			hooks: hookFiles,
			mcp: mcpFiles,
			inlineMcp: manifest.mcpServers && typeof manifest.mcpServers === 'object' ? { mcpServers: manifest.mcpServers } : undefined,
			inlineHooks: manifest.hooks && typeof manifest.hooks === 'object' ? { hooks: manifest.hooks } : undefined,
		};
	}

	private async pluginItems(layout: IPluginLayout): Promise<IAgentCustomization[]> {
		const { info } = layout;
		const root: IRoot = { scope: 'user', uri: info.root, label: info.displayName };
		const source = info.displayName;
		const tag = (item: IAgentCustomization): IAgentCustomization => ({ ...item, plugin: info, origin: info.origin, source });
		const groups = await Promise.all([
			...layout.skills.map(dir => this.skillDir(root, dir, source, info.origin)),
			...layout.agents.map(dir => this.markdownDir(root, dir, 'subagent', source, info.origin)),
			...layout.rules.map(dir => this.markdownDir(root, dir, 'rule', source, info.origin)),
			...layout.commands.map(dir => this.markdownDir(root, dir, 'command', source, info.origin)),
			...layout.hooks.map(file => this.hookItems(root, file, source, info.origin)),
			...layout.mcp.map(file => this.mcpItems(root, file, source, info.origin)),
		]);
		const items = groups.flat();
		const manifest = info.manifest ?? info.root;
		if (layout.inlineMcp) {
			items.push(...mcpServerConfigsFrom(layout.inlineMcp).map(server => ({
				kind: 'mcp' as const, scope: 'user' as const, name: server.name, description: server.description, resource: manifest, source, mcp: server.config,
			})));
		}
		if (layout.inlineHooks) {
			items.push(...hookHandlersFrom(layout.inlineHooks).map(hook => ({
				kind: 'hook' as const, scope: 'user' as const, name: hook.event, description: hook.commands.join(' && '), command: hook.commands.join(' && '), resource: manifest, source,
			})));
		}
		const self: IAgentCustomization = {
			kind: 'plugin', scope: 'user', name: info.displayName, description: info.publisher, resource: manifest, source, origin: info.origin, plugin: info,
		};
		return [self, ...items.map(tag)];
	}

	//#endregion

	private async markdownDir(root: IRoot, dir: URI, kind: AgentCustomizationKind, source: string, origin: AgentCustomizationOrigin, folder?: URI, depth = 0): Promise<IAgentCustomization[]> {
		const entries = await stat(this.fileService, dir);
		if (!entries?.isDirectory || !entries.children) {
			return [];
		}
		const items: IAgentCustomization[] = [];
		await Promise.all(entries.children.map(async child => {
			if (child.isDirectory) {
				if (depth < 2 && !child.name.startsWith('.')) {
					items.push(...await this.markdownDir(root, child.resource, kind, source, origin, folder, depth + 1));
				}
				return;
			}
			if (/\.(md|mdc)$/i.test(child.name) && !/^readme\.md$/i.test(child.name)) {
				const item = await this.markdownItem(root, child.resource, kind, source, origin, folder);
				if (item) {
					items.push(item);
				}
			}
		}));
		return items;
	}

	/** `skills/<name>/SKILL.md`, and one level of grouping folders (`skills/<group>/<name>/SKILL.md`). */
	private async skillDir(root: IRoot, dir: URI, source: string, origin: AgentCustomizationOrigin, folder?: URI, depth = 0): Promise<IAgentCustomization[]> {
		const entries = await stat(this.fileService, dir);
		if (!entries?.isDirectory || !entries.children) {
			return [];
		}
		const items: IAgentCustomization[] = [];
		await Promise.all(entries.children.map(async child => {
			if (!child.isDirectory || child.name.startsWith('.')) {
				return;
			}
			const skillFile = await this.findSkillFile(child.resource);
			if (skillFile) {
				const item = await this.markdownItem(root, skillFile, 'skill', source, origin, folder, child.name);
				if (item) {
					items.push(item);
				}
			} else if (depth < 1) {
				items.push(...await this.skillDir(root, child.resource, source, origin, folder, depth + 1));
			}
		}));
		return items;
	}

	private async findSkillFile(dir: URI): Promise<URI | undefined> {
		const entries = await stat(this.fileService, dir);
		const file = entries?.children?.find(child => !child.isDirectory && /^skill\.md$/i.test(child.name));
		return file?.resource;
	}

	private async markdownItem(root: IRoot, file: URI, kind: AgentCustomizationKind, source: string, origin: AgentCustomizationOrigin, folder?: URI, defaultName?: string): Promise<IAgentCustomization | undefined> {
		const text = await readText(this.fileService, file);
		if (text === undefined) {
			return undefined;
		}
		const described = describeMarkdown(text, kind === 'command' || kind === 'rule' ? '' : kindInfo(kind).label);
		const fileName = basename(file);
		const name = (kind === 'skill' ? described.name || defaultName : kind === 'rule' || kind === 'command' ? undefined : described.name)
			|| fileName.replace(/\.(md|mdc)$/i, '');
		const extra: Partial<Mutable<IAgentCustomization>> = {};
		if (kind === 'rule') {
			const { mode, globs } = ruleModeOf(text);
			extra.ruleMode = mode;
			extra.globs = globs;
		} else if (kind === 'subagent') {
			const doc = parseFrontmatterDocument(text);
			extra.model = frontmatterValue(doc, 'model') || 'inherit';
		}
		return { kind, scope: root.scope, name, description: described.description, resource: file, source, bytes: text.length, origin, folder, ...extra };
	}

	private async mcpItems(root: IRoot, file: URI, source: string, origin: AgentCustomizationOrigin, folder?: URI): Promise<IAgentCustomization[]> {
		const json = await readJsonFile(this.fileService, file);
		return mcpServerConfigsFrom(json).map(server => ({
			kind: 'mcp' as const, scope: root.scope, name: server.name, description: server.description, resource: file, source, origin, folder, mcp: server.config,
		}));
	}

	private async hookItems(root: IRoot, file: URI, source: string, origin: AgentCustomizationOrigin, folder?: URI): Promise<IAgentCustomization[]> {
		const json = await readJsonFile(this.fileService, file);
		return hookHandlersFrom(json).map(hook => ({
			kind: 'hook' as const,
			scope: root.scope,
			name: hook.event,
			description: hook.commands.join(' && ') || localize('voltCustomize.hookIn', "Hook in {0}", basename(file)),
			command: hook.commands.join(' && '),
			resource: file,
			source,
			origin,
			folder,
		}));
	}
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The section an item is listed under: a plugin, the user, or a workspace folder. */
export function customizationGroupKey(item: IAgentCustomization): string {
	if (item.plugin) {
		return `plugin:${item.plugin.id}`;
	}
	if (item.scope === 'user') {
		return 'user';
	}
	return `workspace:${item.folder?.toString() ?? item.source}`;
}

/**
 * One entry per name within a section, so a skill linked into both `~/.claude/skills` and
 * `~/.agents/skills` lists once. Volt's own folders win, then `.agents`, Claude, Cursor, Codex.
 */
function dedupe(items: IAgentCustomization[]): IAgentCustomization[] {
	const rank = (item: IAgentCustomization) => {
		const index = item.origin ? ['volt', 'agents', 'claude', 'cursor', 'codex'].indexOf(item.origin) : -1;
		return index < 0 ? 99 : index;
	};
	const sorted = [...items].sort((a, b) => rank(a) - rank(b));
	const seen = new Set<string>();
	const result: IAgentCustomization[] = [];
	for (const item of sorted) {
		const byName = item.kind === 'skill' || item.kind === 'subagent' || item.kind === 'command';
		const key = byName
			? `${item.kind}:${customizationGroupKey(item)}:${item.name.toLowerCase()}`
			: `${item.kind}:${item.resource.toString()}:${item.name}`;
		if (!seen.has(key)) {
			seen.add(key);
			result.push(item);
		}
	}
	return result.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
}

/** Where a new item of this kind is created for the scope. */
export function newItemLocation(kind: AgentCustomizationKind, name: string, base: URI): URI {
	const info = kindInfo(kind);
	const dir = info.newItemDir ? joinPath(base, '.volt', info.newItemDir) : joinPath(base, '.volt');
	return joinPath(dir, info.newItemFile(name));
}

export function safeItemName(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/** Names Cursor and Claude accept for skills and subagents: lowercase letters, digits and hyphens. */
export function isValidItemName(name: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64;
}

/** The folder holding a skill's `SKILL.md`, or the file itself for other kinds; what Delete removes. */
export function customizationDeletionTarget(item: IAgentCustomization): { resource: URI; recursive: boolean } {
	if (item.kind === 'skill' && /^skill\.md$/i.test(basename(item.resource))) {
		return { resource: dirname(item.resource), recursive: true };
	}
	return { resource: item.resource, recursive: false };
}

//#endregion
