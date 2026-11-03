/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentBranchSuggest.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { AnchorAlignment, AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../../platform/list/browser/listService.js';
import { createVoltButton } from '../chrome/voltButton.js';
import { BRANCH_NAME_SUGGESTIONS } from '../../common/agentPullRequests.js';
import { IAgentPullRequestService } from './agentPullRequestService.js';

/** The sparkle Volt draws for AI actions (the branch row's Suggest button). */
export const AI_SPARKLE_PATH = 'M3 12C7.97053 12 12 7.97053 12 3C12 7.97053 16.0295 12 21 12C16.0295 12 12 16.0295 12 21C12 16.0295 7.97053 12 3 12Z';

export function createAiSparkleIcon(owner: HTMLElement, size = 14): SVGElement {
	const svg = owner.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = owner.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', AI_SPARKLE_PATH);
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.5');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(path);
	return svg;
}

/** The card's title icon: a git branch. */
function createGitBranchIcon(owner: HTMLElement, size = 14): SVGElement {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = owner.ownerDocument.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', String(size));
	svg.setAttribute('height', String(size));
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.5');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	const shape = (tag: string, attrs: Record<string, string>) => {
		const el = owner.ownerDocument.createElementNS(ns, tag);
		for (const [key, value] of Object.entries(attrs)) {
			el.setAttribute(key, value);
		}
		svg.appendChild(el);
	};
	shape('line', { x1: '6', y1: '3', x2: '6', y2: '15' });
	shape('circle', { cx: '18', cy: '6', r: '3' });
	shape('circle', { cx: '6', cy: '18', r: '3' });
	shape('path', { d: 'M18 9a9 9 0 0 1-9 9' });
	return svg;
}

const ROW_HEIGHT = 28;

/** A name to pick, or a shimmering placeholder while the model thinks. */
type SuggestRow = { readonly kind: 'skeleton'; readonly index: number } | { readonly kind: 'name'; readonly name: string };

class SuggestDelegate implements IListVirtualDelegate<SuggestRow> {
	getHeight(): number {
		return ROW_HEIGHT;
	}
	getTemplateId(): string {
		return 'branchSuggestion';
	}
}

interface ISuggestTemplate {
	readonly row: HTMLElement;
	readonly name: HTMLElement;
}

class SuggestRenderer implements IListRenderer<SuggestRow, ISuggestTemplate> {
	readonly templateId = 'branchSuggestion';

	renderTemplate(container: HTMLElement): ISuggestTemplate {
		const row = append(container, $('.volt-branch-suggest-row'));
		append(row, $('span.volt-branch-suggest-radio'));
		const name = append(row, $('span.volt-branch-suggest-name'));
		return { row, name };
	}

	renderElement(element: SuggestRow, _index: number, template: ISuggestTemplate): void {
		const skeleton = element.kind === 'skeleton';
		template.row.classList.toggle('skeleton', skeleton);
		template.name.textContent = skeleton ? '' : element.name;
		// Placeholders of different lengths read as a list of names on the way.
		template.name.style.width = skeleton ? `${[62, 48, 70, 54][element.index % 4]}%` : '';
	}

	disposeTemplate(): void { }
}

export interface IBranchSuggestOptions {
	readonly anchor: HTMLElement;
	/** The checkout whose branch is renamed: the chat's worktree. */
	readonly folder: string;
	readonly sessionId?: string;
	readonly onHide?: () => void;
}

/**
 * The Suggest branch names card: placeholders while the model reads the chat, its commits and
 * changes, then {@link BRANCH_NAME_SUGGESTIONS} names with a radio each. Confirm renames the
 * branch to the picked one; chats in that worktree follow it.
 */
export function showBranchNameSuggestions(accessor: ServicesAccessor, options: IBranchSuggestOptions): IDisposable {
	const contextViewService = accessor.get(IContextViewService);
	const instantiationService = accessor.get(IInstantiationService);
	const pullRequests = accessor.get(IAgentPullRequestService);
	let hidden = false;
	const hide = () => {
		if (!hidden) {
			hidden = true;
			contextViewService.hideContextView();
		}
	};

	contextViewService.showContextView({
		getAnchor: () => options.anchor,
		anchorAlignment: AnchorAlignment.RIGHT,
		anchorPosition: AnchorPosition.BELOW,
		canRelayout: true,
		render: container => {
			const store = new DisposableStore();
			const doc = getWindow(options.anchor).document;
			// The context view reports only presses inside itself: a press anywhere else closes the card.
			store.add(addDisposableListener(doc, 'mousedown', e => {
				if (e.target instanceof Node && (contextViewService.getContextViewElement().contains(e.target) || options.anchor.contains(e.target))) {
					return;
				}
				hide();
			}, true));
			options.anchor.classList.add('open');
			store.add(toDisposable(() => options.anchor.classList.remove('open')));

			const card = append(container, $('.volt-branch-suggest'));
			card.setAttribute('role', 'dialog');
			card.setAttribute('aria-label', localize('voltAgent.branchSuggest.aria', "Suggest branch names"));
			store.add(toDisposable(() => card.remove()));
			// Capture: the list takes Escape to clear its selection.
			store.add(addDisposableListener(card, 'keydown', e => {
				if (new StandardKeyboardEvent(e).equals(KeyCode.Escape)) {
					e.preventDefault();
					e.stopPropagation();
					hide();
				}
			}, true));

			const head = append(card, $('.volt-branch-suggest-head'));
			head.appendChild(createGitBranchIcon(head));
			append(head, $('span.volt-branch-suggest-title')).textContent = localize('voltAgent.branchSuggest.title', "Suggested branch names");

			const listHost = append(card, $('.volt-branch-suggest-list'));
			const list: WorkbenchList<SuggestRow> = store.add(instantiationService.createInstance(WorkbenchList<SuggestRow>, 'AgentBranchSuggestions', listHost, new SuggestDelegate(), [new SuggestRenderer()], {
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				// The radio marks the pick (the arrows move it): no selection fill, outline or focus box, only
				// the theme's hover.
				overrideStyles: {
					listSelectionOutline: undefined,
					listActiveSelectionBackground: undefined,
					listActiveSelectionForeground: undefined,
					listActiveSelectionIconForeground: undefined,
					listInactiveSelectionBackground: undefined,
					listInactiveSelectionForeground: undefined,
					listInactiveSelectionIconForeground: undefined,
					listFocusAndSelectionBackground: undefined,
					listFocusAndSelectionForeground: undefined,
					listFocusAndSelectionOutline: undefined,
					listFocusOutline: undefined,
					listInactiveFocusOutline: undefined,
					listInactiveFocusBackground: undefined,
					listFocusBackground: undefined,
					listFocusForeground: undefined,
				},
				identityProvider: { getId: (row: SuggestRow) => row.kind === 'name' ? `name:${row.name}` : `skeleton:${row.index}` },
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('voltAgent.branchSuggest.listAria', "Branch names"),
					getWidgetRole: () => 'radiogroup',
					getAriaLabel: (row: SuggestRow) => row.kind === 'name' ? row.name : localize('voltAgent.branchSuggest.loadingRow', "Loading"),
					getRole: () => 'radio',
					isChecked: (row: SuggestRow): boolean => row.kind === 'name' && list.getSelectedElements()[0] === row,
				},
			}));
			const note = append(card, $('.volt-branch-suggest-note.hidden'));
			const footer = append(card, $('.volt-branch-suggest-footer'));
			const cancel = store.add(createVoltButton(footer, 'secondary'));
			cancel.label = localize('voltAgent.branchSuggest.cancel', "Cancel");
			cancel.element.classList.add('volt-branch-suggest-cancel');
			store.add(cancel.onDidClick(hide));
			const confirm = store.add(createVoltButton(footer, 'primary', { supportIcons: true }));

			let names: string[] = [];
			let busy = false;
			const setRows = (rows: readonly SuggestRow[]) => {
				const height = rows.length * ROW_HEIGHT;
				listHost.style.height = `${height}px`;
				listHost.classList.toggle('hidden', !rows.length);
				list.layout(height);
				list.splice(0, list.length, [...rows]);
				contextViewService.layout();
			};
			const setNote = (text: string | undefined) => {
				note.textContent = text ?? '';
				note.classList.toggle('hidden', !text);
				contextViewService.layout();
			};
			const syncConfirm = () => {
				const picked = list.getSelectedElements()[0];
				if (busy) {
					confirm.label = names.length ? localize('voltAgent.branchSuggest.renaming', "$(loading~spin) Renaming") : localize('voltAgent.branchSuggest.thinking', "$(loading~spin) Suggesting");
					confirm.enabled = false;
				} else if (!names.length) {
					confirm.label = localize('voltAgent.branchSuggest.retry', "Try Again");
					confirm.enabled = true;
				} else {
					confirm.label = localize('voltAgent.branchSuggest.confirm', "Confirm");
					confirm.enabled = picked?.kind === 'name';
				}
			};

			const load = async () => {
				busy = true;
				names = [];
				setNote(undefined);
				setRows(Array.from({ length: BRANCH_NAME_SUGGESTIONS }, (_, index) => ({ kind: 'skeleton' as const, index })));
				syncConfirm();
				let suggested: string[] = [];
				let failure: string | undefined;
				try {
					suggested = await pullRequests.suggestBranchNames(options.folder, options.sessionId);
				} catch (error) {
					failure = error instanceof Error ? error.message : String(error);
				}
				if (hidden) {
					return;
				}
				busy = false;
				names = suggested;
				setRows(names.map(name => ({ kind: 'name' as const, name })));
				setNote(names.length ? undefined : failure ?? localize('voltAgent.branchSuggest.none', "No model suggested a name. Check that a model is set up for git messages, then try again."));
				if (names.length) {
					// The best name starts picked; arrows move the pick, as in any radio group.
					list.setFocus([0]);
					list.setSelection([0]);
					list.domFocus();
				}
				syncConfirm();
			};

			const rename = async () => {
				const picked = list.getSelectedElements()[0];
				if (picked?.kind !== 'name' || busy) {
					return;
				}
				busy = true;
				setNote(undefined);
				syncConfirm();
				try {
					await pullRequests.renameBranch(options.folder, picked.name);
					hide();
				} catch (error) {
					busy = false;
					setNote(error instanceof Error ? error.message : String(error));
					syncConfirm();
				}
			};

			store.add(list.onDidChangeFocus(e => {
				// Arrows move the radio with the focus.
				if (e.browserEvent && e.indexes.length && list.element(e.indexes[0]).kind === 'name') {
					list.setSelection([...e.indexes]);
				}
			}));
			store.add(list.onDidChangeSelection(() => {
				list.rerender();
				syncConfirm();
			}));
			// Enter on a picked name confirms it.
			store.add(addDisposableListener(listHost, 'keydown', e => {
				if (new StandardKeyboardEvent(e).equals(KeyCode.Enter) && !busy && names.length) {
					e.preventDefault();
					void rename();
				}
			}));
			store.add(confirm.onDidClick(() => void (names.length ? rename() : load())));

			void load();
			return store;
		},
		onHide: () => {
			hidden = true;
			options.onHide?.();
		},
	});
	return toDisposable(hide);
}
