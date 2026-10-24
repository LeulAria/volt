/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentTitlebarHeader.css';
import { $, addDisposableListener, append, isHTMLElement } from '../../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { tildify } from '../../../../../base/common/labels.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { autorun } from '../../../../../base/common/observable.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { getLayoutMode, onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IVoltSessionContextService, projectIdForRoot, uriFromStoredRoot } from '../../../../services/voltRuntime/common/sessionContext.js';
import { AGENT_HOME_NEW_CHAT_ICON_PATH } from '../home/agentHomeIcons.js';
import { scratchProjectLabel } from '../home/agentHomeWorkspace.js';
import { ISCMService, ISCMViewService } from '../../../scm/common/scm.js';
import { AutomationsEditorInput } from '../automations/automationsEditor.js';
import { AgentCustomizeEditorInput } from '../customize/agentCustomizeEditor.js';
import { IAgentPageCrumb } from '../customize/agentMarketplaceView.js';
import { AgentEditorInput, NEW_AGENT_COMMAND_ID } from '../editor/agentEditorInput.js';
import { localEnvironmentLabel } from '../home/agentHomeFilter.js';
import { ScratchBoardEditorInput } from '../scratchBoard/scratchBoardInput.js';
import { getComputerName, onDidChangeComputerName } from '../usage/agentComputerName.js';
import { AgentUsageEditorInput } from '../usage/agentUsageEditor.js';
import { displayComputerName, IUsageEnvironmentSelection, showUsageEnvironmentMenu, usageEnvironmentTriggerLabel, usageMachineName } from '../usage/agentUsageEnvironmentMenu.js';
import { setAgentTooltip } from './agentTooltip.js';

const QUICK_OPEN_COMMAND_ID = 'workbench.action.quickOpenWithModes';
const HEADER_TITLE_WORD_LIMIT = 3;
const HEADER_PATH_MAX_LENGTH = 37;
/** Grace period so the pointer can cross the gap between the title and the card. */
const HEADER_HOVER_HIDE_DELAY = 150;
const HEADER_COPIED_FEEDBACK_MS = 1200;

/** Folder glyph shown beside the project path. */
export const AGENT_HEADER_FOLDER_PATH = 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z';
/** Branch curve of the git glyph. The stem and two nodes are separate shapes. */
export const AGENT_HEADER_GIT_PATH = 'M18 9a9 9 0 0 1-9 9';
/** Same magnifying glass the command center uses. */
export const AGENT_HEADER_SEARCH_PATH = 'M17 17L22 22M19.5 10.75C19.5 15.5825 15.5825 19.5 10.75 19.5C5.91751 19.5 2 15.5825 2 10.75C2 5.91751 5.91751 2 10.75 2C15.5825 2 19.5 5.91751 19.5 10.75Z';

/** One card row: a title with an optional muted subtitle underneath. */
export interface AgentHeaderHoverLine {
	readonly kind: 'branch' | 'path';
	readonly title: string;
	readonly subtitle?: string;
}

export interface IPrimaryHeaderSidebarFlags {
	readonly toggleInTitlebar: boolean;
	readonly auxiliaryBarHidden: boolean;
	readonly leftCollapsed: boolean;
}

/** First three words of the active tab title. A shorter title stays whole. */
export function shortTabTitle(title: string, maxWords = HEADER_TITLE_WORD_LIMIT): string {
	const words = title.trim().split(/\s+/).filter(word => word.length > 0);
	return words.slice(0, Math.max(0, maxWords)).join(' ');
}

/** A fresh agent tab is the empty New Agent screen, not a chat that already has turns. */
export function isNewAgentWindow(isAgentEditor: boolean, title: string, untitledTitle: string, turns: number): boolean {
	return isAgentEditor && turns <= 0 && title.trim() === untitledTitle.trim();
}

/** Search sits on the primary header only after the agent sidebar closes. */
export function primaryHeaderShowsSearch(sidebarClosed: boolean): boolean {
	return sidebarClosed;
}

/** New Agent sits there too, before Search, also while that screen is open. */
export function primaryHeaderShowsNewAgent(sidebarClosed: boolean): boolean {
	return sidebarClosed;
}

/** Closed when the sidebar toggle has moved onto the primary title bar. */
export function primaryHeaderSidebarClosed(flags: IPrimaryHeaderSidebarFlags): boolean {
	return flags.toggleInTitlebar || flags.auxiliaryBarHidden || flags.leftCollapsed;
}

export function headerBranchName(refName: string | undefined): string | undefined {
	const name = refName?.replace(/^refs\/heads\//, '').trim();
	return name || undefined;
}

/** First saved folder wins. Blank entries are skipped. */
export function headerFolderPath(...paths: readonly (string | undefined)[]): string | undefined {
	for (const path of paths) {
		const value = path?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

/** Home-relative path, cut off so the hover card stays one line. */
export function formatHeaderFolderPath(fsPath: string, userHome: string | undefined, maxLength = HEADER_PATH_MAX_LENGTH): string {
	const labeled = userHome ? tildify(fsPath, userHome) : fsPath;
	if (labeled.length <= maxLength) {
		return labeled;
	}
	const keep = Math.max(1, maxLength - 3);
	return `${labeled.slice(0, keep).trimEnd()}...`;
}

/**
 * Repository: project name over the branch, then the folder path.
 * No repository: one folder row, project name over the path.
 */
export function agentHeaderHoverLines(name: string | undefined, branch: string | undefined, path: string | undefined): AgentHeaderHoverLine[] {
	const pathText = path?.trim();
	if (!pathText) {
		return [];
	}
	const title = name?.trim() || pathText;
	const branchText = branch?.trim();
	if (branchText) {
		return [
			{ kind: 'branch', title, subtitle: branchText },
			{ kind: 'path', title: pathText },
		];
	}
	return title === pathText ? [{ kind: 'path', title }] : [{ kind: 'path', title, subtitle: pathText }];
}

function folderDisplayPath(uri: URI): string {
	return uri.scheme === Schemas.file ? uri.fsPath : uri.path;
}

/**
 * The computer's name as the machine menu shows it ("Leul's MacBook Pro"), or undefined while it
 * is unknown. A dotted host name is not that label: "This Mac" stays until the real name arrives.
 */
function machineDisplayName(raw: string | undefined): string | undefined {
	let display = raw ? displayComputerName(raw).replace(/\.local$/i, '').trim() : '';
	if (display && !display.includes(' ') && display.includes('-')) {
		display = display.replace(/-/g, ' ');
	}
	return display && (display.includes(' ') || !display.includes('.')) ? display : undefined;
}

function strokeAttrs(el: SVGElement, width: string): void {
	el.setAttribute('fill', 'none');
	el.setAttribute('stroke', 'currentColor');
	el.setAttribute('stroke-width', width);
	el.setAttribute('stroke-linecap', 'round');
	el.setAttribute('stroke-linejoin', 'round');
}

function createHeaderSvg(doc: Document, size: number): SVGElement {
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	return svg;
}

export function createAgentHeaderFolderIcon(parent: HTMLElement, size = 15): SVGElement {
	const svg = createHeaderSvg(parent.ownerDocument, size);
	const path = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', AGENT_HEADER_FOLDER_PATH);
	strokeAttrs(path, '1.5');
	svg.appendChild(path);
	parent.appendChild(svg);
	return svg;
}

export function createAgentHeaderGitIcon(parent: HTMLElement, size = 15): SVGElement {
	const doc = parent.ownerDocument;
	const svg = createHeaderSvg(doc, size);
	const stem = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
	stem.setAttribute('x1', '6');
	stem.setAttribute('y1', '3');
	stem.setAttribute('x2', '6');
	stem.setAttribute('y2', '15');
	strokeAttrs(stem, '1.5');
	const remote = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
	remote.setAttribute('cx', '18');
	remote.setAttribute('cy', '6');
	remote.setAttribute('r', '3');
	strokeAttrs(remote, '1.5');
	const local = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
	local.setAttribute('cx', '6');
	local.setAttribute('cy', '18');
	local.setAttribute('r', '3');
	strokeAttrs(local, '1.5');
	const curve = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
	curve.setAttribute('d', AGENT_HEADER_GIT_PATH);
	strokeAttrs(curve, '1.5');
	svg.append(stem, remote, local, curve);
	parent.appendChild(svg);
	return svg;
}

function createAgentHeaderSearchIcon(parent: HTMLElement): SVGElement {
	const svg = createHeaderSvg(parent.ownerDocument, 16);
	const path = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', AGENT_HEADER_SEARCH_PATH);
	strokeAttrs(path, '1.5');
	svg.appendChild(path);
	parent.appendChild(svg);
	return svg;
}

/**
 * The paper plane of the sidebar's New Chat row, matched to the search beside it: the plane spans
 * 18 of 24 units where the glass spans 20, so the view box is cropped to scale it up, and the
 * stroke is thinned in user units so both draw the same 1px line.
 */
function createAgentHeaderNewChatIcon(parent: HTMLElement): SVGElement {
	const svg = createHeaderSvg(parent.ownerDocument, 16);
	svg.setAttribute('viewBox', '1.1 1.1 21.8 21.8');
	const path = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', AGENT_HOME_NEW_CHAT_ICON_PATH);
	strokeAttrs(path, '1.36');
	svg.appendChild(path);
	parent.appendChild(svg);
	return svg;
}

function createAgentHeaderCopyIcon(parent: HTMLElement): SVGElement {
	const doc = parent.ownerDocument;
	const svg = createHeaderSvg(doc, 14);
	const front = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
	front.setAttribute('x', '8');
	front.setAttribute('y', '8');
	front.setAttribute('width', '14');
	front.setAttribute('height', '14');
	front.setAttribute('rx', '2');
	strokeAttrs(front, '1.5');
	const back = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
	back.setAttribute('d', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2');
	strokeAttrs(back, '1.5');
	svg.append(front, back);
	parent.appendChild(svg);
	return svg;
}

function createAgentHeaderCheckIcon(parent: HTMLElement): SVGElement {
	const svg = createHeaderSvg(parent.ownerDocument, 14);
	const path = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M20 6 9 17l-5-5');
	strokeAttrs(path, '1.5');
	svg.appendChild(path);
	parent.appendChild(svg);
	return svg;
}

/** The slanted slash between title bar crumbs. */
export function createAgentHeaderSeparatorIcon(parent: HTMLElement): SVGElement {
	const svg = createHeaderSvg(parent.ownerDocument, 14);
	const path = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M15.256 3.04243C15.6453 3.18399 15.8461 3.61434 15.7046 4.00364L9.7046 20.504C9.56304 20.8933 9.13271 21.0942 8.74342 20.9526C8.35414 20.811 8.15331 20.3807 8.29487 19.9914L14.2948 3.49099C14.4364 3.1017 14.8667 2.90087 15.256 3.04243Z');
	path.setAttribute('fill', 'currentColor');
	path.setAttribute('fill-rule', 'evenodd');
	path.setAttribute('clip-rule', 'evenodd');
	svg.appendChild(path);
	parent.appendChild(svg);
	return svg;
}

function createAgentHeaderLaptopIcon(parent: HTMLElement): SVGElement {
	const svg = createHeaderSvg(parent.ownerDocument, 14);
	const path = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16');
	strokeAttrs(path, '1.5');
	svg.appendChild(path);
	parent.appendChild(svg);
	return svg;
}

function createAgentHeaderChevronIcon(parent: HTMLElement): SVGElement {
	const svg = createHeaderSvg(parent.ownerDocument, 12);
	const path = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', 'M6 9l6 6 6-6');
	strokeAttrs(path, '1.75');
	svg.appendChild(path);
	parent.appendChild(svg);
	return svg;
}

function headerProcessEnv(): { COMPUTERNAME?: string; HOSTNAME?: string } | undefined {
	const vscode = (globalThis as { vscode?: { process?: { env?: { COMPUTERNAME?: string; HOSTNAME?: string } } } }).vscode;
	return vscode?.process?.env;
}

/**
 * Primary title bar in agent layout.
 * Open sidebar: project name / short tab title. Hover shows the project, its branch when there is one, and the folder,
 * with a button that copies the absolute folder path.
 * Closed sidebar: the same title, plus search, and New Agent unless that screen is already open.
 * Usage: "Usage / All environments", a menu of this computer and Model prices.
 */
class AgentTitlebarHeaderContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentTitlebarHeader';

	private readonly element: HTMLElement;
	/** Empty space after the title that moves the window. It never overlaps a control. */
	private readonly dragSpacer: HTMLElement;
	private readonly searchButton: HTMLButtonElement;
	private readonly newAgentButton: HTMLButtonElement;
	private readonly titleCluster: HTMLElement;
	private readonly projectLabel: HTMLElement;
	private readonly projectSeparator: HTMLElement;
	private readonly titleLabel: HTMLElement;
	/** Customize's trail after its title: Marketplace, then the open skill or plugin. */
	private readonly crumbsEl: HTMLElement;
	private readonly crumbStore = this._register(new DisposableStore());
	private crumbs: readonly IAgentPageCrumb[] = [];
	private titleHome: (() => void) | undefined;
	private readonly envButton: HTMLButtonElement;
	private readonly envLabel: HTMLElement;
	private readonly laptop: HTMLElement;
	private readonly hover: HTMLElement;
	private readonly editorListeners = this._register(new DisposableStore());
	private readonly scmWatch = this._register(new MutableDisposable());
	private readonly hideTimer = this._register(new MutableDisposable());
	private readonly copiedTimer = this._register(new MutableDisposable());
	private copied = false;
	private userHome: string | undefined;
	private renderScheduled = false;
	private usageCrumb = false;
	private environments: IUsageEnvironmentSelection = { all: true, local: true };
	private machineLabel: string;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@IAgentHistoryService private readonly history: IAgentHistoryService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super();
		this.machineLabel = machineDisplayName(getComputerName()) ?? usageMachineName(headerProcessEnv(), localEnvironmentLabel());
		// The desktop reports the computer's name shortly after startup.
		this._register(onDidChangeComputerName(() => {
			const display = machineDisplayName(getComputerName());
			if (display && display !== this.machineLabel) {
				this.machineLabel = display;
				this.scheduleRender();
			}
		}));
		this.element = $('.volt-agent-primary-header');
		this.element.hidden = true;
		this.dragSpacer = $('.volt-agent-titlebar-drag');
		this.dragSpacer.hidden = true;
		this._register({ dispose: () => this.dragSpacer.remove() });

		this.newAgentButton = append(this.element, $('button.volt-agent-primary-header-button.volt-agent-primary-header-new.volt-titlebar-control')) as HTMLButtonElement;
		this.newAgentButton.type = 'button';
		createAgentHeaderNewChatIcon(this.newAgentButton);

		this.searchButton = append(this.element, $('button.volt-agent-primary-header-button.volt-agent-primary-header-search.volt-titlebar-control')) as HTMLButtonElement;
		this.searchButton.type = 'button';
		createAgentHeaderSearchIcon(this.searchButton);

		this.titleCluster = append(this.element, $('.volt-agent-primary-header-title'));
		this.projectLabel = append(this.titleCluster, $('span.volt-agent-primary-header-project'));
		this.projectSeparator = append(this.titleCluster, $('span.volt-agent-primary-header-separator'));
		createAgentHeaderSeparatorIcon(this.projectSeparator);
		this.titleLabel = append(this.titleCluster, $('span.volt-agent-primary-header-label'));
		this._register(addDisposableListener(this.titleLabel, 'click', event => {
			if (this.titleHome) {
				event.preventDefault();
				event.stopPropagation();
				this.titleHome();
			}
		}));
		this._register(addDisposableListener(this.titleLabel, 'keydown', event => {
			if (this.titleHome && (event.key === 'Enter' || event.key === ' ')) {
				event.preventDefault();
				this.titleHome();
			}
		}));
		this.crumbsEl = append(this.titleCluster, $('span.volt-agent-primary-header-crumbs'));
		this.crumbsEl.hidden = true;
		this.envButton = append(this.titleCluster, $('button.volt-agent-primary-header-env')) as HTMLButtonElement;
		this.envButton.type = 'button';
		this.envButton.hidden = true;
		this.envButton.setAttribute('aria-haspopup', 'menu');
		this.envButton.setAttribute('aria-expanded', 'false');
		this.envLabel = append(this.envButton, $('span.volt-agent-primary-header-env-label'));
		createAgentHeaderChevronIcon(append(this.envButton, $('span.volt-agent-primary-header-chevron')));
		this._register(addDisposableListener(this.envButton, 'click', event => {
			event.preventDefault();
			event.stopPropagation();
			this.openEnvironmentMenu();
		}));
		this.laptop = append(this.titleCluster, $('span.volt-agent-primary-header-laptop'));
		createAgentHeaderLaptopIcon(this.laptop);

		this.hover = $('.volt-agent-primary-header-hover.hidden');
		this.hover.setAttribute('role', 'tooltip');

		this._register(addDisposableListener(this.searchButton, 'click', event => {
			event.preventDefault();
			event.stopPropagation();
			void this.commandService.executeCommand(QUICK_OPEN_COMMAND_ID);
		}));
		this._register(addDisposableListener(this.newAgentButton, 'click', event => {
			event.preventDefault();
			event.stopPropagation();
			void this.commandService.executeCommand(NEW_AGENT_COMMAND_ID);
		}));
		this._register(addDisposableListener(this.titleCluster, 'mouseenter', () => this.showHover()));
		this._register(addDisposableListener(this.titleCluster, 'mouseleave', () => this.scheduleHideHover()));
		this._register(addDisposableListener(this.hover, 'mouseenter', () => this.hideTimer.clear()));
		this._register(addDisposableListener(this.hover, 'mouseleave', () => this.scheduleHideHover()));
		this._register({ dispose: () => this.hover.remove() });

		this.updateButtonTooltips();
		this._register(this.keybindingService.onDidUpdateKeybindings(() => this.updateButtonTooltips()));
		this._register(onDidChangeLayoutMode(() => this.scheduleRender()));
		this._register(this.layoutService.onDidChangePartVisibility(() => this.scheduleRender()));
		this._register(this.layoutService.onDidLayoutMainContainer(() => this.scheduleRender()));
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this.bindActiveEditor();
			this.scheduleRender();
		}));
		this._register(this.history.onDidChange(() => this.scheduleRender()));
		this._register(this.sessionContext.onDidChangeActiveProject(() => this.scheduleRender()));
		this._register(this.sessionContext.onDidChangeProjects(() => this.scheduleRender()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.scheduleRender()));
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.scheduleRender()));
		this._register(this.scmService.onDidAddRepository(() => this.watchRepositories()));
		this._register(this.scmService.onDidRemoveRepository(() => this.watchRepositories()));

		this.bindActiveEditor();
		this.watchRepositories();
		void this.pathService.userHome().then(home => {
			this.userHome = home.scheme === Schemas.file ? home.fsPath : home.path;
			this.scheduleRender();
		}, () => undefined);
		void this.history.whenReady.then(() => this.scheduleRender());
		this.render();
	}

	private scheduleRender(): void {
		if (this.renderScheduled || this._store.isDisposed) {
			return;
		}
		this.renderScheduled = true;
		queueMicrotask(() => {
			this.renderScheduled = false;
			this.render();
		});
	}

	private updateButtonTooltips(): void {
		const searchKey = this.keybindingService.lookupKeybinding(QUICK_OPEN_COMMAND_ID)?.getLabel() ?? undefined;
		const newKey = this.keybindingService.lookupKeybinding(NEW_AGENT_COMMAND_ID)?.getLabel() ?? undefined;
		const searchLabel = localize('voltAgent.header.search', "Search");
		const newLabel = localize('voltAgent.header.newAgent', "New Agent");
		this.searchButton.setAttribute('aria-label', searchLabel);
		this.newAgentButton.setAttribute('aria-label', newLabel);
		setAgentTooltip(this.searchButton, searchLabel, searchKey);
		setAgentTooltip(this.newAgentButton, newLabel, newKey);
	}

	private bindActiveEditor(): void {
		this.editorListeners.clear();
		const editor = this.mainEditor();
		if (editor) {
			this.editorListeners.add(editor.onDidChangeLabel(() => this.scheduleRender()));
		}
	}

	private watchRepositories(): void {
		const store = new DisposableStore();
		store.add(autorun(reader => {
			this.scmViewService.activeRepository.read(reader);
			for (const repository of this.scmService.repositories) {
				repository.provider.historyProvider.read(reader)?.historyItemRef.read(reader);
			}
			this.scheduleRender();
		}));
		this.scmWatch.value = store;
	}

	private mount(): void {
		const left = this.layoutService.mainContainer.querySelector('.part.titlebar > .titlebar-container > .titlebar-left');
		if (!isHTMLElement(left)) {
			return;
		}
		if (this.element.parentElement !== left) {
			const toolbar = left.querySelector(':scope > .action-toolbar-container.left');
			if (isHTMLElement(toolbar)) {
				toolbar.insertAdjacentElement('afterend', this.element);
			} else {
				left.appendChild(this.element);
			}
		}
		if (this.element.nextElementSibling !== this.dragSpacer) {
			this.element.insertAdjacentElement('afterend', this.dragSpacer);
		}
	}

	/** The chat in the main editor area. A tab focused in the chat's tools does not retitle the bar. */
	private mainEditor(): EditorInput | undefined {
		// No group yet while the workbench restores; the header renders again once there is one.
		return this.editorGroupsService.mainPart.activeGroup?.activeEditor ?? undefined;
	}

	private sidebarClosed(): boolean {
		const root = this.layoutService.mainContainer;
		return primaryHeaderSidebarClosed({
			toggleInTitlebar: root.classList.contains('volt-primary-sidebar-toggle-in-titlebar'),
			auxiliaryBarHidden: root.classList.contains('noauxiliarybar'),
			leftCollapsed: root.classList.contains('volt-agent-left-collapsed'),
		});
	}

	private folderUri(): URI | undefined {
		const editor = this.mainEditor();
		if (editor instanceof AgentEditorInput) {
			const bound = this.sessionContext.rootFor(editor.sessionId);
			if (bound) {
				return bound;
			}
			const stored = headerFolderPath(this.history.get(editor.sessionId)?.workspaceFolder);
			if (stored) {
				return uriFromStoredRoot(stored);
			}
		}
		if (editor instanceof ScratchBoardEditorInput) {
			// The project the board's agents run in: the one the window has selected, none when it has none.
			return this.sessionContext.activeProject?.root;
		}
		return this.sessionContext.activeProject?.root
			?? this.workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	private branchFor(folder: URI | undefined): string | undefined {
		if (!folder) {
			return undefined;
		}
		const repository = this.scmService.getRepository(folder);
		const ref = repository?.provider.historyProvider.get()?.historyItemRef.get();
		return headerBranchName(ref?.name);
	}

	private projectName(folder: URI): string {
		if (this.sessionContext.getProject(projectIdForRoot(folder))?.scratch) {
			return scratchProjectLabel();
		}
		const project = this.sessionContext.projects.find(p => p.root.toString() === folder.toString());
		return project?.displayName || basename(folder) || folderDisplayPath(folder);
	}

	private render(): void {
		if (this._store.isDisposed) {
			return;
		}
		const agent = getLayoutMode(this.layoutService) === 'agent';
		this.element.hidden = !agent;
		this.dragSpacer.hidden = !agent;
		if (!agent) {
			this.hideHover();
			return;
		}
		this.mount();
		const editor = this.mainEditor();
		const full = editor?.getName()?.replace(/\r?\n/g, ' ').trim() ?? '';
		const closed = this.sidebarClosed();
		const showSearch = primaryHeaderShowsSearch(closed);
		const showNew = primaryHeaderShowsNewAgent(closed);
		this.searchButton.hidden = !showSearch;
		this.newAgentButton.hidden = !showNew;
		this.element.classList.toggle('has-controls', showSearch || showNew);
		const usageOpen = editor instanceof AgentUsageEditorInput;
		this.usageCrumb = usageOpen;
		this.envButton.hidden = !usageOpen;
		this.laptop.hidden = usageOpen;
		this.titleLabel.hidden = usageOpen;
		const crumbs = !usageOpen && (editor instanceof AgentCustomizeEditorInput || editor instanceof AutomationsEditorInput) ? editor.crumbs : [];
		this.renderCrumbs(crumbs);
		// Automations links back to its list from a page past it.
		this.titleHome = editor instanceof AutomationsEditorInput && crumbs.length ? editor.home : undefined;
		this.titleLabel.classList.toggle('link', !!this.titleHome);
		if (this.titleHome) {
			this.titleLabel.setAttribute('role', 'link');
			this.titleLabel.tabIndex = 0;
		} else {
			this.titleLabel.removeAttribute('role');
			this.titleLabel.removeAttribute('tabindex');
		}
		if (usageOpen) {
			const lead = localize('voltAgent.header.usage', "Usage");
			const trigger = usageEnvironmentTriggerLabel(
				this.environments,
				this.machineLabel,
				localize('voltAgent.header.allEnvironments', "All environments"),
				localize('voltAgent.header.noEnvironments', "No environments"),
			);
			this.projectLabel.textContent = lead;
			this.projectLabel.hidden = false;
			this.projectSeparator.hidden = false;
			this.envLabel.textContent = trigger;
			this.envButton.setAttribute('aria-label', trigger);
			this.titleCluster.hidden = false;
			this.titleCluster.setAttribute('aria-label', `${lead} / ${trigger}`);
		} else {
			const short = shortTabTitle(full);
			this.titleCluster.hidden = short.length === 0;
			this.titleLabel.textContent = short;
			const folder = this.folderUri();
			const project = folder ? this.projectName(folder) : editor instanceof ScratchBoardEditorInput ? scratchProjectLabel() : '';
			this.projectLabel.textContent = project;
			this.projectLabel.hidden = !project;
			this.projectSeparator.hidden = !project;
			if (short.length > 0) {
				const trail = [full, ...crumbs.map(crumb => crumb.label)].join(' / ');
				this.titleCluster.setAttribute('aria-label', project ? `${project} / ${trail}` : trail);
			} else {
				this.titleCluster.removeAttribute('aria-label');
			}
		}
		if (!this.hover.classList.contains('hidden')) {
			this.showHover();
		}
	}

	/**
	 * Each crumb after a separator; one with `run` is a link, the last is where the page is. Built
	 * again only when the trail changes, since the bar renders on every layout and a rebuilt button
	 * loses a click in progress. A click runs the crumb as it is now.
	 */
	private renderCrumbs(crumbs: readonly IAgentPageCrumb[]): void {
		const previous = this.crumbs;
		this.crumbs = crumbs;
		if (crumbs.length === previous.length && crumbs.every((crumb, i) => crumb.label === previous[i].label && !crumb.run === !previous[i].run)) {
			return;
		}
		this.crumbStore.clear();
		this.crumbsEl.replaceChildren();
		this.crumbsEl.hidden = crumbs.length === 0;
		this.titleCluster.classList.toggle('has-crumbs', crumbs.length > 0);
		crumbs.forEach((crumb, index) => {
			createAgentHeaderSeparatorIcon(append(this.crumbsEl, $('span.volt-agent-primary-header-separator')));
			if (!crumb.run) {
				append(this.crumbsEl, $('span.volt-agent-primary-header-crumb')).textContent = crumb.label;
				return;
			}
			const link = append(this.crumbsEl, $('button.volt-agent-primary-header-crumb.link')) as HTMLButtonElement;
			link.type = 'button';
			link.textContent = crumb.label;
			this.crumbStore.add(addDisposableListener(link, 'click', event => {
				event.preventDefault();
				event.stopPropagation();
				this.crumbs[index]?.run?.();
			}));
		});
	}

	private openEnvironmentMenu(): void {
		showUsageEnvironmentMenu(this.contextViewService, {
			anchor: this.envButton,
			state: this.environments,
			machineLabel: this.machineLabel,
			onToggle: state => {
				this.environments = state;
				this.render();
			},
		});
	}

	private showHover(): void {
		this.hideTimer.clear();
		if (this.usageCrumb) {
			this.hideHover();
			return;
		}
		const folder = this.folderUri();
		const absolutePath = folder ? folderDisplayPath(folder) : undefined;
		const lines = folder && absolutePath
			? agentHeaderHoverLines(this.projectName(folder), this.branchFor(folder), formatHeaderFolderPath(absolutePath, this.userHome))
			: [];
		if (!absolutePath || !lines.length || this.titleCluster.hidden) {
			this.hideHover();
			return;
		}
		this.hover.replaceChildren();
		for (const line of lines) {
			const row = append(this.hover, $('.volt-agent-primary-header-hover-row'));
			this.appendHoverIcon(row, line.kind);
			const text = append(row, $('.volt-agent-primary-header-hover-text'));
			append(text, $('span.volt-agent-primary-header-hover-title')).textContent = line.title;
			if (line.subtitle) {
				append(text, $('span.volt-agent-primary-header-hover-subtitle')).textContent = line.subtitle;
			}
		}
		this.appendCopyButton(absolutePath);
		const host = this.element.closest('.monaco-workbench') ?? this.element.ownerDocument.body;
		if (this.hover.parentElement !== host) {
			host.appendChild(this.hover);
		}
		this.hover.classList.remove('hidden');
		const rect = this.titleCluster.getBoundingClientRect();
		const width = this.hover.offsetWidth;
		const viewWidth = this.element.ownerDocument.defaultView?.innerWidth ?? width;
		const left = Math.max(8, Math.min(rect.left, viewWidth - width - 8));
		this.hover.style.left = `${left}px`;
		this.hover.style.top = `${rect.bottom + 6}px`;
	}

	private appendHoverIcon(row: HTMLElement, kind: AgentHeaderHoverLine['kind']): void {
		switch (kind) {
			case 'branch':
				createAgentHeaderGitIcon(row);
				return;
			case 'path':
				createAgentHeaderFolderIcon(row);
				return;
			default: {
				const unexpected: never = kind;
				return unexpected;
			}
		}
	}

	private appendCopyButton(absolutePath: string): void {
		const button = append(this.hover, $('button.volt-agent-primary-header-hover-copy')) as HTMLButtonElement;
		button.type = 'button';
		const label = this.copied
			? localize('voltAgent.header.copiedPath', "Copied")
			: localize('voltAgent.header.copyPath', "Copy Path");
		button.setAttribute('aria-label', label);
		button.title = label;
		button.classList.toggle('copied', this.copied);
		if (this.copied) {
			createAgentHeaderCheckIcon(button);
		} else {
			createAgentHeaderCopyIcon(button);
		}
		button.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			void this.clipboardService.writeText(absolutePath).then(() => {
				this.copied = true;
				this.copiedTimer.value = disposableTimeout(() => {
					this.copied = false;
					this.refreshOpenHover();
				}, HEADER_COPIED_FEEDBACK_MS);
				this.refreshOpenHover();
			});
		});
	}

	private refreshOpenHover(): void {
		if (!this.hover.classList.contains('hidden')) {
			this.showHover();
		}
	}

	private scheduleHideHover(): void {
		this.hideTimer.value = disposableTimeout(() => this.hideHover(), HEADER_HOVER_HIDE_DELAY);
	}

	private hideHover(): void {
		this.hideTimer.clear();
		this.hover.classList.add('hidden');
	}
}

// Before restore, so the header is in the first frame instead of popping in after the editors load.
registerWorkbenchContribution2(AgentTitlebarHeaderContribution.ID, AgentTitlebarHeaderContribution, WorkbenchPhase.BlockRestore);
