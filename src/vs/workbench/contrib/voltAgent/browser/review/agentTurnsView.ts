/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../base/browser/dom.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { IIdentityProvider, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { IAsyncDataSource, ITreeNode, ITreeRenderer } from '../../../../../base/browser/ui/tree/tree.js';
import { Action } from '../../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../../base/common/observable.js';
import { basename, joinPath, relativePath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ResourceLabels } from '../../../../browser/labels.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { IMultiDiffEditorOptions } from '../../../../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.js';
import { MultiDiffEditorInput } from '../../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { MultiDiffEditorItem } from '../../../multiDiffEditor/browser/multiDiffSourceResolverService.js';
import { VIEWLET_ID as SCM_VIEWLET_ID } from '../../../scm/common/scm.js';
import { CHECKPOINT_REDO_COMMAND_ID, CHECKPOINT_RESTORE_COMMAND_ID, IAgentCheckpointService } from './agentCheckpointService.js';
import { AgentChangesScope, agentTurnScope, IAgentChangesTurn, IAgentSessionChangeStats } from './agentSessionChanges.js';
import { getAgentChangesSourceUri, IAgentSessionChangesService } from './agentSessionChangesService.js';

export const AGENT_TURNS_VIEW_ID = 'workbench.scm.voltAgentTurns';

/** The chat whose Changes tab shows Source Control; Agent Turns lists that chat's turns. */
const changesSession = observableValue<string | undefined>('voltAgentChangesSession', undefined);

/** The Changes tab calls this as it shows and hides; Agent Turns is a view only while one shows. */
export function setAgentChangesSession(sessionId: string | undefined): void {
	changesSession.set(sessionId, undefined);
}

const AgentChangesSessionContext = new RawContextKey<boolean>('voltAgentChangesSession', false, localize('voltAgent.turns.sessionContext', "Whether the agent window's Changes tab shows Source Control for a chat."));
const AgentTurnsCanRedoContext = new RawContextKey<boolean>('voltAgentTurnsCanRedo', false);

/** A turn of the chat that changed files, with its line counts (zero until its snapshots are read). */
interface ITurnElement {
	readonly kind: 'turn';
	readonly sessionId: string;
	readonly turn: IAgentChangesTurn;
	readonly stats: IAgentSessionChangeStats;
	/** How many later turns an undo of this one takes back too. */
	readonly laterTurns: number;
}

/** A file the turn changed; it opens in the turn's diff. */
interface IFileElement {
	readonly kind: 'file';
	readonly sessionId: string;
	readonly turnId: string;
	readonly item: MultiDiffEditorItem;
	readonly uri: URI;
	readonly stats: IAgentSessionChangeStats | undefined;
}

/** A folder of a turn's files; one holding nothing but one folder shares its row (`apps/docs/src`). */
interface IFolderElement {
	readonly kind: 'folder';
	readonly turnId: string;
	readonly uri: URI;
	readonly label: string;
	readonly children: readonly (IFolderElement | IFileElement)[];
}

type AgentTurnsElement = ITurnElement | IFolderElement | IFileElement;

interface IFolderEntries { readonly folders: Map<string, IFolderEntries>; readonly files: IFileElement[] }

/** A turn's files as a tree of their folders, folders first, as Source Control's tree view lists changes. */
function toFileTree(turnId: string, root: URI | undefined, files: readonly IFileElement[]): (IFolderElement | IFileElement)[] {
	const top: IFolderEntries = { folders: new Map(), files: [] };
	for (const file of files) {
		const relative = root ? relativePath(root, file.uri) : undefined;
		let folder = top;
		for (const part of relative ? relative.split('/').slice(0, -1) : []) {
			let next = folder.folders.get(part);
			if (!next) {
				next = { folders: new Map(), files: [] };
				folder.folders.set(part, next);
			}
			folder = next;
		}
		folder.files.push(file);
	}
	const build = (entries: IFolderEntries, folderUri: URI | undefined): (IFolderElement | IFileElement)[] => {
		const folders = [...entries.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]): IFolderElement => {
			let label = name;
			let uri = folderUri ? joinPath(folderUri, name) : URI.file(name);
			let current = child;
			while (current.files.length === 0 && current.folders.size === 1) {
				const [nextName, next] = [...current.folders][0];
				label = `${label}/${nextName}`;
				uri = joinPath(uri, nextName);
				current = next;
			}
			return { kind: 'folder', turnId, uri, label, children: build(current, uri) };
		});
		const sorted = [...entries.files].sort((a, b) => basename(a.uri).localeCompare(basename(b.uri)));
		return [...folders, ...sorted];
	};
	return build(top, root);
}

function turnLabel(turn: IAgentChangesTurn): string {
	const prompt = turn.prompt?.trim().split(/\r?\n/, 1)[0];
	return prompt || localize('voltAgent.turns.turn', "Turn {0}", turn.number);
}

function renderStats(element: HTMLElement, stats: IAgentSessionChangeStats | undefined): void {
	element.replaceChildren();
	if (stats?.additions) {
		append(element, $('span.add')).textContent = `+${stats.additions}`;
	}
	if (stats?.deletions) {
		append(element, $('span.del')).textContent = `-${stats.deletions}`;
	}
}

class AgentTurnsDelegate implements IListVirtualDelegate<AgentTurnsElement> {
	getHeight(): number {
		return 22;
	}
	getTemplateId(element: AgentTurnsElement): string {
		return element.kind === 'turn' ? TurnRenderer.ID : FileRenderer.ID;
	}
}

interface IAgentTurnsHost {
	openTurn(turn: ITurnElement): void;
	undoTurn(turn: ITurnElement): void;
}

interface ITurnTemplate {
	readonly label: HTMLElement;
	readonly description: HTMLElement;
	readonly stats: HTMLElement;
	readonly actionBar: ActionBar;
}

class TurnRenderer implements ITreeRenderer<AgentTurnsElement, void, ITurnTemplate> {
	static readonly ID = 'turn';
	readonly templateId = TurnRenderer.ID;

	constructor(private readonly host: IAgentTurnsHost) { }

	renderTemplate(container: HTMLElement): ITurnTemplate {
		const row = append(container, $('.volt-agent-turns-row'));
		append(row, $('span.volt-agent-turns-icon'));
		const label = append(row, $('span.volt-agent-turns-label'));
		const description = append(row, $('span.volt-agent-turns-description'));
		const actionBar = new ActionBar(append(row, $('.volt-agent-turns-actions')));
		const stats = append(row, $('span.volt-agent-turns-stats'));
		return { label, description, stats, actionBar };
	}

	renderElement(node: ITreeNode<AgentTurnsElement, void>, _index: number, template: ITurnTemplate): void {
		const element = node.element;
		if (element.kind !== 'turn') {
			return;
		}
		template.label.textContent = turnLabel(element.turn);
		template.label.title = element.turn.prompt ?? '';
		template.description.textContent = element.turn.prompt ? localize('voltAgent.turns.turn', "Turn {0}", element.turn.number) : '';
		renderStats(template.stats, element.stats);
		template.actionBar.clear();
		template.actionBar.push([
			new Action('voltAgent.turns.openChanges', localize('voltAgent.turns.openChanges', "Open Changes"), ThemeIcon.asClassName(Codicon.diffMultiple), true, async () => this.host.openTurn(element)),
			new Action('voltAgent.turns.undo', element.laterTurns
				? localize('voltAgent.turns.undoWithLater', "Undo This Turn and Later Ones")
				: localize('voltAgent.turns.undo', "Undo This Turn"), ThemeIcon.asClassName(Codicon.discard), true, async () => this.host.undoTurn(element)),
		], { icon: true, label: false });
	}

	disposeTemplate(template: ITurnTemplate): void {
		template.actionBar.dispose();
	}
}

interface IFileTemplate {
	readonly label: ReturnType<ResourceLabels['create']>;
	readonly stats: HTMLElement;
}

class FileRenderer implements ITreeRenderer<AgentTurnsElement, void, IFileTemplate> {
	static readonly ID = 'file';
	readonly templateId = FileRenderer.ID;

	constructor(private readonly labels: ResourceLabels) { }

	renderTemplate(container: HTMLElement): IFileTemplate {
		const row = append(container, $('.volt-agent-turns-file'));
		const label = this.labels.create(append(row, $('.volt-agent-turns-file-label')), { supportHighlights: false, supportIcons: true });
		const stats = append(row, $('span.volt-agent-turns-stats'));
		return { label, stats };
	}

	renderElement(node: ITreeNode<AgentTurnsElement, void>, _index: number, template: IFileTemplate): void {
		const element = node.element;
		if (element.kind === 'folder') {
			template.label.setResource({ resource: element.uri, name: element.label }, { fileKind: FileKind.FOLDER });
			renderStats(template.stats, undefined);
			return;
		}
		if (element.kind !== 'file') {
			return;
		}
		// The folder rows above say where it is.
		template.label.setResource({ resource: element.uri, name: basename(element.uri) }, {
			fileKind: FileKind.FILE,
			strikethrough: !element.item.modifiedUri,
		});
		renderStats(template.stats, element.stats);
	}

	disposeTemplate(template: IFileTemplate): void {
		template.label.dispose();
	}
}

/**
 * Agent Turns, in Source Control beside Changes: each turn of the chat that changed files, newest
 * first, with its line counts, like a stash. It opens to its files; a file opens the turn's diff.
 * Undo puts the files back as they were before the turn (later turns too); Redo brings them back.
 */
export class AgentTurnsViewPane extends ViewPane {

	private tree: WorkbenchAsyncDataTree<string, AgentTurnsElement, void> | undefined;
	private sessionId: string | undefined;
	private readonly sessionStore = this._register(new DisposableStore());
	private readonly refreshScheduler = this._register(new RunOnceScheduler(() => void this.tree?.updateChildren(undefined, true), 50));
	private readonly canRedo: IContextKey<boolean>;
	private readonly treeStore = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IAgentSessionChangesService private readonly changesService: IAgentSessionChangesService,
		@IAgentCheckpointService private readonly checkpoints: IAgentCheckpointService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@ICommandService private readonly commandService: ICommandService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.canRedo = AgentTurnsCanRedoContext.bindTo(this.scopedContextKeyService);
		this._register(autorun(reader => this.setSession(changesSession.read(reader))));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('volt-agent-turns-view');
		const store = new DisposableStore();
		this.treeStore.value = store;
		const labels = store.add(this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: this.onDidChangeBodyVisibility }));
		const identityProvider: IIdentityProvider<AgentTurnsElement> = {
			getId: element => element.kind === 'turn' ? `turn:${element.turn.turnId}` : `${element.kind}:${element.turnId}:${element.uri.toString()}`,
		};
		const dataSource: IAsyncDataSource<string, AgentTurnsElement> = {
			hasChildren: element => typeof element === 'string' || element.kind !== 'file',
			getChildren: async element => {
				if (typeof element === 'string') {
					return this.turnElements(element);
				}
				return element.kind === 'turn' ? this.fileElements(element) : element.kind === 'folder' ? [...element.children] : [];
			},
		};
		const host: IAgentTurnsHost = {
			openTurn: turn => void this.openTurn(turn),
			undoTurn: turn => void this.undoTurn(turn),
		};
		const tree = this.tree = store.add(this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<string, AgentTurnsElement, void>,
			'VoltAgentTurns',
			// File icons, as Source Control's own tree shows them.
			append(container, $('.volt-agent-turns-tree.file-icon-themable-tree.show-file-icons')),
			new AgentTurnsDelegate(),
			[new TurnRenderer(host), new FileRenderer(labels)],
			dataSource,
			{
				identityProvider,
				multipleSelectionSupport: false,
				// Turns open on demand; a turn's folders open with it.
				collapseByDefault: element => element.kind === 'turn',
				overrideStyles: this.getLocationBasedColors().listOverrideStyles,
				accessibilityProvider: {
					getAriaLabel: element => element.kind === 'turn'
						? localize('voltAgent.turns.turnAria', "{0}, {1} lines added, {2} removed", turnLabel(element.turn), element.stats.additions, element.stats.deletions)
						: element.kind === 'folder' ? element.label : basename(element.uri),
					getWidgetAriaLabel: () => localize('voltAgent.turns.aria', "Agent Turns"),
				},
			},
		));
		store.add(tree.onDidOpen(e => {
			if (e.element?.kind === 'file') {
				void this.openFile(e.element, !!e.editorOptions.preserveFocus);
			}
		}));
		if (this.sessionId) {
			void tree.setInput(this.sessionId);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}

	override shouldShowWelcome(): boolean {
		return !this.sessionId || this.changesService.getTurns(this.sessionId).length === 0;
	}

	private setSession(sessionId: string | undefined): void {
		if (sessionId === this.sessionId) {
			return;
		}
		this.sessionId = sessionId;
		this.sessionStore.clear();
		if (sessionId) {
			const refresh = (changed: string) => {
				if (changed === sessionId) {
					if (!this.changesService.getTurns(sessionId).length) {
						// The first load can come before the chat's folder is known; ask again.
						void this.checkpoints.loadCheckpoints(sessionId).catch(() => undefined);
					}
					this.canRedo.set(this.checkpoints.canRedo(sessionId));
					this._onDidChangeViewWelcomeState.fire();
					this.refreshScheduler.schedule();
				}
			};
			this.sessionStore.add(this.changesService.onDidChange(refresh));
			this.sessionStore.add(this.checkpoints.onDidChange(refresh));
			// Turns come from the chat's checkpoints, which load on demand.
			void this.checkpoints.loadCheckpoints(sessionId).then(() => refresh(sessionId), () => undefined);
			this.canRedo.set(this.checkpoints.canRedo(sessionId));
			void this.tree?.setInput(sessionId);
		}
		this._onDidChangeViewWelcomeState.fire();
	}

	private turnElements(sessionId: string): ITurnElement[] {
		const turns = this.changesService.getTurns(sessionId);
		return turns.map((turn, index): ITurnElement => ({
			kind: 'turn',
			sessionId,
			turn,
			// Reads the turn's snapshots the first time; a change event brings the counts.
			stats: this.changesService.getStats(sessionId, agentTurnScope(turn.turnId)),
			laterTurns: turns.length - 1 - index,
		})).reverse();
	}

	private fileElements(turn: ITurnElement): (IFolderElement | IFileElement)[] {
		const scope = agentTurnScope(turn.turn.turnId);
		const files = this.changesService.getMultiDiffItems(turn.sessionId, scope).flatMap((item): IFileElement[] => {
			const uri = item.goToFileUri ?? item.modifiedUri ?? item.originalUri;
			return uri ? [{
				kind: 'file',
				sessionId: turn.sessionId,
				turnId: turn.turn.turnId,
				item,
				uri,
				stats: this.changesService.getFileStats(turn.sessionId, scope, uri),
			}] : [];
		});
		return toFileTree(turn.turn.turnId, this.sessionContext.rootFor(turn.sessionId), files);
	}

	private turnDiffInput(sessionId: string, turn: IAgentChangesTurn): MultiDiffEditorInput {
		const scope: AgentChangesScope = agentTurnScope(turn.turnId);
		return MultiDiffEditorInput.fromResourceMultiDiffEditorInput({
			multiDiffSource: getAgentChangesSourceUri(sessionId, scope),
			label: localize('voltAgent.turns.diffTitle', "Turn {0}: {1}", turn.number, turnLabel(turn)),
		}, this.instantiationService);
	}

	private async openTurn(element: ITurnElement): Promise<void> {
		await this.editorService.openEditor(this.turnDiffInput(element.sessionId, element.turn), { pinned: true });
	}

	private async openFile(element: IFileElement, preserveFocus: boolean): Promise<void> {
		const turn = this.changesService.getTurns(element.sessionId).find(turn => turn.turnId === element.turnId);
		if (!turn) {
			return;
		}
		const options: IMultiDiffEditorOptions = {
			pinned: true,
			preserveFocus,
			viewState: { revealData: { resource: { original: element.item.originalUri, modified: element.item.modifiedUri } } },
		};
		await this.editorService.openEditor(this.turnDiffInput(element.sessionId, turn), options);
	}

	private async undoTurn(element: ITurnElement): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: element.laterTurns
				? localize('voltAgent.turns.undoLaterConfirm', "Undo turn {0} and the {1} turns after it?", element.turn.number, element.laterTurns)
				: localize('voltAgent.turns.undoConfirm', "Undo turn {0}?", element.turn.number),
			detail: localize('voltAgent.turns.undoDetail', "The files the agent changed go back to how they were before this turn, shell side effects included. Redo in Agent Turns brings them back."),
			primaryButton: localize({ key: 'voltAgent.turns.undoButton', comment: ['&& denotes a mnemonic'] }, "&&Undo"),
		});
		if (confirmed) {
			await this.commandService.executeCommand(CHECKPOINT_RESTORE_COMMAND_ID, { sessionId: element.sessionId, turnId: element.turn.turnId });
		}
	}

	redo(): Promise<unknown> {
		return this.sessionId ? this.commandService.executeCommand(CHECKPOINT_REDO_COMMAND_ID, { sessionId: this.sessionId }) : Promise.resolve();
	}
}

registerAction2(class RedoAgentTurnAction extends Action2 {
	constructor() {
		super({
			id: 'voltAgent.turns.redo',
			title: localize2('voltAgent.turns.redo', "Redo Undone Turns"),
			icon: Codicon.redo,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.and(ContextKeyExpr.equals('view', AGENT_TURNS_VIEW_ID), AgentTurnsCanRedoContext),
				group: 'navigation',
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).getViewWithId<AgentTurnsViewPane>(AGENT_TURNS_VIEW_ID)?.redo();
	}
});

/** Puts Agent Turns in the Source Control container, shown while a Changes tab shows a chat. */
export class AgentTurnsViewContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltAgentTurnsView';

	constructor(@IContextKeyService contextKeyService: IContextKeyService) {
		super();
		const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).get(SCM_VIEWLET_ID);
		if (!container) {
			return;
		}
		const views = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		views.registerViews([{
			id: AGENT_TURNS_VIEW_ID,
			name: localize2('voltAgent.turns.view', "Agent Turns"),
			ctorDescriptor: new SyncDescriptor(AgentTurnsViewPane),
			when: AgentChangesSessionContext,
			// After Changes, before Graph.
			order: 1.5,
			canToggleVisibility: true,
			canMoveView: false,
			collapsed: false,
		}], container);
		this._register(views.registerViewWelcomeContent(AGENT_TURNS_VIEW_ID, {
			content: localize('voltAgent.turns.empty', "The agent has not changed any files in this chat yet."),
		}));
		const hasSession = AgentChangesSessionContext.bindTo(contextKeyService);
		this._register(autorun(reader => hasSession.set(!!changesSession.read(reader))));
	}
}
