/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IVoltProfile } from '../../../../services/voltRuntime/common/profiler/profile.js';
import { diffProfiles, findFrames, IProfileDiff, ITimeRange } from '../../../../services/voltRuntime/common/profiler/profileAnalysis.js';
import { IVoltProfileFile, parseProfile } from '../../../../services/voltRuntime/common/profiler/profileFormats.js';
import { openInAgentTools } from '../workspace/agentSurfaceHost.js';
import { VoltProfilerInput } from './profilerInput.js';

/** Adds `{ label, value, chatId? }` as a context chip to the chat on screen (the profile's own chat first). */
export const ADD_PROFILE_TO_CHAT_COMMAND_ID = 'volt.profiler.addToChat';
/** Opens a profile file in the Profiler: `(uri?, compareWith?)`; without a URI, the active editor's file. */
export const OPEN_PROFILER_COMMAND_ID = 'volt.profiler.open';

/** What the Profiler tab shows: a timeline chart, the aggregated flame graph, the heat map, the table, counters, or a diff. */
export type ProfilerView = 'chart' | 'graph' | 'heatmap' | 'table' | 'counters' | 'diff';
export type ProfilerColorMode = 'category' | 'heat';

export interface IProfilerViewState {
	readonly view: ProfilerView;
	readonly color: ProfilerColorMode;
	/** The time window on screen (chart, heat map, counters); undefined: all of it. */
	readonly range?: ITimeRange;
	/** The flame graph zoomed into this node (0: the whole tree). */
	readonly focusNode: number;
	readonly selectedFrame?: number;
	readonly search: string;
	/** Who changed it last: the user's own clicks, or the agent's `profile focus`. */
	readonly by: 'user' | 'agent';
}

/** A note pinned on a function or a stretch of time: how an agent points the user at a finding. */
export interface IProfileNote {
	readonly id: number;
	readonly text: string;
	readonly frame?: number;
	readonly range?: ITimeRange;
	readonly by: 'user' | 'agent';
	readonly at: number;
}

export interface ILoadedProfile {
	/** Short and quotable: `p3`. */
	readonly id: string;
	readonly file: URI;
	readonly profile: IVoltProfile;
	/** The run before, when comparing. */
	readonly base?: { readonly file: URI; readonly profile: IVoltProfile; readonly diff: IProfileDiff };
	readonly chatId?: string;
	/** The workspace folder, for paths. */
	readonly root?: string;
	readonly loadedAt: number;
	readonly state: IProfilerViewState;
	readonly notes: readonly IProfileNote[];
}

export interface IProfileLoadOptions {
	readonly chatId?: string;
	readonly compareWith?: URI;
	readonly root?: string;
}

export const IVoltProfilerService = createDecorator<IVoltProfilerService>('voltProfilerService');

export interface IVoltProfilerService {
	readonly _serviceBrand: undefined;
	/** A profile's state or notes changed (its id). */
	readonly onDidChange: Event<string>;
	/** Reads and parses a profile file (cached per file and comparison). Throws when it is not a profile. */
	load(file: URI, options?: IProfileLoadOptions): Promise<ILoadedProfile>;
	get(id: string): ILoadedProfile | undefined;
	/** By id (`p3`) or file path; a chat's newest when nothing is named. */
	find(ref: string | undefined, chatId?: string): ILoadedProfile | undefined;
	list(chatId?: string): readonly ILoadedProfile[];
	update(id: string, patch: Partial<Omit<IProfilerViewState, 'by'>>, by: 'user' | 'agent'): void;
	addNote(id: string, note: Omit<IProfileNote, 'id' | 'at'>): IProfileNote | undefined;
	clearNotes(id: string, by?: 'user' | 'agent'): void;
	/** Opens the profile's tab: beside its chat when there is one on screen, else in the editor. */
	reveal(id: string, options?: { readonly background?: boolean }): Promise<void>;
	/** Where Volt keeps profiles it records (one folder per recording). */
	readonly profilesHome: URI;
	/** Writes data an agent made (`profile show`) as a Volt profile file and loads it. */
	saveCustom(data: IVoltProfileFile, options?: IProfileLoadOptions): Promise<ILoadedProfile>;
}

/** Profiles kept parsed; older ones are read again from their file when reopened. */
const MAX_LOADED = 24;

export class VoltProfilerService extends Disposable implements IVoltProfilerService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private readonly loaded = new Map<string, ILoadedProfile>();
	private readonly byKey = new Map<string, string>();
	private counter = 0;
	readonly profilesHome: URI;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IEnvironmentService environmentService: IEnvironmentService,
	) {
		super();
		this.profilesHome = joinPath(environmentService.cacheHome, 'volt-profiles');
	}

	async load(file: URI, options: IProfileLoadOptions = {}): Promise<ILoadedProfile> {
		const key = `${file.toString()}\u0000${options.compareWith?.toString() ?? ''}`;
		const known = this.byKey.get(key);
		const stat = await this.fileService.stat(file);
		const cached = known ? this.loaded.get(known) : undefined;
		// The same file, unchanged: keep its view and notes. Rewritten: read it again.
		if (cached && cached.loadedAt >= stat.mtime) {
			if (options.chatId && !cached.chatId) {
				this.set({ ...cached, chatId: options.chatId });
			}
			return this.loaded.get(cached.id)!;
		}
		const profile = await this.read(file);
		const base = options.compareWith ? await this.read(options.compareWith) : undefined;
		const id = cached?.id ?? `p${++this.counter}`;
		const loaded: ILoadedProfile = {
			id,
			file,
			profile,
			...(base && options.compareWith ? { base: { file: options.compareWith, profile: base, diff: diffProfiles(base, profile) } } : {}),
			...(options.chatId ?? cached?.chatId ? { chatId: options.chatId ?? cached?.chatId } : {}),
			...(options.root ? { root: options.root } : {}),
			loadedAt: Date.now(),
			state: cached?.state ?? { view: defaultView(profile, !!base), color: 'category', focusNode: 0, search: '', by: 'user' },
			notes: cached?.notes ?? [],
		};
		this.byKey.set(key, id);
		this.set(loaded);
		this.trim();
		return loaded;
	}

	private async read(file: URI): Promise<IVoltProfile> {
		const content = await this.fileService.readFile(file);
		return parseProfile(content.value.toString(), file.path);
	}

	private set(loaded: ILoadedProfile): void {
		this.loaded.delete(loaded.id);
		this.loaded.set(loaded.id, loaded);
		this._onDidChange.fire(loaded.id);
	}

	private trim(): void {
		while (this.loaded.size > MAX_LOADED) {
			const oldest = this.loaded.keys().next().value!;
			this.loaded.delete(oldest);
			for (const [key, id] of this.byKey) {
				if (id === oldest) {
					this.byKey.delete(key);
				}
			}
		}
	}

	get(id: string): ILoadedProfile | undefined {
		return this.loaded.get(id);
	}

	find(ref: string | undefined, chatId?: string): ILoadedProfile | undefined {
		if (ref) {
			const byId = this.loaded.get(ref.trim());
			if (byId) {
				return byId;
			}
			const path = ref.trim().replace(/^file:\/\//, '');
			return [...this.loaded.values()].reverse().find(loaded => loaded.file.fsPath === path || loaded.file.path === path || loaded.file.path.endsWith(`/${path}`));
		}
		return [...this.list(chatId)][0];
	}

	list(chatId?: string): readonly ILoadedProfile[] {
		return [...this.loaded.values()].filter(loaded => !chatId || loaded.chatId === chatId).reverse();
	}

	update(id: string, patch: Partial<Omit<IProfilerViewState, 'by'>>, by: 'user' | 'agent'): void {
		const loaded = this.loaded.get(id);
		if (!loaded) {
			return;
		}
		const state = { ...loaded.state, ...patch, by };
		if ('range' in patch && !patch.range) {
			delete (state as { range?: ITimeRange }).range;
		}
		this.loaded.set(id, { ...loaded, state });
		this._onDidChange.fire(id);
	}

	addNote(id: string, note: Omit<IProfileNote, 'id' | 'at'>): IProfileNote | undefined {
		const loaded = this.loaded.get(id);
		if (!loaded) {
			return undefined;
		}
		const added: IProfileNote = { ...note, id: (loaded.notes.at(-1)?.id ?? 0) + 1, at: Date.now() };
		this.loaded.set(id, { ...loaded, notes: [...loaded.notes, added] });
		this._onDidChange.fire(id);
		return added;
	}

	clearNotes(id: string, by?: 'user' | 'agent'): void {
		const loaded = this.loaded.get(id);
		if (loaded) {
			this.loaded.set(id, { ...loaded, notes: by ? loaded.notes.filter(note => note.by !== by) : [] });
			this._onDidChange.fire(id);
		}
	}

	async reveal(id: string, options?: { readonly background?: boolean }): Promise<void> {
		const loaded = this.loaded.get(id);
		if (!loaded) {
			return;
		}
		const input = new VoltProfilerInput(loaded.file, loaded.base?.file, loaded.chatId, loaded.profile.title);
		const existing = this.editorService.editors.find(editor => editor.matches(input));
		const editorOptions: IEditorOptions = { pinned: true, preserveFocus: true, ...(options?.background ? { inactive: true } : {}) };
		if (existing) {
			input.dispose();
			const where = this.editorService.findEditors(existing.resource!)[0];
			await this.editorService.openEditor(existing, editorOptions, where?.groupId);
			return;
		}
		const beside = loaded.chatId ? openInAgentTools(input, loaded.chatId, editorOptions) : undefined;
		if (beside) {
			await beside;
			return;
		}
		await this.editorService.openEditor(input, editorOptions);
	}

	async saveCustom(data: IVoltProfileFile, options: IProfileLoadOptions = {}): Promise<ILoadedProfile> {
		// Parsed first: bad data fails here, with its reason, before anything is written.
		parseProfile(JSON.stringify(data), 'data');
		const file = joinPath(this.profilesHome, 'data', `${(data.title ?? 'data').replace(/[^\w.-]+/g, '-').slice(0, 40)}-${generateUuid().slice(0, 8)}.voltprofile.json`);
		await this.fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(data)));
		return this.load(file, options);
	}
}

/** The view a profile opens in: what its data is best read as. */
export function defaultView(profile: IVoltProfile, comparing: boolean): ProfilerView {
	if (comparing) {
		return 'diff';
	}
	if (profile.timeline?.lanes.length) {
		return 'chart';
	}
	if (profile.nodes[0].total > 0) {
		return 'graph';
	}
	if (profile.counters?.length) {
		return 'counters';
	}
	return 'heatmap';
}

/** The views a profile has data for, in the order the picker lists them. */
export function availableViews(loaded: ILoadedProfile): ProfilerView[] {
	const { profile } = loaded;
	const views: ProfilerView[] = [];
	if (loaded.base) {
		views.push('diff');
	}
	if (profile.timeline?.lanes.length) {
		views.push('chart');
	}
	if (profile.nodes[0].total > 0) {
		views.push('graph');
	}
	if (profile.timeline?.lanes.length || profile.matrix) {
		views.push('heatmap');
	}
	if (profile.nodes[0].total > 0) {
		views.push('table');
	}
	if (profile.counters?.length) {
		views.push('counters');
	}
	return views;
}

/** The frame a name or path points at, the costliest when several match. */
export function frameFor(profile: IVoltProfile, query: string | undefined): number | undefined {
	return query ? findFrames(profile, query)[0] : undefined;
}

registerSingleton(IVoltProfilerService, VoltProfilerService, InstantiationType.Delayed);
