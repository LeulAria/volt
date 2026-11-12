/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { basename, isEqual, isEqualOrParent, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../path/common/pathService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IVoltPluginAvailability, IVoltPluginFolders, MEMORY_PLUGIN_ID, PLUGIN_SANDBOXED_HOSTS_SETTING, PLUGIN_UNSANDBOXED_FALLBACK_SETTING, readUnsandboxedFallback } from '../../../../../platform/voltPlugins/common/pluginHosts.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltHostToolCall, IVoltHostToolResult, IVoltHostToolService } from '../../common/hostTools.js';
import { IVoltSessionContextService } from '../../common/sessionContext.js';
import { importedMemoryDraft, IVoltMemory, IVoltMemoryDraft, IVoltMemoryService, memoryFileName, memorySlug, MEMORY_TYPES, parseMemoryFile, renderMemoryContext, renderMemoryForTool, renderMemoryIndex, serializeMemory, serializeSkill, skillSlug, validateMemoryDraft, VOLT_MEMORY_TOOLS, VoltMemoryImport, VoltMemoryScope, VoltMemoryType } from '../../common/memory/voltMemory.js';

const MAX_NOTE_BYTES = 64 * 1024;
const MAX_NOTES_PER_SCOPE = 500;
/**
 * Notes are read once and kept until a write or delete here, or a file change under their folder.
 * The age limit only catches edits made outside Volt to the user folder, which nothing watches.
 */
const NOTES_TTL_MS = 60_000;

/**
 * Where Memory's agent-facing half runs (spec F.13, roadmap P1's dual binding):
 * - `sandboxed`: the T2 plugin (`memoryPlugin.ts`) in a sandboxed plugin host of the execution host
 *   (the main process for this window, the agent server for web and phone);
 * - `inProcess`: this service, as before, labelled with why: the rollback setting, the degraded
 *   mode the user allowed on an OS that can't sandbox, or no execution host at all (a browser);
 * - `refused`: the host can't run here and nothing else may (degraded mode not allowed, the
 *   supervisor off): the tools say so; nothing runs unsandboxed instead.
 *
 * The user's own actions (the Memory page, imports) and core's (the experience reflector, the
 * extension API) stay in this service either way: they are the user and core, not the plugin.
 */
export type VoltMemoryBinding =
	| { readonly kind: 'sandboxed' }
	| { readonly kind: 'inProcess'; readonly label: 'setting' | 'os-unsupported' | 'no-host' }
	| { readonly kind: 'refused'; readonly reason: string };

/** The binding for these facts. Pure: the dual binding's decision table. */
export function memoryBinding(sandboxedHostsSetting: unknown, fallbackSetting: unknown, availability: IVoltPluginAvailability | undefined): VoltMemoryBinding {
	if (sandboxedHostsSetting === false) {
		return { kind: 'inProcess', label: 'setting' };
	}
	if (!availability) {
		return { kind: 'inProcess', label: 'no-host' };
	}
	if (availability.sandboxed) {
		return { kind: 'sandboxed' };
	}
	if (availability.unsupported !== undefined) {
		// Degraded mode (D-06): only for a static fact of this machine, and only when the user allowed it.
		const fallback = readUnsandboxedFallback(fallbackSetting);
		if (fallback === 'allow') {
			return { kind: 'inProcess', label: 'os-unsupported' };
		}
		return {
			kind: 'refused', reason: fallback === 'deny'
				? `Memory is off: Volt can't sandbox its own plugins on this system (${availability.unsupported}), and running them unsandboxed is turned off (${PLUGIN_UNSANDBOXED_FALLBACK_SETTING}).`
				: `Memory is waiting for a choice: Volt can't sandbox its own plugins on this system (${availability.unsupported}). Allow running them without a sandbox, as before, with the setting ${PLUGIN_UNSANDBOXED_FALLBACK_SETTING}.`
		};
	}
	return { kind: 'refused', reason: `Memory can't start its sandboxed host: ${availability.refused ?? 'the plugin host is unavailable'}` };
}

const MUTATING_TOOLS = new Set(['memory_write', 'memory_delete', 'skill_write']);

interface INote {
	readonly memory: IVoltMemory;
	readonly uri: URI;
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function scopeArg(value: unknown): VoltMemoryScope | 'all' | undefined {
	return value === 'user' || value === 'project' || value === 'all' ? value : undefined;
}

function typeArg(value: unknown): VoltMemoryType | undefined {
	return (MEMORY_TYPES as readonly string[]).includes(text(value)) ? value as VoltMemoryType : undefined;
}

/**
 * Notes kept across chats and providers. The user's notes live in Volt's user data (shared by
 * every project); project notes live in `.volt/memory/` of the open folder, and are plain files the
 * user can commit or leave out. Both are read as markdown with frontmatter.
 */
export class VoltMemoryService extends Disposable implements IVoltMemoryService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly userDir: URI;
	/** Notes per scope, read once per change instead of on every turn. */
	private readonly cache = new Map<VoltMemoryScope, { readonly dir: URI; readonly at: number; readonly value: Promise<INote[]> }>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@ILogService private readonly logService: ILogService,
		@IPathService private readonly pathService: IPathService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.userDir = joinPath(environmentService.userRoamingDataHome, 'voltMemory');
		// The tool list is complete before anything starts (H.2); the plugin's host starts on the first call.
		this._register(hostTools.registerToolProvider({
			tools: VOLT_MEMORY_TOOLS,
			invoke: (name, args, call) => this.routeTool(name, args, call),
		}));
		this._register(fileService.onDidFilesChange(e => {
			for (const [scope, entry] of [...this.cache]) {
				if (e.affects(entry.dir)) {
					this.cache.delete(scope);
				}
			}
		}));
		this._register(fileService.onDidRunOperation(e => {
			for (const [scope, entry] of [...this.cache]) {
				if (isEqualOrParent(e.resource, entry.dir) || (e.target && isEqualOrParent(e.target.resource, entry.dir))) {
					this.cache.delete(scope);
				}
			}
		}));
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.cache.delete('project')));
	}

	async list(scope: VoltMemoryScope | 'all' = 'all'): Promise<readonly IVoltMemory[]> {
		return (await this.notes(scope)).map(note => note.memory);
	}

	async read(name: string, scope?: VoltMemoryScope): Promise<IVoltMemory | undefined> {
		return (await this.find(name, scope))?.memory;
	}

	async write(draft: IVoltMemoryDraft): Promise<IVoltMemory> {
		const result = validateMemoryDraft(draft);
		if (!result.ok) {
			throw new Error(result.error);
		}
		const { memory } = result;
		const dir = this.dirFor(memory.scope);
		if (!dir) {
			throw new Error('Open a folder to save project notes, or save to the user scope.');
		}
		await this.fileService.writeFile(joinPath(dir, memoryFileName(memory.name)), VSBuffer.fromString(serializeMemory(memory)));
		this.cache.clear();
		this._onDidChange.fire();
		return memory;
	}

	async importFile(resource: URI, scope: VoltMemoryScope): Promise<VoltMemoryImport> {
		const content = await this.fileService.readFile(resource, { limits: { size: MAX_NOTE_BYTES } });
		const draft = importedMemoryDraft(content.value.toString(), basename(resource));
		if (!draft) {
			return 'empty';
		}
		if (await this.read(draft.name, scope)) {
			return 'exists';
		}
		await this.write({ ...draft, scope });
		return 'imported';
	}

	async delete(name: string, scope?: VoltMemoryScope): Promise<boolean> {
		const note = await this.find(name, scope);
		if (!note) {
			return false;
		}
		await this.fileService.del(note.uri);
		this.cache.clear();
		this._onDidChange.fire();
		return true;
	}

	async context(): Promise<string | undefined> {
		const binding = await this.binding();
		if (binding.kind === 'sandboxed') {
			return this.stdio.pluginContext!(MEMORY_PLUGIN_ID, this.folders(undefined));
		}
		if (binding.kind === 'refused') {
			this.logService.warn(`[volt-memory] ${binding.reason}`);
			return undefined;
		}
		return renderMemoryContext(await this.list('all'));
	}

	private availability: Promise<IVoltPluginAvailability | undefined> | undefined;

	/** Decided per call from the settings, over this machine's static facts (read once). */
	async binding(): Promise<VoltMemoryBinding> {
		if (this.configurationService.getValue(PLUGIN_SANDBOXED_HOSTS_SETTING) === false) {
			return { kind: 'inProcess', label: 'setting' };
		}
		this.availability ??= this.stdio.pluginAvailability
			? this.stdio.pluginAvailability().catch(err => ({ sandboxed: false, refused: err instanceof Error ? err.message : String(err) }))
			: Promise.resolve(undefined);
		return memoryBinding(true, this.configurationService.getValue(PLUGIN_UNSANDBOXED_FALLBACK_SETTING), await this.availability);
	}

	/** Core's record of the call's folders: the window's first folder, and the chat's own (its cwd, else its session's root). */
	private folders(call: IVoltHostToolCall | undefined): IVoltPluginFolders {
		const first = this.workspace.getWorkspace().folders[0]?.uri;
		const workspace = first?.scheme === 'file' ? first.fsPath : undefined;
		const session = call?.sessionId ? this.sessionContext.rootFor(call.sessionId) : undefined;
		const project = call?.cwd ?? (session?.scheme === 'file' ? session.fsPath : undefined) ?? workspace;
		return { ...(workspace ? { workspace } : {}), ...(project ? { project } : {}) };
	}

	private async routeTool(name: string, args: Record<string, unknown>, call?: IVoltHostToolCall): Promise<IVoltHostToolResult> {
		const binding = await this.binding();
		if (binding.kind === 'refused') {
			return { error: binding.reason };
		}
		if (binding.kind === 'inProcess') {
			return this.invokeTool(name, args, call);
		}
		const result = await this.stdio.invokePluginTool!({ plugin: MEMORY_PLUGIN_ID, tool: name, args, folders: this.folders(call) });
		if (result.error === undefined && MUTATING_TOOLS.has(name)) {
			// The plugin changed notes outside this process: the lists here read them again.
			this.cache.clear();
			this._onDidChange.fire();
		}
		return result.error !== undefined ? { error: result.error } : { text: result.text ?? '' };
	}

	private dirFor(scope: VoltMemoryScope): URI | undefined {
		if (scope === 'user') {
			return this.userDir;
		}
		const folder = this.workspace.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, '.volt', 'memory') : undefined;
	}

	private async notes(scope: VoltMemoryScope | 'all'): Promise<INote[]> {
		const scopes: VoltMemoryScope[] = scope === 'all' ? ['project', 'user'] : [scope];
		return (await Promise.all(scopes.map(one => this.scopeNotes(one)))).flat();
	}

	/** Project notes first, so a project note overrides a user note with the same name. */
	private async find(name: string, scope?: VoltMemoryScope): Promise<INote | undefined> {
		const key = memorySlug(name);
		return (await this.notes(scope ?? 'all')).find(note => memorySlug(note.memory.name) === key);
	}

	private scopeNotes(scope: VoltMemoryScope): Promise<INote[]> {
		const dir = this.dirFor(scope);
		if (!dir) {
			return Promise.resolve([]);
		}
		const cached = this.cache.get(scope);
		if (cached && isEqual(cached.dir, dir) && Date.now() - cached.at < NOTES_TTL_MS) {
			return cached.value;
		}
		const value = this.readNotes(scope, dir);
		this.cache.set(scope, { dir, at: Date.now(), value });
		return value;
	}

	private async readNotes(scope: VoltMemoryScope, dir: URI): Promise<INote[]> {
		let children;
		try {
			children = (await this.fileService.resolve(dir)).children ?? [];
		} catch {
			return [];
		}
		const files = children.filter(child => !child.isDirectory && /\.md$/i.test(child.name)).slice(0, MAX_NOTES_PER_SCOPE);
		const notes = await Promise.all(files.map(async (file): Promise<INote | undefined> => {
			try {
				const body = await this.fileService.readFile(file.resource, { limits: { size: MAX_NOTE_BYTES } });
				const memory = parseMemoryFile(body.value.toString(), scope, file.name);
				return memory ? { memory: { ...memory, resource: file.resource }, uri: file.resource } : undefined;
			} catch (err) {
				this.logService.warn(`[volt-memory] could not read ${file.resource.toString()}`, err);
				return undefined;
			}
		}));
		return notes.filter((note): note is INote => !!note);
	}

	/**
	 * Writes `<scope root>/.volt/skills/<name>/SKILL.md`: personal skills under the home folder,
	 * project ones in the chat's folder (its worktree, else its project). Skills are listed in every
	 * later chat by description and loaded on demand, so a procedure learned once is reused.
	 */
	private async writeSkill(args: Record<string, unknown>, call: IVoltHostToolCall | undefined): Promise<IVoltHostToolResult> {
		const name = skillSlug(text(args.name));
		const description = text(args.description).trim();
		const body = text(args.body).trim();
		if (!name || description.length < 12 || body.length < 40) {
			return { error: 'Pass a `name`, a `description` that says when to use the skill, and the procedure as `body`.' };
		}
		const project = args.scope === 'project';
		const root = project
			? (call?.cwd ? URI.file(call.cwd) : undefined) ?? (call?.sessionId ? this.sessionContext.rootFor(call.sessionId) : undefined) ?? this.workspace.getWorkspace().folders[0]?.uri
			: await this.pathService.userHome();
		if (!root) {
			return { error: 'No project folder for this chat: save it with scope "user".' };
		}
		const file = joinPath(root, '.volt', 'skills', name, 'SKILL.md');
		const existed = await this.fileService.exists(file);
		await this.fileService.writeFile(file, VSBuffer.fromString(serializeSkill(name, description, body)));
		return { text: `${existed ? 'Updated' : 'Saved'} skill "${name}" (${project ? 'this project' : 'personal'}): ${file.fsPath}. Chats that start from now on list it and load it when a task matches.` };
	}

	private async invokeTool(name: string, args: Record<string, unknown>, call?: IVoltHostToolCall): Promise<IVoltHostToolResult> {
		const noteName = text(args.name).trim();
		const scope = scopeArg(args.scope);
		const onlyScope = scope === 'all' ? undefined : scope;
		try {
			switch (name) {
				case 'memory_list': {
					const memories = await this.list(scope ?? 'all');
					return { text: memories.length ? [`${memories.length} saved notes:`, ...renderMemoryIndex(memories)].join('\n') : 'No notes are saved yet.' };
				}
				case 'memory_read': {
					if (!noteName) {
						return { error: 'Pass the note `name`, as listed by memory_list.' };
					}
					const memory = await this.read(noteName, onlyScope);
					return memory ? { text: renderMemoryForTool(memory) } : { error: `No saved memory named "${noteName}".` };
				}
				case 'memory_write': {
					const memory = await this.write({
						name: noteName,
						description: text(args.description),
						body: text(args.body),
						type: typeArg(args.type),
						scope: scope === 'project' ? 'project' : 'user',
					});
					return { text: `Saved "${memory.name}" to the ${memory.scope} notes. It is in the index of chats that start from now on.` };
				}
				case 'skill_write':
					return await this.writeSkill(args, call);
				case 'memory_delete': {
					if (!noteName) {
						return { error: 'Pass the note `name`, as listed by memory_list.' };
					}
					const deleted = await this.delete(noteName, onlyScope);
					return deleted ? { text: `Deleted "${noteName}".` } : { error: `No saved memory named "${noteName}".` };
				}
				default:
					return { error: `Unknown tool ${name}` };
			}
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}
}

registerSingleton(IVoltMemoryService, VoltMemoryService, InstantiationType.Eager);
