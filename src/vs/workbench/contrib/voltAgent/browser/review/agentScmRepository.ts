/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../../scm/common/scm.js';

/** Several chat sidebars can request the same repository before Git has registered it. */
const openingRepositories = new WeakMap<ICommandService, Map<string, Promise<unknown>>>();

/**
 * The repository at this folder. `getRepository` only matches paths inside a repository, never its root.
 * Compared the way the disk does: a chat's root can differ from git's in case alone on macOS.
 */
export function findAgentScmRepository(scmService: ISCMService, uriIdentityService: IUriIdentityService, root: URI): ISCMRepository | undefined {
	for (const repository of scmService.repositories) {
		const repositoryRoot = repository.provider.rootUri;
		if (repositoryRoot && uriIdentityService.extUri.isEqual(repositoryRoot, root)) {
			return repository;
		}
	}
	return scmService.getRepository(root);
}

/**
 * Shows a chat's repository in the Source Control view, alone. A chat's project is not a
 * workspace folder, so git has not opened it: open it, and show it once it registers. Git adds
 * other repositories later (the workspace's own, at startup) and the view shows each new one,
 * so every addition while `isShowing` holds puts the chat's back on its own.
 */
export class AgentScmRepositoryFocus extends Disposable {

	private readonly watcher = this._register(new MutableDisposable());
	private request = 0;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super();
	}

	async show(sessionId: string, isShowing: () => boolean, folder?: URI, onState?: (state: 'loading' | 'ready' | 'unavailable') => void): Promise<void> {
		const request = ++this.request;
		this.watcher.clear();
		const repoRoot = folder?.scheme === Schemas.file ? folder.fsPath : this.repoRoot(sessionId);
		if (!repoRoot) {
			onState?.('unavailable');
			return;
		}
		const root = URI.file(repoRoot);
		const current = () => request === this.request && isShowing();
		let focused = false;
		const show = () => {
			const repository = this.repositoryAt(root);
			if (!current()) {
				return;
			}
			const visible = repository ? [repository] : [];
			if (this.scmViewService.visibleRepositories.length !== visible.length || this.scmViewService.visibleRepositories[0] !== visible[0]) {
				this.scmViewService.visibleRepositories = visible;
			}
			if (!repository) {
				return;
			}
			onState?.('ready');
			if (!focused) {
				focused = true;
				this.scmViewService.focus(repository);
			}
		};
		const watch = new DisposableStore();
		this.watcher.value = watch;
		watch.add(this.scmService.onDidAddRepository(show));
		watch.add(this.scmViewService.onDidChangeVisibleRepositories(show));
		if (this.repositoryAt(root)) {
			show();
			return;
		}
		onState?.('loading');
		show();
		try {
			let opening = openingRepositories.get(this.commandService);
			if (!opening) {
				opening = new Map();
				openingRepositories.set(this.commandService, opening);
			}
			const key = this.uriIdentityService.extUri.getComparisonKey(root);
			let pending = opening.get(key);
			if (!pending) {
				pending = this.commandService.executeCommand('git.openRepository', repoRoot).finally(() => opening.delete(key));
				opening.set(key, pending);
			}
			await pending;
		} catch {
			// Keep failures separate from an in-progress discovery.
		}
		if (current()) {
			show();
			if (!this.repositoryAt(root)) {
				onState?.('unavailable');
			}
		}
	}

	clear(): void {
		this.request++;
		this.watcher.clear();
	}

	override dispose(): void {
		this.clear();
		super.dispose();
	}

	private repositoryAt(root: URI): ISCMRepository | undefined {
		return findAgentScmRepository(this.scmService, this.uriIdentityService, root);
	}

	private repoRoot(sessionId: string): string | undefined {
		const root = this.sessionContext.rootFor(sessionId) ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;
		return root?.scheme === Schemas.file ? root.fsPath : undefined;
	}
}
