/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventHelper } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { Checkbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IVoltFsBrowseService } from '../../../../../platform/voltFsBrowse/common/voltFsBrowse.js';
import { nextFreeName, parseCloneUrl, resolveCloneDestination, sameRemote, sanitizeFolderName } from '../../common/cloneUrl.js';
import { tildify } from '../../common/browsePath.js';
import { ICloneProjectRequest } from '../projectCloneService.js';
import { FolderBrowser, IFolderBrowserOptions } from './folderBrowser.js';

export interface IGitUrlPaneHost {
	readonly home: () => string;
	readonly defaultParent: () => Promise<string>;
	readonly folderOptions: Omit<IFolderBrowserOptions, 'onAccept' | 'initialPath'>;
	readonly clone: (request: ICloneProjectRequest) => Promise<void>;
	/** The destination already holds this repo: add it as-is. */
	readonly addExisting: (path: string, url: string) => void;
	readonly cancel: () => void;
}

type DestinationStatus =
	| { readonly kind: 'unknown' }
	| { readonly kind: 'free' }
	| { readonly kind: 'existing' }
	| { readonly kind: 'taken'; readonly suggestion: string };

/** Clone from a Git URL: URL, destination (parent + folder name), optional branch. */
export class GitUrlPane extends Disposable {

	readonly element: HTMLElement;

	private readonly form: HTMLElement;
	private readonly pickerHost: HTMLElement;
	private readonly urlInput: InputBox;
	private readonly nameInput: InputBox;
	private readonly branchInput: InputBox;
	private readonly recursive: Checkbox;
	private readonly parentButton: HTMLButtonElement;
	private readonly parentLabel: HTMLElement;
	private readonly destination: HTMLElement;
	private readonly error: HTMLElement;
	private readonly primary: Button;
	private readonly inspectScheduler: RunOnceScheduler;
	private readonly pickerStore = this._register(new DisposableStore());
	private parent = '';
	private nameEdited = false;
	private status: DestinationStatus = { kind: 'unknown' };
	private source: 'git' | 'github' = 'git';
	private busy = false;

	constructor(
		container: HTMLElement,
		private readonly host: IGitUrlPaneHost,
		@IVoltFsBrowseService private readonly fsBrowse: IVoltFsBrowseService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.element = append(container, $('.volt-add-pane.git-url'));
		this.form = append(this.element, $('.volt-add-form'));
		this.pickerHost = append(this.element, $('.volt-add-picker.hidden'));

		this.urlInput = this.field(localize('voltProjects.repoUrl', "Repository URL"), localize('voltProjects.repoUrlPlaceholder', "https://github.com/owner/repo.git, git@host:owner/repo, or owner/repo"));
		const destinationRow = append(this.form, $('.volt-add-field'));
		append(destinationRow, $('label.volt-add-label')).textContent = localize('voltProjects.cloneInto', "Clone into");
		const destinationControls = append(destinationRow, $('.volt-add-destination'));
		this.parentButton = append(destinationControls, $('button.volt-add-parent')) as HTMLButtonElement;
		this.parentButton.type = 'button';
		this.parentButton.appendChild(renderIcon(Codicon.folder));
		this.parentLabel = append(this.parentButton, $('span.label'));
		append(this.parentButton, $('span.change')).textContent = localize('voltProjects.change', "Change...");
		append(destinationControls, $('span.volt-add-slash')).textContent = '/';
		const nameHost = append(destinationControls, $('.volt-add-name'));
		this.nameInput = this._register(new InputBox(nameHost, undefined, {
			placeholder: localize('voltProjects.folderName', "folder name"),
			ariaLabel: localize('voltProjects.folderNameAria', "Folder name"),
			tooltip: '',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this.destination = append(this.form, $('.volt-add-destination-status'));

		this.branchInput = this.field(localize('voltProjects.branch', "Branch"), localize('voltProjects.branchPlaceholder', "Default branch"));
		const options = append(this.form, $('.volt-add-options'));
		this.recursive = this._register(new Checkbox(localize('voltProjects.recursive', "Clone submodules too"), false, defaultCheckboxStyles));
		options.appendChild(this.recursive.domNode);
		append(options, $('span.volt-add-option-label')).textContent = localize('voltProjects.recursive', "Clone submodules too");
		this.error = append(this.form, $('.volt-add-error'));

		const footer = append(this.form, $('.volt-add-footer'));
		append(footer, $('span.volt-add-footer-hint')).textContent = localize('voltProjects.cloneHint', "The project opens right away; you can prompt the agent while it clones.");
		const cancel = this._register(new Button(footer, { ...defaultButtonStyles, secondary: true }));
		cancel.label = localize('voltProjects.cancel', "Cancel");
		this._register(cancel.onDidClick(() => this.host.cancel()));
		this.primary = this._register(new Button(footer, defaultButtonStyles));
		this.primary.label = localize('voltProjects.clone', "Clone");
		this._register(this.primary.onDidClick(() => void this.submit()));

		this.inspectScheduler = this._register(new RunOnceScheduler(() => void this.inspect(), 200));
		this._register(this.urlInput.onDidChange(() => this.onUrlChange()));
		this._register(this.nameInput.onDidChange(() => {
			this.nameEdited = true;
			this.onDestinationChange();
		}));
		this._register(addDisposableListener(this.parentButton, 'click', e => {
			EventHelper.stop(e, true);
			this.openPicker();
		}));
		this._register(addDisposableListener(this.form, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyMod.CtrlCmd | KeyCode.Enter)) {
				EventHelper.stop(e, true);
				void this.submit();
			}
		}));
		void this.host.defaultParent().then(parent => {
			if (!this.parent) {
				this.setParent(parent);
			}
		});
		this.update();
	}

	focus(): void {
		this.urlInput.focus();
	}

	/** Fills the form from a GitHub pick. */
	prefill(url: string, name: string, source: 'git' | 'github'): void {
		this.source = source;
		this.urlInput.value = url;
		this.nameEdited = false;
		this.nameInput.value = sanitizeFolderName(name);
		this.nameEdited = false;
		this.onDestinationChange();
		this.nameInput.focus();
	}

	private field(label: string, placeholder: string): InputBox {
		const row = append(this.form, $('.volt-add-field'));
		append(row, $('label.volt-add-label')).textContent = label;
		const input = this._register(new InputBox(append(row, $('.volt-add-control')), undefined, {
			placeholder,
			ariaLabel: label,
			tooltip: '',
			inputBoxStyles: defaultInputBoxStyles,
		}));
		input.inputElement.spellcheck = false;
		return input;
	}

	private onUrlChange(): void {
		this.source = /github\.com[/:]/i.test(this.urlInput.value) ? this.source : 'git';
		const parsed = parseCloneUrl(this.urlInput.value);
		if (typeof parsed !== 'string' && !this.nameEdited) {
			this.nameInput.value = parsed.name;
			this.nameEdited = false;
		}
		this.onDestinationChange();
	}

	private onDestinationChange(): void {
		this.status = { kind: 'unknown' };
		this.update();
		this.inspectScheduler.schedule();
	}

	private setParent(parent: string): void {
		this.parent = parent;
		// Left-to-right marks keep the path in order while it ellipsizes on the left.
		this.parentLabel.textContent = `\u200e${tildify(parent, this.host.home())}\u200e`;
		this.parentButton.title = parent;
		this.onDestinationChange();
	}

	private dest(): string | undefined {
		const name = sanitizeFolderName(this.nameInput.value);
		return this.parent && name ? resolveCloneDestination(this.parent, name) : undefined;
	}

	private async inspect(): Promise<void> {
		const dest = this.dest();
		const parsed = parseCloneUrl(this.urlInput.value);
		if (!dest) {
			return;
		}
		const target = await this.fsBrowse.inspect(dest).catch(() => undefined);
		if (dest !== this.dest() || !target) {
			return;
		}
		if (!target.exists || (target.directory && target.empty)) {
			this.status = { kind: 'free' };
		} else if (target.directory && typeof parsed !== 'string' && sameRemote(target.gitRemote, parsed.url)) {
			this.status = { kind: 'existing' };
		} else {
			const listing = await this.fsBrowse.list(this.parent, { showHidden: true, dirsOnly: false }).catch(() => undefined);
			const taken = new Set(listing?.entries.map(entry => entry.name) ?? []);
			this.status = { kind: 'taken', suggestion: nextFreeName(sanitizeFolderName(this.nameInput.value), taken) };
		}
		this.update();
	}

	private update(): void {
		const parsed = parseCloneUrl(this.urlInput.value);
		const dest = this.dest();
		this.destination.textContent = '';
		this.destination.className = 'volt-add-destination-status';
		if (dest) {
			const path = append(this.destination, $('span.path'));
			path.textContent = `→ ${tildify(dest, this.host.home())}`;
			const status = append(this.destination, $('span.status'));
			switch (this.status.kind) {
				case 'free':
					status.textContent = localize('voltProjects.available', "available");
					this.destination.classList.add('ok');
					break;
				case 'existing':
					status.textContent = localize('voltProjects.alreadyCloned', "already cloned here");
					this.destination.classList.add('ok');
					break;
				case 'taken': {
					status.textContent = localize('voltProjects.taken', "already exists, ");
					const suggestion = this.status.suggestion;
					const use = append(status, $('a.volt-add-link'));
					use.textContent = localize('voltProjects.useName', "use {0}", suggestion);
					use.tabIndex = 0;
					use.addEventListener('click', e => {
						EventHelper.stop(e, true);
						this.nameInput.value = suggestion;
					});
					this.destination.classList.add('warn');
					break;
				}
			}
		}
		const urlError = parsed === 'unsafe' ? localize('voltProjects.unsafeUrl', "This URL is not allowed.") : parsed === 'unsupported' ? localize('voltProjects.badUrl', "Enter an https, ssh or git URL, or owner/repo.") : undefined;
		this.error.textContent = this.urlInput.value.trim() ? urlError ?? '' : '';
		this.primary.label = this.status.kind === 'existing' ? localize('voltProjects.addExisting', "Add existing") : localize('voltProjects.clone', "Clone");
		this.primary.enabled = !this.busy && typeof parsed !== 'string' && !!dest && (this.status.kind === 'free' || this.status.kind === 'existing');
	}

	private async submit(): Promise<void> {
		const parsed = parseCloneUrl(this.urlInput.value);
		const dest = this.dest();
		if (this.busy || typeof parsed === 'string' || !dest) {
			return;
		}
		if (this.status.kind === 'unknown') {
			await this.inspect();
		}
		if (this.status.kind === 'existing') {
			this.host.addExisting(dest, parsed.url);
			return;
		}
		if (this.status.kind !== 'free') {
			return;
		}
		this.busy = true;
		this.update();
		try {
			await this.host.clone({
				url: parsed.url,
				parent: this.parent,
				name: sanitizeFolderName(this.nameInput.value),
				ref: this.branchInput.value.trim() || undefined,
				recursive: this.recursive.checked,
				source: this.source === 'github' || parsed.host === 'github.com' ? 'github' : 'git',
			});
		} catch (err) {
			this.error.textContent = err instanceof Error ? err.message : String(err);
		} finally {
			this.busy = false;
			this.update();
		}
	}

	/** "Change..." swaps the form for the same folder browser, in destination mode. */
	private openPicker(): void {
		this.pickerStore.clear();
		this.form.classList.add('hidden');
		this.pickerHost.classList.remove('hidden');
		const browserHost = append(this.pickerHost, $('.volt-add-picker-browser'));
		const browser = this.pickerStore.add(this.instantiationService.createInstance(FolderBrowser, browserHost, {
			...this.host.folderOptions,
			initialPath: this.parent,
			onAccept: path => choose(path),
		}));
		const footer = append(this.pickerHost, $('.volt-add-footer'));
		const target = append(footer, $('span.volt-add-footer-target'));
		const back = this.pickerStore.add(new Button(footer, { ...defaultButtonStyles, secondary: true }));
		back.label = localize('voltProjects.back', "Back");
		const use = this.pickerStore.add(new Button(footer, defaultButtonStyles));
		use.label = localize('voltProjects.useFolder', "Clone Here");
		const close = () => {
			this.pickerStore.clear();
			this.pickerHost.textContent = '';
			this.pickerHost.classList.add('hidden');
			this.form.classList.remove('hidden');
			this.nameInput.focus();
		};
		const choose = (path: string) => {
			this.setParent(path);
			close();
		};
		this.pickerStore.add(browser.onDidChangeTarget(path => {
			target.textContent = path ? `\u200e${tildify(path, this.host.home())}/${sanitizeFolderName(this.nameInput.value)}\u200e` : '';
			use.enabled = !!path;
		}));
		this.pickerStore.add(back.onDidClick(close));
		this.pickerStore.add(use.onDidClick(() => {
			const path = browser.target ?? browser.currentFolder;
			if (path) {
				choose(path);
			}
		}));
		this.pickerStore.add(addDisposableListener(this.pickerHost, 'keydown', e => {
			if (new StandardKeyboardEvent(e).equals(KeyCode.Escape) && !e.defaultPrevented) {
				EventHelper.stop(e, true);
				close();
			}
		}));
		browser.focus();
	}
}
