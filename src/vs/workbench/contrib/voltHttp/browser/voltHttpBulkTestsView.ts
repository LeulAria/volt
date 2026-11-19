/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer } from '../../../../base/browser/ui/list/list.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, relativePath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { IAgentRuntimeService } from '../../../services/voltRuntime/common/runtime.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { httpRequestLabel, httpRequestsOf, IHttpRequest } from '../common/httpCollection.js';
import { httpRequestBadge, httpRequestBadgeKey } from '../common/httpProtocols.js';
import { createHttpAiModelButton, httpAiModelRef } from './voltHttpAiModel.js';
import { HTTP_TEST_WRITE_TIMEOUT_MS, IHttpWrittenTests, writeHttpTestScript } from './voltHttpAiTests.js';
import { generateHttpTestsFor, HttpBulkStage, httpTestBlocker, IHttpBulkResult, IHttpTestTarget } from './voltHttpBulkTests.js';
import { httpDraftKey, IHttpCollectionEntry, IVoltHttpCollections } from './voltHttpCollections.js';
import { createHttpCheck } from './voltHttpWidgets.js';

const ROW_HEIGHT = 28;
const MAX_ROWS_SHOWN = 11;

interface ICollectionRow {
	readonly kind: 'collection';
	readonly entry: IHttpCollectionEntry;
	readonly label: string;
	/** The keys of its requests that can be picked. */
	readonly keys: readonly string[];
}

interface IRequestRow {
	readonly kind: 'request';
	readonly key: string;
	readonly target: IHttpTestTarget;
	readonly request: IHttpRequest;
	/** The folders it sits in, "Auth / Admin". */
	readonly path: string;
	/** Why it cannot be picked. */
	readonly blocker?: string;
}

type Row = ICollectionRow | IRequestRow;

interface IRowTemplate {
	readonly row: HTMLElement;
	readonly check: HTMLElement;
	readonly icon: HTMLElement;
	readonly method: HTMLElement;
	readonly label: HTMLElement;
	readonly detail: HTMLElement;
	readonly status: HTMLElement;
}

export interface IHttpBulkTestsHost {
	readonly root: URI | undefined;
	/** The requests ticked when the dialog opens; every request without tests when absent. */
	readonly preselect?: readonly IHttpTestTarget[];
	close(): void;
}

/**
 * "Generate tests" for many requests at once: the project's collections as one list with a tick
 * per request (and one per collection for all of its requests), what to check, the model, and a
 * run that shows each request's progress and result in its row.
 */
export class HttpBulkTestsView extends Disposable {

	private readonly rows: Row[] = [];
	private readonly checked = new Set<string>();
	private readonly stages = new Map<string, HttpBulkStage | 'queued'>();
	private readonly results = new Map<string, IHttpBulkResult>();
	private readonly running = this._register(new MutableDisposable());
	private list: WorkbenchList<Row> | undefined;
	private skipExisting = true;
	private readonly listHost: HTMLElement;
	private readonly countEl: HTMLElement;
	private readonly statusEl: HTMLElement;
	private readonly wish: HTMLTextAreaElement;
	private readonly modelButton: HTMLButtonElement;
	private readonly run: ReturnType<typeof createVoltButton>;

	constructor(
		body: HTMLElement,
		footer: HTMLElement,
		private readonly host: IHttpBulkTestsHost,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltHttpCollections private readonly collections: IVoltHttpCollections,
	) {
		super();
		body.classList.add('bulk');
		const intro = append(body, $('.volt-http-bulk-section'));
		append(intro, $('.volt-http-note')).textContent = localize('voltHttp.bulkHelp', "Each ticked request is sent, a model writes its tests from the response, and they are added under Scripts, Post-response and run. Requests go in order, so a login runs before the calls that need its token.");
		this.wish = append(intro, $('textarea.volt-http-ai-wish')) as HTMLTextAreaElement;
		this.wish.rows = 1;
		this.wish.spellcheck = false;
		this.wish.placeholder = localize('voltHttp.aiWish', "Optional: what should the tests check?");
		this.wish.setAttribute('aria-label', localize('voltHttp.aiWishLabel', "What the tests should check"));

		this.listHost = append(body, $('.volt-http-bulk-list'));

		const options = append(body, $('.volt-http-bulk-section.volt-http-bulk-options'));
		const skip = createHttpCheck(options, this.skipExisting, localize('voltHttp.bulkSkip', "Skip requests that already have tests"), checked => {
			this.skipExisting = checked;
			this.refresh();
		});
		const skipLabel = append(options, $('span.volt-http-bulk-option'));
		skipLabel.textContent = localize('voltHttp.bulkSkip', "Skip requests that already have tests");
		this._register(addDisposableListener(skipLabel, EventType.CLICK, () => skip.element.click()));
		append(options, $('.volt-http-spacer'));
		this.countEl = append(options, $('span.volt-http-bulk-count'));

		this.modelButton = createHttpAiModelButton(footer, this.instantiationService, this._store, localize('voltHttp.aiModel', "The model that writes the tests"));
		this.statusEl = append(footer, $('.volt-http-bulk-status'));
		this.statusEl.setAttribute('role', 'status');
		const close = this._register(createVoltButton(footer, 'ghost'));
		close.label = localize('voltHttp.closeDialog', "Close");
		this._register(close.onDidClick(() => this.host.close()));
		this.run = this._register(createVoltButton(footer, 'primary'));
		this._register(this.run.onDidClick(() => this.running.value ? this.running.clear() : void this.start()));
		this._register(addDisposableListener(getWindow(body), EventType.RESIZE, () => this.layout()));
		this.refresh();
		void this.load();
	}

	private async load(): Promise<void> {
		const entries = await this.collections.collections(this.host.root);
		if (this._store.isDisposed) {
			return;
		}
		const preselect = this.host.preselect ? new Set(this.host.preselect.map(target => httpDraftKey(target.collection, target.id))) : undefined;
		for (const entry of entries) {
			if (entry.error) {
				continue;
			}
			const requests: IRequestRow[] = httpRequestsOf(entry.collection.items).map(({ request: saved, ancestors }) => {
				const key = httpDraftKey(entry.uri, saved.id);
				// The request as it is open, unsaved edits included: that is what gets sent and tested.
				const request = this.collections.draftOf(key) ?? saved;
				const blocker = httpTestBlocker(request);
				return { kind: 'request', key, target: { collection: entry.uri, id: saved.id }, request, path: ancestors.map(folder => folder.name).join(' / '), ...(blocker ? { blocker } : {}) };
			});
			if (!requests.length) {
				continue;
			}
			const label = entry.collection.format === 'postman' ? entry.collection.name : (this.host.root && relativePath(this.host.root, entry.uri)) || basename(entry.uri);
			this.rows.push({ kind: 'collection', entry, label, keys: requests.filter(row => !row.blocker).map(row => row.key) }, ...requests);
			for (const row of requests) {
				if (!row.blocker && (preselect ? preselect.has(row.key) : !row.request.scripts.test.trim())) {
					this.checked.add(row.key);
				}
			}
		}
		this.buildList();
		this.refresh();
	}

	private buildList(): void {
		if (!this.rows.length) {
			append(this.listHost, $('.volt-http-bulk-empty')).textContent = localize('voltHttp.bulkEmpty', "No requests yet. Add a collection or an .http file first.");
			return;
		}
		const renderer: IListRenderer<Row, IRowTemplate> = {
			templateId: 'row',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-row.volt-http-bulk-row'));
				const check = append(row, $('span.volt-http-check'));
				check.appendChild(renderIcon(Codicon.check));
				return {
					row,
					check,
					icon: append(row, $('span.volt-http-row-icon')),
					method: append(row, $('span.volt-http-row-method')),
					label: append(row, $('span.volt-http-row-label')),
					detail: append(row, $('span.volt-http-row-detail')),
					status: append(row, $('span.volt-http-bulk-state')),
				};
			},
			renderElement: (row, _index, template) => this.renderRow(row, template),
			disposeTemplate: () => { },
		};
		const list = this.list = this._register(this.instantiationService.createInstance(WorkbenchList<Row>, 'VoltHttpBulkTests', this.listHost, { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'row' }, [renderer], {
			accessibilityProvider: {
				getAriaLabel: row => row.kind === 'collection' ? row.label : `${row.request.method} ${httpRequestLabel(row.request)} ${this.stateOf(row).text}`,
				getWidgetAriaLabel: () => localize('voltHttp.bulkList', "Requests to write tests for"),
				getRole: () => 'checkbox',
				isChecked: row => this.isChecked(row),
			},
			multipleSelectionSupport: false,
			identityProvider: { getId: row => row.kind === 'collection' ? row.entry.uri.toString() : row.key },
		}));
		this._register(list.onMouseClick(event => event.element && this.toggle(event.element)));
		this._register(list.onKeyDown(event => {
			if (event.key === ' ' || event.key === 'Enter') {
				event.preventDefault();
				event.stopPropagation();
				const [focused] = list.getFocusedElements();
				if (focused) {
					this.toggle(focused);
				}
			}
		}));
		list.splice(0, 0, this.rows);
		this.layout();
	}

	private layout(): void {
		if (!this.list) {
			return;
		}
		const height = Math.min(this.rows.length, MAX_ROWS_SHOWN) * ROW_HEIGHT;
		this.listHost.style.height = `${height}px`;
		this.list.layout(height, this.listHost.clientWidth || undefined);
	}

	private isChecked(row: Row): boolean {
		return row.kind === 'request' ? this.checked.has(row.key) : row.keys.length > 0 && row.keys.every(key => this.checked.has(key));
	}

	private toggle(row: Row): void {
		if (this.running.value) {
			return;
		}
		if (row.kind === 'request') {
			if (row.blocker) {
				return;
			}
			if (!this.checked.delete(row.key)) {
				this.checked.add(row.key);
			}
		} else {
			const all = this.isChecked(row);
			for (const key of row.keys) {
				if (all) {
					this.checked.delete(key);
				} else {
					this.checked.add(key);
				}
			}
		}
		this.refresh();
	}

	/** What a request's row says at its right end: where its run is, what came of it, or what it has. */
	private stateOf(row: IRequestRow): { readonly text: string; readonly kind: 'muted' | 'busy' | 'ok' | 'error'; readonly title?: string } {
		const result = this.results.get(row.key);
		if (result) {
			if (result.status === 'added') {
				const unsaved = result.unsaved ? localize('voltHttp.bulkUnsaved', " · unsaved") : '';
				const clean = !result.detail && result.passed === result.total;
				return { text: `${localize('voltHttp.bulkPassed', "{0}/{1} passed", result.passed ?? 0, result.total ?? 0)}${unsaved}`, kind: clean ? 'ok' : 'error', ...(result.detail ? { title: result.detail } : {}) };
			}
			return { text: result.detail ?? '', kind: result.status === 'failed' ? 'error' : 'muted', ...(result.detail ? { title: result.detail } : {}) };
		}
		const stage = this.stages.get(row.key);
		if (stage) {
			// allow-any-unicode-next-line
			const text = stage === 'queued' ? localize('voltHttp.bulkQueued', "Queued") : stage === 'sending' ? localize('voltHttp.bulkSending', "Sending…") : stage === 'writing' ? localize('voltHttp.aiWriting', "Writing tests…") : localize('voltHttp.bulkRunning', "Running…");
			return { text, kind: stage === 'queued' ? 'muted' : 'busy' };
		}
		if (row.blocker) {
			return { text: localize('voltHttp.bulkBlocked', "Not supported"), kind: 'muted', title: row.blocker };
		}
		return { text: row.request.scripts.test.trim() ? localize('voltHttp.bulkHasTests', "Has tests") : '', kind: 'muted' };
	}

	private renderRow(row: Row, template: IRowTemplate): void {
		const checked = this.isChecked(row);
		const some = row.kind === 'collection' && !checked && row.keys.some(key => this.checked.has(key));
		template.check.classList.toggle('checked', checked || some);
		template.check.classList.toggle('some', some);
		template.check.replaceChildren(renderIcon(some ? Codicon.dash : Codicon.check));
		template.row.classList.toggle('collection', row.kind === 'collection');
		template.icon.replaceChildren();
		if (row.kind === 'collection') {
			template.row.classList.remove('blocked');
			template.check.classList.toggle('hidden', !row.keys.length);
			template.icon.classList.remove('none');
			template.icon.appendChild(renderIcon(row.entry.collection.format === 'postman' ? Codicon.library : Codicon.file));
			template.method.textContent = '';
			template.method.removeAttribute('data-method');
			template.label.textContent = row.label;
			template.detail.textContent = '';
			const picked = row.keys.filter(key => this.checked.has(key)).length;
			template.status.className = 'volt-http-bulk-state muted';
			template.status.replaceChildren();
			template.status.textContent = row.keys.length ? localize('voltHttp.bulkPicked', "{0} of {1}", picked, row.keys.length) : '';
			setAgentTooltip(template.row, row.entry.uri.fsPath);
			return;
		}
		template.row.classList.toggle('blocked', !!row.blocker);
		template.check.classList.toggle('hidden', !!row.blocker);
		template.icon.classList.add('none');
		template.method.textContent = httpRequestBadge(row.request);
		template.method.dataset.method = httpRequestBadgeKey(row.request);
		template.label.textContent = httpRequestLabel(row.request);
		template.detail.textContent = row.path;
		const state = this.stateOf(row);
		template.status.className = `volt-http-bulk-state ${state.kind}`;
		template.status.replaceChildren();
		if (state.kind === 'busy') {
			template.status.appendChild(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
		}
		append(template.status, $('span')).textContent = state.text;
		setAgentTooltip(template.row, state.title ?? '');
	}

	/** Draws the rows again in place and brings the counts, the button and the summary up to date. */
	private refresh(): void {
		const list = this.list;
		if (list) {
			for (let index = 0; index < this.rows.length; index++) {
				list.splice(index, 1, [this.rows[index]]);
			}
		}
		const busy = !!this.running.value;
		const count = this.checked.size;
		this.countEl.textContent = count === 1 ? localize('voltHttp.bulkCountOne', "1 request ticked") : localize('voltHttp.bulkCount', "{0} requests ticked", count);
		this.run.label = busy ? localize('voltHttp.bulkStop', "Stop") : localize('voltHttp.aiRun', "Generate and Run");
		this.run.enabled = busy || count > 0;
		this.wish.disabled = busy;
		this.modelButton.disabled = busy;
	}

	private targets(): IRequestRow[] {
		return this.rows.filter((row): row is IRequestRow => row.kind === 'request' && this.checked.has(row.key));
	}

	private async start(): Promise<void> {
		const picked = this.targets();
		if (!picked.length) {
			return;
		}
		const ref = httpAiModelRef(this.instantiationService);
		this.statusEl.classList.remove('error');
		if (!ref) {
			this.statusEl.classList.add('error');
			this.statusEl.textContent = localize('voltHttp.aiNoModel', "No model is set up. Add one in Settings, Providers & Models.");
			return;
		}
		const cancel = new CancellationTokenSource();
		this.running.value = toDisposable(() => cancel.dispose(true));
		this.results.clear();
		this.stages.clear();
		for (const row of picked) {
			this.stages.set(row.key, 'queued');
		}
		this.statusEl.textContent = localize('voltHttp.bulkProgress', "{0} of {1} done", 0, picked.length);
		this.refresh();
		const keyOf = (target: IHttpTestTarget) => httpDraftKey(target.collection, target.id);
		const results = await generateHttpTestsFor(this.collections, picked.map(row => row.target), {
			...(this.host.root ? { root: this.host.root } : {}),
			wish: this.wish.value,
			skipExisting: this.skipExisting,
			token: cancel.token,
			write: (prompt, token) => this.write(ref, prompt, token),
			onStage: (target, stage) => {
				this.stages.set(keyOf(target), stage);
				this.refresh();
			},
			onResult: (result, done, total) => {
				this.stages.delete(keyOf(result.target));
				this.results.set(keyOf(result.target), result);
				this.statusEl.textContent = localize('voltHttp.bulkProgress', "{0} of {1} done", done, total);
				this.refresh();
			},
		});
		if (this._store.isDisposed) {
			return;
		}
		const stopped = cancel.token.isCancellationRequested;
		this.running.clear();
		this.stages.clear();
		this.reload();
		const added = results.filter(result => result.status === 'added');
		const failed = results.filter(result => result.status === 'failed').length;
		const skipped = results.filter(result => result.status === 'skipped').length;
		const passed = added.reduce((sum, result) => sum + (result.passed ?? 0), 0);
		const total = added.reduce((sum, result) => sum + (result.total ?? 0), 0);
		const parts = [
			added.length ? localize('voltHttp.bulkAdded', "Tests added to {0}: {1} of {2} pass", added.length === 1 ? localize('voltHttp.bulkOneRequest', "1 request") : localize('voltHttp.bulkRequests', "{0} requests", added.length), passed, total) : localize('voltHttp.bulkNone', "No tests were added"),
			...(failed ? [localize('voltHttp.bulkFailed', "{0} failed", failed)] : []),
			...(skipped ? [localize('voltHttp.bulkSkipped', "{0} skipped", skipped)] : []),
			...(stopped ? [localize('voltHttp.aiCancelled', "Stopped.").replace(/\.$/, '').toLowerCase()] : []),
		];
		this.statusEl.classList.toggle('error', failed > 0 || passed < total);
		this.statusEl.textContent = `${parts.join(', ')}.`;
		setAgentTooltip(this.statusEl, this.statusEl.textContent);
		// What got tests is done: a second press does the rest, not the same ones again.
		for (const result of added) {
			this.checked.delete(keyOf(result.target));
		}
		this.refresh();
	}

	/** The rows hold the requests as they were read: after a run, each one's tests are what is on file (or in its open edits) now. */
	private reload(): void {
		for (let index = 0; index < this.rows.length; index++) {
			const row = this.rows[index];
			if (row.kind !== 'request') {
				continue;
			}
			const entry = this.collections.get(row.target.collection);
			const saved = entry && !entry.error ? httpRequestsOf(entry.collection.items).find(item => item.request.id === row.target.id)?.request : undefined;
			const request = this.collections.draftOf(row.key) ?? saved;
			if (request) {
				this.rows[index] = { ...row, request };
			}
		}
	}

	/** One script from the model, given up on after the same time a single request's generator allows. */
	private async write(ref: string, prompt: string, token: CancellationToken): Promise<IHttpWrittenTests> {
		const own = new CancellationTokenSource(token);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			own.cancel();
		}, HTTP_TEST_WRITE_TIMEOUT_MS);
		try {
			const written = await writeHttpTestScript(this.runtime, ref, prompt, own.token);
			return timedOut ? { script: '', failure: localize('voltHttp.aiTimedOut', "The model took too long. Try again, or pick a faster model.") } : written;
		} finally {
			clearTimeout(timer);
			own.dispose();
		}
	}
}
