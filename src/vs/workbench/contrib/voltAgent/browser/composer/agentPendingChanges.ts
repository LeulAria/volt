/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentEdits.css';
import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { getIconClasses } from '../../../../../editor/common/services/getIconClasses.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { localize } from '../../../../../nls.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IAgentEditsService, IAgentPendingFile } from '../review/agentEditsService.js';

export interface IAgentPendingChangesOptions {
	onOpenFile(file: IAgentPendingFile): void;
	onReview(): void;
}

/**
 * The files an agent changed that the user has not kept or undone, above the composer:
 * "2 Files · Undo All · Keep All · Review", then one row per file with its line counts.
 */
export class AgentPendingChanges extends Disposable {

	readonly element: HTMLElement;

	private readonly listeners = this._register(new DisposableStore());
	private sessionId: string | undefined;
	private collapsed = false;
	private busy = false;

	constructor(
		private readonly options: IAgentPendingChangesOptions,
		@IAgentEditsService private readonly edits: IAgentEditsService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ILabelService private readonly labelService: ILabelService,
	) {
		super();
		this.element = $('.volt-agent-pending-card.hidden');
		this._register(this.edits.onDidChange(() => this.render()));
	}

	setSessionId(sessionId: string | undefined): void {
		if (this.sessionId === sessionId) {
			return;
		}
		this.sessionId = sessionId;
		this.render();
	}

	private render(): void {
		this.listeners.clear();
		this.element.replaceChildren();
		const files = this.sessionId ? this.edits.getPendingFiles(this.sessionId) : [];
		this.element.classList.toggle('hidden', files.length === 0);
		this.element.classList.toggle('collapsed', this.collapsed);
		if (!files.length) {
			return;
		}

		const head = append(this.element, $('.volt-agent-pending-head'));
		const toggle = append(head, $('button.volt-agent-pending-toggle')) as HTMLButtonElement;
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', String(!this.collapsed));
		append(toggle, renderIcon(this.collapsed ? Codicon.chevronRight : Codicon.chevronDown));
		append(toggle, $('span')).textContent = files.length === 1
			? localize('voltAgent.pending.oneFile', "1 File")
			: localize('voltAgent.pending.files', "{0} Files", files.length);
		this.listeners.add(addDisposableListener(toggle, 'click', e => {
			e.preventDefault();
			this.collapsed = !this.collapsed;
			this.render();
		}));

		const actions = append(head, $('.volt-agent-pending-actions'));
		const button = (label: string, className: string, tooltip: string, run: () => Promise<void> | void) => {
			const el = append(actions, $(`button.volt-agent-pending-action.${className}`)) as HTMLButtonElement;
			el.type = 'button';
			el.textContent = label;
			el.disabled = this.busy;
			setAgentTooltip(el, tooltip);
			this.listeners.add(addDisposableListener(el, 'click', async e => {
				e.preventDefault();
				e.stopPropagation();
				if (this.busy) {
					return;
				}
				this.busy = true;
				try {
					await run();
				} finally {
					this.busy = false;
					this.render();
				}
			}));
		};
		const sessionId = this.sessionId!;
		button(localize('voltAgent.pending.undoAll', "Undo All"), 'undo', localize('voltAgent.pending.undoAllHint', "Restore every file to how it was before the agent changed it"), () => this.edits.undoAll(sessionId));
		button(localize('voltAgent.pending.keepAll', "Keep All"), 'keep', localize('voltAgent.pending.keepAllHint', "Accept every change"), () => this.edits.keepAll(sessionId));
		button(localize('voltAgent.pending.review', "Review"), 'review', localize('voltAgent.pending.reviewHint', "Review the changes side by side"), () => this.options.onReview());

		if (this.collapsed) {
			return;
		}
		const list = append(this.element, $('.volt-agent-pending-list.show-file-icons'));
		for (const file of files) {
			const row = append(list, $('.volt-agent-pending-row')) as HTMLElement;
			row.tabIndex = 0;
			row.setAttribute('role', 'button');
			const icon = append(row, $('span.volt-agent-pending-icon'));
			icon.classList.add(...getIconClasses(this.modelService, this.languageService, file.uri, FileKind.FILE));
			const name = append(row, $('span.volt-agent-pending-name'));
			name.textContent = basename(file.uri);
			setAgentTooltip(row, this.labelService.getUriLabel(file.uri, { relative: true }));
			if (file.kind === 'added' || file.kind === 'deleted') {
				append(row, $('span.volt-agent-pending-kind')).textContent = file.kind === 'added'
					? localize('voltAgent.pending.new', "new")
					: localize('voltAgent.pending.deleted', "deleted");
			}
			const stats = append(row, $('span.volt-agent-pending-stats'));
			append(stats, $('span.add')).textContent = `+${file.additions}`;
			append(stats, $('span.del')).textContent = `-${file.deletions}`;
			const rowActions = append(row, $('.volt-agent-pending-row-actions'));
			const rowButton = (codicon: typeof Codicon.check, tooltip: string, run: (uri: URI) => Promise<void>) => {
				const el = append(rowActions, $('button.volt-agent-pending-row-action')) as HTMLButtonElement;
				el.type = 'button';
				el.appendChild(renderIcon(codicon));
				setAgentTooltip(el, tooltip);
				this.listeners.add(addDisposableListener(el, 'click', e => {
					e.preventDefault();
					e.stopPropagation();
					void run(file.uri);
				}));
			};
			rowButton(Codicon.discard, localize('voltAgent.pending.undoFile', "Undo File"), uri => this.edits.undoFile(uri));
			rowButton(Codicon.check, localize('voltAgent.pending.keepFile', "Keep File"), uri => this.edits.keepFile(uri));
			const open = () => this.options.onOpenFile(file);
			this.listeners.add(addDisposableListener(row, 'click', e => {
				e.preventDefault();
				open();
			}));
			this.listeners.add(addDisposableListener(row, 'keydown', e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					open();
				}
			}));
		}
	}
}
