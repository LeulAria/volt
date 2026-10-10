/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentPullRequests.css';
import { $, addDisposableListener, append, EventHelper, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IVoltGitStatus, IVoltGitStatusFile } from '../../../../../platform/voltPullRequests/common/voltPullRequests.js';

export interface IAgentGitCommitDialogOptions {
	readonly status: IVoltGitStatus;
	/** Writes a message for these files (the Write It button). */
	readonly generate: (paths: readonly string[]) => Promise<string | undefined>;
}

export interface IAgentGitCommitChoice {
	/** Empty: the message is written automatically. */
	readonly message?: string;
	/** The files to commit: the ones shown and left in (a renamed file with the path it left). */
	readonly paths: readonly string[];
	readonly newBranch: boolean;
}

/**
 * T3 Code's commit dialog: the branch, the files (Edit to leave some out), an optional message, and
 * Cancel / Commit on New Branch / Commit. A solid card on a dimmed layer (see volt-transparent-window).
 */
export function showAgentGitCommitDialog(accessor: ServicesAccessor, options: IAgentGitCommitDialogOptions): Promise<IAgentGitCommitChoice | undefined> {
	const host = accessor.get(ILayoutService).activeContainer;
	const window = getWindow(host);
	const previousFocus = window.document.activeElement as HTMLElement | null;
	const store = new DisposableStore();
	const { status } = options;
	const excluded = new Set<string>();
	let editing = false;

	return new Promise<IAgentGitCommitChoice | undefined>(resolve => {
		const layer = append(host, $('.volt-git-dialog-layer'));
		store.add(toDisposable(() => layer.remove()));
		const backdrop = append(layer, $('.volt-git-dialog-backdrop'));
		const dialog = append(layer, $('.volt-git-dialog'));
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.tabIndex = -1;

		const head = append(dialog, $('.volt-git-dialog-head'));
		const title = append(head, $('h2'));
		title.textContent = localize('voltGit.dialog.title', "Commit Changes");
		title.id = `volt-git-dialog-${Date.now()}`;
		dialog.setAttribute('aria-labelledby', title.id);
		append(head, $('p')).textContent = localize('voltGit.dialog.description', "Review and confirm your commit. Leave the message empty to have it written for you.");

		const branchRow = append(dialog, $('.volt-git-dialog-row'));
		append(branchRow, $('span.label')).textContent = localize('voltGit.dialog.branch', "Branch");
		const branchValue = append(branchRow, $('span.value.mono'));
		branchValue.textContent = status.branch ?? localize('voltGit.dialog.detached', "(detached)");
		if (status.isDefaultBranch) {
			append(branchRow, $('span.warning')).textContent = localize('voltGit.dialog.defaultBranch', "Default branch");
		}

		const filesHead = append(dialog, $('.volt-git-dialog-row.files-head'));
		const filesLabel = append(filesHead, $('span.label'));
		const totals = append(filesHead, $('span.totals'));
		const edit = append(filesHead, $('button.volt-git-dialog-link')) as HTMLButtonElement;
		edit.type = 'button';
		const list = append(dialog, $('.volt-git-dialog-files'));

		const messageLabel = append(dialog, $('label.volt-git-dialog-message-label')) as HTMLLabelElement;
		append(messageLabel, $('span')).textContent = localize('voltGit.dialog.message', "Commit message (optional)");
		const generate = append(messageLabel, $('button.volt-git-dialog-link')) as HTMLButtonElement;
		generate.type = 'button';
		generate.appendChild(renderIcon(Codicon.sparkle));
		append(generate, $('span')).textContent = localize('voltGit.dialog.generate', "Write It");
		const area = append(dialog, $('textarea.volt-git-dialog-message')) as HTMLTextAreaElement;
		area.placeholder = localize('voltGit.dialog.placeholder', "Leave empty to write it automatically");
		area.rows = 3;
		area.id = `${title.id}-message`;
		messageLabel.htmlFor = area.id;

		const footer = append(dialog, $('.volt-git-dialog-footer'));
		const cancel = button(footer, localize('voltGit.dialog.cancel', "Cancel"), 'secondary');
		append(footer, $('.spacer'));
		const onNewBranch = button(footer, localize('voltGit.dialog.newBranch', "Commit on New Branch"), 'secondary');
		const commit = button(footer, localize('voltGit.dialog.commit', "Commit"), 'primary');

		let settled = false;
		const finish = (choice: IAgentGitCommitChoice | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			store.dispose();
			previousFocus?.focus?.();
			resolve(choice);
		};
		// A renamed file is committed with the path it left, or the old one stays behind.
		const selectedPaths = () => status.files.filter(file => !excluded.has(file.path)).flatMap(file => file.previousPath ? [file.path, file.previousPath] : [file.path]);
		const choose = (newBranch: boolean) => {
			const selected = status.files.filter(file => !excluded.has(file.path));
			if (!selected.length) {
				return;
			}
			const message = area.value.trim();
			finish({
				...(message ? { message } : {}),
				// Only what the dialog showed: files the agent writes while it is open wait for the next commit.
				paths: selectedPaths(),
				newBranch,
			});
		};

		const render = () => {
			list.replaceChildren();
			const selected = status.files.filter(file => !excluded.has(file.path));
			filesLabel.textContent = excluded.size
				? localize('voltGit.dialog.filesSome', "Files ({0} of {1})", selected.length, status.files.length)
				: localize('voltGit.dialog.files', "Files ({0})", status.files.length);
			const additions = selected.reduce((sum, file) => sum + file.additions, 0);
			const deletions = selected.reduce((sum, file) => sum + file.deletions, 0);
			totals.replaceChildren();
			append(totals, $('span.add')).textContent = `+${additions}`;
			append(totals, $('span.del')).textContent = `\u2212${deletions}`;
			edit.textContent = editing ? localize('voltGit.dialog.done', "Done") : localize('voltGit.dialog.edit', "Edit");
			for (const file of status.files) {
				const isExcluded = excluded.has(file.path);
				const row = append(list, $('.volt-git-dialog-file'));
				row.classList.toggle('excluded', isExcluded);
				if (editing) {
					const box = append(row, $('button.volt-git-dialog-check')) as HTMLButtonElement;
					box.type = 'button';
					box.setAttribute('role', 'checkbox');
					box.setAttribute('aria-checked', String(!isExcluded));
					box.setAttribute('aria-label', file.path);
					box.appendChild(renderIcon(isExcluded ? Codicon.circleLarge : Codicon.passFilled));
					store.add(addDisposableListener(box, 'click', e => {
						EventHelper.stop(e, true);
						if (isExcluded) {
							excluded.delete(file.path);
						} else {
							excluded.add(file.path);
						}
						render();
					}));
				}
				const letter = append(row, $(`span.status.status-${file.status}`));
				letter.textContent = statusLetter(file);
				const path = append(row, $('span.path'));
				path.textContent = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
				path.title = path.textContent;
				if (isExcluded) {
					append(row, $('span.excluded-tag')).textContent = localize('voltGit.dialog.excluded', "Excluded");
				} else if (file.additions || file.deletions) {
					const stats = append(row, $('span.stats'));
					append(stats, $('span.add')).textContent = `+${file.additions}`;
					append(stats, $('span.del')).textContent = `\u2212${file.deletions}`;
				}
			}
			const none = selected.length === 0;
			commit.disabled = none;
			onNewBranch.disabled = none;
		};
		render();

		store.add(addDisposableListener(edit, 'click', e => {
			EventHelper.stop(e, true);
			editing = !editing;
			render();
		}));
		store.add(addDisposableListener(generate, 'click', async e => {
			EventHelper.stop(e, true);
			if (generate.disabled) {
				return;
			}
			generate.disabled = true;
			generate.classList.add('busy');
			const icon = generate.querySelector('.codicon');
			icon?.replaceWith(renderIcon(ThemeIcon.modify(Codicon.loading, 'spin')));
			try {
				const message = await options.generate(selectedPaths());
				if (message && !settled) {
					area.value = message;
					area.focus();
				}
			} catch {
				// The field stays as it was; committing still writes a message.
			} finally {
				if (!settled) {
					generate.disabled = false;
					generate.classList.remove('busy');
					generate.querySelector('.codicon')?.replaceWith(renderIcon(Codicon.sparkle));
				}
			}
		}));
		store.add(addDisposableListener(cancel, 'click', () => finish(undefined)));
		store.add(addDisposableListener(backdrop, 'click', () => finish(undefined)));
		store.add(addDisposableListener(onNewBranch, 'click', () => choose(true)));
		store.add(addDisposableListener(commit, 'click', () => choose(false)));
		store.add(addDisposableListener(layer, 'keydown', e => {
			if (e.key === 'Escape') {
				EventHelper.stop(e, true);
				finish(undefined);
			} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				EventHelper.stop(e, true);
				choose(false);
			}
		}));
		window.requestAnimationFrame(() => area.focus());
	});
}

function button(parent: HTMLElement, label: string, kind: 'primary' | 'secondary'): HTMLButtonElement {
	const element = append(parent, $(`button.volt-pr-button.${kind}`)) as HTMLButtonElement;
	element.type = 'button';
	append(element, $('span')).textContent = label;
	return element;
}

function statusLetter(file: IVoltGitStatusFile): string {
	switch (file.status) {
		case 'added': return 'A';
		case 'untracked': return 'U';
		case 'deleted': return 'D';
		case 'renamed': return 'R';
		case 'conflicted': return '!';
		default: return 'M';
	}
}
