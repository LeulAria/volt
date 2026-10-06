/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isLinux, isWindows } from '../../../../base/common/platform.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { AgentRunOn, agentRunOnStorageKey, normalizeAgentRunOn } from '../../../services/voltRuntime/common/git/agentWorktree.js';
import { IAgentHistoryService } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { setProjectRunEnvResolver } from '../../../services/voltRuntime/common/projectRunEnv.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService, uriFromStoredRoot } from '../../../services/voltRuntime/common/sessionContext.js';
import { AgentEditorInput } from '../../voltAgent/browser/editor/agentEditorInput.js';
import { IVoltProjectSettings, normalizeProjectSettings, PROJECT_SETTINGS_STORAGE_KEY, projectForPath, ProjectSettingsMap, readWorktreeSetup, CURSOR_WORKTREES_FILE, VOLT_WORKTREES_FILE, withProjectSettings, writeWorktreeSetup, IWorktreeSetupRead } from '../common/projectSettings.js';

export const IVoltProjectSettingsService = createDecorator<IVoltProjectSettingsService>('voltProjectSettingsService');

export interface IProjectWorktreeSetup extends IWorktreeSetupRead {
	/** Which file the steps came from; Volt's file wins over Cursor's. */
	readonly source?: typeof VOLT_WORKTREES_FILE | typeof CURSOR_WORKTREES_FILE;
}

export interface IVoltProjectSettingsService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<string>;
	get(projectId: string): IVoltProjectSettings;
	set(projectId: string, settings: IVoltProjectSettings): void;
	/** Where new chats in the project run (shared with the composer's Run on menu). */
	getRunOn(projectId: string): AgentRunOn;
	setRunOn(projectId: string, runOn: AgentRunOn): void;
	readWorktreeSetup(root: URI): Promise<IProjectWorktreeSetup>;
	/** Writes `.volt/worktrees.json` in the project (removes the key, or the file, when empty). */
	writeWorktreeSetup(root: URI, steps: readonly string[]): Promise<void>;
}

export class VoltProjectSettingsService extends Disposable implements IVoltProjectSettingsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private map: ProjectSettingsMap;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
	) {
		super();
		this.map = this.read();
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, PROJECT_SETTINGS_STORAGE_KEY, this._store)(() => {
			this.map = this.read();
			this._onDidChange.fire('');
		}));
		this._register(setProjectRunEnvResolver(cwd => this.envFor(cwd)));
	}

	get(projectId: string): IVoltProjectSettings {
		return this.map[projectId] ?? {};
	}

	set(projectId: string, settings: IVoltProjectSettings): void {
		this.map = withProjectSettings(this.map, projectId, settings);
		this.storageService.store(PROJECT_SETTINGS_STORAGE_KEY, JSON.stringify(this.map), StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChange.fire(projectId);
	}

	getRunOn(projectId: string): AgentRunOn {
		return normalizeAgentRunOn(this.storageService.get(agentRunOnStorageKey(projectId), StorageScope.APPLICATION));
	}

	setRunOn(projectId: string, runOn: AgentRunOn): void {
		this.storageService.store(agentRunOnStorageKey(projectId), runOn, StorageScope.APPLICATION, StorageTarget.USER);
		this._onDidChange.fire(projectId);
	}

	async readWorktreeSetup(root: URI): Promise<IProjectWorktreeSetup> {
		const platform = isWindows ? 'windows' : 'unix';
		for (const source of [VOLT_WORKTREES_FILE, CURSOR_WORKTREES_FILE] as const) {
			const text = await this.readText(joinPath(root, source));
			if (text !== undefined) {
				return { ...readWorktreeSetup(text, platform), source };
			}
		}
		return { steps: [], script: false };
	}

	async writeWorktreeSetup(root: URI, steps: readonly string[]): Promise<void> {
		const file = joinPath(root, VOLT_WORKTREES_FILE);
		const next = writeWorktreeSetup(await this.readText(file), steps);
		if (next === undefined) {
			if (await this.fileService.exists(file)) {
				await this.fileService.del(file);
			}
			return;
		}
		await this.fileService.writeFile(file, VSBuffer.fromString(next));
	}

	/** A project folder, or a worktree one of the project's chats runs in. */
	private envFor(cwd: string): Readonly<Record<string, string>> | undefined {
		const withEnv = this.sessionContext.projects.filter(project => project.root.scheme === 'file' && this.map[project.id]?.env);
		if (!withEnv.length) {
			return undefined;
		}
		const caseInsensitive = !isLinux;
		const direct = projectForPath(cwd, withEnv.map(project => ({ id: project.id, root: project.root.fsPath })), caseInsensitive);
		if (direct) {
			return this.map[direct.id]?.env;
		}
		const worktree = projectForPath(cwd, this.history.list({ includeArchived: true })
			.filter(session => session.worktreePath && session.workspaceFolder)
			.map(session => ({ root: session.worktreePath!, folder: session.workspaceFolder! })), caseInsensitive);
		if (!worktree) {
			return undefined;
		}
		const folder = uriFromStoredRoot(worktree.folder).fsPath;
		const owner = projectForPath(folder, withEnv.map(project => ({ id: project.id, root: project.root.fsPath })), caseInsensitive);
		return owner ? this.map[owner.id]?.env : undefined;
	}

	private async readText(file: URI): Promise<string | undefined> {
		try {
			return (await this.fileService.readFile(file)).value.toString();
		} catch {
			return undefined;
		}
	}

	private read(): ProjectSettingsMap {
		try {
			return normalizeProjectSettings(JSON.parse(this.storageService.get(PROJECT_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION, '{}')));
		} catch {
			return {};
		}
	}
}

/**
 * Puts the project's default model on the composer when a new chat opens in it. The composer
 * follows the app's current pick, so a fresh chat in the project starts there; any pick in the
 * chat afterwards is the user's.
 */
export class ProjectDefaultModelContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltProjectDefaultModel';

	/** Chats already given their project's default, so switching back never overrides a pick. */
	private readonly applied = new Set<string>();

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IVoltProjectSettingsService private readonly settings: IVoltProjectSettingsService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
	) {
		super();
		this._register(this.editorService.onDidActiveEditorChange(() => this.apply()));
		this._register(this.sessionContext.onDidChangeActiveProject(() => this.apply()));
		this._register(this.runtime.onDidChangeCatalog(() => this.apply()));
		this.apply();
	}

	private apply(): void {
		const editor = this.editorService.activeEditor;
		if (!(editor instanceof AgentEditorInput) || editor.messages.length || this.applied.has(editor.sessionId)) {
			return;
		}
		const projectId = this.sessionContext.bindingFor(editor.sessionId)?.projectId ?? this.sessionContext.activeProject?.id;
		const ref = projectId ? this.settings.get(projectId).defaultModel : undefined;
		if (!ref) {
			return;
		}
		if (!this.runtime.listCatalog().some(item => item.ref === ref && item.enabled)) {
			// The catalog may still be loading; the next catalog change tries again.
			return;
		}
		this.applied.add(editor.sessionId);
		if (this.runtime.getActiveCatalogRef() !== ref) {
			void this.runtime.setActiveCatalogRef(ref);
		}
	}
}
