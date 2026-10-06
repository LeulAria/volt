/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { AnchorAlignment } from '../../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import {
	AgentHomeGrouping,
	AgentHomePrFilter,
	AgentHomeShowField,
	AgentHomeStatusFilter,
	defaultAgentHomeViewState,
	groupingLabel,
	IAgentHomeViewState,
	isArchivedFilterActive,
	isEnvironmentFilterActive,
	isFlatGrouping,
	localEnvironmentLabel,
	isPrFilterActive,
	isSourceFilterActive,
	isStatusFilterActive,
} from './agentHomeFilter.js';
import { createHomeEnvironmentIcon, createHomeFolderIcon, createHomeStatusIcon } from './agentHomeIcons.js';
import { agentHomeDensityHost } from './agentHomeDensity.js';

export interface IAgentHomeFilterMenuHost {
	readonly view: IAgentHomeViewState;
	setView(next: IAgentHomeViewState): void;
	collapseAll(): void;
	markAllAsRead(): void;
}

type FlyoutKind = 'grouping' | 'ordering' | 'show' | 'status' | 'pr' | 'environment' | 'source';

/**
 * Filter / sort popover for the agent home sidebar. Matches the Cursor-style
 * agents menu: main list, flyout submenus, checks on the right, Reset.
 */
export function showAgentHomeFilterMenu(
	contextViewService: IContextViewService,
	anchor: HTMLElement,
	host: IAgentHomeFilterMenuHost,
): void {
	contextViewService.showContextView({
		getAnchor: () => anchor,
		anchorAlignment: AnchorAlignment.LEFT,
		render: container => {
			const store = new DisposableStore();
			const mainStore = new DisposableStore();
			const flyoutStore = new DisposableStore();
			store.add(mainStore);
			store.add(flyoutStore);
			container.classList.add('volt-agent-home-filter-menu-host');
			const menu = append(container, $('.volt-agent-home-filter-menu'));
			const flyout = append(container, $('.volt-agent-home-filter-flyout.hidden'));
			let openFlyout: FlyoutKind | undefined;

			const close = () => contextViewService.hideContextView();

			const paintFlyout = (kind: FlyoutKind) => {
				flyoutStore.clear();
				renderFlyout(flyout, kind, host, flyoutStore, next => {
					host.setView(next);
					paintMain();
					paintFlyout(kind);
				});
				flyout.classList.remove('hidden');
				placeFlyout(menu, flyout, menu.querySelector(`[data-flyout="${kind}"]`) as HTMLElement | null);
			};

			// Hover opens a submenu and moving back onto its row keeps it open, like a native menu.
			const open = (kind: FlyoutKind | undefined) => {
				if (!kind) {
					flyout.classList.add('hidden');
					openFlyout = undefined;
					return;
				}
				if (openFlyout === kind && !flyout.classList.contains('hidden')) {
					return;
				}
				openFlyout = kind;
				paintFlyout(kind);
			};

			const paintMain = () => {
				mainStore.clear();
				clearNode(menu);
				buildMainMenu(menu, host, mainStore, open, next => {
					host.setView(next);
					paintMain();
					if (openFlyout) {
						paintFlyout(openFlyout);
					}
				}, () => {
					host.setView(defaultAgentHomeViewState());
					paintMain();
					if (openFlyout) {
						paintFlyout(openFlyout);
					}
				}, () => {
					host.collapseAll();
					close();
				}, () => {
					host.markAllAsRead();
					close();
				});
			};

			paintMain();
			store.add(addDisposableListener(getWindow(anchor).document, 'mousedown', e => {
				if (!(e.target instanceof Node)) {
					return;
				}
				const view = contextViewService.getContextViewElement();
				if (view.contains(e.target) || anchor.contains(e.target)) {
					return;
				}
				close();
			}, true));
			store.add(addDisposableListener(getWindow(anchor), 'keydown', e => {
				if (e.key === 'Escape') {
					close();
				}
			}));
			return store;
		},
	});
}

function buildMainMenu(
	menu: HTMLElement,
	host: IAgentHomeFilterMenuHost,
	store: DisposableStore,
	openFlyout: (kind: FlyoutKind | undefined) => void,
	setView: (next: IAgentHomeViewState) => void,
	onReset: () => void,
	onCollapse: () => void,
	onMarkRead: () => void,
): void {
	const view = host.view;
	appendRow(menu, {
		label: localize('voltAgent.home.filter.grouping', "Grouping"),
		value: groupingLabel(view.grouping),
		submenu: true,
		flyout: 'grouping',
		onHover: () => openFlyout('grouping'),
		store,
	});
	appendRow(menu, {
		label: localize('voltAgent.home.filter.ordering', "Ordering"),
		submenu: true,
		flyout: 'ordering',
		onHover: () => openFlyout('ordering'),
		store,
	});
	appendRow(menu, {
		label: localize('voltAgent.home.filter.show', "Show"),
		submenu: true,
		flyout: 'show',
		onHover: () => openFlyout('show'),
		store,
	});
	const density = agentHomeDensityHost();
	if (density) {
		appendToggleRow(menu, {
			label: localize('voltAgent.home.filter.compact', "Compact List"),
			checked: density.compact,
			// The same view again repaints the menu with the new check.
			onClick: () => {
				density.setCompact(!density.compact);
				setView(view);
			},
			onHover: () => openFlyout(undefined),
			store,
		});
	}
	append(menu, $('.volt-agent-home-filter-sep'));

	const filters = append(menu, $('.volt-agent-home-filter-section'));
	append(filters, $('span.label')).textContent = localize('voltAgent.home.filter.filters', "Filters");
	const reset = append(filters, $('button.reset')) as HTMLButtonElement;
	reset.textContent = localize('voltAgent.home.filter.reset', "Reset");
	store.add(addDisposableListener(reset, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		onReset();
	}));

	appendRow(menu, {
		label: localize('voltAgent.home.filter.status', "Status"),
		submenu: true,
		dot: isStatusFilterActive(view),
		flyout: 'status',
		onHover: () => openFlyout('status'),
		store,
	});
	appendRow(menu, {
		label: localize('voltAgent.home.filter.pr', "PR"),
		submenu: true,
		dot: isPrFilterActive(view),
		flyout: 'pr',
		onHover: () => openFlyout('pr'),
		store,
	});
	appendRow(menu, {
		label: localize('voltAgent.home.filter.environment', "Environment"),
		submenu: true,
		dot: isEnvironmentFilterActive(view),
		flyout: 'environment',
		onHover: () => openFlyout('environment'),
		store,
	});
	appendRow(menu, {
		label: localize('voltAgent.home.filter.source', "Source"),
		submenu: true,
		dot: isSourceFilterActive(view),
		flyout: 'source',
		onHover: () => openFlyout('source'),
		store,
	});
	appendToggleRow(menu, {
		label: localize('voltAgent.home.filter.archived', "Archived"),
		checked: isArchivedFilterActive(view),
		onClick: () => setView({ ...view, archived: view.archived === 'show' ? 'hide' : 'show' }),
		onHover: () => openFlyout(undefined),
		store,
	});
	append(menu, $('.volt-agent-home-filter-sep'));
	appendRow(menu, {
		label: localize('voltAgent.home.filter.collapseAll', "Collapse All"),
		onClick: onCollapse,
		onHover: () => openFlyout(undefined),
		store,
	});
	appendRow(menu, {
		label: localize('voltAgent.home.filter.markAllRead', "Mark All as Read"),
		onClick: onMarkRead,
		onHover: () => openFlyout(undefined),
		store,
	});
}

function renderFlyout(
	flyout: HTMLElement,
	kind: FlyoutKind,
	host: IAgentHomeFilterMenuHost,
	store: DisposableStore,
	setView: (next: IAgentHomeViewState) => void,
): void {
	clearNode(flyout);
	const view = host.view;

	switch (kind) {
		case 'grouping':
			for (const option of groupingOptions()) {
				appendCheckRow(flyout, {
					label: option.label,
					icon: option.icon(),
					checked: view.grouping === option.id,
					onClick: () => setView({ ...view, grouping: option.id }),
					store,
				});
			}
			return;
		case 'ordering':
			append(flyout, $('.volt-agent-home-filter-heading')).textContent = localize('voltAgent.home.filter.chats', "Chats");
			appendCheckRow(flyout, {
				label: localize('voltAgent.home.filter.updated', "Updated"),
				icon: Codicon.clock,
				checked: view.chatOrder === 'updated',
				onClick: () => setView({ ...view, chatOrder: 'updated' }),
				store,
			});
			appendCheckRow(flyout, {
				label: localize('voltAgent.home.filter.status', "Status"),
				icon: createHomeStatusIcon(),
				checked: view.chatOrder === 'status',
				onClick: () => setView({ ...view, chatOrder: 'status' }),
				store,
			});
			// Updated, Status and Environment have fixed headers; only project rows can be reordered.
			if (isFlatGrouping(view.grouping)) {
				return;
			}
			append(flyout, $('.volt-agent-home-filter-sep'));
			append(flyout, $('.volt-agent-home-filter-heading')).textContent = localize('voltAgent.home.filter.groups', "Groups");
			appendCheckRow(flyout, {
				label: localize('voltAgent.home.filter.updated', "Updated"),
				icon: Codicon.clock,
				checked: view.groupOrder === 'updated',
				onClick: () => setView({ ...view, groupOrder: 'updated' }),
				store,
			});
			appendCheckRow(flyout, {
				label: localize('voltAgent.home.filter.manual', "Manual"),
				icon: Codicon.arrowBoth,
				checked: view.groupOrder === 'manual',
				onClick: () => setView({ ...view, groupOrder: 'manual' }),
				store,
			});
			return;
		case 'show': {
			const first: AgentHomeShowField[] = ['status', 'updated', 'environment', 'pr'];
			const second: AgentHomeShowField[] = ['workspace', 'branch', 'model', 'machine'];
			for (const field of first) {
				appendCheckRow(flyout, {
					label: showLabel(field),
					icon: showIcon(field),
					checked: view.show.has(field),
					onClick: () => setView({ ...view, show: toggleSet(view.show, field) }),
					store,
				});
			}
			append(flyout, $('.volt-agent-home-filter-sep'));
			for (const field of second) {
				appendCheckRow(flyout, {
					label: showLabel(field),
					icon: showIcon(field),
					checked: view.show.has(field),
					onClick: () => setView({ ...view, show: toggleSet(view.show, field) }),
					store,
				});
			}
			return;
		}
		case 'status':
			for (const option of statusOptions()) {
				appendCheckRow(flyout, {
					label: option.label,
					icon: option.icon,
					checked: view.status.has(option.id),
					onClick: () => setView({ ...view, status: toggleSet(view.status, option.id) }),
					store,
				});
			}
			return;
		case 'pr':
			for (const option of prOptions()) {
				appendCheckRow(flyout, {
					label: option.label,
					icon: option.icon,
					checked: view.pr.has(option.id),
					onClick: () => setView({ ...view, pr: toggleSet(view.pr, option.id) }),
					store,
				});
			}
			return;
		case 'environment':
			appendCheckRow(flyout, {
				label: localize('voltAgent.home.filter.cloud', "Cloud"),
				icon: Codicon.cloud,
				checked: view.environment.has('cloud'),
				onClick: () => setView({ ...view, environment: toggleSet(view.environment, 'cloud') }),
				store,
			});
			appendCheckRow(flyout, {
				label: localEnvironmentLabel(),
				icon: Codicon.deviceDesktop,
				checked: view.environment.has('local'),
				onClick: () => setView({ ...view, environment: toggleSet(view.environment, 'local') }),
				store,
			});
			return;
		case 'source':
			appendCheckRow(flyout, {
				label: localize('voltAgent.home.filter.sourceFolder', "Folder"),
				icon: createHomeFolderIcon(),
				checked: view.source.has('folder'),
				onClick: () => setView({ ...view, source: toggleSet(view.source, 'folder') }),
				store,
			});
			appendCheckRow(flyout, {
				label: localize('voltAgent.home.filter.sourceWorkspace', "Workspace file"),
				icon: Codicon.folderLibrary,
				checked: view.source.has('workspaceFile'),
				onClick: () => setView({ ...view, source: toggleSet(view.source, 'workspaceFile') }),
				store,
			});
			return;
		default: {
			const unexpected: never = kind;
			return unexpected;
		}
	}
}

function appendRow(parent: HTMLElement, options: {
	readonly label: string;
	readonly value?: string;
	readonly submenu?: boolean;
	readonly dot?: boolean;
	readonly flyout?: FlyoutKind;
	readonly onHover?: () => void;
	readonly onClick?: () => void;
	readonly store: DisposableStore;
}): void {
	const row = append(parent, $('button.volt-agent-home-filter-row')) as HTMLButtonElement;
	if (options.flyout) {
		row.dataset.flyout = options.flyout;
	}
	append(row, $('span.label')).textContent = options.label;
	const trailing = append(row, $('span.trailing'));
	if (options.value) {
		append(trailing, $('span.value')).textContent = options.value;
	}
	if (options.dot) {
		append(trailing, $('span.dot'));
	}
	if (options.submenu) {
		trailing.appendChild(renderIcon(Codicon.chevronRight));
	}
	if (options.onHover) {
		options.store.add(addDisposableListener(row, 'mouseenter', () => options.onHover?.()));
	}
	if (options.onClick) {
		options.store.add(addDisposableListener(row, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			options.onClick?.();
		}));
	} else {
		options.store.add(addDisposableListener(row, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			options.onHover?.();
		}));
	}
}

/** A top-level row that switches on and off in place, with its check on the right. */
function appendToggleRow(parent: HTMLElement, options: {
	readonly label: string;
	readonly checked: boolean;
	readonly onClick: () => void;
	readonly onHover: () => void;
	readonly store: DisposableStore;
}): void {
	const row = append(parent, $('button.volt-agent-home-filter-row.toggle')) as HTMLButtonElement;
	row.classList.toggle('checked', options.checked);
	row.setAttribute('role', 'menuitemcheckbox');
	row.setAttribute('aria-checked', String(options.checked));
	append(row, $('span.label')).textContent = options.label;
	const trailing = append(row, $('span.trailing'));
	if (options.checked) {
		trailing.appendChild(renderIcon(Codicon.check));
	}
	options.store.add(addDisposableListener(row, 'mouseenter', () => options.onHover()));
	options.store.add(addDisposableListener(row, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		options.onClick();
	}));
}

function appendCheckRow(parent: HTMLElement, options: {
	readonly label: string;
	readonly icon: ThemeIcon | HTMLElement;
	readonly checked: boolean;
	readonly onClick: () => void;
	readonly store: DisposableStore;
}): void {
	const row = append(parent, $('button.volt-agent-home-filter-row.check')) as HTMLButtonElement;
	row.classList.toggle('checked', options.checked);
	const leading = append(row, $('span.leading'));
	// An element has a string `id` too, so test for the element rather than the theme icon.
	leading.appendChild(isHTMLElement(options.icon) ? options.icon : renderIcon(options.icon));
	append(row, $('span.label')).textContent = options.label;
	const mark = append(row, $('span.check'));
	if (options.checked) {
		mark.appendChild(renderIcon(Codicon.check));
	}
	options.store.add(addDisposableListener(row, 'click', e => {
		e.preventDefault();
		e.stopPropagation();
		options.onClick();
	}));
}

function placeFlyout(menu: HTMLElement, flyout: HTMLElement, row: HTMLElement | null): void {
	flyout.style.position = 'absolute';
	flyout.style.left = `${menu.offsetWidth + 4}px`;
	flyout.style.top = `${row?.offsetTop ?? 0}px`;
}

function toggleSet<T>(set: ReadonlySet<T>, value: T): Set<T> {
	const next = new Set(set);
	if (next.has(value)) {
		next.delete(value);
	} else {
		next.add(value);
	}
	return next;
}

function groupingOptions(): { readonly id: AgentHomeGrouping; readonly label: string; readonly icon: () => ThemeIcon | HTMLElement }[] {
	return [
		{ id: 'repository', label: localize('voltAgent.home.filter.repository', "Repository"), icon: () => Codicon.folderLibrary },
		{ id: 'workspace', label: localize('voltAgent.home.filter.workspace', "Workspace"), icon: () => createHomeFolderIcon() },
		{ id: 'updated', label: localize('voltAgent.home.filter.updated', "Updated"), icon: () => Codicon.clock },
		{ id: 'status', label: localize('voltAgent.home.filter.status', "Status"), icon: () => createHomeStatusIcon() },
		{ id: 'environment', label: localize('voltAgent.home.filter.environment', "Environment"), icon: () => createHomeEnvironmentIcon() },
	];
}

function statusOptions(): { readonly id: AgentHomeStatusFilter; readonly label: string; readonly icon: ThemeIcon }[] {
	return [
		{ id: 'needsAttention', label: localize('voltAgent.home.filter.needsAttention', "Needs Attention"), icon: Codicon.warning },
		{ id: 'unread', label: localize('voltAgent.home.filter.unread', "Unread"), icon: Codicon.bell },
		{ id: 'working', label: localize('voltAgent.home.filter.working', "Working"), icon: Codicon.sync },
		{ id: 'draft', label: localize('voltAgent.home.filter.draft', "Draft"), icon: Codicon.circleOutline },
		{ id: 'done', label: localize('voltAgent.home.filter.done', "Done"), icon: Codicon.pass },
	];
}

function prOptions(): { readonly id: AgentHomePrFilter; readonly label: string; readonly icon: ThemeIcon }[] {
	return [
		{ id: 'draft', label: localize('voltAgent.home.filter.prDraft', "PR Draft"), icon: Codicon.gitPullRequestDraft },
		{ id: 'open', label: localize('voltAgent.home.filter.prOpen', "PR Open"), icon: Codicon.gitPullRequest },
		{ id: 'merged', label: localize('voltAgent.home.filter.prMerged', "PR Merged"), icon: Codicon.gitMerge },
		{ id: 'closed', label: localize('voltAgent.home.filter.prClosed', "PR Closed"), icon: Codicon.gitPullRequestClosed },
		{ id: 'none', label: localize('voltAgent.home.filter.noPr', "No PR"), icon: Codicon.circleSlash },
	];
}

function showLabel(field: AgentHomeShowField): string {
	switch (field) {
		case 'status': return localize('voltAgent.home.filter.statusLine', "Status");
		case 'updated': return localize('voltAgent.home.filter.updated', "Updated");
		case 'environment': return localize('voltAgent.home.filter.environment', "Environment");
		case 'pr': return localize('voltAgent.home.filter.pr', "PR");
		case 'workspace': return localize('voltAgent.home.filter.workspace', "Workspace");
		case 'branch': return localize('voltAgent.home.filter.branch', "Branch");
		case 'machine': return localize('voltAgent.home.filter.machine', "Machine");
		case 'model': return localize('voltAgent.home.filter.model', "Model");
		default: {
			const unexpected: never = field;
			return unexpected;
		}
	}
}

function showIcon(field: AgentHomeShowField): ThemeIcon {
	switch (field) {
		case 'status': return Codicon.pulse;
		case 'updated': return Codicon.clock;
		case 'environment': return Codicon.cloud;
		case 'pr': return Codicon.gitPullRequest;
		case 'workspace': return Codicon.folder;
		case 'branch': return Codicon.gitBranch;
		case 'machine': return Codicon.deviceDesktop;
		case 'model': return Codicon.sparkle;
		default: {
			const unexpected: never = field;
			return unexpected;
		}
	}
}
