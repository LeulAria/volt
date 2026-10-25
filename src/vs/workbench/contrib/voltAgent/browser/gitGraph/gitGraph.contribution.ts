/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { Iterable } from '../../../../../base/common/iterator.js';
import { Schemas } from '../../../../../base/common/network.js';
import { relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ISCMHistoryItem } from '../../../scm/common/history.js';
import { ISCMProvider, ISCMRepository, ISCMService } from '../../../scm/common/scm.js';
import { AgentEditor } from '../editor/agentEditor.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { visibleChatSession } from '../pullRequests/agentPullRequestUi.js';
import { openInAgentTools, openSideChatOnScreen, revealAgentToolEditor } from '../workspace/agentSurfaceHost.js';
import { OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID } from '../workspace/agentSurfaceMenu.js';
import { ASK_AGENT_COMMAND_ID, GIT_GRAPH_EDITOR_ID, GitGraphEditor, GitGraphEditorInput, GitGraphEditorInputSerializer, IGitGraphRequest, InGitGraphContext } from './gitGraphEditor.js';
import { buildGitAgentPrompt, gitAgentPromptTitle, IGitAgentContext, IGitAskAgentArgs, readGitAskAgentArgs } from './gitGraphPrompts.js';

export const OPEN_GIT_GRAPH_COMMAND_ID = 'volt.gitGraph.open';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(GitGraphEditor, GIT_GRAPH_EDITOR_ID, localize('voltGitGraph.editorLabel', "Git Graph")),
	[new SyncDescriptor(GitGraphEditorInput)]
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(GitGraphEditorInput.TypeID, GitGraphEditorInputSerializer);

interface IGitGraphOpenArgs {
	readonly repositoryRoot?: string;
	readonly query?: string;
	readonly revealCommit?: string;
}

function readOpenArgs(value: unknown): IGitGraphOpenArgs {
	const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const text = (key: string) => typeof raw[key] === 'string' && raw[key] ? raw[key] as string : undefined;
	return { repositoryRoot: text('repositoryRoot'), query: text('query'), revealCommit: text('revealCommit') };
}

/**
 * Opens the Git Graph tab, or brings the open one forward, then searches or reveals. Over a chat it
 * lands in that chat's right panel like any other tab (agentFileEditorRouting).
 */
export async function openGitGraph(accessor: ServicesAccessor, args: IGitGraphOpenArgs, sessionId?: string): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const request: IGitGraphRequest | undefined = args.query !== undefined || args.revealCommit
		? { query: args.query, reveal: args.revealCommit }
		: undefined;
	const mainGroups = new Set(accessor.get(IEditorGroupsService).mainPart.groups.map(group => group.id));
	const existing = editorService.editors.find((editor): editor is GitGraphEditorInput => editor instanceof GitGraphEditorInput);
	const where = existing ? editorService.findEditors(existing.resource) : [];
	const inTools = where.some(identifier => !mainGroups.has(identifier.groupId));
	// From a chat's right panel (sessionId given) the graph opens there, even when a tab is open elsewhere.
	if (existing && (inTools || sessionId === undefined)) {
		if (args.repositoryRoot) {
			existing.repositoryRoot = args.repositoryRoot;
		}
		existing.request(request ?? { reveal: undefined });
		// Only a tab that is in the right panel reveals there; revealAgentToolEditor would otherwise just open the panel.
		if (inTools && revealAgentToolEditor(existing)) {
			return;
		}
		await editorService.openEditor(existing, { pinned: true }, where[0]?.groupId);
		return;
	}
	const input = accessor.get(IInstantiationService).createInstance(GitGraphEditorInput);
	input.repositoryRoot = args.repositoryRoot;
	if (request) {
		input.request(request);
	}
	const opened = openInAgentTools(input, sessionId, { pinned: true });
	if (opened) {
		await opened;
	} else {
		await editorService.openEditor(input, { pinned: true });
	}
}

registerAction2(class OpenGitGraphAction extends Action2 {
	constructor() {
		super({
			id: OPEN_GIT_GRAPH_COMMAND_ID,
			title: localize2('voltGitGraph.open', "Open Git Graph"),
			category: localize2('voltGitGraph.category', "Git"),
			icon: Codicon.sourceControl,
			f1: true,
			menu: [{
				id: MenuId.SCMHistoryTitle,
				group: 'navigation',
				order: 0,
			}],
		});
	}

	override async run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
		await openGitGraph(accessor, readOpenArgs(args));
	}
});

registerAction2(class OpenGitGraphInToolsAction extends Action2 {
	constructor() {
		super({ id: OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID, title: localize2('voltGitGraph.openInTools', "Open Git Graph Beside Chat") });
	}

	override async run(accessor: ServicesAccessor, sessionId?: unknown): Promise<void> {
		await openGitGraph(accessor, {}, typeof sessionId === 'string' ? sessionId : undefined);
	}
});

//#region File and line history

/** The deepest repository holding `resource`, and the path inside it with forward slashes. */
function locate(scmService: ISCMService, resource: URI): { repository: ISCMRepository; path: string } | undefined {
	let best: { repository: ISCMRepository; path: string } | undefined;
	for (const repository of scmService.repositories) {
		const root = repository.provider.rootUri;
		const path = root ? relativePath(root, resource) : undefined;
		if (root && path !== undefined && (!best || root.path.length > best.repository.provider.rootUri!.path.length)) {
			best = { repository, path };
		}
	}
	return best;
}

function quoteQueryValue(value: string): string {
	return /[\s"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}

function activeResource(accessor: ServicesAccessor, uri: unknown): URI | undefined {
	if (URI.isUri(uri)) {
		return uri;
	}
	return accessor.get(IEditorService).activeEditor?.resource;
}

registerAction2(class OpenFileHistoryAction extends Action2 {
	constructor() {
		super({
			id: 'volt.gitGraph.fileHistory',
			title: localize2('voltGitGraph.fileHistory', "Open File History"),
			category: localize2('voltGitGraph.category', "Git"),
			icon: Codicon.history,
			f1: true,
			precondition: ContextKeyExpr.equals('config.git.enabled', true),
			menu: [
				{ id: MenuId.ExplorerContext, group: '7_volt_git', order: 1, when: ContextKeyExpr.and(ContextKeyExpr.equals('resourceScheme', Schemas.file), ContextKeyExpr.equals('config.git.enabled', true)) },
				{ id: MenuId.EditorTitleContext, group: '2_volt_git', order: 1, when: ContextKeyExpr.equals('resourceScheme', Schemas.file) },
			],
		});
	}

	override async run(accessor: ServicesAccessor, uri?: unknown): Promise<void> {
		const resource = activeResource(accessor, uri);
		const located = resource && locate(accessor.get(ISCMService), resource);
		if (!located) {
			accessor.get(INotificationService).info(localize('voltGitGraph.notInRepo', "This file is not in a Git repository."));
			return;
		}
		await openGitGraph(accessor, { repositoryRoot: located.repository.provider.rootUri!.fsPath, query: located.path ? `path:${quoteQueryValue(located.path)}` : '' });
	}
});

registerAction2(class OpenLineHistoryAction extends Action2 {
	constructor() {
		super({
			id: 'volt.gitGraph.lineHistory',
			title: localize2('voltGitGraph.lineHistory', "Open Line History"),
			category: localize2('voltGitGraph.category', "Git"),
			icon: Codicon.history,
			f1: true,
			menu: [{ id: MenuId.EditorContext, group: '1_volt_git', order: 1, when: ContextKeyExpr.equals('resourceScheme', Schemas.file) }],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editor = accessor.get(ICodeEditorService).getActiveCodeEditor();
		const resource = editor?.getModel()?.uri;
		const selection = editor?.getSelection();
		const located = resource && locate(accessor.get(ISCMService), resource);
		if (!located || !selection) {
			return;
		}
		// Lines past the end of a selection that stops at column 1 aren't part of it.
		const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
		await openGitGraph(accessor, {
			repositoryRoot: located.repository.provider.rootUri!.fsPath,
			query: `lines:${selection.startLineNumber}-${end}:${quoteQueryValue(located.path)}`,
		});
	}
});

//#endregion

//#region Agent

/** What git knows about the commit: subject, author, stats and changed files (paths relative to the repo). */
async function gitContext(scmService: ISCMService, args: IGitAskAgentArgs): Promise<IGitAgentContext> {
	if (!args.commit) {
		return {};
	}
	const root = args.repositoryRoot ? URI.file(args.repositoryRoot).toString() : undefined;
	const repository = [...scmService.repositories].find(candidate => candidate.provider.rootUri?.toString() === root) ?? Iterable.first(scmService.repositories);
	const history = repository?.provider.historyProvider.get();
	const rootUri = repository?.provider.rootUri;
	try {
		const item = await history?.resolveHistoryItem(args.commit);
		if (!item) {
			return {};
		}
		const changes = await history?.provideHistoryItemChanges(item.id, item.parentIds[0]) ?? [];
		const files = changes.map(change => ({
			path: (rootUri && relativePath(rootUri, change.uri)) || change.uri.path,
			status: (!change.originalUri ? 'A' : !change.modifiedUri ? 'D' : 'M') as 'A' | 'M' | 'D',
		}));
		return { subject: item.subject, author: item.author, files, stats: item.statistics };
	} catch {
		// The prompt still names the SHA; the agent reads the rest.
		return {};
	}
}

/**
 * Explain / Review: a new side chat gets a pull-request-style prompt built from git's facts, and runs
 * it right away. It opens beside the Git Graph on screen (in the right panel it is a tab of, or its
 * own), else beside the chat on screen, and only without either as a chat tab of its own.
 */
async function askAgent(accessor: ServicesAccessor, args: IGitAskAgentArgs): Promise<void> {
	const scmService = accessor.get(ISCMService);
	const editorService = accessor.get(IEditorService);
	const clipboardService = accessor.get(IClipboardService);
	const notificationService = accessor.get(INotificationService);
	const instantiationService = accessor.get(IInstantiationService);
	const graphs: GitGraphEditor[] = [];
	for (const visible of editorService.visibleEditorPanes) {
		if (visible instanceof GitGraphEditor) {
			graphs.push(visible);
		}
	}
	const context = await gitContext(scmService, args);
	const prompt = buildGitAgentPrompt(args, context);
	const display = { text: gitAgentPromptTitle(args, context.subject) };

	// Beside the graph on screen first (its chat's right panel, full screen too), then the chat on screen.
	let pane: unknown;
	for (const graph of graphs) {
		if (!(pane instanceof AgentEditor)) {
			pane = await graph.openSideChat();
		}
	}
	if (!(pane instanceof AgentEditor)) {
		pane = await openSideChatOnScreen(instantiationService.invokeFunction(visibleChatSession));
	}
	if (!(pane instanceof AgentEditor)) {
		// No chat on screen: a new chat tab of its own.
		const input = instantiationService.createInstance(AgentEditorInput, AgentEditorInput.getNewEditorUri());
		pane = await editorService.openEditor(input, { pinned: true });
	}
	if (pane instanceof AgentEditor) {
		// A side chat in the right panel is composer-only by default; this one is opened to be read.
		pane.showTranscriptInTools();
		pane.submitPrompt(prompt, display);
		return;
	}
	await clipboardService.writeText(prompt);
	notificationService.info(localize('voltGitGraph.promptCopied', "A chat couldn't be opened, so the prompt was copied. Paste it into a chat."));
}

registerAction2(class AskAgentAboutGitAction extends Action2 {
	constructor() {
		super({ id: ASK_AGENT_COMMAND_ID, title: localize2('voltGitGraph.askAgent', "Ask Agent About Commit") });
	}

	override async run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
		const parsed = readGitAskAgentArgs(args);
		if (parsed) {
			await askAgent(accessor, parsed);
		}
	}
});

/** The SCM graph's commit menu (sidebar and the Git Graph tab): Explain / Review with the agent. */
for (const [action, id, title, order] of [
	['explain', 'volt.gitGraph.explainCommit', localize2('voltGitGraph.explainCommit', "Explain with Agent"), 1],
	['review', 'volt.gitGraph.reviewCommit', localize2('voltGitGraph.reviewCommit', "Review with Agent"), 2],
] as const) {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id,
				title,
				icon: Codicon.sparkle,
				menu: { id: MenuId.SCMHistoryItemContext, group: '0_volt_agent', order, when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.not('listMultiSelection')) },
			});
		}

		override async run(accessor: ServicesAccessor, provider?: ISCMProvider, historyItem?: ISCMHistoryItem): Promise<void> {
			if (historyItem?.id) {
				await askAgent(accessor, { action, commit: historyItem.id, repositoryRoot: provider?.rootUri?.fsPath });
			}
		}
	});
}

registerAction2(class RevealInGitGraphAction extends Action2 {
	constructor() {
		super({
			id: 'volt.gitGraph.revealCommit',
			title: localize2('voltGitGraph.reveal', "Open in Git Graph"),
			icon: Codicon.sourceControl,
			menu: { id: MenuId.SCMHistoryItemContext, group: '0_view', order: 3, when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), InGitGraphContext.negate()) },
		});
	}

	override async run(accessor: ServicesAccessor, provider?: ISCMProvider, historyItem?: ISCMHistoryItem): Promise<void> {
		await openGitGraph(accessor, { repositoryRoot: provider?.rootUri?.fsPath, revealCommit: historyItem?.id });
	}
});

registerAction2(class ExplainLinesAction extends Action2 {
	constructor() {
		super({
			id: 'volt.gitGraph.explainLines',
			title: localize2('voltGitGraph.explainLines', "Explain Lines with Agent"),
			category: localize2('voltGitGraph.category', "Git"),
			icon: Codicon.sparkle,
			f1: true,
			menu: [{ id: MenuId.EditorContext, group: '1_volt_git', order: 2, when: ContextKeyExpr.equals('resourceScheme', Schemas.file) }],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editor = accessor.get(ICodeEditorService).getActiveCodeEditor();
		const resource = editor?.getModel()?.uri;
		const selection = editor?.getSelection();
		const located = resource && locate(accessor.get(ISCMService), resource);
		if (!located || !selection) {
			return;
		}
		const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
		await askAgent(accessor, {
			action: 'explain',
			repositoryRoot: located.repository.provider.rootUri!.fsPath,
			path: located.path,
			startLine: selection.startLineNumber,
			endLine: end,
		});
	}
});

//#endregion
