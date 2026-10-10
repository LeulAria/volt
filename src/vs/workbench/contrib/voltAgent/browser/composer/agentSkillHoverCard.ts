/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/agentSlashMenu.css';
import { $, addDisposableListener, append, getWindow } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { createModeIcon } from '../chrome/agentModeIcons.js';
import { IAgentCustomizeService, IAgentSlashItem } from '../customize/agentCustomizeService.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
let maskCounter = 0;

function svgElement(document: Document, viewBox = '0 0 16 16'): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', viewBox);
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	return svg;
}

function strokePaths(document: Document, svg: SVGSVGElement, paths: readonly string[], width = '1.1'): void {
	for (const d of paths) {
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', d);
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', width);
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
	}
}

const HEXAGON = 'M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8Z';

/** Volt's mark for built-in entries: a solid cube with a bolt cut out of it. */
export function createVoltGlyph(document: Document): HTMLElement {
	const el = document.createElement('span');
	el.className = 'volt-slash-glyph volt';
	const svg = svgElement(document);
	const id = `volt-slash-bolt-${++maskCounter}`;
	const defs = document.createElementNS(SVG_NS, 'defs');
	const mask = document.createElementNS(SVG_NS, 'mask');
	mask.setAttribute('id', id);
	const all = document.createElementNS(SVG_NS, 'rect');
	all.setAttribute('width', '16');
	all.setAttribute('height', '16');
	all.setAttribute('fill', 'white');
	const bolt = document.createElementNS(SVG_NS, 'path');
	bolt.setAttribute('d', 'M8.95 3.7 5.55 8.65h2.3l-.75 3.65 3.4-4.95h-2.3Z');
	bolt.setAttribute('fill', 'black');
	mask.append(all, bolt);
	defs.appendChild(mask);
	svg.appendChild(defs);
	const body = document.createElementNS(SVG_NS, 'path');
	body.setAttribute('d', HEXAGON);
	body.setAttribute('fill', 'currentColor');
	body.setAttribute('stroke', 'currentColor');
	body.setAttribute('stroke-width', '1.4');
	body.setAttribute('stroke-linejoin', 'round');
	body.setAttribute('mask', `url(#${id})`);
	svg.appendChild(body);
	el.appendChild(svg);
	return el;
}

/** A user's own skill: an outlined cube. */
function createCubeGlyph(document: Document): HTMLElement {
	const el = document.createElement('span');
	el.className = 'volt-slash-glyph cube';
	const svg = svgElement(document);
	strokePaths(document, svg, [HEXAGON, 'M2.6 4.9 8 8l5.4-3.1', 'M8 8v6.3']);
	el.appendChild(svg);
	return el;
}

/** The model command: a cube seen through its corners. */
function createModelGlyph(document: Document): HTMLElement {
	const el = document.createElement('span');
	el.className = 'volt-slash-glyph model';
	const svg = svgElement(document);
	strokePaths(document, svg, [HEXAGON, 'M8 1.6v12.8', 'M2.4 4.8l11.2 6.4', 'M13.6 4.8 2.4 11.2']);
	el.appendChild(svg);
	return el;
}

function codiconGlyph(icon: typeof Codicon.book, className: string): HTMLElement {
	const el = $(`span.volt-slash-glyph.${className}`);
	el.appendChild(renderIcon(icon));
	return el;
}

/** The type's own glyph, ignoring any plugin logo. */
function typeGlyph(item: IAgentSlashItem, document: Document): HTMLElement {
	switch (item.icon) {
		case 'volt': return createVoltGlyph(document);
		case 'model': return createModelGlyph(document);
		case 'subagent': {
			const el = $('span.volt-slash-glyph.subagent');
			el.appendChild(createModeIcon('agent'));
			return el;
		}
		case 'rule': return codiconGlyph(Codicon.book, 'rule');
		case 'command': return codiconGlyph(Codicon.terminal, 'command');
		case 'customize': return codiconGlyph(Codicon.extensions, 'customize');
		case 'new-chat': return codiconGlyph(Codicon.add, 'new-chat');
		case 'usage': return codiconGlyph(Codicon.graph, 'usage');
		case 'skill':
		default:
			return createCubeGlyph(document);
	}
}

/**
 * The 16px icon of a `/` entry. Plugin entries show the plugin's logo once it is read; until then
 * (and when the plugin has none) the type's glyph.
 */
export function createSlashIcon(item: IAgentSlashItem, logo: string | undefined, document: Document): HTMLElement {
	const host = document.createElement('span');
	host.className = 'volt-slash-icon';
	if (logo) {
		const image = document.createElement('img');
		image.className = 'volt-slash-logo';
		image.alt = '';
		image.draggable = false;
		image.src = logo;
		image.addEventListener('error', () => image.replaceWith(typeGlyph(item, document)), { once: true });
		host.appendChild(image);
	} else {
		host.appendChild(typeGlyph(item, document));
	}
	return host;
}

/**
 * The card for one entry: title, the source line when there is one ("Built-in Volt skill",
 * "Created by AWS" with the plugin's logo), then the full description.
 * `side` sits beside the `/` menu; `hover` floats by a token.
 */
export function renderSkillCard(container: HTMLElement, item: IAgentSlashItem, logo: string | undefined, variant: 'side' | 'hover'): void {
	const document = container.ownerDocument;
	container.replaceChildren();
	container.classList.add('volt-skill-card', variant);
	append(container, $('.volt-skill-card-title')).textContent = item.title;
	if (item.sourceLabel) {
		const source = append(container, $('.volt-skill-card-source'));
		// The menu's side card shows where the entry comes from with its icon; the token hover keeps it to the words.
		if (variant === 'side') {
			source.appendChild(item.builtin ? createVoltGlyph(document) : createSlashIcon(item, logo, document));
		}
		append(source, $('span')).textContent = item.sourceLabel;
	}
	if (item.description) {
		append(container, $('.volt-skill-card-description')).textContent = item.description;
	}
}

const SHOW_DELAY_MS = 350;
const HIDE_DELAY_MS = 120;
/** Space between a token and its card. */
const TOKEN_GAP = 12;
const EDGE = 8;

/**
 * The card shown when the pointer rests on a `/skill` token in the composer or in a sent message:
 * beside the token, vertically centred on it, like Cursor's.
 */
export class AgentSkillHoverCard extends Disposable {

	private element: HTMLElement | undefined;
	private showTimer: ReturnType<typeof setTimeout> | undefined;
	private hideTimer: ReturnType<typeof setTimeout> | undefined;
	private shownKey: string | undefined;
	private pendingKey: string | undefined;

	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IAgentCustomizeService private readonly customize: IAgentCustomizeService,
	) {
		super();
		this._register(toDisposable(() => {
			this.clearTimers();
			this.element?.remove();
		}));
	}

	get isVisible(): boolean {
		return !!this.element && !this.element.hidden;
	}

	/**
	 * Shows the card for `item` after a short rest. `anchor` gives the token's box in client
	 * coordinates when the card is placed (the composer may scroll meanwhile).
	 */
	scheduleShow(item: IAgentSlashItem, anchor: () => DOMRect | undefined, key = item.id): void {
		if (this.hideTimer) {
			clearTimeout(this.hideTimer);
			this.hideTimer = undefined;
		}
		if (this.shownKey === key && this.isVisible) {
			return;
		}
		if (this.pendingKey === key && this.showTimer) {
			return;
		}
		if (this.showTimer) {
			clearTimeout(this.showTimer);
		}
		this.pendingKey = key;
		// Moving from one token to another switches at once instead of waiting again.
		const delay = this.isVisible ? 0 : SHOW_DELAY_MS;
		this.showTimer = setTimeout(() => {
			this.showTimer = undefined;
			this.pendingKey = undefined;
			void this.show(item, anchor, key);
		}, delay);
	}

	scheduleHide(): void {
		if (this.showTimer) {
			clearTimeout(this.showTimer);
			this.showTimer = undefined;
			this.pendingKey = undefined;
		}
		if (!this.isVisible || this.hideTimer) {
			return;
		}
		this.hideTimer = setTimeout(() => {
			this.hideTimer = undefined;
			this.hide();
		}, HIDE_DELAY_MS);
	}

	hide(): void {
		this.clearTimers();
		this.shownKey = undefined;
		if (this.element) {
			this.element.hidden = true;
		}
	}

	private clearTimers(): void {
		if (this.showTimer) {
			clearTimeout(this.showTimer);
			this.showTimer = undefined;
		}
		if (this.hideTimer) {
			clearTimeout(this.hideTimer);
			this.hideTimer = undefined;
		}
		this.pendingKey = undefined;
	}

	private async show(item: IAgentSlashItem, anchor: () => DOMRect | undefined, key: string): Promise<void> {
		const logo = item.plugin ? await this.customize.pluginLogo(item.plugin).catch(() => undefined) : undefined;
		const rect = anchor();
		if (!rect || this._store.isDisposed) {
			return;
		}
		const element = this.ensureElement();
		renderSkillCard(element, item, logo, 'hover');
		element.hidden = false;
		this.shownKey = key;
		this.place(element, rect);
	}

	private ensureElement(): HTMLElement {
		if (this.element?.isConnected) {
			return this.element;
		}
		const element = this.element = $('.volt-skill-card.hover');
		element.setAttribute('role', 'tooltip');
		element.hidden = true;
		this.layoutService.activeContainer.appendChild(element);
		// The pointer may cross onto the card on its way to reading it.
		this._register(addDisposableListener(element, 'mouseenter', () => {
			if (this.hideTimer) {
				clearTimeout(this.hideTimer);
				this.hideTimer = undefined;
			}
		}));
		this._register(addDisposableListener(element, 'mouseleave', () => this.scheduleHide()));
		return element;
	}

	private place(element: HTMLElement, rect: DOMRect): void {
		const window = getWindow(element);
		const width = element.offsetWidth;
		const height = element.offsetHeight;
		let left = rect.right + TOKEN_GAP;
		if (left + width > window.innerWidth - EDGE) {
			// No room after the token: put it above the token instead.
			left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - EDGE - width));
			const above = rect.top - TOKEN_GAP - height;
			const top = above >= EDGE ? above : rect.bottom + TOKEN_GAP;
			element.style.left = `${Math.round(left)}px`;
			element.style.top = `${Math.round(Math.min(top, window.innerHeight - EDGE - height))}px`;
			return;
		}
		const centre = rect.top + rect.height / 2;
		const top = Math.max(EDGE, Math.min(centre - height / 2, window.innerHeight - EDGE - height));
		element.style.left = `${Math.round(left)}px`;
		element.style.top = `${Math.round(top)}px`;
	}
}
