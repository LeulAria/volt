/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { basename, joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';

/**
 * Discovery of agent customizations on disk: rules, skills, subagents,
 * commands, hooks and MCP servers, in the workspace and in the user home.
 *
 * Volt owns `.volt/`; the equivalent Cursor and Claude Code layouts are read
 * too so an existing project is understood without migration.
 */

export type AgentCustomizationKind = 'rule' | 'skill' | 'subagent' | 'command' | 'hook' | 'mcp';
export type AgentCustomizationScope = 'workspace' | 'user';

export interface IAgentCustomization {
	readonly kind: AgentCustomizationKind;
	readonly scope: AgentCustomizationScope;
	readonly name: string;
	readonly description: string;
	/** File to open. For MCP servers and hooks this is the config file. */
	readonly resource: URI;
	/** Folder label the item was found in ("my-repo", "~/.volt"). */
	readonly source: string;
	/** Source bytes when the file was read, used for context-window estimates. */
	readonly bytes?: number;
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
		kind: 'rule', label: localize('voltCustomize.rule', "Rule"), plural: localize('voltCustomize.rules', "Rules"), icon: Codicon.book,
		newItemDir: 'rules', newItemFile: name => `${name}.md`,
		template: name => `---\ndescription: ${name}\nalwaysApply: false\nglobs:\n---\n\n# ${name}\n\nDescribe how the agent should behave when this rule applies.\n`,
	},
	{
		kind: 'skill', label: localize('voltCustomize.skill', "Skill"), plural: localize('voltCustomize.skills', "Skills"), icon: Codicon.lightbulb,
		newItemDir: 'skills', newItemFile: name => `${name}/SKILL.md`,
		template: name => `---\nname: ${name}\ndescription: When to use this skill.\n---\n\n# ${name}\n\nStep-by-step instructions the agent follows when the skill applies.\n`,
	},
	{
		kind: 'subagent', label: localize('voltCustomize.subagent', "Subagent"), plural: localize('voltCustomize.subagents', "Subagents"), icon: Codicon.organization,
		newItemDir: 'agents', newItemFile: name => `${name}.md`,
		template: name => `---\nname: ${name}\ndescription: What this subagent is for and when to delegate to it.\n---\n\nYou are ${name}. Describe the role, constraints and expected output.\n`,
	},
	{
		kind: 'command', label: localize('voltCustomize.command', "Command"), plural: localize('voltCustomize.commands', "Commands"), icon: Codicon.terminal,
		newItemDir: 'commands', newItemFile: name => `${name}.md`,
		template: name => `---\ndescription: ${name}\n---\n\nPrompt sent when /${name} is used.\n`,
	},
	{
		kind: 'hook', label: localize('voltCustomize.hook', "Hook"), plural: localize('voltCustomize.hooks', "Hooks"), icon: Codicon.plug,
		newItemDir: undefined, newItemFile: () => 'hooks.json',
		template: () => `{\n\t"version": 1,\n\t"hooks": {\n\t\t"beforeShellExecution": [],\n\t\t"afterFileEdit": []\n\t}\n}\n`,
	},
	{
		kind: 'mcp', label: localize('voltCustomize.mcp', "MCP"), plural: localize('voltCustomize.mcps', "MCPs"), icon: Codicon.server,
		newItemDir: undefined, newItemFile: () => 'mcp.json',
		template: () => `{\n\t"mcpServers": {\n\t\t"example": {\n\t\t\t"command": "npx",\n\t\t\t"args": ["-y", "@modelcontextprotocol/server-example"]\n\t\t}\n\t}\n}\n`,
	},
];

export function kindInfo(kind: AgentCustomizationKind): IAgentCustomizationKindInfo {
	return CUSTOMIZATION_KINDS.find(info => info.kind === kind)!;
}

//#region Parsing

/** YAML-ish front matter: only scalar `key: value` lines are read. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
	const data: Record<string, string> = {};
	if (!text.startsWith('---')) {
		return { data, body: text };
	}
	const end = text.indexOf('\n---', 3);
	if (end === -1) {
		return { data, body: text };
	}
	for (const line of text.slice(3, end).split('\n')) {
		const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
		if (match) {
			data[match[1].toLowerCase()] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
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

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

interface IMcpServer {
	readonly name: string;
	readonly description: string;
}

/** Servers in an `mcp.json` (Cursor/Volt) or Claude `.mcp.json`/settings file. */
export function mcpServersFrom(json: unknown): IMcpServer[] {
	if (!json || typeof json !== 'object') {
		return [];
	}
	const servers = (json as { mcpServers?: unknown; servers?: unknown }).mcpServers ?? (json as { servers?: unknown }).servers;
	if (!servers || typeof servers !== 'object') {
		return [];
	}
	const result: IMcpServer[] = [];
	for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
		const server = (raw ?? {}) as { command?: string; args?: unknown; url?: string; type?: string; description?: string };
		let description = server.description ?? '';
		if (!description) {
			if (typeof server.url === 'string') {
				description = server.url;
			} else if (typeof server.command === 'string') {
				const args = Array.isArray(server.args) ? server.args.filter((a): a is string => typeof a === 'string') : [];
				description = [server.command, ...args].join(' ');
			}
		}
		result.push({ name, description: truncate(description, 140) });
	}
	return result;
}

/** Hook event names with at least one handler in a `hooks.json` or Claude `settings.json`. */
export function hookEventsFrom(json: unknown): string[] {
	if (!json || typeof json !== 'object') {
		return [];
	}
	const hooks = (json as { hooks?: unknown }).hooks;
	if (!hooks || typeof hooks !== 'object') {
		return [];
	}
	return Object.entries(hooks as Record<string, unknown>)
		.filter(([, handlers]) => Array.isArray(handlers) ? handlers.length > 0 : !!handlers)
		.map(([event]) => event);
}

//#endregion

//#region Scanning

interface IRoot {
	readonly scope: AgentCustomizationScope;
	readonly uri: URI;
	readonly label: string;
}

/** Folders that hold agent customizations, relative to a root. */
export const CONFIG_DIRS: readonly string[] = ['.volt', '.cursor', '.claude', '.agents'];
/** Matches a path inside any of the {@link CONFIG_DIRS}. */
export const CONFIG_DIR_PATTERN = /(^|[\\/])\.(volt|cursor|claude|agents)([\\/]|$)/;

/** Resolves a folder with its direct children; undefined when missing. */
async function stat(fileService: IFileService, uri: URI): Promise<IFileStat | undefined> {
	try {
		return await fileService.resolve(uri, { resolveMetadata: false });
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

async function readJson(fileService: IFileService, uri: URI): Promise<unknown> {
	const text = await readText(fileService, uri);
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

export class AgentCustomizationScanner {

	constructor(private readonly fileService: IFileService) { }

	/** One pass over every root; bounded to the known folders so it stays cheap on large repos. */
	async scan(workspaceFolders: readonly URI[], userHome: URI | undefined): Promise<IAgentCustomization[]> {
		const roots: IRoot[] = workspaceFolders.map(uri => ({ scope: 'workspace' as const, uri, label: basename(uri) }));
		if (userHome) {
			roots.push({ scope: 'user', uri: userHome, label: '~' });
		}
		const results = await Promise.all(roots.map(root => this.scanRoot(root)));
		return results.flat();
	}

	private async scanRoot(root: IRoot): Promise<IAgentCustomization[]> {
		const items: IAgentCustomization[] = [];
		const tasks: Promise<void>[] = [];

		if (root.scope === 'workspace') {
			for (const name of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
				tasks.push(this.markdownItem(root, joinPath(root.uri, name), 'rule', `${root.label}`).then(item => { if (item) { items.push(item); } }));
			}
			tasks.push(this.mcpItems(root, joinPath(root.uri, '.mcp.json'), root.label).then(found => { items.push(...found); }));
		} else {
			tasks.push(this.markdownItem(root, joinPath(root.uri, '.claude', 'CLAUDE.md'), 'rule', '~/.claude').then(item => { if (item) { items.push(item); } }));
			tasks.push(this.mcpItems(root, joinPath(root.uri, '.claude.json'), '~').then(found => { items.push(...found); }));
		}

		for (const dirName of CONFIG_DIRS) {
			const dir = joinPath(root.uri, dirName);
			const source = root.scope === 'user' ? `~/${dirName}` : `${root.label}/${dirName}`;
			tasks.push(this.markdownDir(root, joinPath(dir, 'rules'), 'rule', source).then(found => { items.push(...found); }));
			tasks.push(this.skillDir(root, joinPath(dir, 'skills'), source).then(found => { items.push(...found); }));
			tasks.push(this.markdownDir(root, joinPath(dir, 'agents'), 'subagent', source).then(found => { items.push(...found); }));
			tasks.push(this.markdownDir(root, joinPath(dir, 'commands'), 'command', source).then(found => { items.push(...found); }));
			tasks.push(this.hookItems(root, joinPath(dir, 'hooks.json'), source).then(found => { items.push(...found); }));
			tasks.push(this.mcpItems(root, joinPath(dir, 'mcp.json'), source).then(found => { items.push(...found); }));
			if (dirName === '.claude') {
				tasks.push(this.hookItems(root, joinPath(dir, 'settings.json'), source).then(found => { items.push(...found); }));
				tasks.push(this.hookItems(root, joinPath(dir, 'settings.local.json'), source).then(found => { items.push(...found); }));
			}
		}

		await Promise.all(tasks);
		return dedupe(items);
	}

	private async markdownDir(root: IRoot, dir: URI, kind: AgentCustomizationKind, source: string, depth = 0): Promise<IAgentCustomization[]> {
		const folder = await stat(this.fileService, dir);
		if (!folder?.isDirectory || !folder.children) {
			return [];
		}
		const items: IAgentCustomization[] = [];
		await Promise.all(folder.children.map(async child => {
			if (child.isDirectory) {
				if (depth < 2) {
					items.push(...await this.markdownDir(root, child.resource, kind, source, depth + 1));
				}
				return;
			}
			if (/\.(md|mdc)$/i.test(child.name)) {
				const item = await this.markdownItem(root, child.resource, kind, source);
				if (item) {
					items.push(item);
				}
			}
		}));
		return items;
	}

	private async skillDir(root: IRoot, dir: URI, source: string): Promise<IAgentCustomization[]> {
		const folder = await stat(this.fileService, dir);
		if (!folder?.isDirectory || !folder.children) {
			return [];
		}
		const items: IAgentCustomization[] = [];
		await Promise.all(folder.children.map(async child => {
			if (!child.isDirectory) {
				return;
			}
			const item = await this.markdownItem(root, joinPath(child.resource, 'SKILL.md'), 'skill', source, child.name);
			if (item) {
				items.push(item);
			}
		}));
		return items;
	}

	private async markdownItem(root: IRoot, file: URI, kind: AgentCustomizationKind, source: string, defaultName?: string): Promise<IAgentCustomization | undefined> {
		const text = await readText(this.fileService, file);
		if (text === undefined) {
			return undefined;
		}
		const described = describeMarkdown(text, kindInfo(kind).label);
		const fileName = basename(file);
		const name = described.name || defaultName || fileName.replace(/\.(md|mdc)$/i, '');
		return { kind, scope: root.scope, name, description: described.description, resource: file, source, bytes: text.length };
	}

	private async mcpItems(root: IRoot, file: URI, source: string): Promise<IAgentCustomization[]> {
		const json = await readJson(this.fileService, file);
		return mcpServersFrom(json).map(server => ({
			kind: 'mcp' as const, scope: root.scope, name: server.name, description: server.description, resource: file, source,
		}));
	}

	private async hookItems(root: IRoot, file: URI, source: string): Promise<IAgentCustomization[]> {
		const json = await readJson(this.fileService, file);
		return hookEventsFrom(json).map(event => ({
			kind: 'hook' as const, scope: root.scope, name: event, description: localize('voltCustomize.hookIn', "Hook in {0}", basename(file)), resource: file, source,
		}));
	}
}

function dedupe(items: IAgentCustomization[]): IAgentCustomization[] {
	const seen = new Set<string>();
	const result: IAgentCustomization[] = [];
	for (const item of items) {
		const key = `${item.kind}:${item.resource.toString()}:${item.name}`;
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

//#endregion
