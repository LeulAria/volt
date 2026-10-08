/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { parsePullRequestUrl } from '../../../../../platform/voltPullRequests/common/voltPullRequestParse.js';
import { hostProductLabel, normalizeHost, VOLT_PR_PROVIDERS, VoltPrSupportedProvider } from '../../../../../platform/voltPullRequests/common/voltPrHosts.js';
import { voltPrErrorMessage } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, Extensions as ViewExtensions } from '../../../../common/views.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IMultiDiffSourceResolverService } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { ISCMService } from '../../../scm/common/scm.js';
import { buildReviewLinePrompt, currentLink } from '../../common/agentPullRequests.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { AgentFilesSidebar } from '../workspace/agentFilesSidebar.js';
import { agentToolsSessionOnScreen, showAgentFilesSidebar } from '../workspace/agentSurfaceHost.js';
import { LayoutModeContext } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { AgentGitActionsService, IAgentGitActionsService } from './agentGitActionsService.js';
import { parseBlobUri, PR_BLOB_SCHEME, PrBlobContentProvider, PrDiffSourceResolver } from './agentPullRequestDiff.js';
import { AgentPullRequestEditor } from './agentPullRequestEditor.js';
import { AGENT_PULL_REQUEST_EDITOR_ID, AGENT_PULL_REQUEST_SCHEME, AgentPullRequestEditorInput, AgentPullRequestEditorInputSerializer, parsePullRequestUri } from './agentPullRequestEditorInput.js';
import { AgentPullRequestService, IAgentPullRequestService } from './agentPullRequestService.js';
import { AGENT_PR_POST_REVIEW_COMMENTS_SETTING, AGENT_PR_REVIEW_MODEL_SETTING, AGENT_PR_AUTO_REVIEW_SETTING, AgentPullRequestReviewService, IAgentPrReviewService } from './agentPullRequestReviewService.js';
import { AUTO_REVIEW_MODES } from '../../common/agentPrReview.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { AgentPullRequestsViewPane } from './agentPullRequestsViewPane.js';
import { AGENT_PULL_REQUESTS_CONTAINER_ID, AGENT_PULL_REQUESTS_VIEW_ID, setPullRequestsViewSession } from './agentPullRequestsViewState.js';
import { composeInChat, openPullRequest, visibleChatSession } from './agentPullRequestUi.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { CREATE_PULL_REQUEST_COMMAND_ID, FIX_PR_SELECTION_COMMAND_ID, GENERATE_COMMIT_MESSAGE_COMMAND_ID, LINK_PULL_REQUEST_COMMAND_ID, OPEN_CHAT_PULL_REQUEST_COMMAND_ID, OPEN_PULL_REQUEST_COMMAND_ID, SHOW_PULL_REQUESTS_COMMAND_ID, SIGN_IN_HOST_COMMAND_ID } from './agentPullRequestCommands.js';

/** Volt writes commit messages itself; the core sparkle (Copilot setup) stays hidden. */
export const VOLT_COMMIT_MESSAGES_CONTEXT = new RawContextKey<boolean>('voltCommitMessages', false);

registerSingleton(IAgentPullRequestService, AgentPullRequestService, InstantiationType.Delayed);
registerSingleton(IAgentGitActionsService, AgentGitActionsService, InstantiationType.Delayed);
registerSingleton(IAgentPrReviewService, AgentPullRequestReviewService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt.pullRequests',
	title: localize('voltPr.configTitle', "Pull Requests"),
	type: 'object',
	properties: {
		[AGENT_PR_AUTO_REVIEW_SETTING]: {
			type: 'string',
			enum: [...AUTO_REVIEW_MODES],
			enumDescriptions: [
				localize('voltPr.autoReview.off', "Do not review pull requests automatically."),
				localize('voltPr.autoReview.mine', "Review the pull requests you opened when their head changes."),
				localize('voltPr.autoReview.all', "Review every open pull request linked to a chat when its head changes."),
			],
			default: 'off',
			description: localize('voltPr.autoReview', "Runs a review agent on a pull request's head (in its own worktree) and lists the findings in the pull request's Review section."),
		},
		[AGENT_PR_REVIEW_MODEL_SETTING]: {
			type: 'string',
			default: '',
			description: localize('voltPr.reviewModel', "The model that reviews pull requests (its catalog ref). Empty uses the linked chat's model."),
		},
		[AGENT_PR_POST_REVIEW_COMMENTS_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('voltPr.postReviewComments', "Shows Post as Review Comments under a pull request's review, which posts its open findings to GitHub as one review with a comment on each line."),
		},
	},
});

/** Starts the review service with the workbench, so the PR watcher's head changes trigger reviews. */
class AgentPullRequestReviewsContribution {

	static readonly ID = 'workbench.contrib.voltAgentPrReviews';

	constructor(@IAgentPrReviewService reviews: IAgentPrReviewService) {
		void reviews.whenReady;
	}
}
registerWorkbenchContribution2(AgentPullRequestReviewsContribution.ID, AgentPullRequestReviewsContribution, WorkbenchPhase.AfterRestored);

const pullRequestsIcon = registerIcon('volt-pull-requests-view', Codicon.gitPullRequest, localize('voltPr.viewIcon', "Pull Requests view icon."));

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AgentPullRequestEditor, AGENT_PULL_REQUEST_EDITOR_ID, localize('voltPr.editorLabel', "Pull Request")),
	[new SyncDescriptor(AgentPullRequestEditorInput)],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AgentPullRequestEditorInput.TypeID, AgentPullRequestEditorInputSerializer);

const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: AGENT_PULL_REQUESTS_CONTAINER_ID,
	title: localize2('voltPr.containerTitle', "Pull Requests"),
	icon: pullRequestsIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AGENT_PULL_REQUESTS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: AGENT_PULL_REQUESTS_CONTAINER_ID,
	hideIfEmpty: false,
	order: 4,
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: AGENT_PULL_REQUESTS_VIEW_ID,
	name: localize2('voltPr.viewTitle', "Pull Requests"),
	containerIcon: pullRequestsIcon,
	ctorDescriptor: new SyncDescriptor(AgentPullRequestsViewPane),
	canToggleVisibility: false,
	canMoveView: true,
}], container);

/**
 * Serves pull request diffs, blobs and tabs. Before the editors restore: a diff or pull request tab
 * restored from the last session resolves through these, and would come back empty without them.
 */
class AgentPullRequestResolversContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentPullRequestResolvers';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IMultiDiffSourceResolverService multiDiffSourceResolverService: IMultiDiffSourceResolverService,
		@ITextModelService textModelService: ITextModelService,
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		VOLT_COMMIT_MESSAGES_CONTEXT.bindTo(contextKeyService).set(true);
		this._register(multiDiffSourceResolverService.registerResolver(instantiationService.createInstance(PrDiffSourceResolver)));
		this._register(textModelService.registerTextModelContentProvider(PR_BLOB_SCHEME, instantiationService.createInstance(PrBlobContentProvider)));
		this._register(editorResolverService.registerEditor(
			`${AGENT_PULL_REQUEST_SCHEME}:**/**`,
			{ id: AGENT_PULL_REQUEST_EDITOR_ID, label: localize('voltPr.editorLabel', "Pull Request"), priority: RegisteredEditorPriority.builtin },
			{ singlePerResource: true, canSupportResource: resource => resource.scheme === AGENT_PULL_REQUEST_SCHEME },
			{
				createEditorInput: ({ resource, options }) => {
					const target = parsePullRequestUri(resource);
					if (!target) {
						throw new Error(`Not a pull request: ${resource.toString()}`);
					}
					return { editor: instantiationService.createInstance(AgentPullRequestEditorInput, target, undefined), options };
				},
			},
		));
	}
}

registerWorkbenchContribution2(AgentPullRequestResolversContribution.ID, AgentPullRequestResolversContribution, WorkbenchPhase.BlockStartup);

/** Starts syncing linked pull requests (and their watches) once the window is up. */
class AgentPullRequestsContribution {

	static readonly ID = 'workbench.contrib.voltAgentPullRequests';

	constructor(@IAgentPullRequestService pullRequests: IAgentPullRequestService) {
		void pullRequests.whenReady;
	}
}

registerWorkbenchContribution2(AgentPullRequestsContribution.ID, AgentPullRequestsContribution, WorkbenchPhase.AfterRestored);

/** The chat a command acts for: the one given, the chat whose tools are on screen, or the active chat editor's. */
function chatFor(accessor: ServicesAccessor, sessionId: unknown): string | undefined {
	if (typeof sessionId === 'string' && sessionId) {
		return sessionId;
	}
	const active = accessor.get(IEditorService).activeEditor;
	return active instanceof AgentEditorInput ? active.sessionId : agentToolsSessionOnScreen();
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: OPEN_PULL_REQUEST_COMMAND_ID, title: localize2('voltPr.openCommand', "Open Pull Request"), f1: false });
	}
	override async run(accessor: ServicesAccessor, target: { url?: string; host?: string; owner?: string; name?: string; number?: number } | string | undefined, sessionId?: string): Promise<void> {
		const url = typeof target === 'string' ? target : target?.url;
		const parsed = url ? parsePullRequestUrl(url) : target && typeof target === 'object' && target.owner && target.name && target.number ? { repo: { host: target.host ?? 'github.com', owner: target.owner, name: target.name }, number: target.number } : undefined;
		if (!parsed) {
			return;
		}
		await openPullRequest(accessor, { kind: 'pr', repo: parsed.repo, number: parsed.number }, chatFor(accessor, sessionId));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: OPEN_CHAT_PULL_REQUEST_COMMAND_ID, title: localize2('voltPr.openChat', "Open the Chat's Pull Request"), category: localize2('volt', "Volt"), f1: true, icon: Codicon.gitPullRequest });
	}
	override async run(accessor: ServicesAccessor, sessionId?: string): Promise<void> {
		const pullRequests = accessor.get(IAgentPullRequestService);
		const chat = chatFor(accessor, sessionId);
		if (!chat) {
			return;
		}
		const link = currentLink(pullRequests.links(chat));
		if (link) {
			await openPullRequest(accessor, { kind: 'pr', repo: link.repo, number: link.number }, chat);
			return;
		}
		const folder = pullRequests.folderFor(chat);
		if (folder) {
			await openPullRequest(accessor, { kind: 'new', folder }, chat);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: CREATE_PULL_REQUEST_COMMAND_ID, title: localize2('voltPr.createCommand', "Create Pull Request"), category: localize2('volt', "Volt"), f1: true, icon: Codicon.gitPullRequestCreate });
	}
	override async run(accessor: ServicesAccessor, sessionId?: string): Promise<void> {
		const pullRequests = accessor.get(IAgentPullRequestService);
		const chat = chatFor(accessor, sessionId);
		const folder = chat ? pullRequests.folderFor(chat) : undefined;
		if (!folder) {
			accessor.get(INotificationService).info(localize('voltPr.createNoChat', "Open a chat in a GitHub project to create a pull request."));
			return;
		}
		await openPullRequest(accessor, { kind: 'new', folder }, chat);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: SHOW_PULL_REQUESTS_COMMAND_ID, title: localize2('voltPr.showList', "Show Pull Requests"), category: localize2('volt', "Volt"), f1: true, icon: Codicon.gitPullRequest });
	}
	override async run(accessor: ServicesAccessor, sessionId?: string): Promise<void> {
		const chat = typeof sessionId === 'string' ? sessionId : visibleChatSession(accessor);
		if (chat) {
			setPullRequestsViewSession(chat);
		}
		// Agent layout: the right sidebar's Pull Requests tab, beside the chat. IDE layout: the view.
		if (showAgentFilesSidebar('pullRequests')) {
			return;
		}
		if (accessor.get(IContextKeyService).getContextKeyValue<string>(LayoutModeContext.key) === 'agent') {
			AgentFilesSidebar.show(accessor.get(IStorageService), 'pullRequests');
			return;
		}
		await accessor.get(IViewsService).openViewContainer(AGENT_PULL_REQUESTS_CONTAINER_ID, true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: LINK_PULL_REQUEST_COMMAND_ID, title: localize2('voltPr.linkCommand', "Link Pull Request to Chat"), category: localize2('volt', "Volt"), f1: true, icon: Codicon.link });
	}
	override async run(accessor: ServicesAccessor, sessionId?: string, target?: string): Promise<void> {
		const pullRequests = accessor.get(IAgentPullRequestService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const chat = chatFor(accessor, sessionId);
		if (!chat) {
			notificationService.info(localize('voltPr.linkNoChat', "Open a chat to link a pull request to it."));
			return;
		}
		const value = target ?? await quickInputService.input({
			prompt: localize('voltPr.linkPrompt', "The pull request's URL, or its number in this chat's repository"),
			placeHolder: 'https://github.com/owner/repo/pull/12 or 12',
			validateInput: async input => /^#?\d+$/.test(input.trim()) || parsePullRequestUrl(input.trim()) ? undefined : localize('voltPr.linkInvalid', "Enter a pull request URL or number"),
		});
		if (!value) {
			return;
		}
		const trimmed = value.trim();
		try {
			const link = await pullRequests.link(chat, /^#?\d+$/.test(trimmed) ? { number: Number(trimmed.replace('#', '')) } : { url: trimmed }, 'manual');
			notificationService.info(localize('voltPr.linked', "Linked #{0} to the chat.", link.number));
		} catch (err) {
			notificationService.error(voltPrErrorMessage(err));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: SIGN_IN_HOST_COMMAND_ID, title: localize2('voltPr.signInCommand', "Sign In to a Code Host"), category: localize2('volt', "Volt"), f1: true });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const pullRequests = accessor.get(IAgentPullRequestService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const picked = await quickInputService.pick(VOLT_PR_PROVIDERS.filter(provider => provider !== 'github').map(provider => ({ id: provider, label: hostProductLabel(provider) })), {
			placeHolder: localize('voltPr.signInProvider', "What kind of code host is it?"),
		});
		if (!picked) {
			return;
		}
		const provider = picked.id as VoltPrSupportedProvider;
		const server = await quickInputService.input({
			prompt: localize('voltPr.signInServer', "The server's web address"),
			placeHolder: provider === 'gitlab' ? 'https://gitlab.com' : provider === 'bitbucket' ? 'https://bitbucket.org' : provider === 'azure' ? 'https://dev.azure.com' : 'https://git.example.com',
			validateInput: async input => normalizeHost(input) ? undefined : localize('voltPr.signInServerInvalid', "Enter the server's address, such as https://git.example.com"),
		});
		const host = server && normalizeHost(server);
		if (!server || !host) {
			return;
		}
		const token = await quickInputService.input({
			prompt: localize('voltPr.signInToken', "An access token for {0} ({1})", hostProductLabel(provider), host),
			password: true,
			validateInput: async input => input.trim() ? undefined : localize('voltPr.signInTokenEmpty', "Enter an access token"),
		});
		if (!token) {
			return;
		}
		try {
			const account = await pullRequests.signInHost({ host, provider, token, webUrl: server.trim().replace(/\/+$/, '') });
			notificationService.info(localize('voltPr.signedIn', "Signed in to {0} as {1}.", host, account.login));
		} catch (err) {
			notificationService.error(voltPrErrorMessage(err));
		}
	}
});

/** Source Control's sparkle: Volt's text generation model writes the message from what would be committed. */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: GENERATE_COMMIT_MESSAGE_COMMAND_ID,
			title: localize2('voltPr.generateCommit', "Generate Commit Message"),
			icon: Codicon.sparkle,
			f1: false,
			menu: { id: MenuId.SCMInputBox, group: 'navigation', when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), VOLT_COMMIT_MESSAGES_CONTEXT) },
		});
	}
	override async run(accessor: ServicesAccessor, rootUri?: URI): Promise<void> {
		const scmService = accessor.get(ISCMService);
		const pullRequests = accessor.get(IAgentPullRequestService);
		const progressService = accessor.get(IProgressService);
		const notificationService = accessor.get(INotificationService);
		const repository = [...scmService.repositories].find(candidate => URI.isUri(rootUri) && candidate.provider.rootUri?.toString() === rootUri.toString())
			?? [...scmService.repositories][0];
		const root = repository?.provider.rootUri;
		if (!repository || !root || root.scheme !== 'file') {
			return;
		}
		const sessionId = chatFor(accessor, undefined);
		await progressService.withProgress({ location: ProgressLocation.Scm, title: localize('voltPr.generatingCommit', "Writing a commit message…") }, async () => {
			try {
				const message = await pullRequests.generateCommitMessage(root.fsPath, sessionId);
				if (!message) {
					notificationService.info(localize('voltPr.nothingToCommit', "There are no changes to describe."));
					return;
				}
				repository.input.setValue(message, false);
			} catch (err) {
				notificationService.error(localize('voltPr.commitMessageFailed', "Could not write a commit message: {0}", voltPrErrorMessage(err)));
			}
		});
	}
});

/**
 * Lines picked in a pull request's diff (Add to Chat, Cmd+L): "Fix this" with the pull request, the
 * file, the lines and their code goes into the chat's composer, where the user can say more.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({ id: FIX_PR_SELECTION_COMMAND_ID, title: localize2('voltPr.fixSelection', "Fix This with Agent"), f1: false });
	}
	override async run(accessor: ServicesAccessor, resource: unknown, range?: { startLineNumber: number; endLineNumber: number; endColumn?: number }): Promise<void> {
		const blob = URI.isUri(resource) ? parseBlobUri(resource) : undefined;
		const model = URI.isUri(resource) ? accessor.get(IModelService).getModel(resource) : undefined;
		if (!blob || !model || !range) {
			return;
		}
		const pullRequests = accessor.get(IAgentPullRequestService);
		const clipboardService = accessor.get(IClipboardService);
		const notificationService = accessor.get(INotificationService);
		const match = /^(.+?)\/([^/]+)\/([^/#]+)#(\d+)$/.exec(blob.key);
		const snapshot = pullRequests.snapshot(blob.key);
		if (!match && !snapshot) {
			return;
		}
		const start = Math.max(1, range.startLineNumber);
		// A selection that ends at column 1 of a line does not include that line.
		const end = Math.max(start, range.endColumn === 1 && range.endLineNumber > start ? range.endLineNumber - 1 : range.endLineNumber);
		const code = model.getValueInRange({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(Math.min(end, model.getLineCount())) });
		const pr = snapshot ?? { number: Number(match![4]), title: '', url: `https://${match![1]}/${match![2]}/${match![3]}/pull/${match![4]}`, headRefName: '', baseRefName: '' };
		const request = blob.side === 'original'
			? localize('voltPr.fixSelection.base', "Look at these lines as they are on the base branch, before this pull request:")
			: localize('voltPr.fixSelection.head', "Fix this:");
		const prompt = buildReviewLinePrompt(pr, blob.path, start, end, code, request);
		const sessionId = agentToolsSessionOnScreen() ?? pullRequests.sessionsFor(blob.key)[0] ?? visibleChatSession(accessor);
		if (sessionId && await composeInChat(accessor, sessionId, prompt)) {
			return;
		}
		await clipboardService.writeText(prompt);
		notificationService.info(localize('voltPr.fixSelection.copied', "No chat to send it to; the prompt was copied."));
	}
});
