/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IVoltHostToolResult, IVoltHostToolService } from '../../common/hostTools.js';
import { IVoltMemory, IVoltMemoryDraft, IVoltMemoryService, memoryFileName, memorySlug, MEMORY_TYPES, parseMemoryFile, renderMemoryContext, renderMemoryForTool, renderMemoryIndex, serializeMemory, validateMemoryDraft, VOLT_MEMORY_TOOLS, VoltMemoryScope, VoltMemoryType } from '../../common/memory/voltMemory.js';

const MAX_NOTE_BYTES = 64 * 1024;
const MAX_NOTES_PER_SCOPE = 500;

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

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IVoltHostToolService hostTools: IVoltHostToolService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.userDir = joinPath(environmentService.userRoamingDataHome, 'voltMemory');
		this._register(hostTools.registerToolProvider({
			tools: VOLT_MEMORY_TOOLS,
			invoke: (name, args) => this.invokeTool(name, args),
		}));
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
		this._onDidChange.fire();
		return memory;
	}

	async delete(name: string, scope?: VoltMemoryScope): Promise<boolean> {
		const note = await this.find(name, scope);
		if (!note) {
			return false;
		}
		await this.fileService.del(note.uri);
		this._onDidChange.fire();
		return true;
	}

	async context(): Promise<string | undefined> {
		return renderMemoryContext(await this.list('all'));
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

	private async scopeNotes(scope: VoltMemoryScope): Promise<INote[]> {
		const dir = this.dirFor(scope);
		if (!dir) {
			return [];
		}
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
				return memory ? { memory, uri: file.resource } : undefined;
			} catch (err) {
				this.logService.warn(`[volt-memory] could not read ${file.resource.toString()}`, err);
				return undefined;
			}
		}));
		return notes.filter((note): note is INote => !!note);
	}

	private async invokeTool(name: string, args: Record<string, unknown>): Promise<IVoltHostToolResult> {
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
