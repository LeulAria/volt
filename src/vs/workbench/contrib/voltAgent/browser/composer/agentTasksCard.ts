/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ITasksCard, ITasksCardItem } from '../chrome/agentTimeline.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A check for a done to-do, a ring with a dot for the one in progress, an empty ring for the rest. */
function createTaskMark(doc: Document, state: ITasksCardItem['state']): SVGSVGElement {
	const svg = doc.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 14 14');
	svg.setAttribute('width', '14');
	svg.setAttribute('height', '14');
	svg.setAttribute('aria-hidden', 'true');
	if (state === 'done') {
		const check = doc.createElementNS(SVG_NS, 'path');
		check.setAttribute('d', 'M2.75 7.25L5.75 10.25L11.25 3.75');
		check.setAttribute('fill', 'none');
		check.setAttribute('stroke', 'currentColor');
		check.setAttribute('stroke-width', '1.5');
		check.setAttribute('stroke-linecap', 'round');
		check.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(check);
		return svg;
	}
	const ring = doc.createElementNS(SVG_NS, 'circle');
	ring.setAttribute('cx', '7');
	ring.setAttribute('cy', '7');
	ring.setAttribute('r', '6');
	ring.setAttribute('fill', 'none');
	ring.setAttribute('stroke', 'currentColor');
	ring.setAttribute('stroke-width', '1.25');
	svg.appendChild(ring);
	if (state === 'current') {
		const dot = doc.createElementNS(SVG_NS, 'circle');
		dot.setAttribute('cx', '7');
		dot.setAttribute('cy', '7');
		dot.setAttribute('r', '2.25');
		dot.setAttribute('fill', 'currentColor');
		svg.appendChild(dot);
	}
	return svg;
}

/**
 * The agent's to-dos above the composer's chips, a card like Context Usage: one line
 * ("Tasks <current> 1/4 ▬▬▬▬") that opens into the whole list with each to-do's state and time.
 */
export class AgentTasksCard extends Disposable {

	readonly element: HTMLElement;

	private readonly listeners = this._register(new DisposableStore());
	private card: ITasksCard | undefined;
	private signature = '';
	private expanded = false;

	constructor(private readonly onDidChangeVisibility: () => void) {
		super();
		this.element = $('.volt-agent-tasks-card.hidden');
	}

	get visible(): boolean {
		return !!this.card;
	}

	set(card: ITasksCard | undefined): void {
		const signature = card ? JSON.stringify([card.live, card.items]) : '';
		if (signature === this.signature) {
			return;
		}
		const wasVisible = !!this.card;
		this.signature = signature;
		this.card = card;
		this.render();
		if (wasVisible !== !!card) {
			this.onDidChangeVisibility();
		}
	}

	private render(): void {
		this.listeners.clear();
		this.element.replaceChildren();
		const card = this.card;
		this.element.classList.toggle('hidden', !card);
		if (!card) {
			return;
		}
		this.element.classList.toggle('expanded', this.expanded);
		this.element.classList.toggle('live', card.live);
		const head = append(this.element, $('button.volt-agent-tasks-head')) as HTMLButtonElement;
		head.type = 'button';
		head.setAttribute('aria-expanded', String(this.expanded));
		const progress = localize('voltAgent.tasks.progress', "{0} of {1} tasks done", card.done, card.total);
		head.setAttribute('aria-label', card.current
			? localize('voltAgent.tasks.ariaCurrent', "Tasks: {0}, {1}", card.current, progress)
			: localize('voltAgent.tasks.aria', "Tasks: {0}", progress));
		append(head, $('span.volt-agent-tasks-icon')).appendChild(renderIcon(Codicon.checklist));
		append(head, $('span.volt-agent-tasks-title')).textContent = localize('voltAgent.tasks.title', "Tasks");
		const current = append(head, $('span.volt-agent-tasks-current'));
		current.textContent = card.current ?? localize('voltAgent.tasks.allDone', "All tasks done");
		// The to-do being worked on shimmers, as the transcript's live line does.
		const working = card.live && card.items.some(item => item.state === 'current' && item.label === card.current);
		current.classList.toggle('shimmer', working);
		if (card.current) {
			setAgentTooltip(current, card.current);
		}
		append(head, $('span.volt-agent-tasks-count')).textContent = `${card.done}/${card.total}`;
		const bar = append(head, $('span.volt-agent-tasks-bar'));
		bar.setAttribute('aria-hidden', 'true');
		for (const item of card.items) {
			append(bar, $(`span.volt-agent-tasks-seg.${item.state}`));
		}
		append(head, $('span.volt-agent-tasks-chevron')).appendChild(renderIcon(this.expanded ? Codicon.chevronDown : Codicon.chevronUp));
		this.listeners.add(addDisposableListener(head, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.expanded = !this.expanded;
			this.render();
		}));
		if (!this.expanded) {
			return;
		}
		const list = append(this.element, $('ul.volt-agent-tasks-list'));
		for (const item of card.items) {
			const row = append(list, $(`li.volt-agent-tasks-item.${item.state}`));
			append(row, $('span.volt-agent-tasks-mark')).appendChild(createTaskMark(row.ownerDocument, item.state));
			const label = append(row, $('span.volt-agent-tasks-label'));
			label.textContent = item.label;
			label.classList.toggle('shimmer', card.live && item.state === 'current');
			setAgentTooltip(label, item.label);
			if (item.time) {
				append(row, $('span.volt-agent-tasks-time')).textContent = item.time;
			}
		}
	}
}
