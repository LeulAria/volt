/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { OperatingSystem, OS } from '../../../../../base/common/platform.js';
import { basename, dirname, joinPath, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ISearchService, QueryType } from '../../../../services/search/common/search.js';
import { AGENT_RESOURCE_EXCLUDE_GLOBS, AGENT_RESOURCE_GROUPS, AGENT_RESOURCE_INCLUDE_GLOBS, AgentResourceEcosystem, AgentResourceGroupId, AgentResourceScope, classifyAgentResource, classifyAgentResourceMatch, IAgentResourceInfo, IAgentResourceMatch, matchAgentResource, readFrontmatter } from '../../common/agentResources.js';
import { IAgentMcpServerEntry, parseHookEvents, parseMcpServers } from '../../common/agentResourcesModel.js';
import { AgentCustomizationKind, AgentCustomizationOrigin, kindInfo } from '../customize/agentCustomize.js';
import { IAgentCustomizeService } from '../customize/agentCustomizeService.js';

export const IAgentResourcesService = createDecorator<IAgentResourcesService>('voltAgentResourcesService');

/** One discovered file. */
export interface IAgentResource extends IAgentResourceInfo {
	readonly resource: URI;
	/** The folder {@link relativePath} starts from: the project, the home folder, a managed folder, or a plugin. */
	readonly root: URI;
	/** From {@link root}, `/`-separated. */
	readonly relativePath: string;
	/** Why Volt only opens it and never writes it (managed, owned by a plugin manager, rewritten by its app). */
	readonly readOnly?: string;
	/** MCP config: the servers it defines. */
	readonly servers?: readonly IAgentMcpServerEntry[];
	/** Hooks: the lifecycle events it handles. */
	readonly hookEvents?: readonly string[];
	/** Subagents: the model it asks for and the tools it may use, from its front matter. */
	readonly model?: string;
	readonly tools?: string;
	/** Skills: what the skill folder holds beside SKILL.md. Scripts make it an executable package. */
	readonly skill?: { readonly files: number; readonly hasScripts: boolean };
	/** The plugin or extension that ships it (External). */
	readonly source?: string;
}

/** What the files sidebar shows: a group's files, or every agent resource. Undefined shows all files. */
export type AgentResourceFilter = AgentResourceGroupId | 'all';

export interface IAgentResourcesService {
	readonly _serviceBrand: undefined;

	/** A folder's resources were found again and changed. */
	readonly onDidChange: Event<URI>;

	/** The last scan of `folder`, or undefined before one finished. */
	get(folder: URI): readonly IAgentResource[] | undefined;

	/** Scans `folder` on first use and then keeps it up to date; later calls share the result. */
	load(folder: URI): Promise<readonly IAgentResource[]>;

	/** The resources outside any project changed: global, external or managed. */
	readonly onDidChangeGlobal: Event<void>;

	/** The last scan of the home folder, managed folders and installed plugins. */
	getGlobal(): readonly IAgentResource[] | undefined;

	/** Scans the home folder's agent folders, the organization's managed folders and installed plugins. */
	loadGlobal(): Promise<readonly IAgentResource[]>;

	/** The user's home folder, once known. */
	readonly home: URI | undefined;

	/** Where a chat works: its worktree, else its project. */
	folderForSession(sessionId: string): URI | undefined;

	/** The files sidebar's filter, shared by every chat in the window. */
	readonly filter: AgentResourceFilter | undefined;
	readonly onDidChangeFilter: Event<void>;
	setFilter(filter: AgentResourceFilter | undefined): void;
}

/** Files past this are listed by path only: nothing an agent reads is this big. */
const MAX_READ_BYTES = 256 * 1024;
const MAX_RESULTS = 4000;
/** Folders kept scanned and watched at once (the chats on screen and the last few). */
const MAX_FOLDERS = 4;
const RESCAN_DELAY_MS = 600;

/** The agent folders in the home folder. Only these are read: the home folder itself is never searched. */
const HOME_CONFIG_DIRS = ['.claude', '.codex', '.gemini', '.cursor', '.agents', '.volt', '.copilot'];
/** Subfolders of a home config folder that hold resources; everything else there is app state (projects, sessions, caches). */
const HOME_WALK_DIRS = new Set(['skills', 'agents', 'agent', 'commands', 'command', 'prompts', 'rules', 'hooks', 'instructions', 'output-styles', 'workflows', 'extensions']);
const HOME_WALK_DEPTH = 4;
const HOME_MAX_FILES = 2000;

/** Files their own app rewrites: Volt shows them and never writes them. */
const APP_MANAGED_FILES: Record<string, string> = {
	'.claude.json': localize('agentResources.readOnly.claudeJson', "Claude Code rewrites this file. Change its MCP servers with claude mcp add and remove."),
	'.cursor/cli-config.json': localize('agentResources.readOnly.cursorCli', "Cursor repairs this file on its own; edit it with care."),
};

interface IManagedFile {
	readonly path: string;
	readonly match: Omit<IAgentResourceMatch, 'scope'>;
}

interface IManagedRoot {
	readonly dir: string;
	readonly files: readonly IManagedFile[];
	/** A folder of skills (`<name>/SKILL.md`) under the root. */
	readonly skills?: string;
	/** A folder of `*.json` settings fragments merged in name order. */
	readonly fragments?: { readonly dir: string; readonly match: Omit<IAgentResourceMatch, 'scope'> };
}

/** Where organizations put managed agent settings, per the harnesses' docs (checked 2026-10-29). */
function managedRoots(): IManagedRoot[] {
	const claudeSettings: Omit<IAgentResourceMatch, 'scope'> = { group: 'config', ecosystem: 'claude', kind: localize('agentResources.kind.managedSettings', "Managed settings"), format: 'settings' };
	const claude = (dir: string): IManagedRoot => ({
		dir,
		files: [
			{ path: 'CLAUDE.md', match: { group: 'instructions', ecosystem: 'claude', kind: localize('agentResources.kind.orgMemory', "Organization memory"), format: 'markdown' } },
			{ path: 'managed-settings.json', match: claudeSettings },
			{ path: 'managed-mcp.json', match: { group: 'integrations', ecosystem: 'claude', kind: localize('agentResources.kind.managedMcp', "Managed MCP servers"), format: 'json' } },
		],
		skills: '.claude/skills',
		fragments: { dir: 'managed-settings.d', match: claudeSettings },
	});
	const codex: IManagedRoot = {
		dir: '/etc/codex',
		files: [
			{ path: 'requirements.toml', match: { group: 'config', ecosystem: 'codex', kind: localize('agentResources.kind.requirements', "Requirements (enforced)"), format: 'toml' } },
			{ path: 'managed_config.toml', match: { group: 'config', ecosystem: 'codex', kind: localize('agentResources.kind.managedDefaults', "Managed defaults"), format: 'toml' } },
			{ path: 'config.toml', match: { group: 'config', ecosystem: 'codex', kind: localize('agentResources.kind.systemConfig', "System config"), format: 'toml' } },
		],
		skills: 'skills',
	};
	const gemini = (dir: string): IManagedRoot => ({
		dir,
		files: [
			{ path: 'settings.json', match: { group: 'config', ecosystem: 'gemini', kind: localize('agentResources.kind.systemSettings', "System settings (override)"), format: 'settings' } },
			{ path: 'system-defaults.json', match: { group: 'config', ecosystem: 'gemini', kind: localize('agentResources.kind.systemDefaults', "System defaults"), format: 'settings' } },
		],
	});
	const cursor = (dir: string): IManagedRoot => ({
		dir,
		files: [{ path: 'hooks.json', match: { group: 'hooks', ecosystem: 'cursor', kind: localize('agentResources.kind.enterpriseHooks', "Enterprise hooks"), format: 'json' } }],
	});
	switch (OS) {
		case OperatingSystem.Macintosh:
			return [claude('/Library/Application Support/ClaudeCode'), codex, gemini('/Library/Application Support/GeminiCli'), cursor('/Library/Application Support/Cursor')];
		case OperatingSystem.Linux:
			return [claude('/etc/claude-code'), codex, gemini('/etc/gemini-cli'), cursor('/etc/cursor')];
		default:
			return [claude('C:\\Program Files\\ClaudeCode'), gemini('C:\\ProgramData\\gemini-cli'), cursor('C:\\ProgramData\\Cursor')];
	}
}

const ORIGIN_ECOSYSTEM: Record<AgentCustomizationOrigin, AgentResourceEcosystem> = {
	volt: 'volt', claude: 'claude', cursor: 'cursor', codex: 'codex', agents: 'agents', builtin: 'volt',
};

const KIND_GROUP: Partial<Record<AgentCustomizationKind, AgentResourceGroupId>> = {
	rule: 'instructions', skill: 'skills', subagent: 'subagents', command: 'commands', hook: 'hooks', mcp: 'integrations', plugin: 'integrations',
};

interface IFolderEntry {
	resources: readonly IAgentResource[] | undefined;
	scan: Promise<readonly IAgentResource[]> | undefined;
	readonly rescan: RunOnceScheduler;
	readonly store: DisposableStore;
	lastUsed: number;
}

const GROUP_ORDER = new Map(AGENT_RESOURCE_GROUPS.map((group, index) => [group.id, index]));

function sortResources(resources: IAgentResource[]): IAgentResource[] {
	return resources.sort((a, b) => (GROUP_ORDER.get(a.group)! - GROUP_ORDER.get(b.group)!) || a.relativePath.localeCompare(b.relativePath));
}

export class AgentResourcesService extends Disposable implements IAgentResourcesService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<URI>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _onDidChangeGlobal = this._register(new Emitter<void>());
	readonly onDidChangeGlobal = this._onDidChangeGlobal.event;
	private readonly _onDidChangeFilter = this._register(new Emitter<void>());
	readonly onDidChangeFilter = this._onDidChangeFilter.event;

	private readonly folders = new ResourceMap<IFolderEntry>();
	private readonly folderStores = this._register(new DisposableMap<string, DisposableStore>());
	private _filter: AgentResourceFilter | undefined;
	private _home: URI | undefined;
	private global: readonly IAgentResource[] | undefined;
	private globalScan: Promise<readonly IAgentResource[]> | undefined;
	private readonly globalRescan = this._register(new RunOnceScheduler(() => void this.scanGlobal(), RESCAN_DELAY_MS));
	private readonly globalWatch = this._register(new DisposableStore());
	private homeWatched = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@IAgentCustomizeService private readonly customize: IAgentCustomizeService,
	) {
		super();
		this._register(fileService.onDidFilesChange(event => {
			const changed = event.rawAdded.concat(event.rawUpdated, event.rawDeleted);
			for (const [folder, entry] of this.folders) {
				if (!entry.resources) {
					continue;
				}
				// Only a change to a file the scan would list (or a deleted folder that held some) rescans.
				const touches = changed.some(resource => {
					const path = relativePath(folder, resource);
					return path !== undefined && path !== '' && (!!matchAgentResource(path) || entry.resources!.some(item => item.relativePath.startsWith(`${path}/`)));
				});
				if (touches) {
					entry.rescan.schedule();
				}
			}
			const home = this._home;
			if (home && this.global && changed.some(resource => {
				const path = relativePath(home, resource);
				return !!path && (HOME_CONFIG_DIRS.some(dir => path === dir || path.startsWith(`${dir}/`)) || path in APP_MANAGED_FILES);
			})) {
				this.globalRescan.schedule();
			}
		}));
		// Plugins installed or removed through Customize or a harness's own plugin manager.
		this._register(customize.onDidChange(() => {
			if (this.global) {
				this.globalRescan.schedule();
			}
		}));
	}

	get home(): URI | undefined {
		return this._home;
	}

	get filter(): AgentResourceFilter | undefined {
		return this._filter;
	}

	setFilter(filter: AgentResourceFilter | undefined): void {
		if (filter !== this._filter) {
			this._filter = filter;
			this._onDidChangeFilter.fire();
		}
	}

	folderForSession(sessionId: string): URI | undefined {
		const meta = this.history.get(sessionId);
		const worktree = meta?.worktreePath ?? this.runtime.getOrCreateSession(sessionId).worktreePath;
		if (worktree) {
			return URI.file(worktree);
		}
		// A new chat has no folder of its own yet: it works in the window's project.
		return this.sessionContext.rootFor(sessionId)
			?? (meta?.workspaceFolder ? uriFromStoredRoot(meta.workspaceFolder) : undefined)
			?? this.workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	//#region Project folders

	get(folder: URI): readonly IAgentResource[] | undefined {
		return this.folders.get(folder)?.resources;
	}

	load(folder: URI): Promise<readonly IAgentResource[]> {
		const entry = this.entryFor(folder);
		entry.lastUsed = Date.now();
		if (entry.resources) {
			return Promise.resolve(entry.resources);
		}
		return entry.scan ??= this.scan(folder, entry);
	}

	private entryFor(folder: URI): IFolderEntry {
		let entry = this.folders.get(folder);
		if (entry) {
			return entry;
		}
		const store = new DisposableStore();
		const created: IFolderEntry = {
			resources: undefined,
			scan: undefined,
			rescan: store.add(new RunOnceScheduler(() => void this.scan(folder, created), RESCAN_DELAY_MS)),
			store,
			lastUsed: Date.now(),
		};
		entry = created;
		this.folders.set(folder, entry);
		this.folderStores.set(folder.toString(), store);
		// A chat's worktree is outside the workspace, so nothing else watches it.
		try {
			store.add(this.fileService.watch(folder, { recursive: true, excludes: [...AGENT_RESOURCE_EXCLUDE_GLOBS] }));
		} catch (error) {
			this.logService.trace('[agentResources] watch failed', error);
		}
		this.evict();
		return entry;
	}

	private evict(): void {
		if (this.folders.size <= MAX_FOLDERS) {
			return;
		}
		const oldest = [...this.folders].sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
		if (oldest) {
			this.folders.delete(oldest[0]);
			this.folderStores.deleteAndDispose(oldest[0].toString());
		}
	}

	private async scan(folder: URI, entry: IFolderEntry): Promise<readonly IAgentResource[]> {
		let found: URI[] = [];
		try {
			const complete = await this.searchService.fileSearch({
				type: QueryType.File,
				_reason: 'voltAgentResources',
				folderQueries: [{ folder, disregardIgnoreFiles: false, disregardGlobalIgnoreFiles: false }],
				includePattern: Object.fromEntries(AGENT_RESOURCE_INCLUDE_GLOBS.map(glob => [glob, true])),
				excludePattern: Object.fromEntries(AGENT_RESOURCE_EXCLUDE_GLOBS.map(glob => [glob, true])),
				maxResults: MAX_RESULTS,
				sortByScore: false,
			});
			found = complete.results.map(match => match.resource);
		} catch (error) {
			this.logService.warn('[agentResources] search failed', error);
		}
		const seen = new ResourceMap<true>(uri => this.uriIdentityService.extUri.getComparisonKey(uri));
		const candidates: { resource: URI; path: string }[] = [];
		for (const resource of found) {
			const path = relativePath(folder, resource);
			if (path && !seen.has(resource) && matchAgentResource(path)) {
				seen.set(resource, true);
				candidates.push({ resource, path });
			}
		}
		const resources = sortResources((await Promise.all(candidates.map(async ({ resource, path }) => {
			const content = await this.read(resource);
			const info = classifyAgentResource(path, content);
			return info ? this.describe(info, resource, folder, path, content) : undefined;
		}))).filter((item): item is IAgentResource => !!item));
		const previous = entry.resources;
		entry.resources = resources;
		entry.scan = undefined;
		if (this.folders.get(folder) === entry && (!previous || signature(previous) !== signature(resources))) {
			this._onDidChange.fire(folder);
		}
		return resources;
	}

	//#endregion

	//#region Global, managed and external

	getGlobal(): readonly IAgentResource[] | undefined {
		return this.global;
	}

	loadGlobal(): Promise<readonly IAgentResource[]> {
		if (this.global) {
			return Promise.resolve(this.global);
		}
		return this.globalScan ??= this.scanGlobal();
	}

	private async scanGlobal(): Promise<readonly IAgentResource[]> {
		const home = this._home ??= await this.pathService.userHome({ preferLocal: true });
		if (!this.homeWatched) {
			this.homeWatched = true;
			this.watchHome(home);
		}
		const [homeItems, managed, external] = await Promise.all([
			this.scanHome(home),
			this.scanManaged(),
			this.scanExternal(),
		]);
		// A plugin's files may also sit under a home folder (Gemini extensions): the External entry wins.
		const externalKeys = new Set(external.map(item => item.resource.toString()));
		const resources = sortResources([...homeItems.filter(item => !externalKeys.has(item.resource.toString())), ...managed, ...external]);
		const previous = this.global;
		this.global = resources;
		this.globalScan = undefined;
		if (!previous || signature(previous) !== signature(resources)) {
			this._onDidChangeGlobal.fire();
		}
		return resources;
	}

	private watchHome(home: URI): void {
		for (const dir of HOME_CONFIG_DIRS) {
			try {
				// App state in these folders churns (sessions, caches): only the resource subfolders matter, and the handler filters.
				this.globalWatch.add(this.fileService.watch(joinPath(home, dir), { recursive: true, excludes: ['**/projects/**', '**/sessions/**', '**/plugins/cache/**', '**/todos/**', '**/shell-snapshots/**', '**/statsig/**', '**/file-history/**', '**/logs/**', '**/worktrees/**', '**/node_modules/**'] }));
			} catch (error) {
				this.logService.trace('[agentResources] home watch failed', error);
			}
		}
	}

	/** The agent folders in the home folder, walked only where resources live. */
	private async scanHome(home: URI): Promise<IAgentResource[]> {
		const files: URI[] = [];
		const walk = async (dir: URI, depth: number) => {
			if (files.length >= HOME_MAX_FILES) {
				return;
			}
			const stat = await this.fileService.resolve(dir).catch(() => undefined);
			for (const child of stat?.children ?? []) {
				if (child.isFile) {
					files.push(child.resource);
				} else if (child.isDirectory && depth < HOME_WALK_DEPTH && !child.name.startsWith('.') && child.name !== 'node_modules') {
					await walk(child.resource, depth + 1);
				}
			}
		};
		await Promise.all(HOME_CONFIG_DIRS.map(async dir => {
			const stat = await this.fileService.resolve(joinPath(home, dir)).catch(() => undefined);
			for (const child of stat?.children ?? []) {
				if (child.isFile) {
					files.push(child.resource);
				} else if (child.isDirectory && HOME_WALK_DIRS.has(child.name)) {
					await walk(child.resource, 1);
				}
			}
		}));
		files.push(...Object.keys(APP_MANAGED_FILES).filter(path => !path.includes('/')).map(path => joinPath(home, path)));
		const resources = await Promise.all(files.map(async resource => {
			const path = relativePath(home, resource);
			if (!path) {
				return undefined;
			}
			const match = path === '.claude.json'
				? { group: 'integrations' as const, ecosystem: 'claude' as const, kind: localize('agentResources.kind.claudeJson', "MCP servers and app state"), scope: 'global' as const, format: 'json' as const }
				: matchAgentResource(path);
			if (!match) {
				return undefined;
			}
			const exists = path !== '.claude.json' || await this.fileService.exists(resource);
			if (!exists) {
				return undefined;
			}
			const content = await this.read(resource);
			// The project's local Claude servers live under projects[<path>] in ~/.claude.json; they are not this list's.
			const info = classifyAgentResourceMatch(match, path, content);
			if (!info) {
				return undefined;
			}
			// Gemini extensions are installed by `gemini extensions install`: External.
			const scope: AgentResourceScope = path.startsWith('.gemini/extensions/') ? 'external' : 'global';
			const readOnly = APP_MANAGED_FILES[path]
				?? (path.startsWith('.claude/skills/synced/') ? localize('agentResources.readOnly.synced', "Synced from claude.ai; changes here are overwritten.") : undefined)
				?? (scope === 'external' ? localize('agentResources.readOnly.geminiExtension', "Installed by gemini extensions; update it there.") : undefined);
			return this.describe({ ...info, scope }, resource, home, path, content, readOnly, scope === 'external' ? path.split('/')[2] : undefined);
		}));
		return resources.filter((item): item is IAgentResource => !!item);
	}

	private async scanManaged(): Promise<IAgentResource[]> {
		const out: IAgentResource[] = [];
		const readOnly = localize('agentResources.readOnly.managed', "Set by your organization. Ask your admin to change it.");
		await Promise.all(managedRoots().map(async root => {
			const dir = URI.file(root.dir);
			if (!await this.fileService.exists(dir)) {
				return;
			}
			const add = async (resource: URI, match: Omit<IAgentResourceMatch, 'scope'>) => {
				const path = relativePath(dir, resource) ?? basename(resource);
				const content = await this.read(resource);
				const info = classifyAgentResourceMatch({ ...match, scope: 'managed' }, path, content);
				if (info) {
					out.push(await this.describe(info, resource, dir, path, content, readOnly));
				}
			};
			await Promise.all(root.files.map(async file => {
				const resource = joinPath(dir, file.path);
				if (await this.fileService.exists(resource)) {
					await add(resource, file.match);
				}
			}));
			if (root.fragments) {
				const stat = await this.fileService.resolve(joinPath(dir, root.fragments.dir)).catch(() => undefined);
				await Promise.all((stat?.children ?? []).filter(child => child.isFile && child.name.endsWith('.json')).map(child => add(child.resource, root.fragments!.match)));
			}
			if (root.skills) {
				const stat = await this.fileService.resolve(joinPath(dir, root.skills)).catch(() => undefined);
				await Promise.all((stat?.children ?? []).filter(child => child.isDirectory).map(async child => {
					const skill = joinPath(child.resource, 'SKILL.md');
					if (await this.fileService.exists(skill)) {
						await add(skill, { group: 'skills', ecosystem: root.files[0].match.ecosystem, kind: localize('agentResources.kind.managedSkill', "Managed skill"), format: 'frontmatter' });
					}
				}));
			}
		}));
		return out;
	}

	/** What installed plugins ship, from Customize's plugin scan: read-only here, their plugin manager owns them. */
	private async scanExternal(): Promise<IAgentResource[]> {
		const items = await this.customize.getItems().catch(() => []);
		const out = new ResourceMap<IAgentResource>();
		await Promise.all(items.map(async item => {
			const group = item.plugin ? KIND_GROUP[item.kind] : undefined;
			if (!group || !item.plugin || out.has(item.resource)) {
				return;
			}
			const root = item.plugin.root;
			const path = `${item.plugin.displayName}/${relativePath(root, item.resource) ?? basename(item.resource)}`;
			const content = await this.read(item.resource);
			const info: IAgentResourceInfo = {
				group,
				ecosystem: ORIGIN_ECOSYSTEM[item.origin ?? item.plugin.origin] ?? 'volt',
				kind: item.kind === 'plugin' ? localize('agentResources.kind.plugin', "Plugin manifest") : kindInfo(item.kind).label,
				scope: 'external',
				status: { kind: 'ok' },
				name: item.name,
				description: item.description || undefined,
			};
			const readOnly = localize('agentResources.readOnly.plugin', "Ships with the {0} plugin ({1}). Update or remove the plugin to change it.", item.plugin.displayName, item.plugin.publisher);
			out.set(item.resource, await this.describe(info, item.resource, root, path, content, readOnly, item.plugin.displayName));
		}));
		return [...out.values()];
	}

	//#endregion

	/** The file's details beyond its group: servers, hook events, a subagent's model, a skill folder's scripts. */
	private async describe(info: IAgentResourceInfo, resource: URI, root: URI, path: string, content: string | undefined, readOnly?: string, source?: string): Promise<IAgentResource> {
		const base: { -readonly [K in keyof IAgentResource]: IAgentResource[K] } = { ...info, resource, root, relativePath: path, readOnly, source };
		if (content !== undefined) {
			if (info.group === 'integrations' && !path.endsWith('.json') && !path.endsWith('.toml')) {
				// Plugin manifests in other formats have no servers to list.
			} else if (info.group === 'integrations' || (info.group === 'config' && /settings|config|opencode/.test(path))) {
				const projectPath = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
				const servers = parseMcpServers(path, content, path === '.claude.json' ? projectPath : undefined);
				if (servers.length) {
					base.servers = servers;
				}
			}
			if (info.group === 'hooks' && (path.endsWith('.json') || path.endsWith('.toml'))) {
				base.hookEvents = parseHookEvents(path, content);
			}
			if (info.group === 'subagents') {
				const front = readFrontmatter(content);
				base.model = front?.model || undefined;
				base.tools = front?.tools || undefined;
			}
		}
		if (info.group === 'skills') {
			base.skill = await this.inspectSkill(dirname(resource));
		}
		return base;
	}

	/** Counts the skill folder's files and says whether it ships scripts (it then runs code, not just text). */
	private async inspectSkill(folder: URI): Promise<{ files: number; hasScripts: boolean }> {
		const stat = await this.fileService.resolve(folder).catch(() => undefined);
		const children = stat?.children ?? [];
		const hasScripts = children.some(child => (child.isDirectory && child.name === 'scripts') || (child.isFile && /\.(sh|py|js|mjs|ts|rb|ps1|bash|zsh)$/i.test(child.name)));
		return { files: children.filter(child => child.name !== 'SKILL.md').length, hasScripts };
	}

	private async read(resource: URI): Promise<string | undefined> {
		try {
			const content = await this.fileService.readFile(resource, { limits: { size: MAX_READ_BYTES } });
			return content.value.toString();
		} catch {
			return undefined;
		}
	}
}

function signature(resources: readonly IAgentResource[]): string {
	return resources.map(item => [item.resource.toString(), item.group, item.ecosystem, item.kind, item.status.kind, item.status.message, item.name, item.description, item.servers?.length, item.hookEvents?.join()].join('\u0001')).join('\n');
}

registerSingleton(IAgentResourcesService, AgentResourcesService, InstantiationType.Delayed);
