/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IVoltPullRequest, VoltPrChecksState, VoltPrState } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { AgentPrInvolvement, AgentPrSort, isOpenState, prInvolvement, rankPullRequests } from '../../common/agentPullRequests.js';
import { IVoltMenuHandle, IVoltMenuItem, IVoltMenuSection, showVoltMenu } from '../ui/menu/voltMenu.js';
import { lineIcon, SORT_ICONS, SORT_LABELS, SORT_ORDER } from './agentPullRequestsViewPane.js';
import { checkIcon, prStateIcon } from './agentPullRequestUi.js';

export type PrGrouping = 'involvement' | 'status' | 'author' | 'label' | 'none';
export type PrReviewFilter = 'approved' | 'changesRequested' | 'reviewRequired' | 'none';
export type PrUpdatedFilter = 'any' | 'day' | 'week' | 'month' | 'older';
export type PrSize = 'XS' | 'S' | 'M' | 'L' | 'XL';

/** What the Pull Requests page and its sidebar show; the menu edits it in place. Empty sets mean all. */
export interface IPrFilter {
	grouping: PrGrouping;
	sort: AgentPrSort;
	readonly states: Set<VoltPrState>;
	readonly checks: Set<VoltPrChecksState>;
	readonly reviews: Set<PrReviewFilter>;
	readonly involvement: Set<AgentPrInvolvement>;
	readonly authors: Set<string>;
	readonly labels: Set<string>;
	readonly sizes: Set<PrSize>;
	updated: PrUpdatedFilter;
	conflictsOnly: boolean;
	linkedOnly: boolean;
}

export function newPrFilter(): IPrFilter {
	return { grouping: 'involvement', sort: 'blocked', states: new Set(), checks: new Set(), reviews: new Set(), involvement: new Set(), authors: new Set(), labels: new Set(), sizes: new Set(), updated: 'any', conflictsOnly: false, linkedOnly: false };
}

const GROUPINGS: readonly PrGrouping[] = ['involvement', 'status', 'author', 'label', 'none'];
const STATES: readonly VoltPrState[] = ['open', 'draft', 'merged', 'closed'];
const CHECKS: readonly VoltPrChecksState[] = ['success', 'failure', 'pending', 'none'];
const REVIEWS: readonly PrReviewFilter[] = ['approved', 'changesRequested', 'reviewRequired', 'none'];
const INVOLVEMENT: readonly AgentPrInvolvement[] = ['authored', 'reviewRequested', 'others'];
const SIZES: readonly PrSize[] = ['XS', 'S', 'M', 'L', 'XL'];
const UPDATED: readonly PrUpdatedFilter[] = ['any', 'day', 'week', 'month', 'older'];
const DAY = 24 * 3_600_000;

const GROUPING_LABELS: Record<PrGrouping, string> = {
	involvement: localize('voltPrFilter.group.involvement', "Involvement"),
	status: localize('voltPrFilter.group.status', "Status"),
	author: localize('voltPrFilter.group.author', "Author"),
	label: localize('voltPrFilter.group.label', "Label"),
	none: localize('voltPrFilter.group.none', "None"),
};

export const PR_STATE_LABELS: Record<VoltPrState, string> = {
	open: localize('voltPrFilter.state.open', "Open"),
	draft: localize('voltPrFilter.state.draft', "Draft"),
	merged: localize('voltPrFilter.state.merged', "Merged"),
	closed: localize('voltPrFilter.state.closed', "Closed"),
};

const CHECK_LABELS: Record<VoltPrChecksState, string> = {
	success: localize('voltPrFilter.checks.success', "Passing"),
	failure: localize('voltPrFilter.checks.failure', "Failing"),
	pending: localize('voltPrFilter.checks.pending', "Pending"),
	none: localize('voltPrFilter.checks.none', "No Checks"),
};

const REVIEW_LABELS: Record<PrReviewFilter, string> = {
	approved: localize('voltPrFilter.review.approved', "Approved"),
	changesRequested: localize('voltPrFilter.review.changes', "Changes Requested"),
	reviewRequired: localize('voltPrFilter.review.required', "Review Required"),
	none: localize('voltPrFilter.review.none', "No Review"),
};

const REVIEW_ICONS: Record<PrReviewFilter, ThemeIcon> = {
	approved: Codicon.check,
	changesRequested: Codicon.requestChanges,
	reviewRequired: Codicon.eye,
	none: Codicon.circleSlash,
};

export const INVOLVEMENT_LABELS: Record<AgentPrInvolvement, string> = {
	authored: localize('voltPrFilter.inv.authored', "Authored by you"),
	reviewRequested: localize('voltPrFilter.inv.review', "Review requested"),
	others: localize('voltPrFilter.inv.others', "Others"),
};

const INVOLVEMENT_ICONS: Record<AgentPrInvolvement, ThemeIcon> = {
	authored: Codicon.account,
	reviewRequested: Codicon.eye,
	others: Codicon.organization,
};

const SIZE_HINTS: Record<PrSize, string> = { XS: '< 10', S: '< 50', M: '< 250', L: '< 1000', XL: '1000+' };

const UPDATED_LABELS: Record<PrUpdatedFilter, string> = {
	any: localize('voltPrFilter.updated.any', "Any Time"),
	day: localize('voltPrFilter.updated.day', "Past Day"),
	week: localize('voltPrFilter.updated.week', "Past Week"),
	month: localize('voltPrFilter.updated.month', "Past Month"),
	older: localize('voltPrFilter.updated.older', "Older than a Month"),
};

export function prSize(pr: IVoltPullRequest): PrSize {
	const lines = pr.additions + pr.deletions;
	return lines < 10 ? 'XS' : lines < 50 ? 'S' : lines < 250 ? 'M' : lines < 1000 ? 'L' : 'XL';
}

function reviewOf(pr: IVoltPullRequest): PrReviewFilter {
	return pr.reviewDecision ?? 'none';
}

/** Filters set besides grouping and ordering, for the filter button's active state. */
export function prFilterCount(filter: IPrFilter): number {
	return filter.states.size + filter.checks.size + filter.reviews.size + filter.involvement.size + filter.authors.size + filter.labels.size + filter.sizes.size
		+ (filter.updated !== 'any' ? 1 : 0) + (filter.conflictsOnly ? 1 : 0) + (filter.linkedOnly ? 1 : 0);
}

export function matchesPrFilter(pr: IVoltPullRequest, filter: IPrFilter, linked: boolean, now = Date.now()): boolean {
	if (filter.states.size && !filter.states.has(pr.state)) {
		return false;
	}
	if (filter.checks.size && !filter.checks.has(pr.checks.state)) {
		return false;
	}
	if (filter.reviews.size && !filter.reviews.has(reviewOf(pr))) {
		return false;
	}
	if (filter.involvement.size && !filter.involvement.has(prInvolvement(pr))) {
		return false;
	}
	if (filter.authors.size && !filter.authors.has(pr.author.login)) {
		return false;
	}
	if (filter.labels.size && !pr.labels.some(label => filter.labels.has(label.name))) {
		return false;
	}
	if (filter.sizes.size && !filter.sizes.has(prSize(pr))) {
		return false;
	}
	const age = now - pr.updatedAt;
	switch (filter.updated) {
		case 'day': if (age > DAY) { return false; } break;
		case 'week': if (age > 7 * DAY) { return false; } break;
		case 'month': if (age > 30 * DAY) { return false; } break;
		case 'older': if (age <= 30 * DAY) { return false; } break;
	}
	if (filter.conflictsOnly && !(isOpenState(pr.state) && pr.mergeable === 'conflicting')) {
		return false;
	}
	return !filter.linkedOnly || linked;
}

export interface IPrGroup {
	readonly id: string;
	readonly label: string;
	readonly items: IVoltPullRequest[];
}

/** Groups by the filter's grouping, each ranked by its ordering. */
export function groupPullRequests(prs: readonly IVoltPullRequest[], filter: IPrFilter): IPrGroup[] {
	const groups = new Map<string, { label: string; items: IVoltPullRequest[] }>();
	const add = (id: string, label: string, pr: IVoltPullRequest) => {
		let group = groups.get(id);
		if (!group) {
			group = { label, items: [] };
			groups.set(id, group);
		}
		group.items.push(pr);
	};
	for (const pr of prs) {
		switch (filter.grouping) {
			case 'involvement': add(prInvolvement(pr), INVOLVEMENT_LABELS[prInvolvement(pr)], pr); break;
			case 'status': add(pr.state, PR_STATE_LABELS[pr.state], pr); break;
			case 'author': add(`@${pr.author.login}`, pr.author.login, pr); break;
			case 'label': add(pr.labels[0] ? `#${pr.labels[0].name}` : '~', pr.labels[0]?.name ?? localize('voltPrFilter.noLabel', "No label"), pr); break;
			case 'none': add('all', localize('voltPrFilter.all', "Pull requests"), pr); break;
		}
	}
	const order = (id: string) => {
		switch (filter.grouping) {
			case 'involvement': return INVOLVEMENT.indexOf(id as AgentPrInvolvement);
			case 'status': return STATES.indexOf(id as VoltPrState);
			default: return id === '~' ? Number.MAX_SAFE_INTEGER : 0;
		}
	};
	return [...groups]
		.sort((a, b) => order(a[0]) - order(b[0]) || a[1].label.localeCompare(b[1].label))
		.map(([id, group]) => ({ id, label: group.label, items: rankPullRequests(group.items, filter.sort, filter.grouping === 'involvement' ? id as AgentPrInvolvement : undefined) }));
}

/** The filter as stored: sets as arrays. */
export function serializePrFilter(filter: IPrFilter): string {
	return JSON.stringify({ ...filter, states: [...filter.states], checks: [...filter.checks], reviews: [...filter.reviews], involvement: [...filter.involvement], authors: [...filter.authors], labels: [...filter.labels], sizes: [...filter.sizes] });
}

export function parsePrFilter(raw: string | undefined): IPrFilter {
	const filter = newPrFilter();
	if (!raw) {
		return filter;
	}
	try {
		const data = JSON.parse(raw);
		const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
		const fill = <T extends string>(set: Set<T>, value: unknown, allowed?: readonly T[]) => strings(value).forEach(item => (!allowed || allowed.includes(item as T)) && set.add(item as T));
		filter.grouping = GROUPINGS.includes(data.grouping) ? data.grouping : filter.grouping;
		filter.sort = SORT_ORDER.includes(data.sort) ? data.sort : filter.sort;
		fill(filter.states, data.states, STATES);
		fill(filter.checks, data.checks, CHECKS);
		fill(filter.reviews, data.reviews, REVIEWS);
		fill(filter.involvement, data.involvement, INVOLVEMENT);
		fill(filter.authors, data.authors);
		fill(filter.labels, data.labels);
		fill(filter.sizes, data.sizes, SIZES);
		filter.updated = UPDATED.includes(data.updated) ? data.updated : 'any';
		filter.conflictsOnly = data.conflictsOnly === true;
		filter.linkedOnly = data.linkedOnly === true;
	} catch {
		// A broken record starts from the defaults.
	}
	return filter;
}

type FilterPick =
	| { readonly kind: 'grouping'; readonly value: PrGrouping }
	| { readonly kind: 'sort'; readonly value: AgentPrSort }
	| { readonly kind: 'toggle'; readonly set: Set<string>; readonly value: string }
	| { readonly kind: 'updated'; readonly value: PrUpdatedFilter }
	| { readonly kind: 'conflicts' }
	| { readonly kind: 'linked' }
	| { readonly kind: 'reset' }
	| { readonly kind: 'none' };

function toggle<T>(set: Set<T>, value: T): void {
	if (set.has(value)) {
		set.delete(value);
	} else {
		set.add(value);
	}
}

function badge(count: number): { badge?: string } {
	return count ? { badge: String(count) } : {};
}

/**
 * The agent list's filter menu, for pull requests: Grouping and Ordering, then Filters (status,
 * checks, review, involvement, author, label, size, last update), each a flyout of checks, two
 * toggles and Reset. Picks apply at once and the menu stays open.
 */
export function showPrFilterMenu(contextView: IContextViewService, anchor: HTMLElement, filter: IPrFilter, prs: readonly IVoltPullRequest[], onChange: () => void): IVoltMenuHandle {
	const none: FilterPick = { kind: 'none' };
	const reset: FilterPick = { kind: 'reset' };
	const doc = anchor.ownerDocument;
	const checkList = <T extends string>(id: string, values: readonly T[], set: Set<T>, label: (value: T) => string, icon?: (value: T) => IVoltMenuItem<FilterPick>['icon'], description?: (value: T) => string | undefined): IVoltMenuSection<FilterPick>[] => [{
		id,
		items: values.map(value => ({ id: value, label: label(value), icon: icon?.(value), description: description?.(value), checked: set.has(value), keepOpen: true, data: { kind: 'toggle', set: set as Set<string>, value } })),
	}];
	const count = (key: (pr: IVoltPullRequest) => readonly string[]) => {
		const counts = new Map<string, number>();
		for (const pr of prs) {
			for (const value of key(pr)) {
				counts.set(value, (counts.get(value) ?? 0) + 1);
			}
		}
		return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	};
	const authors = count(pr => [pr.author.login]);
	const labels = count(pr => pr.labels.map(label => label.name));
	const flyout = (id: string, label: string, active: number, width: number, sections: () => IVoltMenuSection<FilterPick>[], search?: string): IVoltMenuItem<FilterPick> => ({
		id, label, ...badge(active), data: none,
		submenu: { width, sections: () => sections(), search: search ? { placeholder: search } : undefined },
	});
	anchor.classList.add('open');
	const handle: IVoltMenuHandle = showVoltMenu<FilterPick>(contextView, {
		anchor,
		align: 'left',
		gap: 6,
		width: 240,
		// Every row fits without scrolling, Reset included.
		maxListHeight: 600,
		className: 'volt-pr-filter-menu',
		ariaLabel: localize('voltPrFilter.aria', "Filter and sort pull requests"),
		sections: () => [
			{
				id: 'view',
				items: [
					{
						id: 'grouping', label: localize('voltPrFilter.grouping', "Grouping"), detail: GROUPING_LABELS[filter.grouping], data: none,
						submenu: { width: 180, sections: () => [{ id: 'g', items: GROUPINGS.map(value => ({ id: value, label: GROUPING_LABELS[value], checked: filter.grouping === value, keepOpen: true, data: { kind: 'grouping', value } })) }] },
					},
					{
						id: 'ordering', label: localize('voltPrFilter.ordering', "Ordering"), detail: SORT_LABELS[filter.sort], data: none,
						submenu: { width: 220, sections: () => [{ id: 'o', items: SORT_ORDER.map(value => ({ id: value, label: SORT_LABELS[value], icon: () => lineIcon(doc, SORT_ICONS[value], 16), checked: filter.sort === value, keepOpen: true, data: { kind: 'sort', value } })) }] },
					},
				],
			},
			{
				id: 'filters',
				title: localize('voltPrFilter.filters', "Filters"),
				items: [
					flyout('status', localize('voltPrFilter.status', "Status"), filter.states.size, 180, () => checkList('s', STATES, filter.states, value => PR_STATE_LABELS[value], value => prStateIcon(value))),
					flyout('checks', localize('voltPrFilter.checks', "Checks"), filter.checks.size, 180, () => checkList('c', CHECKS, filter.checks, value => CHECK_LABELS[value], value => value === 'none' ? Codicon.circleSlash : checkIcon(value))),
					flyout('review', localize('voltPrFilter.review', "Review"), filter.reviews.size, 210, () => checkList('r', REVIEWS, filter.reviews, value => REVIEW_LABELS[value], value => REVIEW_ICONS[value])),
					flyout('involvement', localize('voltPrFilter.involvement', "Involvement"), filter.involvement.size, 210, () => checkList('i', INVOLVEMENT, filter.involvement, value => INVOLVEMENT_LABELS[value], value => INVOLVEMENT_ICONS[value])),
					flyout('author', localize('voltPrFilter.author', "Author"), filter.authors.size, 220, () => [{
						id: 'a', emptyMessage: localize('voltPrFilter.noAuthors', "No authors"),
						items: authors.map(([login, n]) => ({ id: login, label: login, icon: Codicon.account, badge: String(n), checked: filter.authors.has(login), keepOpen: true, data: { kind: 'toggle', set: filter.authors, value: login } })),
					}], localize('voltPrFilter.searchAuthor', "Search authors...")),
					flyout('label', localize('voltPrFilter.label', "Label"), filter.labels.size, 220, () => [{
						id: 'l', emptyMessage: localize('voltPrFilter.noLabels', "No labels"),
						items: labels.map(([name, n]) => ({ id: name, label: name, icon: Codicon.tag, badge: String(n), checked: filter.labels.has(name), keepOpen: true, data: { kind: 'toggle', set: filter.labels, value: name } })),
					}], localize('voltPrFilter.searchLabel', "Search labels...")),
					flyout('size', localize('voltPrFilter.size', "Size"), filter.sizes.size, 180, () => checkList('z', SIZES, filter.sizes, value => value, undefined, value => localize('voltPrFilter.lines', "{0} lines", SIZE_HINTS[value]))),
					{
						id: 'updated', label: localize('voltPrFilter.updated', "Updated"), detail: filter.updated !== 'any' ? UPDATED_LABELS[filter.updated] : undefined, data: none,
						submenu: { width: 200, sections: () => [{ id: 'u', items: UPDATED.map(value => ({ id: value, label: UPDATED_LABELS[value], checked: filter.updated === value, keepOpen: true, data: { kind: 'updated', value } })) }] },
					},
					{ id: 'conflicts', label: localize('voltPrFilter.conflicts', "Has Conflicts"), checked: filter.conflictsOnly, keepOpen: true, data: { kind: 'conflicts' } },
					{ id: 'linked', label: localize('voltPrFilter.linked', "Linked to Chats"), checked: filter.linkedOnly, keepOpen: true, data: { kind: 'linked' } },
				],
			},
			...(prFilterCount(filter) ? [{ id: 'reset', items: [{ id: 'reset', label: localize('voltPrFilter.reset', "Reset Filters"), icon: Codicon.clearAll, keepOpen: true, data: reset }] }] : []),
		],
		onPick: item => {
			const pick = item.data;
			switch (pick.kind) {
				case 'grouping': filter.grouping = pick.value; break;
				case 'sort': filter.sort = pick.value; break;
				case 'toggle': toggle(pick.set, pick.value); break;
				case 'updated': filter.updated = pick.value; break;
				case 'conflicts': filter.conflictsOnly = !filter.conflictsOnly; break;
				case 'linked': filter.linkedOnly = !filter.linkedOnly; break;
				case 'reset': {
					const fresh = newPrFilter();
					for (const set of [filter.states, filter.checks, filter.reviews, filter.involvement, filter.authors, filter.labels, filter.sizes] as Set<string>[]) {
						set.clear();
					}
					filter.updated = fresh.updated;
					filter.conflictsOnly = fresh.conflictsOnly;
					filter.linkedOnly = fresh.linkedOnly;
					break;
				}
				case 'none':
					return;
			}
			onChange();
			handle.refresh();
		},
		onHide: () => anchor.classList.remove('open'),
	});
	return handle;
}
