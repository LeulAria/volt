/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentIdeCard.css';
import { $, append, clearNode, Dimension } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../../../base/common/path.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IEditorOptions, ITextEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { EditorExtensions, IEditorOpenContext, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextEditorService } from '../../../../services/textfile/common/textEditorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ideCapability } from '../../../../services/voltRuntime/common/ide/ideCapabilities.js';
import { IDebugService, REPL_VIEW_ID, VIEWLET_ID as DEBUG_VIEWLET_ID } from '../../../debug/common/debug.js';
import { Markers } from '../../../markers/common/markers.js';
import { NotebookEditorInput } from '../../../notebook/common/notebookEditorInput.js';
import { Testing } from '../../../testing/common/constants.js';
import { IVoltHttpService } from '../../../voltHttp/browser/voltHttpService.js';
import { OPEN_HTTP_EXCHANGE_COMMAND_ID } from '../../../voltHttp/browser/voltHttpViews.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { openInAgentTools } from '../workspace/agentSurfaceHost.js';
import { OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID } from '../workspace/agentSurfaceMenu.js';
import { AgentIdeTabKey, IAgentIdeLogEntry, IAgentIdeService, IDE_AUTO_OPEN_SETTING, OPEN_IDE_ACTIVITY_TAB_COMMAND_ID } from './agentIdeService.js';

const EDITOR_ID = 'workbench.editor.voltAgentIdeActivity';
const INPUT_ID = 'workbench.input.voltAgentIdeActivity';
/** Open entries show this much before "Show more". */
const PREVIEW_LINES = 18;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt',
	properties: {
		[IDE_AUTO_OPEN_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('voltIde.autoOpen', "When an agent uses the IDE (tests, debugger, git, notebooks, Docker, Kubernetes, CI, coverage, HTTP client...), open what it works on as a tab beside the chat. Closing a tab keeps it closed for that chat."),
		},
	},
});

interface ITabAction {
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly run: (accessor: ServicesAccessor) => unknown;
}

interface ITabMeta {
	readonly title: string;
	readonly icon: ThemeIcon;
	readonly actions: readonly ITabAction[];
}

function viewContainer(id: string) {
	return (accessor: ServicesAccessor) => accessor.get(IViewsService).openViewContainer(id, true);
}

function view(id: string) {
	return (accessor: ServicesAccessor) => accessor.get(IViewsService).openView(id, true);
}

function command(id: string, ...args: unknown[]) {
	return (accessor: ServicesAccessor) => accessor.get(ICommandService).executeCommand(id, ...args);
}

/** Each tab's name, icon, and the native views it hands over to. */
function tabMeta(key: AgentIdeTabKey): ITabMeta {
	switch (key) {
		case 'tests': return { title: localize('voltIde.tab.tests', "Tests"), icon: Codicon.beaker, actions: [{ label: localize('voltIde.act.explorer', "Test Explorer"), icon: Codicon.beaker, run: viewContainer(Testing.ViewletId) }, { label: localize('voltIde.act.results', "Test Results"), icon: Codicon.output, run: view(Testing.ResultsViewId) }] };
		case 'debug': return { title: localize('voltIde.tab.debug', "Debugger"), icon: Codicon.debugAlt, actions: [{ label: localize('voltIde.act.runDebug', "Run and Debug"), icon: Codicon.debugAlt, run: viewContainer(DEBUG_VIEWLET_ID) }, { label: localize('voltIde.act.console', "Debug Console"), icon: Codicon.debugConsole, run: view(REPL_VIEW_ID) }] };
		case 'tasks': return { title: localize('voltIde.tab.tasks', "Tasks"), icon: Codicon.tools, actions: [{ label: localize('voltIde.act.terminal', "Terminal"), icon: Codicon.terminal, run: command('workbench.action.terminal.focus') }] };
		case 'git': return { title: localize('voltIde.tab.git', "Source Control"), icon: Codicon.sourceControl, actions: [{ label: localize('voltIde.act.scm', "Source Control"), icon: Codicon.sourceControl, run: viewContainer('workbench.view.scm') }, { label: localize('voltIde.act.graph', "Git Graph"), icon: Codicon.gitCommit, run: command(OPEN_GIT_GRAPH_IN_TOOLS_COMMAND_ID) }] };
		case 'docker': return { title: localize('voltIde.tab.docker', "Containers"), icon: Codicon.vm, actions: [{ label: localize('voltIde.act.containers', "Containers View"), icon: Codicon.vm, run: viewContainer('workbench.view.extension.containersView') }] };
		case 'k8s': return { title: localize('voltIde.tab.k8s', "Kubernetes"), icon: Codicon.cloud, actions: [] };
		case 'ci': return { title: localize('voltIde.tab.ci', "CI/CD"), icon: Codicon.githubAction, actions: [] };
		case 'coverage': return { title: localize('voltIde.tab.coverage', "Coverage"), icon: Codicon.shield, actions: [{ label: localize('voltIde.act.coverage', "Test Coverage"), icon: Codicon.shield, run: view(Testing.CoverageViewId) }] };
		case 'analyze': return { title: localize('voltIde.tab.analyze', "Static Analysis"), icon: Codicon.checklist, actions: [{ label: localize('voltIde.act.problems', "Problems"), icon: Codicon.warning, run: view(Markers.MARKERS_VIEW_ID) }] };
		case 'profile': return { title: localize('voltIde.tab.profile', "Profiler"), icon: Codicon.dashboard, actions: [] };
		case 'extensions': return { title: localize('voltIde.tab.extensions', "Extensions"), icon: Codicon.extensions, actions: [{ label: localize('voltIde.act.extensions', "Extensions View"), icon: Codicon.extensions, run: viewContainer('workbench.view.extensions') }] };
		case 'http': return { title: localize('voltIde.tab.http', "HTTP Client"), icon: Codicon.send, actions: [] };
		case 'notebook': return { title: localize('voltIde.tab.notebook', "Notebook"), icon: Codicon.notebook, actions: [] };
	}
	return { title: ideCapability(key)?.summary ?? key, icon: Codicon.tools, actions: [] };
}

export class AgentIdeActivityInput extends EditorInput {

	static readonly TypeID = INPUT_ID;
	readonly resource: URI;

	constructor(readonly chatId: string, readonly key: AgentIdeTabKey) {
		super();
		this.resource = URI.from({ scheme: 'volt-ide-activity', path: `/${encodeURIComponent(chatId)}/${key}` });
	}

	override get typeId(): string { return INPUT_ID; }
	override get editorId(): string { return EDITOR_ID; }
	override getName(): string { return tabMeta(this.key).title; }
	override getIcon(): ThemeIcon { return tabMeta(this.key).icon; }

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof AgentIdeActivityInput ? other.chatId === this.chatId && other.key === this.key : super.matches(other);
	}
}

/**
 * A capability's tab beside the chat: what the agent did with it, newest first (op, arguments,
 * time, the result as the agent read it), live as calls land, with buttons into the IDE's own
 * views for the same thing (Test Explorer, Run and Debug, Source Control, Containers, Problems...).
 */
export class AgentIdeActivityEditor extends EditorPane {

	static readonly ID = EDITOR_ID;

	private root!: HTMLElement;
	private header!: HTMLElement;
	private feed!: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly expanded = new Set<string>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentIdeService private readonly ide: IAgentIdeService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(EDITOR_ID, group, telemetryService, themeService, storageService);
		this._register(ide.onDidLog(({ chatId, key }) => {
			const input = this.input as AgentIdeActivityInput | undefined;
			if (input && input.chatId === chatId && input.key === key) {
				this.render();
			}
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.root = append(parent, $('.volt-ide-activity'));
		this.header = append(this.root, $('.volt-ide-activity-header'));
		this.feed = append(this.root, $('.volt-ide-activity-feed'));
	}

	override async setInput(input: AgentIdeActivityInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.render();
	}

	private render(): void {
		const input = this.input as AgentIdeActivityInput | undefined;
		if (!input) {
			return;
		}
		this.renderStore.clear();
		clearNode(this.header);
		clearNode(this.feed);
		const meta = tabMeta(input.key);
		const entries = [...this.ide.log(input.chatId, input.key)].reverse();
		const title = append(this.header, $('.volt-ide-activity-title'));
		title.appendChild(renderIcon(meta.icon));
		append(title, $('span.name')).textContent = meta.title;
		append(title, $('span.count')).textContent = localize('voltIde.ops', "{0} agent operation(s)", entries.length);
		const actions = append(this.header, $('.volt-ide-activity-actions'));
		for (const action of meta.actions) {
			const button = this.renderStore.add(createVoltButton(actions, 'ghost', { supportIcons: true }));
			button.label = `$(${action.icon.id}) ${action.label}`;
			this.renderStore.add(button.onDidClick(() => this.instantiationService.invokeFunction(action.run)));
		}
		if (!entries.length) {
			append(this.feed, $('.volt-ide-activity-empty')).textContent = localize('voltIde.empty', "Nothing yet. What the agent does here shows up as it happens.");
			return;
		}
		entries.forEach((entry, index) => this.renderEntry(entry, index === 0));
	}

	private renderEntry(entry: IAgentIdeLogEntry, newest: boolean): void {
		const card = append(this.feed, $('.volt-ide-activity-entry'));
		card.classList.toggle('failed', !entry.ok);
		const head = append(card, $('.volt-ide-activity-entry-head'));
		head.appendChild(renderIcon(entry.ok ? Codicon.pass : Codicon.error));
		append(head, $('code.op')).textContent = entry.op;
		const args = append(head, $('span.args'));
		args.textContent = entry.args;
		args.title = entry.args;
		append(head, $('span.when')).textContent = `${fromNow(entry.at, true)} · ${entry.durationMs < 1000 ? `${entry.durationMs}ms` : `${(entry.durationMs / 1000).toFixed(1)}s`}`;
		const lines = entry.text.split('\n');
		// The newest entry is open (long output capped); older ones show their first lines.
		const limit = this.expanded.has(entry.id) ? lines.length : newest ? PREVIEW_LINES * 4 : 3;
		append(card, $('pre.volt-ide-activity-output')).textContent = lines.slice(0, limit).join('\n');
		const hidden = lines.length - Math.min(limit, lines.length);
		if (hidden > 0) {
			const more = append(card, $('button.volt-ide-activity-more')) as HTMLButtonElement;
			more.type = 'button';
			more.textContent = localize('voltIde.more', "Show {0} more lines", hidden);
			more.addEventListener('click', () => {
				this.expanded.add(entry.id);
				this.render();
			});
		}
	}

	override layout(dimension: Dimension): void {
		this.root.style.height = `${dimension.height}px`;
	}
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AgentIdeActivityEditor, EDITOR_ID, localize('voltIde.activityEditor', "Agent IDE Activity")),
	[new SyncDescriptor(AgentIdeActivityInput)],
);

/** Tabs the user closed after Volt opened them: they stay closed for that chat. */
const dismissed = new Set<string>();

interface IOpenTabRequest {
	readonly chatId: string;
	readonly sessionId?: string;
	readonly root?: string;
	readonly key: AgentIdeTabKey;
	readonly op: string;
	readonly args: Readonly<Record<string, unknown>>;
}

/** Opens `input` beside the chat on screen; in the IDE layout, as a background tab. */
async function openBeside(accessor: ServicesAccessor, input: EditorInput, request: IOpenTabRequest): Promise<void> {
	const options: IEditorOptions = { pinned: true, preserveFocus: true };
	const inTools = openInAgentTools(input, request.sessionId, options) ?? openInAgentTools(input, request.chatId, options);
	if (inTools) {
		await inTools;
		return;
	}
	await accessor.get(IEditorService).openEditor(input, { ...options, inactive: true });
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: OPEN_IDE_ACTIVITY_TAB_COMMAND_ID, title: localize2('voltIde.openTab', "Open Agent IDE Tab") });
	}

	override async run(accessor: ServicesAccessor, request?: IOpenTabRequest): Promise<void> {
		// Remote connections and the editor capability open nothing: the first changes where the
		// window runs, the second already shows the user the file it points at.
		if (!request?.chatId || request.key === 'remote' || request.key === 'editor' || accessor.get(IConfigurationService).getValue<boolean>(IDE_AUTO_OPEN_SETTING) === false) {
			return;
		}
		const dismissKey = `${request.chatId}\u0000${request.key}`;
		if (dismissed.has(dismissKey)) {
			return;
		}
		const editorService = accessor.get(IEditorService);
		// Notebooks and HTTP requests open their own editors; everything else its activity tab.
		if (request.key === 'notebook' && typeof request.args.path === 'string') {
			const root = request.root ? URI.parse(request.root) : undefined;
			const uri = isAbsolute(request.args.path) ? URI.file(request.args.path) : root ? joinPath(root, request.args.path) : undefined;
			if (uri && uri.path.endsWith('.ipynb') && !editorService.findEditors(uri).length && request.op !== 'create') {
				await openBeside(accessor, NotebookEditorInput.getOrCreate(accessor.get(IInstantiationService), uri, undefined, 'jupyter-notebook'), request);
			}
			return;
		}
		if (request.key === 'http') {
			const latest = accessor.get(IVoltHttpService).history[0];
			if (request.op === 'send' && latest) {
				await accessor.get(ICommandService).executeCommand(OPEN_HTTP_EXCHANGE_COMMAND_ID, latest.id, request.sessionId ?? request.chatId);
			}
			return;
		}
		// The debugger: the line it paused on, beside the chat (the editor shows the debug highlight).
		if (request.key === 'debug') {
			const frame = accessor.get(IDebugService).getViewModel().focusedStackFrame;
			if (frame?.source.available && frame.thread.stopped) {
				const line = frame.range.startLineNumber;
				const source = accessor.get(ITextEditorService).createTextEditor({ resource: frame.source.uri });
				const options: ITextEditorOptions = { pinned: true, preserveFocus: true, selection: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, revealIfOpened: true };
				const inTools = openInAgentTools(source, request.sessionId, options) ?? openInAgentTools(source, request.chatId, options);
				if (inTools) {
					await inTools;
				}
			}
		}
		const input = new AgentIdeActivityInput(request.chatId, request.key);
		if (editorService.editors.some(editor => editor.matches(input))) {
			input.dispose();
			return;
		}
		input.onWillDispose(() => dismissed.add(dismissKey));
		await openBeside(accessor, input, request);
	}
});
