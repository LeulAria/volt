/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { RenderIndentGuides } from '../../../../base/browser/ui/tree/abstractTree.js';
import { ObjectTree } from '../../../../base/browser/ui/tree/objectTree.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { defaultListStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IAgentSessionMeta } from '../../../services/voltRuntime/common/history/agentHistory.js';
import { uriFromStoredRoot } from '../../../services/voltRuntime/common/sessionContext.js';
import { sessionFolders, defaultAgentHomeViewState } from '../../voltAgent/browser/home/agentHomeFilter.js';
import { createHomeNewChatIcon, createHomeSearchIcon } from '../../voltAgent/browser/home/agentHomeIcons.js';
import { AgentHomeElement, buildAgentHomeTree, isTwoLineView } from '../../voltAgent/browser/home/agentHomeModel.js';
import { AgentHomeAccessibilityProvider, AgentHomeDelegate, agentHomeElementLabel, agentHomeIdentityProvider, AgentHomeRenderer, IAgentHomeRendererHost, ROW_HEIGHT, toTreeElement } from '../../voltAgent/browser/home/agentHomePane.js';
import { IAgentRepoInfo, repoInitials } from '../../voltAgent/browser/home/agentRepoInfo.js';
import { WebAgentServices } from './webServices.js';

/**
 * The agent window's sidebar: the same nav rows, and the same tree (the window's row renderer,
 * delegate and tree options over the base tree), fed with the server's chat history.
 */
export class WebHome extends Disposable {

	readonly element: HTMLElement;
	private readonly treeContainer: HTMLElement;
	private readonly tree: ObjectTree<AgentHomeElement>;
	private readonly view = defaultAgentHomeViewState();
	private readonly repos = new Map<string, IAgentRepoInfo>();
	private readonly asked = new Set<string>();
	private readonly refresh: RunOnceScheduler;
	private activeId: string | undefined;

	private readonly _onDidOpen = this._register(new Emitter<string>());
	readonly onDidOpen = this._onDidOpen.event;
	private readonly _onDidNewChat = this._register(new Emitter<void>());
	readonly onDidNewChat = this._onDidNewChat.event;

	constructor(private readonly services: WebAgentServices) {
		super();
		this.element = $('.volt-agent-home');
		const nav = append(this.element, $('.volt-agent-home-nav'));
		this.navRow(nav, 'is-new', createHomeNewChatIcon(), localize('voltAgent.home.newChat', "New Chat"), '⌘N', () => this._onDidNewChat.fire());
		this.navRow(nav, 'is-action', createHomeSearchIcon(), localize('voltAgent.home.search', "Search"), '', () => { });
		this.navRow(nav, 'is-action', renderIcon(Codicon.settingsGear), localize('voltAgent.home.automations', "Automations"), '', () => { });
		this.navRow(nav, 'is-action', renderIcon(Codicon.extensions), localize('voltAgent.home.customize', "Customize"), '', () => { });
		this.treeContainer = append(this.element, $('.volt-agent-home-tree'));
		const host = this.rendererHost();
		const noKeybindings: Partial<IKeybindingService> = { lookupKeybinding: () => undefined };
		this.tree = this._register(new ObjectTree<AgentHomeElement>('AgentHome', this.treeContainer, new AgentHomeDelegate(host), [new AgentHomeRenderer(host, noKeybindings as IKeybindingService)], {
			accessibilityProvider: new AgentHomeAccessibilityProvider(),
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: (element: AgentHomeElement) => agentHomeElementLabel(element) },
			identityProvider: agentHomeIdentityProvider,
			multipleSelectionSupport: false,
			hideTwistiesOfChildlessElements: false,
			renderIndentGuides: RenderIndentGuides.None,
			expandOnlyOnTwistieClick: false,
			paddingBottom: ROW_HEIGHT,
			setRowLineHeight: false,
			horizontalScrolling: false,
			transformOptimization: false,
		}));
		this.tree.style(defaultListStyles);
		this._register(this.tree.onMouseClick(e => {
			if (e.element?.type === 'session') {
				this._onDidOpen.fire(e.element.session.id);
			}
		}));
		const footer = append(this.element, $('.volt-agent-home-footer'));
		const settings = append(footer, $('button.volt-agent-home-settings'));
		settings.appendChild(renderIcon(Codicon.settingsGear));
		this.refresh = this._register(new RunOnceScheduler(() => this.rebuild(), 30));
		this._register(services.history.onDidChange(() => this.refresh.schedule()));
		this._register(services.orchestrator.onDidChange(() => this.refresh.schedule()));
		// Ages tick every 30s, as in the window; "Working 12s" badges every second while a chat runs.
		let lastAgeTick = Date.now();
		const ticker = mainWindow.setInterval(() => {
			const working = this.services.history.list().some(session => session.status === 'running');
			if (working || Date.now() - lastAgeTick >= 30_000) {
				lastAgeTick = Date.now();
				this.rebuild();
			}
		}, 1000);
		this._register(toDisposable(() => mainWindow.clearInterval(ticker)));
		const observer = new ResizeObserver(() => this.layout());
		observer.observe(this.treeContainer);
		this._register(toDisposable(() => observer.disconnect()));
		this.rebuild();
	}

	setActive(sessionId: string | undefined): void {
		this.activeId = sessionId;
		this.tree.rerender();
	}

	private navRow(parent: HTMLElement, kind: string, icon: HTMLElement, label: string, keybinding: string, run: () => void): void {
		const button = append(parent, $('button.volt-agent-home-nav-row'));
		const row = append(button, $(`div.volt-agent-home-row.${kind}`));
		const iconEl = append(row, $('span.icon'));
		append(iconEl, $('span.twist'));
		append(iconEl, $('span.glyph')).appendChild(icon);
		append(row, $('span.name')).textContent = label;
		append(row, $('span.keybinding')).textContent = keybinding;
		this._register(addDisposableListener(button, 'click', run));
	}

	private layout(): void {
		this.tree.layout(this.treeContainer.clientHeight, this.treeContainer.clientWidth);
	}

	private rebuild(): void {
		const sessions = this.services.history.list({ includeArchived: false })
			.filter(session => !session.subagent && !this.services.orchestrator.getThread(session.id)?.taskId);
		this.resolveRepos(sessions);
		const tree = buildAgentHomeTree([], sessions, this.view, { repos: this.repos });
		this.tree.setChildren(null, tree.map(toTreeElement));
		this.tree.rerender();
		this.layout();
	}

	/** Branch and project initials for rows, read on the server the way the window reads them. */
	private resolveRepos(sessions: readonly IAgentSessionMeta[]): void {
		for (const session of sessions) {
			for (const path of sessionFolders(session)) {
				if (this.asked.has(path)) {
					continue;
				}
				this.asked.add(path);
				void this.services.client.call<IAgentRepoInfo | undefined>('repos.resolve', path).then(repo => {
					if (repo) {
						this.repos.set(path, repo);
						this.refresh.schedule();
					}
				}, () => undefined);
			}
		}
	}

	private sessionContext(session: IAgentSessionMeta): { workspace?: string; branch?: string; initials: string } {
		const primary = sessionFolders(session)[0];
		const repo = primary ? this.repos.get(primary) : undefined;
		let folderName: string | undefined;
		try {
			folderName = primary ? basename(uriFromStoredRoot(primary)) : undefined;
		} catch {
			folderName = undefined;
		}
		const name = repo?.name || folderName || session.workspaceLabel;
		return { workspace: repo?.name || folderName || session.workspaceLabel || undefined, branch: repo?.branch, initials: name ? repoInitials(name) : '' };
	}

	private rendererHost(): IAgentHomeRendererHost {
		const history = this.services.history;
		const none: IDisposable = toDisposable(() => { });
		const view = this.view;
		const host = {
			view,
			twoLine: isTwoLineView(view),
			modelLabel: (session: IAgentSessionMeta) => session.model || this.services.orchestrator.getThread(session.id)?.modelLabel,
			prBadge: () => undefined,
			openPullRequest: () => { },
			projectStatus: () => undefined,
			togglePin: (session: IAgentSessionMeta) => void history.setPinned(session.id, !session.pinned),
			toggleArchive: (session: IAgentSessionMeta) => void history.setArchived(session.id, !session.archived),
			settle: (session: IAgentSessionMeta) => void history.setSettled(session.id, true),
			openSnoozeMenu: () => { },
			wake: (session: IAgentSessionMeta) => void history.setSnoozed(session.id, false),
			openFilterMenu: () => { },
			openNewChatMenu: () => this._onDidNewChat.fire(),
			openWorkspaceMenu: () => { },
			isActiveChat: (sessionId: string) => sessionId === this.activeId,
			sessionContext: (session: IAgentSessionMeta) => this.sessionContext(session),
			bindSessionHover: () => none,
			addProject: async () => { },
			startChat: async () => this._onDidNewChat.fire(),
		};
		return host as unknown as IAgentHomeRendererHost;
	}
}
