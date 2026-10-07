/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentHomePane.css';
import { $, addDisposableListener, append, isHTMLElement } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { CONTEXT_IN_AGENT_INPUT } from '../editor/agentFindWidget.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { GroupsOrder, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { getLayoutMode, LayoutModeContext, onDidChangeLayoutMode } from '../../../../browser/parts/titlebar/layoutModeSwitch.js';
import { AgentEditorInput } from '../editor/agentEditorInput.js';
import { VoltSettingsEditorInput } from '../../../voltSettings/browser/voltSettingsEditorInput.js';
import { findAgentPanelGroup, openAgentPanel } from '../workspace/agentPanels.js';
import { formatAgentTooltipShortcut, setAgentTooltip } from './agentTooltip.js';
import { AgentNavHistory, agentSidebarNavDragClearance } from './agentNavHistory.js';

export const AGENT_NAV_BACK_COMMAND_ID = 'workbench.action.voltAgent.goBack';
export const AGENT_NAV_FORWARD_COMMAND_ID = 'workbench.action.voltAgent.goForward';

/**
 * Agent layout, and not typing in a code editor (where ⌘[ / ⌘] outdent and indent) or a terminal
 * (where Ctrl+[ is Escape). The chat composer is a code editor but has no indentation to change,
 * so there the keys go back and forward like everywhere else in the window.
 */
const agentNavWhen = ContextKeyExpr.and(
	LayoutModeContext.isEqualTo('agent'),
	ContextKeyExpr.or(EditorContextKeys.textInputFocus.negate(), CONTEXT_IN_AGENT_INPUT),
	ContextKeyExpr.not('terminalFocus'),
);

let navigation: AgentNavContribution | undefined;

/** ⌘[ / ⌘] on macOS, Alt+← / Alt+→ elsewhere (as the IDE's own back and forward). */
function navShortcut(key: '[' | ']'): string {
	return formatAgentTooltipShortcut(isMacintosh ? { meta: true, key } : { alt: true, key: key === '[' ? '\u2190' : '\u2192' });
}

function navKey(editor: EditorInput): string {
	if (editor instanceof AgentEditorInput) {
		return `agent:${editor.sessionId}`;
	}
	if (editor instanceof VoltSettingsEditorInput) {
		return 'settings';
	}
	return `editor:${editor.typeId}:${editor.resource?.toString() ?? editor.getName()}`;
}

function arrowIcon(direction: 'back' | 'forward'): SVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', '14');
	svg.setAttribute('height', '14');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const shaft = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	shaft.setAttribute('d', direction === 'back' ? 'M12.5 8H4' : 'M3.5 8H12');
	head.setAttribute('d', direction === 'back' ? 'M7 4.5L3.5 8L7 11.5' : 'M9 4.5L12.5 8L9 11.5');
	for (const path of [shaft, head]) {
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1.5');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
	}
	return svg;
}

class AgentNavContribution extends Disposable {

	static readonly ID = 'workbench.contrib.voltAgentNav';

	private readonly history = new AgentNavHistory();
	private readonly buttons: { back: HTMLButtonElement; forward: HTMLButtonElement }[] = [];

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
		navigation = this;
		this._register({ dispose: () => { if (navigation === this) { navigation = undefined; } } });

		this._register(this.editorService.onDidActiveEditorChange(() => this.capture()));
		this._register(onDidChangeLayoutMode(() => this.capture()));
		this._register(this.layoutService.onDidLayoutMainContainer(() => this.mount()));

		this.mount();
		this.capture();
	}

	back(): Promise<void> {
		return this.history.back().then(() => this.paint());
	}

	forward(): Promise<void> {
		return this.history.forward().then(() => this.paint());
	}

	private mount(): void {
		const aux = this.layoutService.getContainer(mainWindow, Parts.AUXILIARYBAR_PART);
		if (isHTMLElement(aux)) {
			// The header drag strip reads this so it ends before these arrows.
			const clearance = `${agentSidebarNavDragClearance()}px`;
			if (aux.style.getPropertyValue('--volt-agent-nav-drag-clearance') !== clearance) {
				aux.style.setProperty('--volt-agent-nav-drag-clearance', clearance);
			}
			if (!aux.querySelector(':scope > .volt-agent-nav')) {
				this.mountPair(aux, false);
			}
		}
		const titlebar = this.layoutService.getContainer(mainWindow, Parts.TITLEBAR_PART);
		const left = titlebar?.querySelector('.titlebar-left');
		if (isHTMLElement(left) && !left.querySelector(':scope > .volt-agent-nav-titlebar')) {
			const nav = this.mountPair(left, true);
			const header = left.querySelector('.volt-agent-primary-header');
			if (header) {
				header.before(nav);
			}
		}
	}

	private mountPair(parent: HTMLElement, titlebar: boolean): HTMLElement {
		const nav = append(parent, $(titlebar ? '.volt-agent-nav.volt-agent-nav-titlebar' : '.volt-agent-nav'));
		const back = this.button(nav, 'back', localize('voltAgent.goBack', "Go Back"), '[');
		const forward = this.button(nav, 'forward', localize('voltAgent.goForward', "Go Forward"), ']');
		this.buttons.push({ back, forward });
		this._register({ dispose: () => nav.remove() });
		this.paint();
		return nav;
	}

	private button(parent: HTMLElement, direction: 'back' | 'forward', label: string, key: '[' | ']'): HTMLButtonElement {
		const button = append(parent, $('button.volt-agent-nav-button.volt-titlebar-control')) as HTMLButtonElement;
		button.type = 'button';
		button.appendChild(arrowIcon(direction));
		setAgentTooltip(button, label, navShortcut(key), undefined, 'below');
		this._register(addDisposableListener(button, 'click', event => {
			event.preventDefault();
			event.stopPropagation();
			if (button.classList.contains('is-disabled')) {
				return;
			}
			void (direction === 'back' ? this.back() : this.forward());
		}));
		return button;
	}

	private capture(): void {
		if (getLayoutMode(this.layoutService) !== 'agent') {
			this.paint();
			return;
		}
		const editor = this.editorService.activeEditor;
		if (!editor || !this.isNavigation(editor)) {
			this.paint();
			return;
		}
		this.history.push({
			key: navKey(editor),
			open: () => this.reveal(editor),
		});
		this.paint();
	}

	/** Chats and settings always count. Other editors count when they take the agent panel. */
	private isNavigation(editor: EditorInput): boolean {
		if (editor instanceof AgentEditorInput || editor instanceof VoltSettingsEditorInput) {
			return true;
		}
		const pane = this.editorService.activeEditorPane;
		if (!pane) {
			return false;
		}
		return pane.group.id === findAgentPanelGroup(this.editorGroupsService.mainPart).id;
	}

	private async reveal(editor: EditorInput): Promise<void> {
		if (editor.isDisposed()) {
			if (editor instanceof AgentEditorInput) {
				await openAgentPanel(this.editorGroupsService, this.instantiationService, editor.sessionId, { preserveFocus: true });
			} else if (editor instanceof VoltSettingsEditorInput) {
				await this.editorService.openEditor(this.instantiationService.createInstance(VoltSettingsEditorInput), { pinned: true, preserveFocus: true });
			}
			return;
		}
		for (const group of this.editorGroupsService.mainPart.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
			if (group.contains(editor)) {
				await group.openEditor(editor, { pinned: true, preserveFocus: true });
				return;
			}
		}
		await this.editorService.openEditor(editor, { pinned: true, preserveFocus: true });
	}

	private paint(): void {
		for (const pair of this.buttons) {
			this.paintButton(pair.back, !this.history.canBack, localize('voltAgent.goBack', "Go Back"), navShortcut('['));
			this.paintButton(pair.forward, !this.history.canForward, localize('voltAgent.goForward', "Go Forward"), navShortcut(']'));
		}
	}

	private paintButton(button: HTMLButtonElement, disabled: boolean, label: string, shortcut: string): void {
		button.classList.toggle('is-disabled', disabled);
		button.setAttribute('aria-disabled', String(disabled));
		button.setAttribute('aria-label', label);
		setAgentTooltip(button, label, shortcut, undefined, 'below');
	}
}

registerWorkbenchContribution2(AgentNavContribution.ID, AgentNavContribution, WorkbenchPhase.AfterRestored);

registerAction2(class AgentNavBackAction extends Action2 {
	constructor() {
		super({
			id: AGENT_NAV_BACK_COMMAND_ID,
			title: localize2('voltAgent.goBack', "Go Back"),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: agentNavWhen,
				primary: KeyMod.Alt | KeyCode.LeftArrow,
				secondary: [KeyMod.CtrlCmd | KeyCode.BracketLeft],
				mac: { primary: KeyMod.CtrlCmd | KeyCode.BracketLeft },
			},
		});
	}
	override run(): Promise<void> {
		return navigation?.back() ?? Promise.resolve();
	}
});

registerAction2(class AgentNavForwardAction extends Action2 {
	constructor() {
		super({
			id: AGENT_NAV_FORWARD_COMMAND_ID,
			title: localize2('voltAgent.goForward', "Go Forward"),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 50,
				when: agentNavWhen,
				primary: KeyMod.Alt | KeyCode.RightArrow,
				secondary: [KeyMod.CtrlCmd | KeyCode.BracketRight],
				mac: { primary: KeyMod.CtrlCmd | KeyCode.BracketRight },
			},
		});
	}
	override run(): Promise<void> {
		return navigation?.forward() ?? Promise.resolve();
	}
});
