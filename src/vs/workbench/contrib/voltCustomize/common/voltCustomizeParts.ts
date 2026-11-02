/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltSlotId } from './voltSlots.js';

/**
 * The agent window as parts: what the Playground devtools list as layers, highlight on hover and
 * hand to the agent as context. Each part names the element it is (a selector), the tokens and
 * theme colors that style it, the layout fields that place it, and the slot it holds.
 */
export interface IVoltCustomizePart {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	/** The element(s) it is in the window. */
	readonly selector: string;
	readonly tokens?: readonly string[];
	readonly colors?: readonly string[];
	/** Layout fields that place it, as `field.subfield`. */
	readonly layout?: readonly string[];
	/** The slot it holds; its items are listed under it. */
	readonly slot?: Exclude<VoltSlotId, 'hidden'>;
	/** Where its CSS lives, for an agent that needs to go deeper. */
	readonly files?: readonly string[];
	readonly children?: readonly IVoltCustomizePart[];
}

const AGENT_CSS = 'src/vs/workbench/contrib/voltAgent/browser/media';

export const VOLT_CUSTOMIZE_PARTS: readonly IVoltCustomizePart[] = [
	{
		id: 'titlebar', label: 'Title bar', description: 'The bar across the top: sidebar toggle, back and forward, the chat title and the panel toggles.',
		selector: '.part.titlebar', tokens: ['toolbar.buttonSize'], colors: ['titleBar.activeBackground', 'titleBar.activeForeground'],
		files: [`${AGENT_CSS}/agentViewSidebars.css`],
	},
	{
		id: 'sidebar', label: 'Agent sidebar', description: 'The chat list on the left, with its header and footer icons.',
		selector: '.part.auxiliarybar', tokens: ['sidebar.fontSize', 'sidebar.rowGap', 'sidebar.compact'], colors: ['voltAgent.sidebarBackground', 'sideBar.foreground', 'list.hoverBackground', 'list.activeSelectionBackground'],
		layout: ['sidebar.visible', 'sidebar.width', 'sidebar.rail'], files: [`${AGENT_CSS}/agentHomePane.css`],
		children: [
			{
				id: 'activityBar', label: 'Activity bar', description: 'VS Code\'s icon column at the left edge of the sidebar. Off until a layout puts items in its slots (volt/vscode does).',
				selector: '.volt-agent-activity-bar', slot: 'activityBar.top', tokens: ['activityBar.width'], colors: ['voltAgent.activityBarBackground', 'activityBar.foreground', 'activityBar.inactiveForeground', 'activityBar.activeBorder', 'activityBar.border'],
				files: [`${AGENT_CSS}/agentHomePane.css`],
				children: [
					{ id: 'activityBar.bottom', label: 'Activity bar (bottom)', description: 'The icons at the bottom of the activity bar.', selector: '.volt-agent-activity-bar-bottom', slot: 'activityBar.bottom' },
				],
			},
			{ id: 'sidebar.header', label: 'Sidebar header', description: 'Search and the icon row beside it.', selector: '.volt-agent-home-nav-bar', slot: 'sidebar.header', tokens: ['toolbar.buttonSize'] },
			{ id: 'sidebar.list', label: 'Chat list', description: 'Projects and their chats.', selector: '.volt-agent-home-tree', tokens: ['sidebar.fontSize', 'sidebar.rowGap', 'sidebar.compact'], colors: ['list.hoverBackground', 'list.activeSelectionBackground'] },
			{ id: 'sidebar.footer', label: 'Sidebar footer', description: 'The icon row at the bottom-left.', selector: '.volt-agent-home-footer', slot: 'sidebar.footer' },
		],
	},
	{
		id: 'chat', label: 'Chat', description: 'The conversation in the middle.',
		selector: '.volt-agent-thread-inner', tokens: ['chat.width', 'chat.gutter', 'chat.turnGap', 'chat.messageGap'], colors: ['voltAgent.background', 'editor.background', 'foreground'],
		files: [`${AGENT_CSS}/agentEditor.css`, `${AGENT_CSS}/agentMarkdown.css`],
		children: [
			{ id: 'chat.userMessage', label: 'Your messages', description: 'The messages you sent.', selector: '.volt-agent-turn.user .volt-agent-bubble', tokens: ['chat.userBubbleRadius', 'chat.userBubblePaddingY', 'chat.userBubblePaddingX', 'chat.fontSize'] },
			{ id: 'chat.answer', label: 'Answers', description: 'The agent\'s replies.', selector: '.volt-agent-turn:not(.user) .volt-agent-markdown', tokens: ['chat.fontSize', 'chat.lineHeight', 'font.ui'] },
			{ id: 'chat.cards', label: 'Cards', description: 'Tool cards, terminal blocks, changed files, the running and queued cards.', selector: '.volt-agent-card, .volt-agent-block.terminal', tokens: ['chat.cardRadius'] },
			{ id: 'chat.codeBlocks', label: 'Code blocks', description: 'Code in answers.', selector: '.volt-md-code-block', tokens: ['chat.codeBlockRadius'], colors: ['textCodeBlock.background'] },
			{ id: 'chat.tables', label: 'Tables', description: 'Tables in answers.', selector: '.volt-agent-table-wrap', tokens: ['chat.tableRadius'] },
			{ id: 'chat.inlineCode', label: 'Inline code', description: '`code` inside a sentence.', selector: '.volt-agent-markdown code', tokens: ['chat.inlineCodeRadius', 'chat.inlineCodeFontSize'], colors: ['textPreformat.foreground'] },
		],
	},
	{
		id: 'composer', label: 'Message box', description: 'Where you type, with its chips and send button.',
		selector: '.volt-agent-input-box', tokens: ['composer.radius', 'composer.pillRadius', 'composer.minHeight', 'composer.borderWidth', 'composer.inputPaddingY', 'composer.inputPaddingX'], colors: ['input.background', 'input.border', 'focusBorder'],
		files: [`${AGENT_CSS}/agentEditor.css`],
		children: [
			{ id: 'composer.chips', label: 'Chips', description: 'Plan, Multitask and the other chips by the box.', selector: '.volt-agent-composer-chip', tokens: ['composer.chipHeight', 'composer.chipRadius'] },
			{ id: 'composer.send', label: 'Send button', description: 'The round send button.', selector: '.volt-agent-send', tokens: ['composer.sendSize'], colors: ['button.background', 'button.foreground'] },
		],
	},
	{
		id: 'rightPanel', label: 'Right panel', description: 'Tabs beside the chat: terminal, browser, changes, files and extension tabs.',
		selector: '.volt-agent-tools-area', layout: ['rightPanel.open', 'rightPanel.commands'], colors: ['voltAgent.background', 'tab.activeBackground', 'tab.inactiveBackground'],
	},
	{
		id: 'filesSidebar', label: 'Files sidebar', description: 'Explorer, Source Control, Search and Pull Requests at the right edge.',
		selector: '.volt-agent-files-sidebar', layout: ['filesSidebar.open', 'filesSidebar.view'], colors: ['sideBar.background'],
	},
];

/** Every part, depth first. */
export function allVoltCustomizeParts(parts: readonly IVoltCustomizePart[] = VOLT_CUSTOMIZE_PARTS): IVoltCustomizePart[] {
	return parts.flatMap(part => [part, ...allVoltCustomizeParts(part.children ?? [])]);
}
