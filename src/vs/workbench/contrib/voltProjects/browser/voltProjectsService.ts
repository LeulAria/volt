/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltProjectRecord, IVoltSessionContextService, projectIdForRoot } from '../../../services/voltRuntime/common/sessionContext.js';
import { AgentEditorInput } from '../../voltAgent/browser/editor/agentEditorInput.js';
import { newAgentChat } from '../../voltAgent/browser/workspace/agentPanels.js';
import { IAgentWorkspaceService } from '../../voltAgent/browser/workspace/agentWorkspace.js';
import { IVoltProject, IVoltProjectsService, VoltProjectSource, VoltProjectState } from '../common/projects.js';

const META_KEY = 'volt.projects.meta.v1';

interface IProjectMeta {
	readonly source: VoltProjectSource;
	readonly remoteUrl?: string;
}

const READY: VoltProjectState = { kind: 'ready' };

export class VoltProjectsService extends Disposable implements IVoltProjectsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly states = new Map<string, VoltProjectState>();
	private meta: Record<string, IProjectMeta>;

	constructor(
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IStorageService private readonly storageService: IStorageService,
		@IAgentWorkspaceService private readonly agentWorkspace: IAgentWorkspaceService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.meta = this.readMeta();
		this._register(this.sessionContext.onDidChangeProjects(() => this._onDidChange.fire()));
	}

	list(): readonly IVoltProject[] {
		return this.sessionContext.projects.map(record => this.toProject(record));
	}

	get(id: string): IVoltProject | undefined {
		const record = this.sessionContext.getProject(id);
		return record && this.toProject(record);
	}

	getByUri(uri: URI): IVoltProject | undefined {
		return this.get(projectIdForRoot(uri));
	}

	add(uri: URI, options?: { readonly name?: string; readonly source?: VoltProjectSource; readonly remoteUrl?: string }): IVoltProject {
		const record = this.sessionContext.registerProject(uri, options?.name);
		if (options?.source && options.source !== 'local' && !this.meta[record.id]) {
			this.meta = { ...this.meta, [record.id]: { source: options.source, remoteUrl: options.remoteUrl } };
			this.storageService.store(META_KEY, JSON.stringify(this.meta), StorageScope.APPLICATION, StorageTarget.USER);
		}
		return this.toProject(record);
	}

	remove(id: string): void {
		this.closeEmptyChats(id);
		this.states.delete(id);
		if (this.meta[id]) {
			const { [id]: _removed, ...rest } = this.meta;
			this.meta = rest;
			this.storageService.store(META_KEY, JSON.stringify(this.meta), StorageScope.APPLICATION, StorageTarget.USER);
		}
		this.sessionContext.unregisterProject(id);
		this._onDidChange.fire();
	}

	setState(id: string, state: VoltProjectState): void {
		if (state.kind === 'ready') {
			this.states.delete(id);
		} else {
			this.states.set(id, state);
		}
		this._onDidChange.fire();
	}

	whenReady(id: string): Promise<boolean> {
		const current = this.states.get(id) ?? READY;
		if (current.kind !== 'cloning') {
			return Promise.resolve(current.kind === 'ready');
		}
		return new Promise(resolve => {
			const listener = this.onDidChange(() => {
				const state = this.states.get(id) ?? READY;
				if (state.kind !== 'cloning') {
					listener.dispose();
					// A cancelled clone removes the project, which also counts as not ready.
					resolve(state.kind === 'ready' && !!this.sessionContext.getProject(id));
				}
			});
		});
	}

	async open(id: string): Promise<void> {
		const record = this.sessionContext.getProject(id);
		if (!record) {
			return;
		}
		await newAgentChat(this.sessionContext, this.agentWorkspace, this.history, this.editorGroupsService, this.instantiationService, record.root, record.displayName);
	}

	/**
	 * New agent tabs opened in this project that never got a message. Left open they would pin
	 * the forgotten folder and bring the project back on the next start.
	 */
	private closeEmptyChats(id: string): void {
		for (const group of this.editorGroupsService.groups) {
			for (const editor of group.editors) {
				if (editor instanceof AgentEditorInput && !editor.messages.length && this.sessionContext.bindingFor(editor.sessionId)?.projectId === id) {
					void group.closeEditor(editor);
					void this.history.delete(editor.sessionId).catch(() => undefined);
				}
			}
		}
	}

	private toProject(record: IVoltProjectRecord): IVoltProject {
		const meta = this.meta[record.id];
		return {
			id: record.id,
			uri: record.root,
			name: record.displayName,
			source: meta?.source ?? 'local',
			remoteUrl: meta?.remoteUrl,
			state: this.states.get(record.id) ?? READY,
		};
	}

	private readMeta(): Record<string, IProjectMeta> {
		try {
			const raw = JSON.parse(this.storageService.get(META_KEY, StorageScope.APPLICATION, '{}'));
			return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
		} catch {
			return {};
		}
	}
}
