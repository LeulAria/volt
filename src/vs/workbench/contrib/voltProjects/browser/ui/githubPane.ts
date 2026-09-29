/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventHelper, getWindow } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { HighlightedLabel } from '../../../../../base/browser/ui/highlightedlabel/highlightedLabel.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { List } from '../../../../../base/browser/ui/list/listWidget.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { IMatch, matchesFuzzy } from '../../../../../base/common/filters.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles, defaultInputBoxStyles, getListStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IGitHubRepo, IGitHubReposService } from '../githubRepos.js';

type Row =
	| { readonly kind: 'repo'; readonly id: string; readonly repo: IGitHubRepo; readonly matches?: IMatch[] }
	| { readonly kind: 'searchAll'; readonly id: string; readonly query: string }
	| { readonly kind: 'message'; readonly id: string; readonly text: string };

const ROW_HEIGHT = 34;

/** Your GitHub repositories, filtered as you type, with server search for the rest. */
export class GitHubPane extends Disposable {

	readonly element: HTMLElement;

	private readonly account: HTMLElement;
	private readonly search: InputBox;
	private readonly listHost: HTMLElement;
	private readonly list: List<Row>;
	private readonly searchScheduler: RunOnceScheduler;
	private readonly accountStore = this._register(new DisposableStore());
	private repos: IGitHubRepo[] = [];
	private remote: IGitHubRepo[] = [];
	private rows: Row[] = [];
	private nextPage = 1;
	private hasMore = true;
	private loading = false;
	private signedIn: boolean | undefined;
	private error: string | undefined;
	private everywhere = false;
	/** A server search is scheduled or running; empty results are not final yet. */
	private searching = false;
	private cts = new CancellationTokenSource();

	constructor(
		container: HTMLElement,
		private readonly onPick: (repo: IGitHubRepo) => void,
		@IGitHubReposService private readonly github: IGitHubReposService,
	) {
		super();
		this.element = append(container, $('.volt-add-pane.github'));
		this.account = append(this.element, $('.volt-github-account'));
		const searchRow = append(this.element, $('.volt-github-search'));
		searchRow.appendChild(renderIcon(Codicon.search));
		this.search = this._register(new InputBox(searchRow, undefined, {
			placeholder: localize('voltGitHub.search', "Search your repositories"),
			ariaLabel: localize('voltGitHub.search', "Search your repositories"),
			tooltip: '',
			inputBoxStyles: { ...defaultInputBoxStyles, inputBackground: 'transparent', inputBorder: 'transparent' },
		}));
		this.listHost = append(this.element, $('.volt-github-list'));
		this.list = this._register(new List<Row>('VoltGitHubRepos', this.listHost, new RowDelegate(), [new RepoRenderer(), new SearchAllRenderer(), new MessageRenderer()], {
			identityProvider: { getId: row => row.id },
			multipleSelectionSupport: false,
			keyboardSupport: false,
			mouseSupport: true,
			horizontalScrolling: false,
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('voltGitHub.repos', "Repositories"),
				getAriaLabel: row => row.kind === 'repo' ? `${row.repo.fullName}${row.repo.private ? ', private' : ''}` : row.kind === 'searchAll' ? localize('voltGitHub.searchAllAria', "Search all of GitHub for {0}", row.query) : row.text,
			},
		}));
		this.list.style(getListStyles({ listBackground: 'transparent', listFocusOutline: 'transparent', listInactiveFocusOutline: 'transparent' }));
		this._register(addDisposableListener(this.listHost, 'mousedown', e => e.preventDefault()));
		this._register(this.list.onMouseClick(e => {
			if (e.index !== undefined) {
				this.list.setFocus([e.index]);
				this.activate(this.rows[e.index]);
			}
		}));
		this._register(this.list.onDidScroll(e => {
			if (e.scrollTop + e.height > e.scrollHeight - ROW_HEIGHT * 6) {
				void this.loadMore();
			}
		}));
		this.searchScheduler = this._register(new RunOnceScheduler(() => void this.serverSearch(), 300));
		this._register(this.search.onDidChange(() => {
			this.everywhere = false;
			this.remote = [];
			this.searching = this.search.value.trim().length >= 2;
			this.render(true);
			if (this.searching) {
				this.searchScheduler.schedule();
			}
		}));
		this._register(addDisposableListener(this.search.inputElement, 'keydown', e => this.onKeyDown(e)));
		this._register(this.github.onDidChangeAccount(() => void this.reset()));
		this._register(toDisposable(() => this.cts.dispose(true)));
		const win = getWindow(this.element);
		const observer = new win.ResizeObserver(() => this.list.layout(this.listHost.clientHeight, this.listHost.clientWidth));
		observer.observe(this.listHost);
		this._register(toDisposable(() => observer.disconnect()));
		void this.reset();
	}

	focus(): void {
		this.search.focus();
	}

	private async reset(): Promise<void> {
		this.cts.dispose(true);
		this.cts = new CancellationTokenSource();
		this.repos = [];
		this.remote = [];
		this.nextPage = 1;
		this.hasMore = true;
		this.error = undefined;
		const account = await this.github.account();
		this.signedIn = !!account;
		this.renderAccount(account?.login);
		this.search.setPlaceHolder(account ? localize('voltGitHub.search', "Search your repositories") : localize('voltGitHub.searchPublic', "Search public repositories"));
		this.render(true);
		if (account) {
			await this.loadMore();
		}
	}

	private renderAccount(login: string | undefined): void {
		this.accountStore.clear();
		clearNode(this.account);
		this.account.appendChild(renderIcon(Codicon.github));
		if (login) {
			append(this.account, $('span')).textContent = localize('voltGitHub.signedInAs', "Signed in as @{0}", login);
			return;
		}
		append(this.account, $('span')).textContent = localize('voltGitHub.signedOut', "Sign in to see your repositories, including private ones.");
		const button = this.accountStore.add(new Button(this.account, { ...defaultButtonStyles, secondary: true }));
		button.label = localize('voltGitHub.signIn', "Sign in with GitHub");
		this.accountStore.add(button.onDidClick(() => void this.github.signIn()));
	}

	private async loadMore(): Promise<void> {
		if (this.loading || !this.hasMore || !this.signedIn) {
			return;
		}
		this.loading = true;
		this.render();
		const token = this.cts.token;
		try {
			const page = await this.github.page(this.nextPage, token);
			if (token.isCancellationRequested) {
				return;
			}
			this.repos.push(...page.repos);
			this.hasMore = page.hasMore;
			this.nextPage++;
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
			this.hasMore = false;
		} finally {
			this.loading = false;
			if (!token.isCancellationRequested) {
				this.render();
			}
		}
	}

	private async serverSearch(): Promise<void> {
		const query = this.search.value.trim();
		if (query.length < 2) {
			return;
		}
		const token = this.cts.token;
		this.searching = true;
		try {
			const found = await this.github.search(query, this.everywhere || !this.signedIn, token);
			if (!token.isCancellationRequested && query === this.search.value.trim()) {
				this.remote = [...found];
				this.searching = false;
				this.render();
			}
		} catch (err) {
			if (!token.isCancellationRequested && query === this.search.value.trim()) {
				this.searching = false;
				this.error = err instanceof Error ? err.message : String(err);
				this.render();
			}
		}
	}

	private render(resetFocus = false): void {
		const query = this.search.value.trim();
		const rows: Row[] = [];
		const seen = new Set<string>();
		const push = (repo: IGitHubRepo, matches?: IMatch[]) => {
			if (!seen.has(repo.fullName)) {
				seen.add(repo.fullName);
				rows.push({ kind: 'repo', id: repo.fullName, repo, matches });
			}
		};
		if (!this.everywhere) {
			for (const repo of this.repos) {
				if (!query) {
					push(repo);
					continue;
				}
				const matches = matchesFuzzy(query, repo.fullName, true) ?? matchesFuzzy(query, repo.name, true);
				if (matches) {
					push(repo, matchesFuzzy(query, repo.fullName, true) ?? undefined);
				}
			}
		}
		for (const repo of this.remote) {
			push(repo, query ? matchesFuzzy(query, repo.fullName, true) ?? undefined : undefined);
		}
		if (this.loading) {
			rows.push({ kind: 'message', id: 'loading', text: localize('voltGitHub.loading', "Loading repositories...") });
		} else if (this.error) {
			rows.push({ kind: 'message', id: 'error', text: this.error });
		} else if (!rows.length && this.signedIn === false && !query) {
			rows.push({ kind: 'message', id: 'hint', text: localize('voltGitHub.publicHint', "Type to search public repositories, or paste a URL in the Git URL tab.") });
		} else if (this.searching) {
			rows.push({ kind: 'message', id: 'searching', text: localize('voltGitHub.searching', "Searching GitHub...") });
		} else if (!rows.length && query) {
			rows.push({ kind: 'message', id: 'none', text: localize('voltGitHub.none', "No repositories match \"{0}\"", query) });
		}
		if (query && !this.everywhere && this.signedIn) {
			rows.push({ kind: 'searchAll', id: 'searchAll', query });
		}
		const previous = this.list.getFocus()[0];
		const previousId = previous !== undefined ? this.rows[previous]?.id : undefined;
		this.rows = rows;
		this.list.splice(0, this.list.length, rows);
		let focus = !resetFocus && previousId ? rows.findIndex(row => row.id === previousId) : -1;
		if (focus < 0) {
			focus = rows.findIndex(row => row.kind !== 'message');
		}
		this.list.setFocus(focus >= 0 ? [focus] : []);
		if (resetFocus) {
			this.list.scrollTop = 0;
		}
	}

	private activate(row: Row | undefined): void {
		if (row?.kind === 'repo') {
			this.onPick(row.repo);
		} else if (row?.kind === 'searchAll') {
			this.everywhere = true;
			this.remote = [];
			this.render(true);
			void this.serverSearch();
		}
	}

	private onKeyDown(e: KeyboardEvent): void {
		const event = new StandardKeyboardEvent(e);
		const focus = this.list.getFocus()[0] ?? -1;
		const move = (delta: number) => {
			let index = focus;
			for (let step = 0; step < this.rows.length; step++) {
				index += delta;
				if (index < 0 || index >= this.rows.length) {
					return;
				}
				if (this.rows[index].kind !== 'message') {
					this.list.setFocus([index]);
					this.list.reveal(index);
					return;
				}
			}
		};
		if (event.equals(KeyCode.DownArrow)) {
			move(1);
		} else if (event.equals(KeyCode.UpArrow)) {
			move(-1);
		} else if (event.equals(KeyCode.Enter)) {
			this.activate(this.rows[focus]);
		} else if (event.equals(KeyCode.Escape) && this.search.value) {
			this.search.value = '';
		} else {
			return;
		}
		EventHelper.stop(e, true);
	}
}

class RowDelegate implements IListVirtualDelegate<Row> {
	getHeight(): number {
		return ROW_HEIGHT;
	}
	getTemplateId(row: Row): string {
		return row.kind;
	}
}

interface IRepoTemplate {
	readonly icon: HTMLElement;
	readonly name: HighlightedLabel;
	readonly description: HTMLElement;
	readonly meta: HTMLElement;
}

class RepoRenderer implements IListRenderer<Row, IRepoTemplate> {
	readonly templateId = 'repo';

	renderTemplate(container: HTMLElement): IRepoTemplate {
		const row = append(container, $('.volt-github-row'));
		const icon = append(row, $('span.volt-github-icon'));
		const text = append(row, $('.volt-github-text'));
		const name = new HighlightedLabel(append(text, $('span.volt-github-name')));
		const description = append(text, $('span.volt-github-description'));
		const meta = append(row, $('span.volt-github-meta'));
		return { icon, name, description, meta };
	}

	renderElement(row: Row, _index: number, template: IRepoTemplate): void {
		if (row.kind !== 'repo') {
			return;
		}
		const repo = row.repo;
		clearNode(template.icon);
		template.icon.appendChild(renderIcon(repo.private ? Codicon.lock : repo.fork ? Codicon.repoForked : Codicon.repo));
		template.name.set(repo.fullName, row.matches);
		template.description.textContent = repo.description ?? '';
		const parts = [repo.language, repo.stars ? `\u2605 ${repo.stars}` : undefined, repo.pushedAt ? fromNow(Date.parse(repo.pushedAt), true) : undefined].filter(Boolean);
		template.meta.textContent = parts.join('  ·  ');
	}

	disposeTemplate(): void { }
}

class SearchAllRenderer implements IListRenderer<Row, HTMLElement> {
	readonly templateId = 'searchAll';

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-github-row.search-all'));
	}

	renderElement(row: Row, _index: number, element: HTMLElement): void {
		clearNode(element);
		append(element, $('span.volt-github-icon')).appendChild(renderIcon(Codicon.globe));
		append(element, $('span.volt-github-name')).textContent = row.kind === 'searchAll' ? localize('voltGitHub.searchAll', "Search all of GitHub for \"{0}\"", row.query) : '';
	}

	disposeTemplate(): void { }
}

class MessageRenderer implements IListRenderer<Row, HTMLElement> {
	readonly templateId = 'message';

	renderTemplate(container: HTMLElement): HTMLElement {
		return append(container, $('.volt-github-row.message'));
	}

	renderElement(row: Row, _index: number, element: HTMLElement): void {
		element.textContent = row.kind === 'message' ? row.text : '';
	}

	disposeTemplate(): void { }
}
