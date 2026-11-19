/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/voltHttpWire.css';
import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { IObjectTreeElement, ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList, WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { IHttpResponseRecord } from '../../../services/voltRuntime/common/ide/httpFile.js';
import { createVoltButton } from '../../voltAgent/browser/chrome/voltButton.js';
import { httpCookieAttributes, httpSetCookieLines, IHttpCookie, normalizeHttpCookieDomain, serializeHttpCookie } from '../common/httpCookies.js';
import { httpCookieJarKey, IVoltHttpCookies } from './voltHttpCookies.js';
import { createHttpIconButton } from './voltHttpWidgets.js';
import { setAgentTooltip } from '../../voltAgent/browser/chrome/agentTooltip.js';

const ROW_HEIGHT = 28;
const EDIT_ROW_HEIGHT = 40;
const MAX_LIST_HEIGHT = 12 * ROW_HEIGHT;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const ELLIPSIS = String.fromCharCode(0x2026);

/** The cookies a response set, for its Cookies tab: each `Set-Cookie` line's name, value and attributes. */
export function httpResponseCookies(response: Pick<IHttpResponseRecord, 'headers' | 'setCookies'>): { name: string; value: string; attributes: string }[] {
	return (response.setCookies ?? httpSetCookieLines(response.headers)).map(line => {
		const [pair, ...attributes] = line.split(';');
		const at = pair.indexOf('=');
		return { name: (at < 0 ? pair : pair.slice(0, at)).trim(), value: at < 0 ? '' : pair.slice(at + 1).trim(), attributes: attributes.map(item => item.trim()).filter(Boolean).join('; ') };
	}).filter(cookie => cookie.name);
}

interface IDomainNode { readonly kind: 'domain'; readonly domain: string; readonly count: number }
interface ICookieNode { readonly kind: 'cookie'; readonly domain: string; readonly cookie: IHttpCookie }
interface IAddNode { readonly kind: 'add'; readonly domain: string }
interface IEditNode { readonly kind: 'edit'; readonly domain: string }
type CookieNode = IDomainNode | ICookieNode | IAddNode | IEditNode;

/** The cookie being written in the inline editor row: a new one for `domain`, or `original` changed. */
interface IEditing {
	readonly domain: string;
	readonly original?: IHttpCookie;
	text: string;
}

interface IDomainTemplate { readonly label: HTMLElement; readonly count: HTMLElement; current?: IDomainNode }
interface ICookieTemplate { readonly name: HTMLElement; readonly value: HTMLElement; readonly attributes: HTMLElement; current?: ICookieNode }
interface IAddTemplate { readonly label: HTMLElement }
interface IEditTemplate { readonly input: HTMLInputElement; readonly store: DisposableStore }
interface IAllowTemplate { readonly label: HTMLElement; current?: string }

export interface IHttpCookiesViewOptions {
	/** The project whose jar it is; the window's own when absent. */
	readonly root: URI | undefined;
	readonly close: () => void;
	/** The domain to open on (the request's host). */
	readonly domain?: string;
}

/**
 * The Cookies dialog, as Postman's: the jar's domains with their cookies under them, a field to add
 * a domain, an inline editor for a cookie's text, and the list of domains whose cookies scripts may
 * use. It follows the jar: a cookie a response sets while it is open shows up.
 */
export class HttpCookiesView extends Disposable {

	private readonly jar: string;
	private readonly view = this._register(new DisposableStore());
	private mode: 'cookies' | 'allowlist' = 'cookies';
	/** Domains added here that hold no cookie yet. */
	private readonly added = new Set<string>();
	private readonly expanded = new Set<string>();
	private editing: IEditing | undefined;
	private tree: WorkbenchObjectTree<CookieNode> | undefined;
	private treeHost: HTMLElement | undefined;
	private emptyEl: HTMLElement | undefined;
	private statusEl: HTMLElement | undefined;
	private editInput: HTMLInputElement | undefined;
	private allowList: WorkbenchList<string> | undefined;
	private allowHost: HTMLElement | undefined;
	private allowEmpty: HTMLElement | undefined;
	private readonly allowButton: ReturnType<typeof createVoltButton>;
	private readonly clearButton: ReturnType<typeof createVoltButton>;

	constructor(
		private readonly body: HTMLElement,
		footer: HTMLElement,
		options: IHttpCookiesViewOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IVoltHttpCookies private readonly cookies: IVoltHttpCookies,
	) {
		super();
		this.jar = httpCookieJarKey(options.root);
		body.classList.add('volt-http-cookies');
		const domain = options.domain ? normalizeHttpCookieDomain(options.domain) : '';
		const domains = this.cookies.domains(this.jar);
		if (domain) {
			// The request's host, and the domains above it that hold cookies it gets.
			this.expanded.add(domain);
			for (const item of domains) {
				if (domain.endsWith(`.${item.domain}`)) {
					this.expanded.add(item.domain);
				}
			}
			if (!domains.some(item => item.domain === domain)) {
				this.added.add(domain);
			}
		} else if (domains.reduce((sum, item) => sum + item.count, 0) <= 12) {
			for (const item of domains) {
				this.expanded.add(item.domain);
			}
		}

		this.allowButton = this._register(createVoltButton(footer, 'secondary'));
		this._register(this.allowButton.onDidClick(() => {
			this.mode = this.mode === 'cookies' ? 'allowlist' : 'cookies';
			this.render();
		}));
		append(footer, $('.volt-http-spacer'));
		this.clearButton = this._register(createVoltButton(footer, 'danger'));
		this.clearButton.label = localize('voltHttp.cookieClearAll', "Clear All");
		this._register(this.clearButton.onDidClick(() => void this.clearAll()));

		this._register(this.cookies.onDidChange(jar => {
			if (jar === this.jar) {
				this.refresh();
			}
		}));
		this._register(addDisposableListener(getWindow(body), EventType.RESIZE, () => this.layout()));
		this.render();
	}

	private render(): void {
		this.view.clear();
		clearNode(this.body);
		this.tree = undefined;
		this.allowList = undefined;
		this.editInput = undefined;
		this.allowButton.label = this.mode === 'cookies' ? localize('voltHttp.cookieAllowlist', "Domains Allowlist") : localize('voltHttp.cookieBack', "Back to Cookies");
		this.clearButton.element.classList.toggle('volt-http-cookie-hidden', this.mode !== 'cookies');
		if (this.mode === 'cookies') {
			this.renderCookies();
		} else {
			this.renderAllowlist();
		}
		this.refresh();
	}

	/** A field with a button at its end; Enter in the field presses the button. */
	private renderAddBar(placeholder: string, button: string, add: (domain: string) => void): void {
		const bar = append(this.body, $('.volt-http-cookie-bar'));
		const input = append(bar, $('input.volt-http-set-input.volt-http-cookie-domain')) as HTMLInputElement;
		input.type = 'text';
		input.spellcheck = false;
		input.autocomplete = 'off';
		input.placeholder = placeholder;
		input.setAttribute('aria-label', placeholder);
		const submit = this.view.add(createVoltButton(bar, 'secondary'));
		submit.label = button;
		const run = () => {
			const domain = normalizeHttpCookieDomain(input.value);
			if (!domain || /\s/.test(domain)) {
				input.focus();
				return;
			}
			input.value = '';
			add(domain);
		};
		this.view.add(submit.onDidClick(run));
		this.view.add(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				run();
			}
		}));
		queueMicrotask(() => input.focus());
	}

	// --- Cookies ------------------------------------------------------------------------------

	private renderCookies(): void {
		this.renderAddBar(localize('voltHttp.cookieDomainPlaceholder', "Type a domain name"), localize('voltHttp.cookieAddDomain', "Add domain"), domain => {
			if (!this.cookies.domains(this.jar).some(item => item.domain === domain)) {
				this.added.add(domain);
			}
			this.expanded.add(domain);
			this.startEdit(domain);
		});
		this.statusEl = append(this.body, $('.volt-http-cookie-status'));
		this.statusEl.setAttribute('role', 'status');
		this.treeHost = append(this.body, $('.volt-http-cookie-list'));
		this.emptyEl = append(this.body, $('.volt-http-cookie-empty'));
		this.emptyEl.textContent = localize('voltHttp.cookieEmpty', "No cookies yet. Cookies that responses set are kept here and sent back to their domain.");

		const delegate: IListVirtualDelegate<CookieNode> = {
			getHeight: node => node.kind === 'edit' ? EDIT_ROW_HEIGHT : ROW_HEIGHT,
			getTemplateId: node => node.kind,
		};
		const domainRenderer: ITreeRenderer<CookieNode, void, IDomainTemplate> = {
			templateId: 'domain',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-row.tree.volt-http-cookie-row.domain'));
				const template: IDomainTemplate = { label: append(row, $('span.volt-http-row-label')), count: append(row, $('span.volt-http-row-detail')) };
				createHttpIconButton(row, Codicon.add, localize('voltHttp.cookieAdd', "Add Cookie"), () => template.current && this.startEdit(template.current.domain)).classList.add('quiet');
				createHttpIconButton(row, Codicon.trash, localize('voltHttp.cookieRemoveDomain', "Remove the domain and its cookies"), () => template.current && this.removeDomain(template.current.domain)).classList.add('quiet');
				return template;
			},
			renderElement: (node, _index, template) => {
				const element = node.element as IDomainNode;
				template.current = element;
				template.label.textContent = element.domain;
				template.count.textContent = element.count === 1 ? localize('voltHttp.cookieCountOne', "1 cookie") : localize('voltHttp.cookieCount', "{0} cookies", element.count);
			},
			disposeTemplate: () => { },
		};
		const cookieRenderer: ITreeRenderer<CookieNode, void, ICookieTemplate> = {
			templateId: 'cookie',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-row.tree.volt-http-cookie-row.cookie'));
				const template: ICookieTemplate = { name: append(row, $('span.volt-http-cookie-name')), value: append(row, $('span.volt-http-cookie-value')), attributes: append(row, $('span.volt-http-cookie-attributes')) };
				createHttpIconButton(row, Codicon.edit, localize('voltHttp.cookieEdit', "Edit"), () => template.current && this.startEdit(template.current.domain, template.current.cookie)).classList.add('quiet');
				createHttpIconButton(row, Codicon.trash, localize('voltHttp.cookieDelete', "Delete"), () => template.current && this.cookies.remove(this.jar, template.current.domain, template.current.cookie.name, template.current.cookie.path)).classList.add('quiet');
				return template;
			},
			renderElement: (node, _index, template) => {
				const element = node.element as ICookieNode;
				template.current = element;
				template.name.textContent = element.cookie.name;
				template.value.textContent = element.cookie.value;
				setAgentTooltip(template.value, element.cookie.value.length > 2000 ? `${element.cookie.value.slice(0, 2000)}${ELLIPSIS}` : element.cookie.value);
				template.attributes.textContent = httpCookieAttributes(element.cookie);
			},
			disposeTemplate: () => { },
		};
		const addRenderer: ITreeRenderer<CookieNode, void, IAddTemplate> = {
			templateId: 'add',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-row.tree.volt-http-cookie-row.add'));
				append(row, $('span.volt-http-row-icon')).appendChild(renderIcon(Codicon.add));
				return { label: append(row, $('span.volt-http-row-label')) };
			},
			renderElement: (_node, _index, template) => {
				template.label.textContent = localize('voltHttp.cookieAdd', "Add Cookie");
			},
			disposeTemplate: () => { },
		};
		const editRenderer: ITreeRenderer<CookieNode, void, IEditTemplate> = {
			templateId: 'edit',
			renderTemplate: container => {
				const store = new DisposableStore();
				const row = append(container, $('.volt-http-row.tree.volt-http-cookie-row.edit'));
				const input = append(row, $('input.volt-http-set-input.volt-http-cookie-text')) as HTMLInputElement;
				input.type = 'text';
				input.spellcheck = false;
				input.autocomplete = 'off';
				input.setAttribute('aria-label', localize('voltHttp.cookieText', "The cookie, as name=value and its attributes"));
				store.add(addDisposableListener(input, EventType.INPUT, () => {
					if (this.editing) {
						this.editing.text = input.value;
					}
				}));
				store.add(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						event.stopPropagation();
						this.saveEdit();
					} else if (event.key === 'Escape') {
						// The dialog's own Escape would close it: this one only leaves the editor.
						event.preventDefault();
						event.stopPropagation();
						this.cancelEdit();
					}
				}));
				const save = store.add(createVoltButton(row, 'primary'));
				save.label = localize('voltHttp.cookieSave', "Save");
				store.add(save.onDidClick(() => this.saveEdit()));
				const cancel = store.add(createVoltButton(row, 'ghost'));
				cancel.label = localize('voltHttp.cookieCancel', "Cancel");
				store.add(cancel.onDidClick(() => this.cancelEdit()));
				return { input, store };
			},
			renderElement: (_node, _index, template) => {
				template.input.value = this.editing?.text ?? '';
				this.editInput = template.input;
			},
			disposeTemplate: template => template.store.dispose(),
		};
		const tree = this.tree = this.view.add(this.instantiationService.createInstance(WorkbenchObjectTree<CookieNode>, 'VoltHttpCookies', this.treeHost, delegate, [domainRenderer, cookieRenderer, addRenderer, editRenderer], {
			accessibilityProvider: {
				getAriaLabel: node => {
					switch (node.kind) {
						case 'domain': return localize('voltHttp.cookieDomainAria', "{0}, {1} cookies", node.domain, node.count);
						case 'cookie': return `${node.cookie.name}=${node.cookie.value.slice(0, 80)}; ${httpCookieAttributes(node.cookie)}`;
						case 'add': return localize('voltHttp.cookieAddAria', "Add a cookie to {0}", node.domain);
						case 'edit': return localize('voltHttp.cookieEditAria', "Cookie editor for {0}", node.domain);
					}
				},
				getWidgetAriaLabel: () => localize('voltHttp.cookieListAria', "Cookies by domain"),
			},
			multipleSelectionSupport: false,
			identityProvider: { getId: node => node.kind === 'cookie' ? `cookie:${node.domain}|${node.cookie.name}|${node.cookie.path}` : `${node.kind}:${node.domain}` },
		}));
		this.view.add(tree.onDidOpen(event => {
			const node = event.element;
			if (node?.kind === 'add') {
				this.startEdit(node.domain);
			} else if (node?.kind === 'cookie') {
				this.startEdit(node.domain, node.cookie);
			}
		}));
		this.view.add(tree.onDidChangeCollapseState(event => {
			const node = event.node.element;
			if (node?.kind === 'domain') {
				if (event.node.collapsed) {
					this.expanded.delete(node.domain);
				} else {
					this.expanded.add(node.domain);
				}
				this.layout();
			}
		}));
	}

	/** The jar's domains and the ones added here, each with its cookies, the editor row where one is open, and "Add Cookie". */
	private nodes(): IObjectTreeElement<CookieNode>[] {
		const counts = new Map(this.cookies.domains(this.jar).map(item => [item.domain, item.count]));
		for (const domain of this.added) {
			if (!counts.has(domain)) {
				counts.set(domain, 0);
			}
		}
		const editing = this.editing;
		return [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([domain, count]): IObjectTreeElement<CookieNode> => {
			const editor: IObjectTreeElement<CookieNode> = { element: { kind: 'edit', domain } };
			const here = editing?.domain === domain ? editing : undefined;
			const children: IObjectTreeElement<CookieNode>[] = this.cookies.cookies(this.jar, domain).map(cookie => here?.original && here.original.name === cookie.name && here.original.path === cookie.path ? editor : { element: { kind: 'cookie', domain, cookie } });
			children.push(here && !here.original ? editor : { element: { kind: 'add', domain } });
			return { element: { kind: 'domain', domain, count }, children, collapsible: true, collapsed: !this.expanded.has(domain) };
		});
	}

	private refresh(): void {
		if (this.mode === 'allowlist') {
			this.refreshAllowlist();
			return;
		}
		if (!this.tree || !this.treeHost || !this.emptyEl) {
			return;
		}
		const nodes = this.nodes();
		this.tree.setChildren(null, nodes);
		this.treeHost.classList.toggle('volt-http-cookie-hidden', !nodes.length);
		this.emptyEl.classList.toggle('volt-http-cookie-hidden', nodes.length > 0);
		this.clearButton.enabled = this.cookies.cookies(this.jar).length > 0;
		this.layout();
	}

	private layout(): void {
		if (this.mode === 'allowlist') {
			if (this.allowList && this.allowHost) {
				const height = Math.min(this.allowList.length * ROW_HEIGHT, MAX_LIST_HEIGHT);
				this.allowHost.style.height = `${height}px`;
				this.allowList.layout(height, this.allowHost.clientWidth || undefined);
			}
			return;
		}
		if (!this.tree || !this.treeHost) {
			return;
		}
		let height = 0;
		for (const node of this.nodes()) {
			height += ROW_HEIGHT;
			if (!node.collapsed) {
				for (const child of node.children ?? []) {
					height += child.element.kind === 'edit' ? EDIT_ROW_HEIGHT : ROW_HEIGHT;
				}
			}
		}
		height = Math.min(height, MAX_LIST_HEIGHT);
		this.treeHost.style.height = `${height}px`;
		this.tree.layout(height, this.treeHost.clientWidth || undefined);
	}

	private say(text: string): void {
		if (this.statusEl) {
			this.statusEl.textContent = text;
			this.statusEl.classList.toggle('shown', !!text);
		}
	}

	private startEdit(domain: string, original?: IHttpCookie): void {
		let text: string;
		if (original) {
			text = serializeHttpCookie(original);
		} else {
			// Postman's own starting text: a name not taken yet, the whole site, a year to live.
			const taken = new Set(this.cookies.cookies(this.jar, domain).map(cookie => cookie.name));
			let index = 1;
			while (taken.has(`Cookie_${index}`)) {
				index++;
			}
			text = `Cookie_${index}=value; Path=/; Expires=${new Date(Date.now() + YEAR_MS).toUTCString()};`;
		}
		this.editing = { domain, ...(original ? { original } : {}), text };
		this.expanded.add(domain);
		this.say('');
		this.editInput = undefined;
		this.refresh();
		const editor = this.findNode('edit', domain);
		if (editor && this.tree) {
			this.tree.reveal(editor);
		}
		// The row is drawn by the list: its field exists once that has happened.
		queueMicrotask(() => {
			this.editInput?.focus();
			if (!original) {
				// The placeholder value, ready to be typed over.
				const at = text.indexOf('=') + 1;
				this.editInput?.setSelectionRange(at, at + 'value'.length);
			}
		});
	}

	private findNode(kind: CookieNode['kind'], domain: string): CookieNode | undefined {
		const walk = (node: ITreeNode<CookieNode | null, void>): CookieNode | undefined => {
			if (node.element?.kind === kind && node.element.domain === domain) {
				return node.element;
			}
			for (const child of node.children) {
				const found = walk(child);
				if (found) {
					return found;
				}
			}
			return undefined;
		};
		return this.tree ? walk(this.tree.getNode()) : undefined;
	}

	private saveEdit(): void {
		const editing = this.editing;
		if (!editing) {
			return;
		}
		const before = editing.original;
		this.editing = undefined;
		const saved = this.cookies.set(this.jar, editing.domain, editing.text);
		if (!saved) {
			this.editing = editing;
			this.say(localize('voltHttp.cookieInvalid', "Not a cookie for {0}. Write it as name=value; Path=/; a Domain must be {0} or a domain above it.", editing.domain));
			this.editInput?.focus();
			return;
		}
		if (before && (before.name !== saved.name || before.path !== saved.path || before.domain !== saved.domain)) {
			// Renamed or moved: the one it was is gone.
			this.cookies.remove(this.jar, before.domain, before.name, before.path);
		}
		this.added.delete(saved.domain);
		this.expanded.add(saved.domain);
		this.say(saved.expires !== undefined && saved.expires <= Date.now() ? localize('voltHttp.cookieExpired', "{0} has already expired, so it was removed.", saved.name) : '');
		this.refresh();
		this.tree?.domFocus();
	}

	private cancelEdit(): void {
		this.editing = undefined;
		this.say('');
		this.refresh();
		this.tree?.domFocus();
	}

	private removeDomain(domain: string): void {
		this.added.delete(domain);
		this.expanded.delete(domain);
		if (this.editing?.domain === domain) {
			this.editing = undefined;
		}
		this.cookies.remove(this.jar, domain);
		this.refresh();
	}

	private async clearAll(): Promise<void> {
		const count = this.cookies.cookies(this.jar).length;
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('voltHttp.cookieClearConfirm', "Clear all cookies?"),
			detail: count === 1 ? localize('voltHttp.cookieClearDetailOne', "1 cookie of this project's requests will be removed.") : localize('voltHttp.cookieClearDetail', "{0} cookies of this project's requests will be removed.", count),
			primaryButton: localize('voltHttp.cookieClearAll', "Clear All"),
		});
		if (!confirmed || this._store.isDisposed) {
			return;
		}
		this.added.clear();
		this.editing = undefined;
		this.cookies.clear(this.jar);
		this.refresh();
	}

	// --- Domains allowlist --------------------------------------------------------------------

	private renderAllowlist(): void {
		const intro = append(this.body, $('.volt-http-cookie-intro'));
		const back = append(intro, $('button.volt-http-link')) as HTMLButtonElement;
		back.type = 'button';
		back.textContent = localize('voltHttp.cookieBack', "Back to Cookies");
		this.view.add(addDisposableListener(back, EventType.CLICK, () => {
			this.mode = 'cookies';
			this.render();
		}));
		append(intro, $('.volt-http-note')).textContent = localize('voltHttp.cookieAllowHelp', "Scripts may read and change the cookies of the domains listed here, and of no others.");
		this.renderAddBar(localize('voltHttp.cookieAllowPlaceholder', "Type a domain name to allow"), localize('voltHttp.cookieAllowAdd', "Add"), domain => {
			this.cookies.setAllowlist(this.jar, [...this.cookies.allowlist(this.jar), domain]);
		});
		this.allowHost = append(this.body, $('.volt-http-cookie-list'));
		this.allowEmpty = append(this.body, $('.volt-http-cookie-empty'));
		this.allowEmpty.textContent = localize('voltHttp.cookieAllowEmpty', "No domains yet. Scripts cannot use any cookie.");
		const renderer: IListRenderer<string, IAllowTemplate> = {
			templateId: 'domain',
			renderTemplate: container => {
				const row = append(container, $('.volt-http-row.volt-http-cookie-row.allow'));
				const template: IAllowTemplate = { label: append(row, $('span.volt-http-row-label')) };
				createHttpIconButton(row, Codicon.trash, localize('voltHttp.cookieAllowRemove', "Remove"), () => {
					if (template.current) {
						this.cookies.setAllowlist(this.jar, this.cookies.allowlist(this.jar).filter(domain => domain !== template.current));
					}
				}).classList.add('quiet');
				return template;
			},
			renderElement: (domain, _index, template) => {
				template.current = domain;
				template.label.textContent = domain;
			},
			disposeTemplate: () => { },
		};
		this.allowList = this.view.add(this.instantiationService.createInstance(WorkbenchList<string>, 'VoltHttpCookieAllowlist', this.allowHost, { getHeight: () => ROW_HEIGHT, getTemplateId: () => 'domain' }, [renderer], {
			accessibilityProvider: {
				getAriaLabel: domain => domain,
				getWidgetAriaLabel: () => localize('voltHttp.cookieAllowAria', "Domains whose cookies scripts may use"),
			},
			multipleSelectionSupport: false,
			identityProvider: { getId: domain => domain },
		}));
	}

	private refreshAllowlist(): void {
		if (!this.allowList || !this.allowHost || !this.allowEmpty) {
			return;
		}
		const domains = [...this.cookies.allowlist(this.jar)];
		this.allowList.splice(0, this.allowList.length, domains);
		this.allowHost.classList.toggle('volt-http-cookie-hidden', !domains.length);
		this.allowEmpty.classList.toggle('volt-http-cookie-hidden', domains.length > 0);
		this.layout();
	}
}
