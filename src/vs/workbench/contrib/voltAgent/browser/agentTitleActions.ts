/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IActionViewItem } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { IAction } from '../../../../base/common/actions.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IMenuEntryActionViewItemOptions, MenuEntryActionViewItem } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { NEW_AGENT_COMMAND_ID, NEW_AGENT_TAB_COMMAND_ID, OPEN_AGENT_COMMAND_ID, OPEN_AGENT_HISTORY_COMMAND_ID, REPLACE_AGENT_COMMAND_ID } from './agentEditorInput.js';
import { toggleAgentHistoryDropdown } from './agentHistoryDropdown.js';
import { formatAgentTooltipShortcut, IAgentTooltipRow, setAgentTooltip } from './agentTooltip.js';

interface IAgentTitleTooltip {
	readonly label: string;
	/** Command whose shortcut is shown; defaults to the action itself. */
	readonly keybindingFor?: string;
	/** A modifier variant of the same button, shown as a second row. */
	readonly extra?: IAgentTooltipRow;
}

/** Returns true when the click was handled and the action must not run. */
type ClickHandler = (event: MouseEvent, item: AgentTitleActionViewItem) => boolean;

/**
 * A tab-bar action that carries the styled agent tooltip instead of the
 * workbench hover, and can react to modifier clicks.
 */
class AgentTitleActionViewItem extends MenuEntryActionViewItem {

	constructor(
		action: MenuItemAction,
		options: IMenuEntryActionViewItemOptions | undefined,
		private readonly agentTooltip: IAgentTitleTooltip,
		private readonly clickHandler: ClickHandler | undefined,
		@IKeybindingService keybindingService: IKeybindingService,
		@INotificationService notificationService: INotificationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
	) {
		super(action, options, keybindingService, notificationService, contextKeyService, themeService, contextMenuService, accessibilityService);
	}

	/** The tab bar's group context, so a handler can target the right group. */
	get commandContext(): unknown {
		return this._context;
	}

	get anchor(): HTMLElement | undefined {
		return this.element;
	}

	override async onClick(event: MouseEvent): Promise<void> {
		if (this.clickHandler?.(event, this)) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		return super.onClick(event);
	}

	protected override updateTooltip(): void {
		if (!this.element) {
			return;
		}
		const id = this.agentTooltip.keybindingFor ?? this.action.id;
		const shortcut = this._keybindingService.lookupKeybinding(id, this._contextKeyService)?.getLabel() ?? undefined;
		setAgentTooltip(this.element, this.agentTooltip.label, shortcut, this.agentTooltip.extra);
		this.updateAriaLabel();
	}
}

/**
 * Tab-bar rendering for the agent title actions, shared by the agent editor and
 * the Customize tab: the clock opens the history dropdown, `+` opens a new
 * agent (⌥ replaces the current one), and both carry styled tooltips.
 */
export function createAgentTitleActionViewItem(
	instantiationService: IInstantiationService,
	action: IAction,
	options: IMenuEntryActionViewItemOptions | undefined,
	commandService: ICommandService,
	contextViewService: IContextViewService,
	activeSessionId?: string,
): IActionViewItem | undefined {
	if (!(action instanceof MenuItemAction)) {
		return undefined;
	}

	if (action.id === OPEN_AGENT_HISTORY_COMMAND_ID) {
		return instantiationService.createInstance(
			AgentTitleActionViewItem,
			action,
			options,
			{ label: localize('voltAgent.title.history', "Show Chat History") },
			(_event: MouseEvent, item: AgentTitleActionViewItem) => {
				const anchor = item.anchor;
				if (!anchor) {
					return false;
				}
				toggleAgentHistoryDropdown(
					{ contextViewService, instantiationService },
					anchor,
					session => void commandService.executeCommand(OPEN_AGENT_COMMAND_ID, session.id),
					activeSessionId,
				);
				return true;
			},
		);
	}

	if (action.id === NEW_AGENT_TAB_COMMAND_ID) {
		return instantiationService.createInstance(
			AgentTitleActionViewItem,
			action,
			options,
			{
				label: localize('voltAgent.title.newAgent', "New Agent"),
				keybindingFor: NEW_AGENT_COMMAND_ID,
				extra: {
					label: localize('voltAgent.title.replaceAgent', "Replace Agent"),
					shortcut: formatAgentTooltipShortcut({ alt: true, key: '' }).trim(),
				},
			},
			(event: MouseEvent, item: AgentTitleActionViewItem) => {
				if (!event.altKey) {
					return false;
				}
				void commandService.executeCommand(REPLACE_AGENT_COMMAND_ID, item.commandContext);
				return true;
			},
		);
	}

	// Every other tab-bar action keeps its own label, styled like the rest.
	return instantiationService.createInstance(
		AgentTitleActionViewItem,
		action,
		options,
		{ label: action.tooltip || action.label },
		undefined,
	);
}
