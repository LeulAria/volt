/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVoltPluginApi, IVoltPluginCallContext, IVoltPluginFiles, VoltPluginToolResult } from '../../../../../platform/voltPlugins/common/voltPluginApi.js';
import { IVoltMemory, memoryFileName, memorySlug, MEMORY_TYPES, parseMemoryFile, renderMemoryContext, renderMemoryForTool, renderMemoryIndex, serializeMemory, serializeSkill, skillSlug, validateMemoryDraft, VoltMemoryScope, VoltMemoryType } from './voltMemory.js';

/**
 * Memory as a T2 plugin (spec H.11 #13, roadmap P1): the agent-facing half of Memory, run in a
 * sandboxed plugin host. Bundled into one file (`extensions/volt-memory/plugin/memory.js`, by
 * `scripts/volt-bundle-t2-plugins.mjs`) and evaluated in the host's Compartment: it imports only
 * the pure note functions of `voltMemory.ts` and reaches files only through the `volt` API.
 *
 * - User notes are the plugin's own storage (`storage.own`; core keeps it in Volt's user data,
 *   where the in-process service always kept them, so notes carry over).
 * - Project notes are `.volt/memory/` of the open folder, and skills `.volt/skills/<name>/SKILL.md`
 *   of the chat's folder or the home folder: through the files broker, within the manifest's
 *   targets and Memory's first-party ceiling.
 * - The context block (`<volt_memory>`) is the same as the in-process service's; core caps it.
 *
 * Tool results are the in-process service's word for word (`voltMemoryService.ts`): both bindings
 * run the same parity test.
 */

const MAX_NOTE_BYTES = 64 * 1024;
const MAX_NOTES_PER_SCOPE = 500;
const PROJECT_DIR = '.volt/memory';

interface INote {
	readonly memory: IVoltMemory;
	readonly file: string;
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

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

/** The plugin, given the `volt` API the host endows. */
export function activate(volt: IVoltPluginApi): void {

	/** A scope's notes: markdown files, at most 500, none over 64 KB. */
	async function scopeNotes(scope: VoltMemoryScope, files: IVoltPluginFiles): Promise<INote[]> {
		let entries;
		try {
			entries = scope === 'user' ? await volt.storage.list('') : await files.list('workspace', PROJECT_DIR);
		} catch {
			// No open folder (project), or nothing saved yet.
			return [];
		}
		const names = entries.filter(entry => entry.kind === 'file' && /\.md$/i.test(entry.name)).slice(0, MAX_NOTES_PER_SCOPE).map(entry => entry.name);
		const notes = await Promise.all(names.map(async (name): Promise<INote | undefined> => {
			try {
				const body = scope === 'user' ? await volt.storage.read(name) : await files.read('workspace', `${PROJECT_DIR}/${name}`);
				if (body === undefined || byteLength(body) > MAX_NOTE_BYTES) {
					return undefined;
				}
				const memory = parseMemoryFile(body, scope, name);
				return memory ? { memory, file: name } : undefined;
			} catch (err) {
				volt.log.warn(`could not read ${scope} note ${name}: ${err instanceof Error ? err.message : String(err)}`);
				return undefined;
			}
		}));
		return notes.filter((note): note is INote => !!note);
	}

	async function notes(scope: VoltMemoryScope | 'all', files: IVoltPluginFiles): Promise<INote[]> {
		const scopes: VoltMemoryScope[] = scope === 'all' ? ['project', 'user'] : [scope];
		return (await Promise.all(scopes.map(one => scopeNotes(one, files)))).flat();
	}

	/** Project notes first, so a project note overrides a user note with the same name. */
	async function find(name: string, scope: VoltMemoryScope | undefined, files: IVoltPluginFiles): Promise<INote | undefined> {
		const key = memorySlug(name);
		return (await notes(scope ?? 'all', files)).find(note => memorySlug(note.memory.name) === key);
	}

	async function write(args: Readonly<Record<string, unknown>>, files: IVoltPluginFiles): Promise<IVoltMemory> {
		const scope = scopeArg(args.scope);
		const result = validateMemoryDraft({
			name: text(args.name).trim(),
			description: text(args.description),
			body: text(args.body),
			type: typeArg(args.type),
			scope: scope === 'project' ? 'project' : 'user',
		});
		if (!result.ok) {
			throw new Error(result.error);
		}
		const { memory } = result;
		if (memory.scope === 'user') {
			await volt.storage.write(memoryFileName(memory.name), serializeMemory(memory));
		} else {
			try {
				await files.write('workspace', `${PROJECT_DIR}/${memoryFileName(memory.name)}`, serializeMemory(memory));
			} catch (err) {
				throw err instanceof Error && err.name === 'NotFound' ? new Error('Open a folder to save project notes, or save to the user scope.') : err;
			}
		}
		return memory;
	}

	async function remove(note: INote, files: IVoltPluginFiles): Promise<boolean> {
		return note.memory.scope === 'user' ? volt.storage.delete(note.file) : files.delete('workspace', `${PROJECT_DIR}/${note.file}`);
	}

	/** `<scope root>/.volt/skills/<name>/SKILL.md`: personal skills under the home folder, project ones in the chat's folder. */
	async function writeSkill(args: Readonly<Record<string, unknown>>, files: IVoltPluginFiles): Promise<VoltPluginToolResult> {
		const name = skillSlug(text(args.name));
		const description = text(args.description).trim();
		const body = text(args.body).trim();
		if (!name || description.length < 12 || body.length < 40) {
			return { error: 'Pass a `name`, a `description` that says when to use the skill, and the procedure as `body`.' };
		}
		const project = args.scope === 'project';
		let written;
		try {
			written = await files.write(project ? 'project' : 'home', `.volt/skills/${name}/SKILL.md`, serializeSkill(name, description, body));
		} catch (err) {
			if (project && err instanceof Error && err.name === 'NotFound') {
				return { error: 'No project folder for this chat: save it with scope "user".' };
			}
			throw err;
		}
		return { text: `${written.created ? 'Saved' : 'Updated'} skill "${name}" (${project ? 'this project' : 'personal'}): ${written.path ?? `.volt/skills/${name}/SKILL.md`}. Chats that start from now on list it and load it when a task matches.` };
	}

	async function invoke(tool: string, args: Readonly<Record<string, unknown>>, context: IVoltPluginCallContext): Promise<VoltPluginToolResult> {
		const noteName = text(args.name).trim();
		const scope = scopeArg(args.scope);
		const onlyScope = scope === 'all' ? undefined : scope;
		const files = context.files;
		try {
			switch (tool) {
				case 'memory_list': {
					const memories = (await notes(scope ?? 'all', files)).map(note => note.memory);
					return { text: memories.length ? [`${memories.length} saved notes:`, ...renderMemoryIndex(memories)].join('\n') : 'No notes are saved yet.' };
				}
				case 'memory_read': {
					if (!noteName) {
						return { error: 'Pass the note `name`, as listed by memory_list.' };
					}
					const note = await find(noteName, onlyScope, files);
					return note ? { text: renderMemoryForTool(note.memory) } : { error: `No saved memory named "${noteName}".` };
				}
				case 'memory_write': {
					const memory = await write(args, files);
					return { text: `Saved "${memory.name}" to the ${memory.scope} notes. It is in the index of chats that start from now on.` };
				}
				case 'skill_write':
					return await writeSkill(args, files);
				case 'memory_delete': {
					if (!noteName) {
						return { error: 'Pass the note `name`, as listed by memory_list.' };
					}
					const note = await find(noteName, onlyScope, files);
					const deleted = note ? await remove(note, files) : false;
					return deleted ? { text: `Deleted "${noteName}".` } : { error: `No saved memory named "${noteName}".` };
				}
				default:
					return { error: `Unknown tool ${tool}` };
			}
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	for (const tool of ['memory_list', 'memory_read', 'memory_write', 'skill_write', 'memory_delete']) {
		volt.tools.register(tool, (args, context) => invoke(tool, args, context));
	}
	volt.context.register(async context => renderMemoryContext((await notes('all', context.files)).map(note => note.memory)));
}
