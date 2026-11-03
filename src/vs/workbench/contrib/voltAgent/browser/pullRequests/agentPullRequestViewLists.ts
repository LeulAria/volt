/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { IVoltPrCheck, IVoltPrCommit } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { ago, avatar, checkDuration, checkIcon, iconSpan } from './agentPullRequestUi.js';

/**
 * The pull request view's Summary lists (Commits, Checks): VS Code lists whose rows run edge to
 * edge of the view with square corners, like Previous agents. The view's 16px gutter moves into
 * the rows, so their icons line up with the sections' titles.
 */

const COMMIT_ROW_HEIGHT = 32;
const CHECK_ROW_HEIGHT = 30;

class FixedHeightDelegate<T> implements IListVirtualDelegate<T> {
	constructor(private readonly height: number, private readonly templateId: string) { }
	getHeight(): number {
		return this.height;
	}
	getTemplateId(): string {
		return this.templateId;
	}
}

/** A small button in a row: the list must not take its press as picking the row. */
function rowButton(parent: HTMLElement, icon: ThemeIcon, label: string | undefined, tooltip: string, store: DisposableStore, run: () => void): HTMLButtonElement {
	const button = append(parent, $(label ? 'button.volt-pr-button.ghost' : 'button.volt-pr-icon-button.subtle')) as HTMLButtonElement;
	button.type = 'button';
	button.appendChild(renderIcon(icon));
	if (label) {
		append(button, $('span')).textContent = label;
	}
	button.setAttribute('aria-label', tooltip);
	setAgentTooltip(button, tooltip);
	store.add(addDisposableListener(button, 'mousedown', e => e.stopPropagation()));
	store.add(addDisposableListener(button, 'click', e => {
		EventHelper.stop(e, true);
		run();
	}));
	return button;
}

function mountList<T>(instantiationService: IInstantiationService, parent: HTMLElement, className: string, rowHeight: number, items: readonly T[], renderer: IListRenderer<T, unknown>, options: { ariaLabel: string; getId: (item: T) => string; getAriaLabel: (item: T) => string; onOpen: (item: T) => void }): IDisposable {
	const store = new DisposableStore();
	const host = append(parent, $(`.volt-pr-row-list.${className}`));
	const height = items.length * rowHeight;
	host.style.height = `${height}px`;
	const list = store.add(instantiationService.createInstance(WorkbenchList<T>, className, host, new FixedHeightDelegate<T>(rowHeight, renderer.templateId), [renderer], {
		identityProvider: { getId: options.getId },
		multipleSelectionSupport: false,
		horizontalScrolling: false,
		// The view scrolls, not the list: a wheel over the rows scrolls the page.
		alwaysConsumeMouseWheel: false,
		accessibilityProvider: {
			getWidgetAriaLabel: () => options.ariaLabel,
			getAriaLabel: options.getAriaLabel,
		},
	}));
	list.layout(height);
	list.splice(0, 0, [...items]);
	store.add(list.onDidOpen(e => e.element && options.onOpen(e.element)));
	store.add(toDisposable(() => host.remove()));
	return store;
}

//#region Commits

export interface IPrCommitListOptions {
	/** The code host, for authors' avatars. */
	readonly host: string;
	/** Opening a row: the commit in Source Control (or its changes in the Code tab). */
	readonly open: (commit: IVoltPrCommit) => void;
	readonly showChanges: (commit: IVoltPrCommit) => void;
	readonly copyId: (commit: IVoltPrCommit) => void;
}

interface ICommitTemplate {
	readonly avatar: HTMLElement;
	readonly headline: HTMLElement;
	readonly checks: HTMLElement;
	readonly sha: HTMLElement;
	readonly time: HTMLElement;
	readonly actions: HTMLElement;
	readonly elementStore: DisposableStore;
}

class CommitRenderer implements IListRenderer<IVoltPrCommit, ICommitTemplate> {
	static readonly TEMPLATE_ID = 'voltPrCommit';
	readonly templateId = CommitRenderer.TEMPLATE_ID;

	constructor(private readonly options: IPrCommitListOptions) { }

	renderTemplate(container: HTMLElement): ICommitTemplate {
		const row = append(container, $('.volt-pr-commit-row'));
		return {
			avatar: append(row, $('span.volt-pr-commit-avatar')),
			headline: append(row, $('span.volt-pr-commit-headline')),
			checks: append(row, $('span.volt-pr-commit-checks')),
			sha: append(row, $('span.volt-pr-commit-sha')),
			time: append(row, $('span.volt-pr-commit-time')),
			actions: append(row, $('span.volt-pr-row-actions')),
			elementStore: new DisposableStore(),
		};
	}

	renderElement(commit: IVoltPrCommit, _index: number, template: ICommitTemplate): void {
		template.elementStore.clear();
		template.avatar.replaceChildren();
		// A login gets its avatar; a plain name (no account) keeps the letter.
		avatar(template.avatar, commit.author, /^[\w-]+$/.test(commit.author) ? `https://${this.options.host}/${commit.author}.png` : undefined, 18);
		template.headline.textContent = commit.headline;
		template.checks.replaceChildren();
		if (commit.checks !== 'none') {
			iconSpan(template.checks, commit.checks === 'pending' ? ThemeIcon.modify(Codicon.loading, 'spin') : checkIcon(commit.checks), `check-${commit.checks}`);
		}
		template.sha.textContent = commit.oid.slice(0, 7);
		template.time.textContent = ago(commit.at);
		template.time.title = commit.author;
		template.actions.replaceChildren();
		rowButton(template.actions, Codicon.diff, undefined, localize('voltPr.showCommit', "Show this commit's changes"), template.elementStore, () => this.options.showChanges(commit));
		rowButton(template.actions, Codicon.copy, undefined, localize('voltPr.copySha', "Copy commit id"), template.elementStore, () => this.options.copyId(commit));
	}

	disposeTemplate(template: ICommitTemplate): void {
		template.elementStore.dispose();
	}
}

/** The pull request's commits, one row each: author, headline, checks, short id and when. */
export function renderPrCommitList(instantiationService: IInstantiationService, parent: HTMLElement, commits: readonly IVoltPrCommit[], options: IPrCommitListOptions): IDisposable {
	return mountList(instantiationService, parent, 'volt-pr-commit-list', COMMIT_ROW_HEIGHT, commits, new CommitRenderer(options), {
		ariaLabel: localize('voltPr.commitsAria', "Commits"),
		getId: commit => commit.oid,
		getAriaLabel: commit => localize('voltPr.commitAria', "{0}, {1} by {2}, {3}", commit.headline, commit.oid.slice(0, 7), commit.author, ago(commit.at)),
		onOpen: options.open,
	});
}

//#endregion

//#region Checks

export interface IPrCheckListOptions {
	/** Failing checks offer Fix (the chat's agent fixes it) while the pull request is open. */
	readonly canFix: boolean;
	readonly fix: (check: IVoltPrCheck) => void;
	/** Opening a row: the check's page on the host. */
	readonly open: (check: IVoltPrCheck) => void;
	readonly stateLabel: (state: IVoltPrCheck['state']) => string;
}

interface ICheckTemplate {
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly required: HTMLElement;
	readonly time: HTMLElement;
	readonly state: HTMLElement;
	readonly actions: HTMLElement;
	readonly elementStore: DisposableStore;
}

class CheckRenderer implements IListRenderer<IVoltPrCheck, ICheckTemplate> {
	static readonly TEMPLATE_ID = 'voltPrCheck';
	readonly templateId = CheckRenderer.TEMPLATE_ID;

	constructor(private readonly options: IPrCheckListOptions) { }

	renderTemplate(container: HTMLElement): ICheckTemplate {
		const row = append(container, $('.volt-pr-check-row'));
		const icon = append(row, $('span.volt-pr-check-icon'));
		const name = append(row, $('span.volt-pr-check-name'));
		const required = append(row, $('span.volt-pr-tag'));
		required.textContent = localize('voltPr.required', "required");
		append(row, $('.volt-pr-spacer'));
		return {
			icon,
			name,
			required,
			time: append(row, $('span.volt-pr-check-time')),
			state: append(row, $('span.volt-pr-check-state')),
			actions: append(row, $('span.volt-pr-row-actions')),
			elementStore: new DisposableStore(),
		};
	}

	renderElement(check: IVoltPrCheck, _index: number, template: ICheckTemplate): void {
		template.elementStore.clear();
		template.icon.replaceChildren();
		iconSpan(template.icon, check.state === 'pending' ? ThemeIcon.modify(Codicon.loading, 'spin') : checkIcon(check.state), `check-${check.state}`);
		template.name.textContent = check.workflow ? `${check.workflow} / ${check.name}` : check.name;
		template.name.title = check.summary ?? '';
		template.required.classList.toggle('hidden', !check.required);
		template.time.textContent = checkDuration(check) ?? '';
		template.state.className = `volt-pr-check-state check-${check.state}`;
		template.state.textContent = this.options.stateLabel(check.state);
		template.actions.replaceChildren();
		template.actions.classList.toggle('pinned', check.state === 'failure' && this.options.canFix);
		if (check.state === 'failure' && this.options.canFix) {
			rowButton(template.actions, Codicon.wrench, localize('voltPr.fix', "Fix"), localize('voltPr.fixTip', "Ask the chat's agent to fix {0}", check.name), template.elementStore, () => this.options.fix(check));
		}
		if (check.url) {
			rowButton(template.actions, Codicon.linkExternal, undefined, localize('voltPr.details', "Details"), template.elementStore, () => this.options.open(check));
		}
	}

	disposeTemplate(template: ICheckTemplate): void {
		template.elementStore.dispose();
	}
}

/** The latest commit's checks, failing first: state, name, how long it ran, and Fix or Details. */
export function renderPrCheckList(instantiationService: IInstantiationService, parent: HTMLElement, checks: readonly IVoltPrCheck[], options: IPrCheckListOptions): IDisposable {
	return mountList(instantiationService, parent, 'volt-pr-check-list', CHECK_ROW_HEIGHT, checks, new CheckRenderer(options), {
		ariaLabel: localize('voltPr.checksAria', "Checks"),
		getId: check => `${check.workflow ?? ''}/${check.name}`,
		getAriaLabel: check => `${check.workflow ? `${check.workflow} / ` : ''}${check.name}: ${options.stateLabel(check.state)}`,
		onOpen: check => check.url && options.open(check),
	});
}

//#endregion
