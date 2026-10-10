/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { streamToBuffer, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { asJson, asText, IRequestService } from '../../../../../platform/request/common/request.js';
import { IAuthenticationService } from '../../../../services/authentication/common/authentication.js';
import { readJsonFile, safeItemName } from './agentCustomize.js';
import { IAgentCustomizeService } from './agentCustomizeService.js';
import { frontmatterValue, parseFrontmatterDocument } from './agentFrontmatter.js';

export const IAgentMarketplaceService = createDecorator<IAgentMarketplaceService>('voltAgentMarketplaceService');

/** A skill listed on skills.sh. */
export interface ISkillsShSkill {
	/** `owner/repo/skillId`. */
	readonly id: string;
	/** `owner/repo` on GitHub (a few entries name another host). */
	readonly source: string;
	readonly skillId: string;
	readonly name: string;
	readonly installs: number;
}

/** A skill's SKILL.md and the files around it, found in its GitHub repository. */
export interface ISkillsShDetail {
	readonly skill: ISkillsShSkill;
	readonly description: string;
	/** Repository path of the skill folder. */
	readonly folder: string;
	readonly files: readonly string[];
	readonly ref: string;
	readonly url: string;
}

export type MarketplacePluginSource =
	| { readonly kind: 'path'; readonly path: string }
	| { readonly kind: 'github'; readonly repo: string; readonly ref?: string; readonly path?: string }
	| { readonly kind: 'unsupported'; readonly label: string };

export interface IMarketplacePlugin {
	readonly name: string;
	readonly description: string;
	readonly author: string;
	readonly category?: string;
	readonly homepage?: string;
	readonly source: MarketplacePluginSource;
	/** The marketplace it is listed in. */
	readonly marketplace: string;
	/** Installed for Claude Code, Cursor or Volt. */
	readonly installed: boolean;
	/** Installed into Volt's own plugins folder (can be removed from Volt). */
	readonly installedInVolt: boolean;
}

export interface IMarketplace {
	/** `claude-plugins-official`. */
	readonly name: string;
	/** "Claude Plugins Official". */
	readonly displayName: string;
	readonly description: string;
	readonly owner: string;
	/** Where it was registered: Claude Code's list, or Volt's own. */
	readonly registry: 'claude' | 'volt';
	/** The folder holding `.claude-plugin/marketplace.json`. */
	readonly root: URI;
	readonly plugins: readonly IMarketplacePlugin[];
}

export type MarketplaceScope = { readonly kind: 'user' } | { readonly kind: 'workspace'; readonly folder: URI };

export interface IAgentMarketplaceService {
	readonly _serviceBrand: undefined;

	/** Marketplaces were added or removed, or a plugin was installed or removed. */
	readonly onDidChange: Event<void>;

	/** skills.sh search; needs at least two characters. */
	searchSkills(query: string, limit: number, token: CancellationToken): Promise<readonly ISkillsShSkill[]>;

	/** The most installed skills on skills.sh, from a handful of broad searches. */
	popularSkills(token: CancellationToken): Promise<readonly ISkillsShSkill[]>;

	/** Finds the skill's folder in its repository and reads its description. Undefined when it is not on GitHub or cannot be found. */
	skillDetail(skill: ISkillsShSkill, token: CancellationToken): Promise<ISkillsShDetail | undefined>;

	/** Downloads the skill into `.volt/skills/<name>/` of the user or a workspace folder; returns its SKILL.md. */
	installSkill(skill: ISkillsShSkill, scope: MarketplaceScope, token: CancellationToken): Promise<URI>;

	/** Whether a skill with this name is already installed in the scope. */
	isSkillInstalled(skill: ISkillsShSkill, scope: MarketplaceScope): Promise<boolean>;

	/** skills.sh page of the skill. */
	skillPage(skill: ISkillsShSkill): URI;

	/** Plugin marketplaces registered with Claude Code or with Volt, with their plugins. */
	listMarketplaces(): Promise<readonly IMarketplace[]>;

	/** Installs a marketplace plugin into `~/.volt/plugins/<name>/`. */
	installPlugin(plugin: IMarketplacePlugin, token: CancellationToken): Promise<URI>;

	/** Removes a plugin Volt installed. */
	uninstallPlugin(name: string): Promise<void>;

	/** Registers a marketplace from a GitHub repository (`owner/repo` or a URL). */
	addMarketplaceFromGitHub(repository: string, token: CancellationToken): Promise<IMarketplace>;

	/** Registers a marketplace folder on disk (holding `.claude-plugin/marketplace.json`). */
	addMarketplaceFromDisk(folder: URI): Promise<IMarketplace>;

	/** Creates an empty team marketplace in `folder` and registers it. */
	createMarketplace(folder: URI, name: string): Promise<URI>;

	/** Forgets a marketplace Volt registered. */
	removeMarketplace(name: string): Promise<void>;
}

const SKILLS_SH = 'https://skills.sh';
const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';
const POPULAR_SEEDS = ['skill', 'react', 'test', 'git', 'design', 'docs', 'review', 'python'];
const MAX_DOWNLOAD_FILES = 400;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface IVoltMarketplaceRecord {
	readonly name: string;
	readonly source: { readonly kind: 'github'; readonly repo: string } | { readonly kind: 'local'; readonly path: string };
	readonly addedAt: number;
}

interface IGitTree {
	readonly sha: string;
	readonly truncated?: boolean;
	readonly tree: readonly { readonly path: string; readonly type: 'blob' | 'tree' | 'commit'; readonly size?: number }[];
}

function githubRepoOf(value: string): string | undefined {
	const trimmed = value.trim().replace(/\.git$/, '').replace(/\/+$/, '');
	const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(trimmed);
	if (url) {
		return `${url[1]}/${url[2]}`;
	}
	const short = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
	return short ? `${short[1]}/${short[2]}` : undefined;
}

function pluginSourceOf(raw: unknown): MarketplacePluginSource {
	if (typeof raw === 'string') {
		return { kind: 'path', path: raw };
	}
	if (!raw || typeof raw !== 'object') {
		return { kind: 'unsupported', label: 'unknown' };
	}
	const source = raw as { source?: unknown; repo?: unknown; url?: unknown; path?: unknown; ref?: unknown; sha?: unknown };
	const ref = typeof source.sha === 'string' ? source.sha : typeof source.ref === 'string' ? source.ref : undefined;
	switch (source.source) {
		case 'github':
			return typeof source.repo === 'string' ? { kind: 'github', repo: source.repo, ref } : { kind: 'unsupported', label: 'github' };
		case 'url':
		case 'git': {
			const repo = typeof source.url === 'string' ? githubRepoOf(source.url) : undefined;
			return repo ? { kind: 'github', repo, ref } : { kind: 'unsupported', label: String(source.url ?? 'url') };
		}
		case 'git-subdir': {
			const repo = typeof source.url === 'string' ? githubRepoOf(source.url) : undefined;
			return repo && typeof source.path === 'string' ? { kind: 'github', repo, ref, path: source.path } : { kind: 'unsupported', label: 'git-subdir' };
		}
		default:
			return { kind: 'unsupported', label: String(source.source ?? 'unknown') };
	}
}

/** "claude-plugins-official" → "Claude Plugins Official". */
function titleOf(name: string): string {
	return name.split(/[-_\s]+/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export class AgentMarketplaceService extends Disposable implements IAgentMarketplaceService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly searches = new Map<string, Promise<readonly ISkillsShSkill[]>>();
	private readonly details = new Map<string, Promise<ISkillsShDetail | undefined>>();
	private readonly trees = new Map<string, Promise<IGitTree | undefined>>();
	private popular: Promise<readonly ISkillsShSkill[]> | undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IFileService private readonly fileService: IFileService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IAgentCustomizeService private readonly customize: IAgentCustomizeService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	//#region skills.sh

	searchSkills(query: string, limit: number, token: CancellationToken): Promise<readonly ISkillsShSkill[]> {
		const q = query.trim();
		if (q.length < 2) {
			return Promise.resolve([]);
		}
		const key = `${q.toLowerCase()}|${limit}`;
		let pending = this.searches.get(key);
		if (!pending) {
			pending = this.fetchJson<{ skills?: unknown[] }>(`${SKILLS_SH}/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, {}, token)
				.then(result => (result?.skills ?? []).map(toSkill).filter((skill): skill is ISkillsShSkill => !!skill));
			pending.catch(() => this.searches.delete(key));
			this.searches.set(key, pending);
		}
		return pending;
	}

	popularSkills(token: CancellationToken): Promise<readonly ISkillsShSkill[]> {
		if (!this.popular) {
			this.popular = Promise.all(POPULAR_SEEDS.map(seed => this.searchSkills(seed, 20, token).catch(() => [] as readonly ISkillsShSkill[])))
				.then(lists => {
					const byId = new Map<string, ISkillsShSkill>();
					for (const skill of lists.flat()) {
						byId.set(skill.id, skill);
					}
					return [...byId.values()].sort((a, b) => b.installs - a.installs);
				});
			this.popular.then(list => {
				if (!list.length) {
					this.popular = undefined;
				}
			}, () => this.popular = undefined);
		}
		return this.popular;
	}

	skillPage(skill: ISkillsShSkill): URI {
		return URI.parse(`${SKILLS_SH}/${skill.source}/${skill.skillId}`);
	}

	skillDetail(skill: ISkillsShSkill, token: CancellationToken): Promise<ISkillsShDetail | undefined> {
		let pending = this.details.get(skill.id);
		if (!pending) {
			pending = this.findSkill(skill, token);
			pending.then(detail => { if (!detail) { this.details.delete(skill.id); } }, () => this.details.delete(skill.id));
			this.details.set(skill.id, pending);
		}
		return pending;
	}

	private async findSkill(skill: ISkillsShSkill, token: CancellationToken): Promise<ISkillsShDetail | undefined> {
		const repo = githubRepoOf(skill.source);
		if (!repo) {
			return undefined;
		}
		const tree = await this.repoTree(repo, 'HEAD', token);
		const skillFiles = tree?.tree.filter(entry => entry.type === 'blob' && /(^|\/)SKILL\.md$/i.test(entry.path)).map(entry => entry.path) ?? [];
		const id = skill.skillId.toLowerCase();
		let path = skillFiles.find(file => folderName(file).toLowerCase() === id);
		if (!path && skillFiles.length === 1) {
			path = skillFiles[0];
		}
		let text: string | undefined;
		if (!path) {
			// A large repository's tree comes back cut short: try the usual places.
			for (const candidate of [`skills/${skill.skillId}/SKILL.md`, `${skill.skillId}/SKILL.md`, `.claude/skills/${skill.skillId}/SKILL.md`, `.agents/skills/${skill.skillId}/SKILL.md`]) {
				text = await this.rawText(repo, 'HEAD', candidate, token).catch(() => undefined);
				if (text) {
					path = candidate;
					break;
				}
			}
		}
		if (!path && skillFiles.length) {
			// Folder names differ from the listed id: match on the name in the front matter.
			for (const candidate of skillFiles.slice(0, 30)) {
				const content = await this.rawText(repo, 'HEAD', candidate, token).catch(() => undefined);
				if (content && frontmatterValue(parseFrontmatterDocument(content), 'name')?.toLowerCase() === id) {
					path = candidate;
					text = content;
					break;
				}
			}
		}
		if (!path) {
			return undefined;
		}
		text ??= await this.rawText(repo, 'HEAD', path, token);
		const doc = parseFrontmatterDocument(text ?? '');
		const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		const prefix = folder ? `${folder}/` : '';
		const files = tree
			? tree.tree.filter(entry => entry.type === 'blob' && (!folder || entry.path.startsWith(prefix))).map(entry => entry.path)
			: [path];
		return {
			skill,
			description: frontmatterValue(doc, 'description') ?? '',
			folder,
			// A skill at the repository root would take the whole repository: keep only its own file then.
			files: folder ? files : [path],
			ref: 'HEAD',
			url: `https://github.com/${repo}/tree/HEAD/${folder}`,
		};
	}

	private async skillsBase(scope: MarketplaceScope): Promise<URI> {
		if (scope.kind === 'workspace') {
			return joinPath(scope.folder, '.volt', 'skills');
		}
		const home = await this.customize.userHome();
		if (!home) {
			throw new Error(localize('voltMarketplace.noHome', "Volt could not find your home folder."));
		}
		return joinPath(home, '.volt', 'skills');
	}

	async isSkillInstalled(skill: ISkillsShSkill, scope: MarketplaceScope): Promise<boolean> {
		const name = safeItemName(skill.skillId);
		const items = await this.customize.getItems();
		if (items.some(item => item.kind === 'skill' && item.name.toLowerCase() === skill.name.toLowerCase() && (scope.kind === 'user' ? item.scope === 'user' && !item.plugin : item.folder?.toString() === scope.folder.toString()))) {
			return true;
		}
		return this.fileService.exists(joinPath(await this.skillsBase(scope), name, 'SKILL.md'));
	}

	async installSkill(skill: ISkillsShSkill, scope: MarketplaceScope, token: CancellationToken): Promise<URI> {
		const detail = await this.skillDetail(skill, token);
		const repo = githubRepoOf(skill.source);
		if (!detail || !repo) {
			throw new Error(localize('voltMarketplace.skillNotFound', "Couldn't find {0} in {1}. Open it on skills.sh to install it by hand.", skill.name, skill.source));
		}
		const target = joinPath(await this.skillsBase(scope), safeItemName(skill.skillId) || safeItemName(skill.name));
		const prefix = detail.folder ? `${detail.folder}/` : '';
		await this.downloadFiles(repo, detail.ref, detail.files.map(file => ({ path: file, relative: prefix ? file.slice(prefix.length) : basename(URI.file(`/${file}`)) })), target, token);
		void this.customize.refresh();
		return joinPath(target, 'SKILL.md');
	}

	//#endregion

	//#region Plugin marketplaces

	async listMarketplaces(): Promise<readonly IMarketplace[]> {
		const home = await this.customize.userHome();
		if (!home) {
			return [];
		}
		const [known, voltRecords, installed, items] = await Promise.all([
			readJsonFile(this.fileService, joinPath(home, '.claude', 'plugins', 'known_marketplaces.json')),
			this.voltRecords(home),
			readJsonFile(this.fileService, joinPath(home, '.claude', 'plugins', 'installed_plugins.json')),
			this.customize.getItems(),
		]);
		const installedKeys = new Set(Object.keys((installed as { plugins?: Record<string, unknown> } | undefined)?.plugins ?? {}));
		const installedNames = new Set(items.filter(item => item.kind === 'plugin' && item.plugin).map(item => item.plugin!.name));
		const voltNames = new Set(items.filter(item => item.kind === 'plugin' && item.plugin?.origin === 'volt').map(item => item.plugin!.name));
		const roots: { root: URI; registry: 'claude' | 'volt'; name: string }[] = [];
		if (known && typeof known === 'object') {
			for (const [name, entry] of Object.entries(known as Record<string, { installLocation?: unknown }>)) {
				if (typeof entry?.installLocation === 'string') {
					roots.push({ root: URI.file(entry.installLocation), registry: 'claude', name });
				}
			}
		}
		for (const record of voltRecords) {
			const root = record.source.kind === 'local' ? URI.file(record.source.path) : joinPath(home, '.volt', 'marketplaces', record.name);
			if (!roots.some(candidate => candidate.name === record.name)) {
				roots.push({ root, registry: 'volt', name: record.name });
			}
		}
		const marketplaces = await Promise.all(roots.map(async ({ root, registry, name }): Promise<IMarketplace | undefined> => {
			const json = await readJsonFile(this.fileService, joinPath(root, '.claude-plugin', 'marketplace.json'), 4 * 1024 * 1024) as { name?: unknown; description?: unknown; owner?: { name?: unknown }; metadata?: { description?: unknown }; plugins?: unknown[] } | undefined;
			if (!json || !Array.isArray(json.plugins)) {
				return undefined;
			}
			const marketplaceName = typeof json.name === 'string' ? json.name : name;
			const plugins = json.plugins.flatMap((raw): IMarketplacePlugin[] => {
				const plugin = raw as { name?: unknown; description?: unknown; author?: { name?: unknown } | string; category?: unknown; homepage?: unknown; source?: unknown };
				if (typeof plugin?.name !== 'string') {
					return [];
				}
				const author = typeof plugin.author === 'string' ? plugin.author : typeof plugin.author?.name === 'string' ? plugin.author.name : '';
				return [{
					name: plugin.name,
					description: typeof plugin.description === 'string' ? plugin.description : '',
					author,
					category: typeof plugin.category === 'string' ? plugin.category : undefined,
					homepage: typeof plugin.homepage === 'string' ? plugin.homepage : undefined,
					source: pluginSourceOf(plugin.source),
					marketplace: marketplaceName,
					installed: installedKeys.has(`${plugin.name}@${marketplaceName}`) || installedNames.has(plugin.name),
					installedInVolt: voltNames.has(plugin.name),
				}];
			});
			const owner = typeof json.owner?.name === 'string' ? json.owner.name : '';
			const description = typeof json.description === 'string' ? json.description : typeof json.metadata?.description === 'string' ? json.metadata.description : '';
			return { name: marketplaceName, displayName: titleOf(marketplaceName), description, owner, registry, root, plugins };
		}));
		return marketplaces.filter((marketplace): marketplace is IMarketplace => !!marketplace);
	}

	async installPlugin(plugin: IMarketplacePlugin, token: CancellationToken): Promise<URI> {
		const home = await this.customize.userHome();
		if (!home) {
			throw new Error(localize('voltMarketplace.noHome', "Volt could not find your home folder."));
		}
		const target = joinPath(home, '.volt', 'plugins', safeItemName(plugin.name) || 'plugin');
		const source = plugin.source;
		if (source.kind === 'path') {
			const marketplace = (await this.listMarketplaces()).find(candidate => candidate.name === plugin.marketplace);
			if (!marketplace) {
				throw new Error(localize('voltMarketplace.missingMarketplace', "The {0} marketplace is not on this computer.", plugin.marketplace));
			}
			const from = joinPath(marketplace.root, source.path.replace(/^\.\//, ''));
			if (!(await this.fileService.exists(from))) {
				throw new Error(localize('voltMarketplace.missingPlugin', "{0} is listed but its folder is missing from the marketplace.", plugin.name));
			}
			await this.fileService.copy(from, target, true);
		} else if (source.kind === 'github') {
			const ref = source.ref ?? 'HEAD';
			const tree = await this.repoTree(source.repo, ref, token);
			if (!tree) {
				throw new Error(localize('voltMarketplace.repoUnavailable', "Couldn't read {0} on GitHub.", source.repo));
			}
			const prefix = source.path ? `${source.path.replace(/^\.?\/+|\/+$/g, '')}/` : '';
			const files = tree.tree
				.filter(entry => entry.type === 'blob' && (!prefix || entry.path.startsWith(prefix)) && !entry.path.split('/').includes('.git'))
				.map(entry => ({ path: entry.path, relative: prefix ? entry.path.slice(prefix.length) : entry.path, size: entry.size }));
			await this.downloadFiles(source.repo, ref, files, target, token);
		} else {
			throw new Error(localize('voltMarketplace.unsupportedSource', "Volt can't install plugins from {0} sources yet.", source.label));
		}
		void this.customize.refresh();
		this._onDidChange.fire();
		return target;
	}

	async uninstallPlugin(name: string): Promise<void> {
		const home = await this.customize.userHome();
		if (!home) {
			return;
		}
		const target = joinPath(home, '.volt', 'plugins', safeItemName(name));
		if (await this.fileService.exists(target)) {
			await this.fileService.del(target, { recursive: true, useTrash: true });
		}
		void this.customize.refresh();
		this._onDidChange.fire();
	}

	async addMarketplaceFromGitHub(repository: string, token: CancellationToken): Promise<IMarketplace> {
		const repo = githubRepoOf(repository);
		if (!repo) {
			throw new Error(localize('voltMarketplace.badRepo', "Enter a GitHub repository as owner/repo or its URL."));
		}
		const home = await this.requireHome();
		const text = await this.rawText(repo, 'HEAD', '.claude-plugin/marketplace.json', token);
		let json: { name?: unknown };
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error(localize('voltMarketplace.noManifest', "{0} has no .claude-plugin/marketplace.json.", repo));
		}
		const name = safeItemName(typeof json.name === 'string' ? json.name : repo.split('/')[1]);
		const root = joinPath(home, '.volt', 'marketplaces', name);
		await this.fileService.writeFile(joinPath(root, '.claude-plugin', 'marketplace.json'), VSBuffer.fromString(text));
		// Plugins listed by relative path live in the same repository: download those folders too.
		const tree = await this.repoTree(repo, 'HEAD', token).catch(() => undefined);
		const relative = (JSON.parse(text).plugins as unknown[] | undefined ?? [])
			.map(plugin => (plugin as { source?: unknown }).source)
			.filter((source): source is string => typeof source === 'string')
			.map(source => source.replace(/^\.?\/+|\/+$/g, ''));
		if (tree && relative.length) {
			const files = tree.tree
				.filter(entry => entry.type === 'blob' && relative.some(path => entry.path.startsWith(`${path}/`)))
				.map(entry => ({ path: entry.path, relative: entry.path, size: entry.size }));
			await this.downloadFiles(repo, 'HEAD', files, root, token).catch(err => this.logService.warn('[volt-marketplace] plugin folders not downloaded', err));
		}
		await this.saveRecord(home, { name, source: { kind: 'github', repo }, addedAt: Date.now() });
		return this.requireMarketplace(name);
	}

	async addMarketplaceFromDisk(folder: URI): Promise<IMarketplace> {
		const home = await this.requireHome();
		const json = await readJsonFile(this.fileService, joinPath(folder, '.claude-plugin', 'marketplace.json')) as { name?: unknown } | undefined;
		if (!json) {
			throw new Error(localize('voltMarketplace.noLocalManifest', "{0} has no .claude-plugin/marketplace.json.", basename(folder)));
		}
		const name = safeItemName(typeof json.name === 'string' ? json.name : basename(folder));
		await this.saveRecord(home, { name, source: { kind: 'local', path: folder.fsPath }, addedAt: Date.now() });
		return this.requireMarketplace(name);
	}

	async createMarketplace(folder: URI, name: string): Promise<URI> {
		const home = await this.requireHome();
		const safe = safeItemName(name) || 'team-marketplace';
		const manifest = joinPath(folder, '.claude-plugin', 'marketplace.json');
		if (!(await this.fileService.exists(manifest))) {
			const content = {
				name: safe,
				owner: { name: '' },
				metadata: { description: '' },
				plugins: [],
			};
			await this.fileService.writeFile(manifest, VSBuffer.fromString(`${JSON.stringify(content, undefined, '\t')}\n`));
		}
		await this.saveRecord(home, { name: safe, source: { kind: 'local', path: folder.fsPath }, addedAt: Date.now() });
		return manifest;
	}

	async removeMarketplace(name: string): Promise<void> {
		const home = await this.requireHome();
		const records = (await this.voltRecords(home)).filter(record => record.name !== name);
		await this.fileService.writeFile(joinPath(home, '.volt', 'marketplaces.json'), VSBuffer.fromString(`${JSON.stringify(records, undefined, '\t')}\n`));
		const copy = joinPath(home, '.volt', 'marketplaces', name);
		if (await this.fileService.exists(copy)) {
			await this.fileService.del(copy, { recursive: true, useTrash: true });
		}
		this._onDidChange.fire();
	}

	private async requireMarketplace(name: string): Promise<IMarketplace> {
		const marketplace = (await this.listMarketplaces()).find(candidate => candidate.name === name);
		if (!marketplace) {
			throw new Error(localize('voltMarketplace.notRead', "The marketplace was saved but could not be read."));
		}
		this._onDidChange.fire();
		return marketplace;
	}

	private async requireHome(): Promise<URI> {
		const home = await this.customize.userHome();
		if (!home) {
			throw new Error(localize('voltMarketplace.noHome', "Volt could not find your home folder."));
		}
		return home;
	}

	private async voltRecords(home: URI): Promise<IVoltMarketplaceRecord[]> {
		const json = await readJsonFile(this.fileService, joinPath(home, '.volt', 'marketplaces.json'));
		return Array.isArray(json) ? json.filter((record): record is IVoltMarketplaceRecord => !!record && typeof (record as IVoltMarketplaceRecord).name === 'string' && !!(record as IVoltMarketplaceRecord).source) : [];
	}

	private async saveRecord(home: URI, record: IVoltMarketplaceRecord): Promise<void> {
		const records = (await this.voltRecords(home)).filter(existing => existing.name !== record.name);
		records.push(record);
		await this.fileService.writeFile(joinPath(home, '.volt', 'marketplaces.json'), VSBuffer.fromString(`${JSON.stringify(records, undefined, '\t')}\n`));
	}

	//#endregion

	//#region GitHub

	private repoTree(repo: string, ref: string, token: CancellationToken): Promise<IGitTree | undefined> {
		const key = `${repo}@${ref}`;
		let pending = this.trees.get(key);
		if (!pending) {
			pending = this.githubHeaders()
				.then(headers => this.fetchJson<IGitTree>(`${GITHUB_API}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, headers, token))
				.catch(err => {
					this.logService.info('[volt-marketplace] tree unavailable', repo, err);
					return undefined;
				});
			pending.then(tree => { if (!tree) { this.trees.delete(key); } });
			this.trees.set(key, pending);
		}
		return pending;
	}

	private async rawText(repo: string, ref: string, path: string, token: CancellationToken): Promise<string> {
		const context = await this.requestService.request({ type: 'GET', url: `${GITHUB_RAW}/${repo}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`, headers: { 'User-Agent': 'Volt' } }, token);
		const status = context.res.statusCode ?? 0;
		if (status < 200 || status >= 300) {
			throw new Error(`GitHub returned ${status} for ${path}`);
		}
		return (await asText(context)) ?? '';
	}

	private async downloadFiles(repo: string, ref: string, files: readonly { path: string; relative: string; size?: number }[], target: URI, token: CancellationToken): Promise<void> {
		if (!files.length) {
			throw new Error(localize('voltMarketplace.nothingToDownload', "Nothing to download from {0}.", repo));
		}
		if (files.length > MAX_DOWNLOAD_FILES) {
			throw new Error(localize('voltMarketplace.tooManyFiles', "{0} has {1} files, more than Volt downloads at once ({2}).", repo, files.length, MAX_DOWNLOAD_FILES));
		}
		const total = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
		if (total > MAX_DOWNLOAD_BYTES) {
			throw new Error(localize('voltMarketplace.tooLarge', "{0} is too large to download ({1} MB).", repo, Math.round(total / 1024 / 1024)));
		}
		// Fetch everything before writing, so a failed download leaves no half-installed folder.
		const contents: { relative: string; bytes: VSBuffer }[] = [];
		const queue = [...files];
		const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
			while (queue.length) {
				if (token.isCancellationRequested) {
					throw new Error('Cancelled');
				}
				const file = queue.shift()!;
				if ((file.size ?? 0) > MAX_FILE_BYTES || file.relative.split('/').some(part => part === '..' || !part)) {
					continue;
				}
				const context = await this.requestService.request({ type: 'GET', url: `${GITHUB_RAW}/${repo}/${ref}/${file.path.split('/').map(encodeURIComponent).join('/')}`, headers: { 'User-Agent': 'Volt' } }, token);
				const status = context.res.statusCode ?? 0;
				if (status < 200 || status >= 300) {
					throw new Error(`GitHub returned ${status} for ${file.path}`);
				}
				contents.push({ relative: file.relative, bytes: await streamToBuffer(context.stream) });
			}
		});
		await Promise.all(workers);
		for (const content of contents) {
			await this.fileService.writeFile(joinPath(target, ...content.relative.split('/')), content.bytes);
		}
	}

	private async githubHeaders(): Promise<Record<string, string>> {
		const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Volt' };
		try {
			const sessions = await this.authenticationService.getSessions('github', ['repo'], undefined, true);
			if (sessions[0]) {
				headers.Authorization = `token ${sessions[0].accessToken}`;
			}
		} catch {
			// Signed out: anonymous requests have a smaller hourly quota but work for public repositories.
		}
		return headers;
	}

	private async fetchJson<T>(url: string, headers: Record<string, string>, token: CancellationToken): Promise<T | undefined> {
		const context = await this.requestService.request({ type: 'GET', url, headers: { 'User-Agent': 'Volt', ...headers } }, token);
		const status = context.res.statusCode ?? 0;
		if (status < 200 || status >= 300) {
			let message = '';
			try {
				message = String(JSON.parse(await asText(context) ?? '')?.message ?? '');
			} catch {
				// Not JSON.
			}
			throw new Error(message ? `${message} (${status})` : `Request failed (${status})`);
		}
		return (await asJson<T>(context)) ?? undefined;
	}

	//#endregion
}

function folderName(path: string): string {
	const parts = path.split('/');
	return parts.length > 1 ? parts[parts.length - 2] : '';
}

function toSkill(raw: unknown): ISkillsShSkill | undefined {
	const skill = raw as { id?: unknown; source?: unknown; skillId?: unknown; name?: unknown; installs?: unknown };
	if (typeof skill?.id !== 'string' || typeof skill.source !== 'string') {
		return undefined;
	}
	const skillId = typeof skill.skillId === 'string' ? skill.skillId : skill.id.split('/').pop() ?? skill.id;
	return {
		id: skill.id,
		source: skill.source,
		skillId,
		name: typeof skill.name === 'string' ? skill.name : skillId,
		installs: typeof skill.installs === 'number' ? skill.installs : 0,
	};
}

/** "17033" → "17K", for install counts. */
export function formatInstalls(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
	}
	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`;
	}
	return String(count);
}
