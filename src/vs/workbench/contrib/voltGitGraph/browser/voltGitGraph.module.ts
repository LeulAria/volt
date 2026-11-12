/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Iterable } from '../../../../base/common/iterator.js';
import { Schemas } from '../../../../base/common/network.js';
import { relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVoltAgentWindowService, IVoltChatPane } from '../../../services/voltPlugins/browser/voltAgentWindow.js';
import { IVoltPluginService } from '../../../services/voltPlugins/common/voltApi.js';
import { ISCMHistoryItem } from '../../scm/common/history.js';
import { ISCMProvider, ISCMRepository, ISCMService } from '../../scm/common/scm.js';
import { IVoltFeatureModule, IVoltFeatureModuleHost } from '../../voltCustomize/browser/voltFeatureModules.js';
import { GIT_GRAPH_ASK_AGENT_COMMAND_ID, GIT_GRAPH_EXPLAIN_COMMIT_COMMAND_ID, GIT_GRAPH_EXPLAIN_LINES_COMMAND_ID, GIT_GRAPH_FILE_HISTORY_COMMAND_ID, GIT_GRAPH_LINE_HISTORY_COMMAND_ID, GIT_GRAPH_REVEAL_COMMIT_COMMAND_ID, GIT_GRAPH_REVIEW_COMMIT_COMMAND_ID, InGitGraphContext, OPEN_GIT_GRAPH_COMMAND_ID, OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID } from '../common/voltGitGraph.js';
import { checkGitGraph, setGitGraphCheck } from './gitGraphAccess.js';
import { GitGraphEditor } from './gitGraphEditor.js';
import { GIT_GRAPH_EDITOR_ID, GitGraphEditorInput, GitGraphEditorInputSerializer, IGitGraphRequest } from './gitGraphInput.js';
import { buildGitAgentPrompt, gitAgentPromptTitle, IGitAgentContext, IGitAskAgentArgs, readGitAskAgentArgs } from './gitGraphPrompts.js';

/**
 * The Git Graph, a module of the `volt.git-graph` built-in extension (spec M3). Core's module table
 * (`voltFeatureModuleTable.ts`) loads it the first time one of its commands runs or a saved Git
 * Graph tab is shown; until then stubs stand in for the commands and their menu entries. Disabling
 * the extension disposes everything `activate` registered.
 */

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
async function openGitGraph(accessor: ServicesAccessor, args: IGitGraphOpenArgs, sessionId?: string): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const agentWindow = accessor.get(IVoltAgentWindowService);
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
		// Only a tab that is in the right panel reveals there; revealInTools would otherwise just open the panel.
		if (inTools && agentWindow.revealInTools(existing)) {
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
	const opened = agentWindow.openInTools(input, sessionId, { pinned: true });
	if (opened) {
		await opened;
	} else {
		await editorService.openEditor(input, { pinned: true });
	}
}

class OpenGitGraphAction extends Action2 {
	constructor() {
		super({
			id: OPEN_GIT_GRAPH_COMMAND_ID,
			visibility: 'exported:git.read',
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
}

class OpenGitGraphInToolsAction extends Action2 {
	constructor() {
		super({ id: OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID, visibility: 'public', title: localize2('voltGitGraph.openInTools', "Open Git Graph Beside Chat") });
	}

	override async run(accessor: ServicesAccessor, sessionId?: unknown): Promise<void> {
		await openGitGraph(accessor, {}, typeof sessionId === 'string' ? sessionId : undefined);
	}
}

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

class OpenFileHistoryAction extends Action2 {
	constructor() {
		super({
			id: GIT_GRAPH_FILE_HISTORY_COMMAND_ID,
			visibility: 'public',
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
}

class OpenLineHistoryAction extends Action2 {
	constructor() {
		super({
			id: GIT_GRAPH_LINE_HISTORY_COMMAND_ID,
			visibility: 'public',
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
}

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
	checkGitGraph('readCommit', 'git.read', rootUri?.fsPath);
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
	const agentWindow = accessor.get(IVoltAgentWindowService);
	const graphs: GitGraphEditor[] = [];
	for (const visible of editorService.visibleEditorPanes) {
		if (visible instanceof GitGraphEditor) {
			graphs.push(visible);
		}
	}
	const context = await gitContext(scmService, args);
	const prompt = buildGitAgentPrompt(args, context);
	const display = { text: gitAgentPromptTitle(args, context.subject) };

	checkGitGraph('askAgent', 'agents.send');
	// Beside the graph on screen first (its chat's right panel, full screen too), then the chat on screen.
	let pane: IVoltChatPane | undefined;
	for (const graph of graphs) {
		pane ??= await graph.openSideChat();
	}
	pane ??= await agentWindow.openSideChatOnScreen(agentWindow.visibleChat());
	// No chat on screen: a new chat tab of its own.
	pane ??= await agentWindow.openNewChat();
	if (pane) {
		// A side chat in the right panel is composer-only by default; this one is opened to be read.
		pane.showTranscript();
		pane.submitPrompt(prompt, display);
		return;
	}
	await clipboardService.writeText(prompt);
	notificationService.info(localize('voltGitGraph.promptCopied', "A chat couldn't be opened, so the prompt was copied. Paste it into a chat."));
}

class AskAgentAboutGitAction extends Action2 {
	constructor() {
		super({ id: GIT_GRAPH_ASK_AGENT_COMMAND_ID, visibility: 'exported:agents.send', title: localize2('voltGitGraph.askAgent', "Ask Agent About Commit") });
	}

	override async run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
		const parsed = readGitAskAgentArgs(args);
		if (parsed) {
			await askAgent(accessor, parsed);
		}
	}
}

/** The SCM graph's commit menu (sidebar and the Git Graph tab): Explain / Review with the agent. */
const COMMIT_AGENT_MENU_WHEN = ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), ContextKeyExpr.not('listMultiSelection'));

class ExplainCommitAction extends Action2 {
	constructor() {
		super({
			id: GIT_GRAPH_EXPLAIN_COMMIT_COMMAND_ID,
			visibility: 'internal',
			title: localize2('voltGitGraph.explainCommit', "Explain with Agent"),
			icon: Codicon.sparkle,
			menu: { id: MenuId.SCMHistoryItemContext, group: '0_volt_agent', order: 1, when: COMMIT_AGENT_MENU_WHEN },
		});
	}

	override async run(accessor: ServicesAccessor, provider?: ISCMProvider, historyItem?: ISCMHistoryItem): Promise<void> {
		if (historyItem?.id) {
			await askAgent(accessor, { action: 'explain', commit: historyItem.id, repositoryRoot: provider?.rootUri?.fsPath });
		}
	}
}

class ReviewCommitAction extends Action2 {
	constructor() {
		super({
			id: GIT_GRAPH_REVIEW_COMMIT_COMMAND_ID,
			visibility: 'internal',
			title: localize2('voltGitGraph.reviewCommit', "Review with Agent"),
			icon: Codicon.sparkle,
			menu: { id: MenuId.SCMHistoryItemContext, group: '0_volt_agent', order: 2, when: COMMIT_AGENT_MENU_WHEN },
		});
	}

	override async run(accessor: ServicesAccessor, provider?: ISCMProvider, historyItem?: ISCMHistoryItem): Promise<void> {
		if (historyItem?.id) {
			await askAgent(accessor, { action: 'review', commit: historyItem.id, repositoryRoot: provider?.rootUri?.fsPath });
		}
	}
}

class RevealInGitGraphAction extends Action2 {
	constructor() {
		super({
			id: GIT_GRAPH_REVEAL_COMMIT_COMMAND_ID,
			visibility: 'public',
			title: localize2('voltGitGraph.reveal', "Open in Git Graph"),
			icon: Codicon.sourceControl,
			menu: { id: MenuId.SCMHistoryItemContext, group: '0_view', order: 3, when: ContextKeyExpr.and(ContextKeyExpr.equals('scmProvider', 'git'), InGitGraphContext.negate()) },
		});
	}

	override async run(accessor: ServicesAccessor, provider?: ISCMProvider, historyItem?: ISCMHistoryItem): Promise<void> {
		await openGitGraph(accessor, { repositoryRoot: provider?.rootUri?.fsPath, revealCommit: historyItem?.id });
	}
}

class ExplainLinesAction extends Action2 {
	constructor() {
		super({
			id: GIT_GRAPH_EXPLAIN_LINES_COMMAND_ID,
			visibility: 'internal',
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
}

//#endregion

export const gitGraphModule: IVoltFeatureModule = {
	activate(host: IVoltFeatureModuleHost): void {
		const { plugin, subscriptions } = host;
		// Its uses of git and chats, checked against its manifest (report mode: logged, never refused).
		const reporter = host.instantiationService.invokeFunction(accessor => accessor.get(IVoltPluginService).reporter);
		const principal = { extensionId: plugin.extensionId, label: plugin.manifest.contributes?.voltModule?.label, firstParty: true, capabilities: plugin.manifest.contributes?.voltCapabilities ?? {} };
		subscriptions.add(setGitGraphCheck(request => reporter.check(principal, request)));

		subscriptions.add(Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
			EditorPaneDescriptor.create(GitGraphEditor, GIT_GRAPH_EDITOR_ID, localize('voltGitGraph.editorLabel', "Git Graph")),
			[new SyncDescriptor(GitGraphEditorInput)]
		));
		host.registerEditorSerializer(GitGraphEditorInput.TypeID, new GitGraphEditorInputSerializer());

		// Core took the stubs (and their menu entries) down before activating; these are the real ones.
		subscriptions.add(registerAction2(OpenGitGraphAction));
		subscriptions.add(registerAction2(OpenGitGraphInToolsAction));
		subscriptions.add(registerAction2(OpenFileHistoryAction));
		subscriptions.add(registerAction2(OpenLineHistoryAction));
		subscriptions.add(registerAction2(AskAgentAboutGitAction));
		subscriptions.add(registerAction2(ExplainCommitAction));
		subscriptions.add(registerAction2(ReviewCommitAction));
		subscriptions.add(registerAction2(RevealInGitGraphAction));
		subscriptions.add(registerAction2(ExplainLinesAction));
	},
};
