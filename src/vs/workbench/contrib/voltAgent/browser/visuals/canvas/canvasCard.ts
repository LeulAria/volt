/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../media/agentCanvas.css';
import { $, addDisposableListener, append } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { IVisualBlock } from '../../blocks/agentBlocks.js';

/** `(canvasId: string, frame?: string)`: opens a design canvas beside the chat. */
export const OPEN_CANVAS_COMMAND_ID = 'volt.canvas.open';

interface ICardContext {
	readonly instantiationService: IInstantiationService;
	readonly store: DisposableStore;
}

export function openCanvas(ctx: { readonly instantiationService: IInstantiationService }, canvasId: string, frame?: string): void {
	ctx.instantiationService.invokeFunction(accessor => accessor.get(ICommandService).executeCommand(OPEN_CANVAS_COMMAND_ID, canvasId, frame));
}

/**
 * A canvas_update in the reply: one line (the canvas, its version, what changed) that opens the
 * canvas. The canvas itself is the page canvas_render showed, kept in step with every update.
 */
export function renderCanvasCard(parent: HTMLElement, block: IVisualBlock, ctx: ICardContext): void {
	const pending = !block.ref;
	const card = append(parent, $('button.volt-agent-block.volt-canvas-card')) as HTMLButtonElement;
	card.type = 'button';
	card.classList.toggle('pending', pending);
	const glyph = append(card, $('span.volt-canvas-card-icon'));
	glyph.appendChild(renderIcon(pending ? Codicon.loading : Codicon.symbolColor));
	const text = append(card, $('span.volt-canvas-card-text'));
	const title = append(text, $('span.volt-canvas-card-title'));
	append(title, $('span.volt-canvas-card-name')).textContent = block.title || localize('voltCanvas.card.untitled', "Design canvas");
	const version = /@(\d+)$/.exec(block.ref)?.[1];
	if (version) {
		append(title, $('span.volt-canvas-card-version')).textContent = localize('voltCanvas.card.version', "v{0}", version);
	}
	append(text, $('span.volt-canvas-card-detail')).textContent = pending
		? localize('voltCanvas.card.updating', "Updating the canvas")
		: block.detail || localize('voltCanvas.card.updated', "Updated");
	if (pending) {
		card.disabled = true;
		card.setAttribute('aria-busy', 'true');
		return;
	}
	const open = append(card, $('span.volt-canvas-card-open'));
	open.appendChild(renderIcon(Codicon.layoutSidebarRight));
	append(open, $('span')).textContent = localize('voltCanvas.card.open', "Open");
	card.setAttribute('aria-label', localize('voltCanvas.card.aria', "Open the design canvas {0}", block.title));
	const canvasId = block.canvas;
	ctx.store.add(addDisposableListener(card, 'click', event => {
		event.preventDefault();
		if (canvasId) {
			openCanvas(ctx, canvasId);
		}
	}));
}

/**
 * canvas_render streaming in: a dotted board where each screen the agent has named so far appears
 * as a frame with its name, so the user watches the flow take shape before it renders.
 */
export function renderCanvasBuilding(parent: HTMLElement, frames: readonly string[]): HTMLElement {
	const root = append(parent, $('.volt-canvas-building'));
	root.setAttribute('role', 'status');
	const board = append(root, $('.volt-canvas-building-board'));
	const names = frames.length ? frames.slice(0, 8) : ['', '', ''];
	names.forEach((name, index) => {
		const frame = append(board, $('.volt-canvas-building-frame'));
		frame.classList.toggle('ghost', !name);
		// Only the newest one animates in: the row is redrawn as names arrive.
		frame.classList.toggle('newest', !!name && index === names.length - 1);
		// Staggered shimmer: the screens read as separate frames.
		append(frame, $('span.volt-canvas-building-screen')).style.animationDelay = `${index * 120}ms`;
		append(frame, $('span.volt-canvas-building-name')).textContent = name;
	});
	if (frames.length > names.length) {
		append(board, $('.volt-canvas-building-more')).textContent = localize('voltCanvas.building.more', "+{0}", frames.length - names.length);
	}
	const caption = append(root, $('.volt-canvas-building-caption'));
	append(caption, $('span.volt-canvas-building-dot'));
	append(caption, $('span')).textContent = frames.length === 1
		? localize('voltCanvas.building.one', "Designing 1 screen")
		: frames.length
			? localize('voltCanvas.building.count', "Designing {0} screens", frames.length)
			: localize('voltCanvas.building.start', "Designing screens");
	root.setAttribute('aria-label', caption.textContent ?? '');
	return root;
}
