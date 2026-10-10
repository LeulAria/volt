/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { basename, dirname, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IVoltMemoryService } from '../../../../services/voltRuntime/common/memory/voltMemory.js';
import { IVoltBuiltinCommand, IVoltBuiltinSkill, skillPromptBlock, skillTitle, VOLT_BUILTIN_COMMANDS, VOLT_BUILTIN_SKILLS, VoltBuiltinCommandId } from '../../../../services/voltRuntime/common/skills/voltBuiltinSkills.js';
import { AgentCustomizationKind, AgentCustomizationScanner, CONFIG_DIR_PATTERN, CONFIG_DIRS, customizationDeletionTarget, IAgentCustomization, IAgentPluginInfo, kindInfo, newItemLocation, ORIGIN_LABELS } from './agentCustomize.js';
import { parseFrontmatterDocument } from './agentFrontmatter.js';

export const IAgentCustomizeService = createDecorator<IAgentCustomizeService>('voltAgentCustomizeService');

/** How a `/` entry is drawn in the menu. Plugin entries show the plugin's logo when it has one. */
export type AgentSlashIcon = 'volt' | 'model' | 'skill' | 'subagent' | 'rule' | 'command' | 'customize' | 'new-chat' | 'usage';

/** One entry of the composer's `/` menu. */
export interface IAgentSlashItem {
	/** Unique in the menu. */
	readonly id: string;
	/** What follows the `/`. */
	readonly name: string;
	/** `builtin-command` acts in the app; the others send instructions with the prompt. */
	readonly type: 'builtin-command' | 'skill' | 'command' | 'subagent' | 'rule';
	/** Hover card title: "Create Skill". */
	readonly title: string;
	/** Full description (hover card). */
	readonly description: string;
	/** Short line for the menu row. */
	readonly summary: string;
	readonly icon: AgentSlashIcon;
	/** Hover card source line: "Built-in Volt skill", "Created by AWS". Absent for the user's own files. */
	readonly sourceLabel?: string;
	readonly builtin: boolean;
	readonly plugin?: IAgentPluginInfo;
	/** The file behind the entry; clicking the token opens it. Absent for built-ins. */
	readonly resource?: URI;
	/** Built-in command to run. */
	readonly command?: VoltBuiltinCommandId;
	/** ⌥⏎ keeps it on for every message: skills that describe a way of working. */
	readonly canUseAsMode: boolean;
	/** Where the item was found ("~/.claude/skills", "my-repo/.volt"). */
	readonly location?: string;
}

export interface IAgentCustomizeService {
	readonly _serviceBrand: undefined;

	/** Fires after a rescan found a change. */
	readonly onDidChange: Event<void>;

	/** The last scan; empty until the first one finishes. */
	readonly items: readonly IAgentCustomization[];

	/** Every customization on disk and every memory note. Scans on first use; later calls share the cached result. */
	getItems(): Promise<readonly IAgentCustomization[]>;

	/** Scans again now. */
	refresh(): Promise<readonly IAgentCustomization[]>;

	userHome(): Promise<URI | undefined>;

	/** Entries for the `/` menu: built-in commands, built-in skills, and the skills, commands, subagents and rules on disk. */
	getSlashItems(): Promise<readonly IAgentSlashItem[]>;

	/** The entry `/name` stands for. */
	findSlashItem(name: string): Promise<IAgentSlashItem | undefined>;

	/**
	 * What is sent to the model with the prompt for a used entry: the skill's instructions, the
	 * command's text (`$ARGUMENTS` filled with `args`), the rule, or a hand-off to the subagent.
	 * Undefined for built-in commands and missing files.
	 */
	resolveSlashPrompt(item: IAgentSlashItem, args?: string): Promise<string | undefined>;

	/** The logo of a plugin as a `data:` URL, read once. */
	pluginLogo(plugin: IAgentPluginInfo): Promise<string | undefined>;

	/** Where an item of `kind` named `name` is created under `base` (the home folder or a workspace folder). */
	newItemLocation(kind: AgentCustomizationKind, name: string, base: URI): URI;

	/** Creates the item from its template (existing files are left alone) and returns the file. */
	createItem(kind: AgentCustomizationKind, name: string, base: URI, content?: string): Promise<URI>;

	/** Moves the item's file (a skill's whole folder) to the trash. */
	deleteItem(item: IAgentCustomization): Promise<void>;

	/** The MCP config file Volt reads for `base`: `<base>/.volt/mcp.json`, created when missing. */
	ensureMcpConfig(base: URI): Promise<URI>;
}

const REFRESH_DELAY_MS = 400;

const SLASH_ICON_BY_KIND: Partial<Record<AgentCustomizationKind, AgentSlashIcon>> = {
	skill: 'skill',
	command: 'command',
	subagent: 'subagent',
	rule: 'rule',
};

const SLASH_TYPE_BY_KIND: Partial<Record<AgentCustomizationKind, IAgentSlashItem['type']>> = {
	skill: 'skill',
	command: 'command',
	subagent: 'subagent',
	rule: 'rule',
};

function firstSentence(text: string): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	const match = /^(.+?[.!?])(\s|$)/.exec(clean);
	return match ? match[1] : clean;
}

function builtinSkillItem(skill: IVoltBuiltinSkill): IAgentSlashItem {
	return {
		id: `builtin-skill:${skill.name}`,
		name: skill.name,
		type: 'skill',
		title: skill.title,
		description: skill.description,
		summary: skill.summary,
		icon: 'volt',
		sourceLabel: localize('voltSlash.builtinSkill', "Built-in Volt skill"),
		builtin: true,
		canUseAsMode: true,
	};
}

function builtinCommandItem(command: IVoltBuiltinCommand): IAgentSlashItem {
	return {
		id: `builtin-command:${command.id}`,
		name: command.name,
		type: 'builtin-command',
		title: command.title,
		description: command.description,
		summary: command.description,
		icon: command.id === 'model' ? 'model' : command.id,
		sourceLabel: localize('voltSlash.builtinCommand', "Built-in Volt command"),
		builtin: true,
		command: command.id,
		canUseAsMode: false,
	};
}

/**
 * The one place that knows every skill, rule, subagent, command, hook, MCP server and plugin:
 * Volt's own, Claude Code's, Cursor's, Codex's and the shared `.agents` folders, in the open
 * folders and the home folder. Watches those folders and rescans when they change.
 */
export class AgentCustomizeService extends Disposable implements IAgentCustomizeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly scanner: AgentCustomizationScanner;
	private current: readonly IAgentCustomization[] = [];
	private scanning: Promise<readonly IAgentCustomization[]> | undefined;
	private scanned = false;
	private signature = '';
	private home: Promise<URI | undefined> | undefined;
	private readonly logos = new Map<string, Promise<string | undefined>>();
	private readonly watcher = this._register(new MutableDisposable<DisposableStore>());
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => void this.refresh(), REFRESH_DELAY_MS));

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@IVoltMemoryService private readonly memory: IVoltMemoryService,
	) {
		super();
		this.scanner = new AgentCustomizationScanner(fileService);
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()));
		this._register(this.memory.onDidChange(() => this.scheduleRefresh()));
		this._register(this.fileService.onDidFilesChange(e => {
			if (!this.scanned) {
				return;
			}
			const inConfigDir = (uri: URI) => CONFIG_DIR_PATTERN.test(uri.path) || /(^|[\\/])(AGENTS|CLAUDE)\.md$/.test(uri.path) || /[\\/]\.mcp\.json$/.test(uri.path);
			if (this.current.some(item => e.contains(item.resource)) || e.rawAdded.some(inConfigDir) || e.rawDeleted.some(inConfigDir) || e.rawUpdated.some(inConfigDir)) {
				this.scheduleRefresh();
			}
		}));
	}

	get items(): readonly IAgentCustomization[] {
		return this.current;
	}

	userHome(): Promise<URI | undefined> {
		this.home ??= this.pathService.userHome().catch(() => undefined);
		return this.home;
	}

	getItems(): Promise<readonly IAgentCustomization[]> {
		if (this.scanned && !this.refreshScheduler.isScheduled()) {
			return Promise.resolve(this.current);
		}
		return this.scanning ?? this.refresh();
	}

	refresh(): Promise<readonly IAgentCustomization[]> {
		if (this.scanning) {
			// A scan is running: run once more after it so changes made meanwhile are seen.
			return this.scanning.then(() => this.scanNow());
		}
		return this.scanNow();
	}

	private scanNow(): Promise<readonly IAgentCustomization[]> {
		const scan = (async () => {
			const folders = this.workspaceService.getWorkspace().folders.map(folder => folder.uri);
			const home = await this.userHome();
			const [scanned, memories] = await Promise.all([
				this.scanner.scan(folders, home),
				this.memoryItems(folders).catch(() => []),
			]);
			const items = [...scanned, ...memories].sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
			const signature = items.map(item => `${item.kind}|${item.name}|${item.description}|${item.resource.toString()}|${item.ruleMode ?? ''}|${item.model ?? ''}|${item.command ?? ''}`).join('\n');
			this.current = items;
			this.scanned = true;
			this.watchRoots(folders, home);
			if (signature !== this.signature) {
				this.signature = signature;
				this._onDidChange.fire();
			}
			return items;
		})();
		this.scanning = scan;
		void scan.finally(() => {
			if (this.scanning === scan) {
				this.scanning = undefined;
			}
		});
		return scan;
	}

	private scheduleRefresh(): void {
		if (this.scanned) {
			this.refreshScheduler.schedule();
		}
	}

	/** Saved notes from the memory service, listed with the rules and skills; their files open like any other. */
	private async memoryItems(folders: readonly URI[]): Promise<IAgentCustomization[]> {
		const memories = await this.memory.list('all');
		const projectLabel = folders[0] ? basename(folders[0]) : '';
		return memories.flatMap((memory): IAgentCustomization[] => memory.resource ? [{
			kind: 'memory',
			scope: memory.scope === 'user' ? 'user' : 'workspace',
			name: memory.name,
			description: memory.description,
			resource: memory.resource,
			source: memory.scope === 'user' ? '~' : `${projectLabel}/.volt/memory`,
			origin: 'volt',
			folder: memory.scope === 'user' ? undefined : folders[0],
		}] : []);
	}

	/**
	 * Workspace config folders are watched recursively (small). Home folders such as ~/.cursor can
	 * be huge, so only the relevant subfolders are watched, flat.
	 */
	private watchRoots(folders: readonly URI[], home: URI | undefined): void {
		const key = [...folders.map(folder => folder.toString()), home?.toString() ?? ''].join('|');
		if (this.watcher.value && (this.watcher.value as DisposableStore & { key?: string }).key === key) {
			return;
		}
		const store = new DisposableStore() as DisposableStore & { key?: string };
		store.key = key;
		for (const folder of folders) {
			for (const dir of CONFIG_DIRS) {
				store.add(this.fileService.watch(joinPath(folder, dir), { recursive: true, excludes: ['**/node_modules/**'] }));
			}
		}
		if (home) {
			for (const dir of CONFIG_DIRS) {
				const base = joinPath(home, dir);
				store.add(this.fileService.watch(base));
				for (const sub of ['rules', 'skills', 'agents', 'commands', 'plugins', 'prompts']) {
					store.add(this.fileService.watch(joinPath(base, sub)));
				}
			}
			store.add(this.fileService.watch(joinPath(home, '.claude', 'plugins')));
		}
		this.watcher.value = store;
	}

	//#region Slash menu

	async getSlashItems(): Promise<readonly IAgentSlashItem[]> {
		const items = await this.getItems();
		const byName = new Map<string, IAgentSlashItem>();
		const add = (item: IAgentSlashItem) => {
			const key = item.name.toLowerCase();
			if (!byName.has(key)) {
				byName.set(key, item);
			}
		};
		for (const command of VOLT_BUILTIN_COMMANDS) {
			add(builtinCommandItem(command));
		}
		// Project files first, then personal ones, then plugins: the nearest definition of a name wins.
		const rank = (item: IAgentCustomization) => item.plugin ? 2 : item.scope === 'workspace' ? 0 : 1;
		const disk = items
			.filter(item => !!SLASH_TYPE_BY_KIND[item.kind])
			// Always-on rules already reach every prompt; only rules that can be asked for are offered.
			.filter(item => item.kind !== 'rule' || item.ruleMode === 'manual' || item.ruleMode === 'intelligent')
			.sort((a, b) => rank(a) - rank(b));
		for (const item of disk) {
			add(this.diskItem(item));
		}
		for (const skill of VOLT_BUILTIN_SKILLS) {
			add(builtinSkillItem(skill));
		}
		return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	private diskItem(item: IAgentCustomization): IAgentSlashItem {
		const type = SLASH_TYPE_BY_KIND[item.kind]!;
		const description = item.description || kindInfo(item.kind).label;
		return {
			id: `${item.kind}:${item.resource.toString()}:${item.name}`,
			name: item.name,
			type,
			title: skillTitle(item.name),
			description,
			summary: item.description ? firstSentence(item.description) : '',
			icon: SLASH_ICON_BY_KIND[item.kind] ?? 'skill',
			sourceLabel: item.plugin ? localize('voltSlash.createdBy', "Created by {0}", item.plugin.publisher || ORIGIN_LABELS[item.plugin.origin]) : undefined,
			builtin: false,
			plugin: item.plugin,
			resource: item.resource,
			canUseAsMode: type === 'skill' || type === 'rule',
			location: item.source,
		};
	}

	async findSlashItem(name: string): Promise<IAgentSlashItem | undefined> {
		const key = name.replace(/^\//, '').trim().toLowerCase();
		return (await this.getSlashItems()).find(item => item.name.toLowerCase() === key);
	}

	async resolveSlashPrompt(item: IAgentSlashItem, args?: string): Promise<string | undefined> {
		if (item.type === 'builtin-command') {
			return undefined;
		}
		if (item.builtin) {
			const skill = VOLT_BUILTIN_SKILLS.find(candidate => candidate.name === item.name);
			return skill ? skillPromptBlock(skill.name, skill.body) : undefined;
		}
		if (!item.resource) {
			return undefined;
		}
		let text: string;
		try {
			text = (await this.fileService.readFile(item.resource, { limits: { size: 256 * 1024 } })).value.toString();
		} catch {
			return undefined;
		}
		const doc = parseFrontmatterDocument(text);
		const body = (doc.hasFrontmatter ? doc.body : text).trim();
		switch (item.type) {
			case 'skill':
				return skillPromptBlock(item.name, body, dirname(item.resource).fsPath);
			case 'command': {
				const filled = body.includes('$ARGUMENTS') ? body.split('$ARGUMENTS').join(args?.trim() ?? '') : body;
				return `<command name="${item.name}">\nThe user ran the /${item.name} command. Carry out these instructions${args?.trim() && !body.includes('$ARGUMENTS') ? ' for the request in the message' : ''}.\n\n${filled}\n</command>`;
			}
			case 'subagent':
				return `<subagent name="${item.name}" path="${item.resource.fsPath}">\nThe user asked for the ${item.name} subagent. If your task tool offers "${item.name}", delegate the work to it (agent: "${item.name}") with a complete prompt; otherwise do the task the way it is defined below.\n\n${body}\n</subagent>`;
			case 'rule':
				return `<rule name="${item.name}">\n${body}\n</rule>`;
		}
	}

	//#endregion

	pluginLogo(plugin: IAgentPluginInfo): Promise<string | undefined> {
		const logo = plugin.logo;
		if (!logo) {
			return Promise.resolve(undefined);
		}
		const key = logo.toString();
		let pending = this.logos.get(key);
		if (!pending) {
			pending = this.readImage(logo);
			this.logos.set(key, pending);
		}
		return pending;
	}

	private async readImage(resource: URI): Promise<string | undefined> {
		const extension = basename(resource).split('.').pop()?.toLowerCase() ?? '';
		const mime = extension === 'svg' ? 'image/svg+xml' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : extension === 'gif' ? 'image/gif' : 'image/png';
		try {
			const content = await this.fileService.readFile(resource, { limits: { size: 512 * 1024 } });
			return `data:${mime};base64,${encodeBase64(content.value)}`;
		} catch {
			return undefined;
		}
	}

	newItemLocation(kind: AgentCustomizationKind, name: string, base: URI): URI {
		return newItemLocation(kind, name, base);
	}

	async createItem(kind: AgentCustomizationKind, name: string, base: URI, content?: string): Promise<URI> {
		const target = newItemLocation(kind, name, base);
		if (!(await this.fileService.exists(target))) {
			await this.fileService.createFile(target, VSBuffer.fromString(content ?? kindInfo(kind).template(name || basename(target))));
		}
		void this.refresh();
		return target;
	}

	async deleteItem(item: IAgentCustomization): Promise<void> {
		const target = customizationDeletionTarget(item);
		await this.fileService.del(target.resource, { recursive: target.recursive, useTrash: true });
		void this.refresh();
	}

	async ensureMcpConfig(base: URI): Promise<URI> {
		return this.createItem('mcp', '', base);
	}
}
