/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, getWindow } from '../../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { AUTOMATION_RUN_TOOLS, AUTOMATION_TOOL_STATUSES, AutomationRunToolKind, AutomationToolStatus, RUN_STATUS_BUCKETS, RunStatusBucket } from '../../../../services/voltRuntime/common/automations/automations.js';
import { AUTOMATION_TRIGGER_GROUPS, AutomationTriggerGroup, triggerGroupLabel } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';
import { providerIcon, statusIcon, toolKindIcon } from './automationIcons.js';

/** The filter the Run History table applies; the popover edits it in place. */
export interface IMutableRunFilter {
	readonly statuses: Set<RunStatusBucket>;
	readonly triggers: Set<AutomationTriggerGroup>;
	readonly tools: Map<AutomationRunToolKind, Set<AutomationToolStatus>>;
	text: string;
}

export function newRunFilter(): IMutableRunFilter {
	return { statuses: new Set(), triggers: new Set(), tools: new Map(), text: '' };
}

export function statusLabel(status: RunStatusBucket | AutomationToolStatus): string {
	switch (status) {
		case 'running': return localize('voltAutomations.running', "Running");
		case 'failed': return localize('voltAutomations.failed', "Failed");
		case 'succeeded': return localize('voltAutomations.succeeded', "Succeeded");
		case 'skipped': return localize('voltAutomations.skipped', "Skipped");
		case 'success': return localize('voltAutomations.success', "Success");
		case 'pending': return localize('voltAutomations.pending', "Pending");
	}
}

export function runToolLabel(kind: AutomationRunToolKind): string {
	switch (kind) {
		case 'pr_comment': return localize('voltAutomations.prComment', "PR Comment");
		case 'slack': return localize('voltAutomations.slack', "Slack");
		case 'slack_read': return localize('voltAutomations.readSlackShort', "Read Slack");
		case 'teams': return localize('voltAutomations.teams', "Microsoft Teams");
		case 'teams_read': return localize('voltAutomations.readTeamsShort', "Read Microsoft Teams");
		case 'pull_request': return localize('voltAutomations.pullRequest', "Pull Request");
		case 'reviewers': return localize('voltAutomations.reviewers', "Reviewers");
		case 'mcp': return localize('voltAutomations.mcp', "MCP");
		case 'memories': return localize('voltAutomations.memories', "Memories");
	}
}

type View = 'root' | 'status' | 'trigger' | 'tools';

/**
 * Filter by: Status, Trigger or Tools, each a page with a back arrow. Picks toggle (several per
 * page) and the table follows at once; a Tools row opens to its statuses and shows how many are
 * picked.
 */
export function showRunFilterMenu(contextView: IContextViewService, anchor: HTMLElement, filter: IMutableRunFilter, onChange: () => void): void {
	const store = new DisposableStore();
	let view: View = 'root';
	let query = '';
	const open = new Set<AutomationRunToolKind>([...filter.tools].filter(([, statuses]) => statuses.size).map(([kind]) => kind));
	contextView.showContextView({
		getAnchor: () => anchor,
		anchorAlignment: AnchorAlignment.RIGHT,
		anchorPosition: AnchorPosition.BELOW,
		canRelayout: true,
		render: container => {
			const root = append(container, $('.volt-auto-filter'));
			root.tabIndex = -1;
			anchor.classList.add('open');
			store.add(toDisposable(() => anchor.classList.remove('open')));
			store.add(addDisposableListener(getWindow(anchor).document, 'mousedown', e => {
				if (e.target instanceof Node && !root.contains(e.target) && !anchor.contains(e.target)) {
					contextView.hideContextView();
				}
			}, true));
			store.add(addDisposableListener(root, 'keydown', e => {
				if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					if (view === 'root') {
						contextView.hideContextView();
					} else {
						view = 'root';
						draw();
					}
				} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					const rows = [...root.querySelectorAll<HTMLElement>('.volt-auto-filter-row')];
					const index = rows.indexOf(getWindow(root).document.activeElement as HTMLElement);
					rows[(index + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
				} else if (e.key === 'ArrowLeft' && view !== 'root' && (e.target as HTMLElement).tagName !== 'INPUT') {
					view = 'root';
					draw();
				}
			}));
			const row = (parent: HTMLElement, label: string, options: { icon?: () => Element; checked?: boolean; chevron?: 'right' | 'down' | 'up'; count?: number; indent?: boolean; onClick: () => void }) => {
				const element = append(parent, $('button.volt-auto-filter-row')) as HTMLButtonElement;
				element.type = 'button';
				element.classList.toggle('indent', !!options.indent);
				if (options.icon) {
					append(element, $('span.icon')).appendChild(options.icon());
				}
				append(element, $('span.label')).textContent = label;
				if (options.count) {
					append(element, $('span.count')).textContent = `(${options.count})`;
				}
				const trailing = append(element, $('span.trailing'));
				if (options.chevron) {
					trailing.appendChild(renderIcon(options.chevron === 'right' ? Codicon.chevronRight : options.chevron === 'down' ? Codicon.chevronDown : Codicon.chevronUp));
				} else if (options.checked) {
					trailing.appendChild(renderIcon(Codicon.check));
				}
				if (options.checked !== undefined) {
					element.setAttribute('role', 'menuitemcheckbox');
					element.setAttribute('aria-checked', String(options.checked));
				}
				store.add(addDisposableListener(element, 'mouseenter', () => element.focus()));
				store.add(addDisposableListener(element, 'click', e => {
					e.stopPropagation();
					options.onClick();
				}));
				return element;
			};
			const header = (title: string) => {
				const head = append(root, $('.volt-auto-filter-head'));
				const back = append(head, $('button.volt-auto-filter-back')) as HTMLButtonElement;
				back.type = 'button';
				back.setAttribute('aria-label', localize('voltAutomations.back', "Back"));
				back.appendChild(renderIcon(Codicon.arrowLeft));
				append(head, $('span.title')).textContent = title;
				store.add(addDisposableListener(back, 'click', e => {
					e.stopPropagation();
					view = 'root';
					draw();
				}));
			};
			const toggle = <T>(set: Set<T>, value: T) => {
				if (set.has(value)) {
					set.delete(value);
				} else {
					set.add(value);
				}
				onChange();
				draw();
			};
			let lastView: View = view;
			const draw = () => {
				// Keep the toggled row focused across the redraw (same page only).
				const rows = [...root.querySelectorAll<HTMLElement>('.volt-auto-filter-row')];
				const focused = lastView === view ? rows.indexOf(getWindow(root).document.activeElement as HTMLElement) : -1;
				lastView = view;
				clearNode(root);
				root.dataset.view = view;
				switch (view) {
					case 'root': {
						append(root, $('.volt-auto-filter-title')).textContent = localize('voltAutomations.filterBy', "Filter by");
						const list = append(root, $('.volt-auto-filter-list'));
						row(list, localize('voltAutomations.status', "Status"), { chevron: 'right', ...(filter.statuses.size ? { count: filter.statuses.size } : {}), onClick: () => { view = 'status'; draw(); } });
						row(list, localize('voltAutomations.trigger', "Trigger"), { chevron: 'right', ...(filter.triggers.size ? { count: filter.triggers.size } : {}), onClick: () => { view = 'trigger'; query = ''; draw(); } });
						const tools = [...filter.tools.values()].reduce((sum, set) => sum + set.size, 0);
						row(list, localize('voltAutomations.tools', "Tools"), { chevron: 'right', ...(tools ? { count: tools } : {}), onClick: () => { view = 'tools'; draw(); } });
						break;
					}
					case 'status': {
						header(localize('voltAutomations.status', "Status"));
						const list = append(root, $('.volt-auto-filter-list'));
						for (const status of RUN_STATUS_BUCKETS) {
							row(list, statusLabel(status), { icon: () => statusIcon(status), checked: filter.statuses.has(status), onClick: () => toggle(filter.statuses, status) });
						}
						break;
					}
					case 'trigger': {
						header(localize('voltAutomations.trigger', "Trigger"));
						const search = append(root, $('input.volt-auto-filter-search')) as HTMLInputElement;
						search.placeholder = localize('voltAutomations.searchTrigger', "Search trigger...");
						search.value = query;
						const list = append(root, $('.volt-auto-filter-list'));
						const fill = () => {
							clearNode(list);
							const wanted = query.trim().toLowerCase();
							for (const group of AUTOMATION_TRIGGER_GROUPS.filter(entry => !wanted || triggerGroupLabel(entry).toLowerCase().includes(wanted))) {
								row(list, triggerGroupLabel(group), { icon: () => providerIcon(group), checked: filter.triggers.has(group), onClick: () => toggle(filter.triggers, group) });
							}
						};
						store.add(addDisposableListener(search, 'input', () => {
							query = search.value;
							fill();
						}));
						fill();
						getWindow(root).requestAnimationFrame(() => search.focus());
						break;
					}
					case 'tools': {
						header(localize('voltAutomations.tools', "Tools"));
						const list = append(root, $('.volt-auto-filter-list.scroll'));
						for (const kind of AUTOMATION_RUN_TOOLS) {
							const statuses = filter.tools.get(kind) ?? new Set<AutomationToolStatus>();
							const expanded = open.has(kind);
							row(list, runToolLabel(kind), {
								icon: () => toolKindIcon(kind),
								chevron: expanded ? 'up' : 'down',
								...(statuses.size ? { count: statuses.size } : {}),
								onClick: () => {
									if (expanded) {
										open.delete(kind);
									} else {
										open.add(kind);
									}
									draw();
								},
							});
							if (expanded) {
								for (const status of AUTOMATION_TOOL_STATUSES) {
									row(list, statusLabel(status), {
										icon: () => statusIcon(status),
										checked: statuses.has(status),
										indent: true,
										onClick: () => {
											const set = filter.tools.get(kind) ?? new Set<AutomationToolStatus>();
											filter.tools.set(kind, set);
											toggle(set, status);
										},
									});
								}
							}
						}
						break;
					}
				}
				if (view !== 'trigger' || focused >= 0) {
					const next = root.querySelectorAll<HTMLElement>('.volt-auto-filter-row');
					(next[Math.max(0, focused)] ?? next[0])?.focus();
				}
				contextView.layout();
			};
			draw();
			return store;
		},
		onHide: () => store.dispose(),
	});
}
