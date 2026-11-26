/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IVoltMenuItem, showVoltMenu } from '../ui/menu/voltMenu.js';

/** Where the right panel sits against the chat. */
export type AgentToolsDock = 'right' | 'left' | 'top' | 'bottom';

export const AGENT_TOOLS_DOCKS: readonly AgentToolsDock[] = ['left', 'right', 'top', 'bottom'];

export function isAgentToolsDock(value: unknown): value is AgentToolsDock {
	return typeof value === 'string' && (AGENT_TOOLS_DOCKS as readonly string[]).includes(value);
}

/** Fill: the tools across the whole window. Arrange: the tools beside the chat, on their dock side. */
export type AgentToolsArrange = 'fill' | 'arrange';

export interface IAgentToolsLayoutMenuOptions {
	readonly anchor: HTMLElement;
	readonly dock: AgentToolsDock;
	readonly arrange: AgentToolsArrange;
	/** A tab is in front that can move into a window of its own. */
	readonly canOpenInWindow: boolean;
	readonly onDock: (dock: AgentToolsDock) => void;
	readonly onArrange: (arrange: AgentToolsArrange) => void;
	readonly onOpenInWindow: () => void;
	/** The shortcut label shown at a row's end. */
	readonly keybindingFor?: (commandId: string) => string | undefined;
	readonly onHide?: () => void;
}

/** One of the menu's choices; each also has a command with a shortcut. */
export type AgentToolsLayoutPick = { readonly kind: 'dock'; readonly dock: AgentToolsDock } | { readonly kind: 'arrange'; readonly arrange: AgentToolsArrange } | { readonly kind: 'window' };

/** The command that makes `pick` from the keyboard. */
export function agentToolsLayoutCommandId(pick: AgentToolsLayoutPick): string {
	switch (pick.kind) {
		case 'dock': return `workbench.action.voltAgentTools.move.${pick.dock}`;
		case 'arrange': return `workbench.action.voltAgentTools.${pick.arrange}`;
		case 'window': return 'workbench.action.voltAgentTools.openInNewWindow';
	}
}

type LayoutPick = AgentToolsLayoutPick;

const SVG_NS = 'http://www.w3.org/2000/svg';

interface IRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** A window outline with the filled parts it shows: where the panel lands, or how it fills. */
function layoutGlyph(doc: Document, parts: readonly IRect[]): () => SVGSVGElement {
	return () => {
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('width', '16');
		svg.setAttribute('height', '16');
		svg.setAttribute('aria-hidden', 'true');
		const frame = doc.createElementNS(SVG_NS, 'rect');
		for (const [name, value] of Object.entries({ x: 2.75, y: 4.75, width: 18.5, height: 14.5, rx: 3.25 })) {
			frame.setAttribute(name, String(value));
		}
		frame.setAttribute('fill', 'none');
		frame.setAttribute('stroke', 'currentColor');
		frame.setAttribute('stroke-width', '1.5');
		svg.appendChild(frame);
		for (const part of parts) {
			const rect = doc.createElementNS(SVG_NS, 'rect');
			for (const [name, value] of Object.entries(part)) {
				rect.setAttribute(name, String(value));
			}
			rect.setAttribute('rx', '1.25');
			rect.setAttribute('fill', 'currentColor');
			svg.appendChild(rect);
		}
		return svg;
	};
}

const DOCK_GLYPHS: Record<AgentToolsDock, readonly IRect[]> = {
	left: [{ x: 5, y: 7, width: 5.5, height: 10 }],
	right: [{ x: 13.5, y: 7, width: 5.5, height: 10 }],
	top: [{ x: 5, y: 7, width: 14, height: 4.25 }],
	bottom: [{ x: 5, y: 12.75, width: 14, height: 4.25 }],
};

const ARRANGE_GLYPHS: Record<AgentToolsArrange, readonly IRect[]> = {
	fill: [{ x: 5, y: 7, width: 14, height: 10 }],
	arrange: [{ x: 5, y: 7, width: 6.5, height: 10 }, { x: 12.5, y: 7, width: 6.5, height: 10 }],
};

function dockLabel(dock: AgentToolsDock): string {
	switch (dock) {
		case 'left': return localize('voltAgent.toolsLayout.moveLeft', "Move to left");
		case 'right': return localize('voltAgent.toolsLayout.moveRight', "Move to right");
		case 'top': return localize('voltAgent.toolsLayout.moveTop', "Move to top");
		case 'bottom': return localize('voltAgent.toolsLayout.moveBottom', "Move to bottom");
	}
}

function arrangeLabel(arrange: AgentToolsArrange): string {
	return arrange === 'fill'
		? localize('voltAgent.toolsLayout.fill', "Fill window")
		: localize('voltAgent.toolsLayout.arrange', "Arrange beside chat");
}

/**
 * The right panel's layout menu (its expand button), a Volt menu like the others: Fill and arrange
 * takes the whole window or shares it with the chat, Move puts the panel on a side of the chat,
 * and Open in new window moves the tab in front into a window of its own. A second click on the
 * button closes it.
 */
export function showAgentToolsLayoutMenu(contextViewService: IContextViewService, options: IAgentToolsLayoutMenuOptions): IDisposable {
	const doc = options.anchor.ownerDocument;
	const keybinding = (pick: LayoutPick) => options.keybindingFor?.(agentToolsLayoutCommandId(pick));
	const docks: IVoltMenuItem<LayoutPick>[] = AGENT_TOOLS_DOCKS.map(dock => ({
		id: `dock-${dock}`,
		label: dockLabel(dock),
		icon: layoutGlyph(doc, DOCK_GLYPHS[dock]),
		checked: options.arrange === 'arrange' && options.dock === dock,
		keybinding: keybinding({ kind: 'dock', dock }),
		data: { kind: 'dock', dock },
	}));
	const arranges: IVoltMenuItem<LayoutPick>[] = (['fill', 'arrange'] as const).map(arrange => ({
		id: `arrange-${arrange}`,
		label: arrangeLabel(arrange),
		icon: layoutGlyph(doc, ARRANGE_GLYPHS[arrange]),
		checked: options.arrange === arrange,
		keybinding: keybinding({ kind: 'arrange', arrange }),
		data: { kind: 'arrange', arrange },
	}));
	options.anchor.setAttribute('aria-expanded', 'true');
	return showVoltMenu<LayoutPick>(contextViewService, {
		anchor: options.anchor,
		align: 'right',
		gap: 4,
		width: 260,
		ariaLabel: localize('voltAgent.toolsLayout.aria', "Panel Layout"),
		sections: [
			{ id: 'arrange', title: localize('voltAgent.toolsLayout.fillAndArrange', "Fill and arrange"), items: arranges },
			{ id: 'move', title: localize('voltAgent.toolsLayout.move', "Move"), items: docks },
			{
				id: 'window',
				items: [{
					id: 'window',
					label: localize('voltAgent.toolsLayout.newWindow', "Open in new window"),
					icon: Codicon.multipleWindows,
					disabled: !options.canOpenInWindow,
					keybinding: keybinding({ kind: 'window' }),
					data: { kind: 'window' },
				}],
			},
		],
		onPick: item => {
			const pick = item.data;
			switch (pick.kind) {
				case 'dock': options.onDock(pick.dock); break;
				case 'arrange': options.onArrange(pick.arrange); break;
				case 'window': options.onOpenInWindow(); break;
			}
		},
		onHide: () => {
			options.anchor.setAttribute('aria-expanded', 'false');
			options.onHide?.();
		},
	});
}
