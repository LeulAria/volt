/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { geometricBounds } from '../../common/scratchBoard/scratchGeometry.js';
import { svgNum, unionBounds } from '../../common/scratchBoard/scratchMath.js';
import { IScratchAgentRun, IScratchBounds, ScratchElement } from '../../common/scratchBoard/scratchTypes.js';
import { setAgentTooltip } from '../chrome/agentTooltip.js';
import { IScratchAgentBridge, IScratchRunStatus, ScratchRunState } from './scratchAgentBridge.js';
import type { ScratchCanvas } from './scratchCanvas.js';
import { scratchIcon, ScratchIconName } from './scratchIcons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD = 12;

interface IRunView {
	readonly outline: SVGRectElement;
	readonly chip: HTMLButtonElement;
	readonly icon: HTMLElement;
	readonly title: HTMLElement;
	readonly meta: HTMLElement;
	readonly store: DisposableStore;
	state: ScratchRunState | undefined;
}

export function runStateLabel(state: ScratchRunState): string {
	switch (state) {
		case 'starting': return localize('voltScratch.run.starting', "Starting");
		case 'running': return localize('voltScratch.run.running', "Working");
		case 'waiting': return localize('voltScratch.run.waiting', "Needs you");
		case 'queued': return localize('voltScratch.run.queued', "Queued");
		case 'done': return localize('voltScratch.run.done', "Done");
		case 'failed': return localize('voltScratch.run.failed', "Failed");
		case 'stopped': return localize('voltScratch.run.stopped', "Stopped");
		default: return localize('voltScratch.run.idle', "Ready");
	}
}

export function runStateIcon(state: ScratchRunState): ScratchIconName {
	switch (state) {
		case 'starting': case 'running': case 'queued': return 'loader-circle';
		case 'waiting': return 'circle-help';
		case 'done': return 'circle-check';
		case 'failed': return 'circle-alert';
		case 'stopped': return 'circle-stop';
		default: return 'agent-spark';
	}
}

/**
 * What was handed to an agent stays marked on the board: a dashed frame around those elements,
 * marching while the agent works, with a chip that says how it is going and opens the chat.
 */
export class ScratchRuns extends Disposable {

	private readonly svg: SVGSVGElement;
	private readonly chips: HTMLElement;
	private readonly views = new Map<string, IRunView>();

	constructor(parent: HTMLElement, private readonly canvas: ScratchCanvas, @IScratchAgentBridge private readonly agents: IScratchAgentBridge) {
		super();
		this.svg = parent.ownerDocument.createElementNS(SVG_NS, 'svg');
		this.svg.classList.add('sx-runs');
		this.svg.setAttribute('aria-hidden', 'true');
		parent.appendChild(this.svg);
		this.chips = append(parent, $('.sx-run-chips'));
		this._register({ dispose: () => { for (const v of this.views.values()) { v.store.dispose(); } this.views.clear(); } });
	}

	/** Screen outlines for the overlay; runs paint their own layer, so none. */
	outlines(): readonly { readonly corners: readonly [number, number][]; readonly state: string }[] {
		return [];
	}

	private runBounds(run: IScratchAgentRun): IScratchBounds {
		const scene = this.canvas.scene;
		const live = run.elementIds.map(id => scene?.get(id)).filter((el): el is ScratchElement => !!el);
		// A frame's name tab sits above its edge: the outline takes it in, so the chip on the outline's top sits above the name, not on it.
		const b = live.length ? unionBounds(live.map(el => {
			const box = geometricBounds(el);
			const title = el.type === 'frame' ? this.canvas.frameTitleHeight(el.id) : 0;
			return title ? { ...box, minY: box.minY - title } : box;
		})) : undefined;
		return b ?? { minX: run.bounds.x, minY: run.bounds.y, maxX: run.bounds.x + run.bounds.width, maxY: run.bounds.y + run.bounds.height };
	}

	layout(): void {
		const scene = this.canvas.scene;
		const runs = scene ? scene.runs.filter(r => !r.hidden) : [];
		const seen = new Set<string>();
		const { width, height } = this.canvas.viewportSize;
		// Chips already placed this pass: a run over the same elements puts its chip beside them, not on top.
		const placed: { x: number; y: number; w: number; h: number }[] = [];
		for (const run of runs) {
			seen.add(run.id);
			const view = this.views.get(run.id) ?? this.createView(run);
			const b = this.runBounds(run);
			const a = this.canvas.toScreen([b.minX, b.minY]);
			const c = this.canvas.toScreen([b.maxX, b.maxY]);
			const x = a[0] - PAD, y = a[1] - PAD, w = c[0] - a[0] + PAD * 2, h = c[1] - a[1] + PAD * 2;
			const offscreen = x > width || y > height || x + w < 0 || y + h < 0;
			view.outline.style.display = offscreen ? 'none' : '';
			view.chip.style.display = offscreen ? 'none' : '';
			if (offscreen) {
				continue;
			}
			view.outline.setAttribute('x', svgNum(x));
			view.outline.setAttribute('y', svgNum(y));
			view.outline.setAttribute('width', svgNum(Math.max(1, w)));
			view.outline.setAttribute('height', svgNum(Math.max(1, h)));
			this.paintStatus(run, view, this.agents.status(run.sessionId));
			// The chip sits on the frame's top edge, kept on screen.
			const chipW = view.chip.offsetWidth || 160, chipH = view.chip.offsetHeight || 26;
			let chipX = Math.max(8, Math.min(width - 80, x + 8));
			// Below the toolbar when the outline's top is off screen.
			// Centred on the edge, a little high, so it clears a frame name inside the outline's padding.
			const chipY = Math.max(64, Math.min(height - 32, y - Math.round(chipH / 2) - 3));
			for (let moved = true; moved;) {
				moved = false;
				for (const other of placed) {
					if (chipX < other.x + other.w && other.x < chipX + chipW && chipY < other.y + other.h && other.y < chipY + chipH) {
						chipX = other.x + other.w + 6;
						moved = true;
					}
				}
			}
			placed.push({ x: chipX, y: chipY, w: chipW, h: chipH });
			view.chip.style.transform = `translate(${Math.round(chipX)}px, ${Math.round(chipY)}px)`;
		}
		for (const [id, view] of this.views) {
			if (!seen.has(id)) {
				view.store.dispose();
				view.outline.remove();
				view.chip.remove();
				this.views.delete(id);
			}
		}
	}

	private createView(run: IScratchAgentRun): IRunView {
		const doc = this.svg.ownerDocument;
		const store = new DisposableStore();
		const outline = doc.createElementNS(SVG_NS, 'rect');
		outline.setAttribute('rx', '14');
		outline.classList.add('sx-run-outline');
		this.svg.appendChild(outline);
		const chip = append(this.chips, $('button.sx-run-chip.sx-chrome-item')) as HTMLButtonElement;
		chip.type = 'button';
		const icon = append(chip, $('span.sx-run-icon'));
		const title = append(chip, $('span.sx-run-title'));
		const meta = append(chip, $('span.sx-run-meta'));
		const close = append(chip, $('span.sx-run-close'));
		close.setAttribute('role', 'button');
		close.setAttribute('aria-label', localize('voltScratch.run.hide', "Hide outline"));
		close.appendChild(scratchIcon(doc, 'x', { size: 12 }));
		setAgentTooltip(close, localize('voltScratch.run.hide', "Hide outline"), undefined, undefined, 'above');
		store.add(addDisposableListener(chip, 'pointerdown', e => e.stopPropagation()));
		store.add(addDisposableListener(chip, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			if ((e.target as HTMLElement).closest('.sx-run-close')) {
				this.canvas.hideRun(run.id);
				return;
			}
			this.canvas.openRunChat(run.sessionId);
		}));
		store.add(addDisposableListener(chip, 'dblclick', e => e.stopPropagation()));
		const view: IRunView = { outline, chip, icon, title, meta, store, state: undefined };
		this.views.set(run.id, view);
		return view;
	}

	private paintStatus(run: IScratchAgentRun, view: IRunView, status: IScratchRunStatus): void {
		if (view.state !== status.state) {
			view.state = status.state;
			view.icon.replaceChildren(scratchIcon(this.svg.ownerDocument, runStateIcon(status.state), { size: 13, strokeWidth: 2 }));
			view.chip.dataset.state = status.state;
			view.outline.dataset.state = status.state;
		}
		// What the user asked, as they asked it; the chat's own title (an agent may rename it) comes second.
		const title = run.prompt.split('\n')[0].trim() || status.title || localize('voltScratch.run.untitled', "Agent");
		if (view.title.textContent !== title) {
			view.title.textContent = title;
		}
		const meta = [runStateLabel(status.state), status.modelLabel ?? run.modelLabel].filter(Boolean).join(' · ');
		if (view.meta.textContent !== meta) {
			view.meta.textContent = meta;
		}
		setAgentTooltip(view.chip, run.prompt ? localize('voltScratch.run.tooltip', "Show the agent: {0}", run.prompt.slice(0, 200)) : localize('voltScratch.run.open', "Show the agent"), undefined, undefined, 'above');
	}
}
