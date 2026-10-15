/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../../base/common/async.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../../base/common/network.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IVoltGitService } from '../../../../../platform/voltGit/common/voltGit.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../../scm/common/scm.js';

const GIT_EXTENSION_ID = 'vscode.git';
/** How long a stopped Git extension gets to come back (the extension host restarts when the window moves folders). */
const GIT_RESTART_WAIT_MS = 15_000;

/**
 * Where a chat's repository stands in Source Control. Anything but `loading` and `ready` says
 * why it is missing, from git itself (Volt's own git, not the extension): the folder really is
 * not a repository, git cannot run, or git sees a repository the Git extension did not open.
 */
export type AgentScmRepositoryState =
	| { readonly kind: 'loading' }
	| { readonly kind: 'ready' }
	/** The chat has no local folder. */
	| { readonly kind: 'noFolder' }
	/** Git ran and the folder is in no repository. */
	| { readonly kind: 'notRepository' }
	/** Git could not run: not installed, or a broken shim (an unaccepted Xcode license). */
	| { readonly kind: 'gitFailed'; readonly detail: string }
	/** A repository, with `git.enabled` off. */
	| { readonly kind: 'gitDisabled'; readonly repoRoot: string }
	/**
	 * A repository, and the Git extension is not running. `outdated`: the app on disk is a newer
	 * build than this window, so a new extension host refuses to start (version mismatch) until a relaunch.
	 */
	| { readonly kind: 'extensionStopped'; readonly repoRoot: string; readonly outdated: boolean }
	/** A repository, and Git runs, but did not open it: unsafe (another owner) or ignored. */
	| { readonly kind: 'notOpened'; readonly repoRoot: string };

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
 * so every addition while `isShowing` holds puts the chat's back on its own. When the extension
 * host restarts (its repositories go away), it opens the chat's again once Git is back.
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
		@IVoltGitService private readonly gitService: IVoltGitService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@IProductService private readonly productService: IProductService,
	) {
		super();
	}

	async show(sessionId: string, isShowing: () => boolean, folder?: URI, onState?: (state: AgentScmRepositoryState) => void): Promise<void> {
		const request = ++this.request;
		this.watcher.clear();
		const repoRoot = folder?.scheme === Schemas.file ? folder.fsPath : this.repoRoot(sessionId);
		if (!repoRoot) {
			onState?.({ kind: 'noFolder' });
			return;
		}
		const root = URI.file(repoRoot);
		/** Git's own top folder for `root`, once asked: a subfolder's repository, or the same folder through a symlink. */
		let gitRoot: URI | undefined;
		const repositoryAt = () => this.repositoryAt(root) ?? (gitRoot ? this.repositoryAt(gitRoot) : undefined);
		const current = () => request === this.request && isShowing();
		let focused = false;
		let shownState: AgentScmRepositoryState['kind'] | undefined;
		const setState = (state: AgentScmRepositoryState) => {
			shownState = state.kind;
			onState?.(state);
		};
		const show = () => {
			const repository = repositoryAt();
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
			if (shownState !== 'ready') {
				setState({ kind: 'ready' });
			}
			if (!focused) {
				focused = true;
				this.scmViewService.focus(repository);
			}
		};
		const watch = new DisposableStore();
		this.watcher.value = watch;

		/** One attempt to open and show the repository; true to try again (Git came back meanwhile). */
		const attempt = async (): Promise<boolean> => {
			if (repositoryAt()) {
				show();
				return false;
			}
			setState({ kind: 'loading' });
			show();
			await this.openRepository(root, repoRoot);
			if (!current()) {
				return false;
			}
			show();
			if (repositoryAt()) {
				return false;
			}
			// Git did not register it. Ask git itself why, so the message says what is really wrong.
			const repo = await this.gitService.resolveRepo(repoRoot).then(found => found ?? null, (error: unknown) => toErrorMessage(error));
			if (!current()) {
				return false;
			}
			if (repo === null) {
				setState({ kind: 'notRepository' });
				return false;
			}
			if (typeof repo === 'string') {
				setState({ kind: 'gitFailed', detail: repo });
				return false;
			}
			gitRoot = URI.file(repo.repoRoot);
			if (repositoryAt()) {
				show();
				return false;
			}
			if (this.configurationService.getValue<boolean>('git.enabled', { resource: root }) === false) {
				setState({ kind: 'gitDisabled', repoRoot: repo.repoRoot });
				return false;
			}
			if (!this.isGitRunning()) {
				// A restarting extension host brings Git back in a moment.
				await Promise.race([
					Event.toPromise(Event.filter(this.extensionService.onDidChangeExtensionsStatus, () => this.isGitRunning()), watch),
					timeout(GIT_RESTART_WAIT_MS),
				]);
				if (!current()) {
					return false;
				}
				if (this.isGitRunning()) {
					return true;
				}
				setState({ kind: 'extensionStopped', repoRoot: repo.repoRoot, outdated: await this.isAppOutdated() });
				return false;
			}
			setState({ kind: 'notOpened', repoRoot: repo.repoRoot });
			return false;
		};
		let busy = false;
		const run = async () => {
			if (busy) {
				return;
			}
			busy = true;
			let again = false;
			try {
				again = await attempt();
			} finally {
				busy = false;
			}
			if (again && current()) {
				await run();
			}
		};

		watch.add(this.scmService.onDidAddRepository(show));
		watch.add(this.scmViewService.onDidChangeVisibleRepositories(show));
		// The extension host stopped (its repositories close) or Git started again: open the chat's anew.
		watch.add(this.scmService.onDidRemoveRepository(() => {
			if (focused && current() && !repositoryAt()) {
				focused = false;
				void run();
			}
		}));
		watch.add(this.extensionService.onDidChangeExtensionsStatus(ids => {
			if (current() && !repositoryAt() && ids.some(id => id.value === GIT_EXTENSION_ID) && this.isGitRunning()) {
				void run();
			}
		}));
		await run();
	}

	clear(): void {
		this.request++;
		this.watcher.clear();
	}

	override dispose(): void {
		this.clear();
		super.dispose();
	}

	/** Asks Git to open the folder (or the repository it is in). Sidebars asking for the same folder share one request. */
	private async openRepository(root: URI, repoRoot: string): Promise<void> {
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
			// The Git extension is not running, or failed: the caller asks git why.
		}
	}

	private isGitRunning(): boolean {
		return !!this.extensionService.getExtensionsStatus()[GIT_EXTENSION_ID]?.activationTimes;
	}

	/** The app was rebuilt or updated on disk while this window ran: its product.json names another commit. */
	private async isAppOutdated(): Promise<boolean> {
		const running = this.productService.commit;
		if (!running) {
			return false;
		}
		try {
			const content = await this.fileService.readFile(joinPath(FileAccess.asFileUri(''), '..', 'product.json'));
			const commit = (JSON.parse(content.value.toString()) as { commit?: unknown }).commit;
			return typeof commit === 'string' && commit !== running;
		} catch {
			return false;
		}
	}

	private repositoryAt(root: URI): ISCMRepository | undefined {
		return findAgentScmRepository(this.scmService, this.uriIdentityService, root);
	}

	private repoRoot(sessionId: string): string | undefined {
		const root = this.sessionContext.rootFor(sessionId) ?? this.workspaceContextService.getWorkspace().folders[0]?.uri;
		return root?.scheme === Schemas.file ? root.fsPath : undefined;
	}
}
