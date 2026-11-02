/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { WorkflowNodeColor } from '../../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { IRect, stepBetween, Vec } from './workflowCanvasGeometry.js';
import { colorClass } from './workflowCanvasNodes.js';
import { svg } from './workflowCanvasEdges.js';

export type EmptyBranch = 'describe' | 'add' | 'templates';

const BRANCH_X = 112;
const BRANCH_GAP = 64;
const BUTTON_HEIGHT = 32;
/** For fitting the view; the buttons size to their labels. */
const BUTTON_WIDTH = 190;

interface IBranch {
	readonly id: EmptyBranch;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly color: WorkflowNodeColor;
}

/**
 * A new workflow's first step, Postman-style: three ghost buttons fan out from the start node's
 * port, joined to it by steps. Hovering one lights the button and draws a highlight along its
 * line from the port (a dash offset on a path with `pathLength=1`, so no lengths are measured).
 */
export class WorkflowEmptyState extends Disposable {

	readonly element: HTMLElement;
	private readonly lines: SVGSVGElement;
	private readonly rendered = this._register(new DisposableStore());
	private port: Vec | undefined;

	constructor(parent: HTMLElement, private readonly onPick: (branch: EmptyBranch, button: HTMLElement) => void) {
		super();
		this.element = append(parent, $('.volt-wf-empty.hidden'));
		this.lines = append(this.element, svg(parent.ownerDocument, 'svg', 'volt-wf-empty-lines'));
	}

	get shown(): boolean {
		return !!this.port;
	}

	/** World area the branches take, for fitting the view. */
	bounds(): IRect | undefined {
		const port = this.port;
		return port ? { x: port[0], y: port[1] - BRANCH_GAP - BUTTON_HEIGHT / 2, width: BRANCH_X + BUTTON_WIDTH, height: BRANCH_GAP * 2 + BUTTON_HEIGHT } : undefined;
	}

	show(port: Vec): void {
		if (this.port && this.port[0] === port[0] && this.port[1] === port[1]) {
			return;
		}
		this.port = port;
		this.element.classList.remove('hidden');
		this.render(port);
	}

	hide(): void {
		if (!this.port) {
			return;
		}
		this.port = undefined;
		this.element.classList.add('hidden');
		this.rendered.clear();
		this.lines.replaceChildren();
		for (const button of this.element.querySelectorAll('.volt-wf-ghost')) {
			button.remove();
		}
	}

	private render(port: Vec): void {
		this.rendered.clear();
		this.lines.replaceChildren();
		for (const button of this.element.querySelectorAll('.volt-wf-ghost')) {
			button.remove();
		}
		const doc = this.element.ownerDocument;
		const branches: readonly IBranch[] = [
			{ id: 'describe', label: localize('voltWorkflows.emptyDescribe', "Describe what it should do"), icon: Codicon.commentDiscussion, color: 'purple' },
			{ id: 'add', label: localize('voltWorkflows.emptyAdd', "Add blocks"), icon: Codicon.add, color: 'blue' },
			{ id: 'templates', label: localize('voltWorkflows.emptyTemplates', "Browse templates"), icon: Codicon.library, color: 'green' },
		];
		branches.forEach((branch, i) => {
			const y = port[1] + (i - 1) * BRANCH_GAP;
			const end: Vec = [port[0] + BRANCH_X, y];
			const d = stepBetween([port[0] + 5, port[1]], end);
			const group = this.lines.appendChild(svg(doc, 'g', `volt-wf-empty-branch ${colorClass(branch.color)}`));
			const base = group.appendChild(svg(doc, 'path', 'base'));
			base.setAttribute('d', d);
			const glow = group.appendChild(svg(doc, 'path', 'glow'));
			glow.setAttribute('d', d);
			glow.setAttribute('pathLength', '1');
			const button = append(this.element, $(`button.volt-wf-ghost.${colorClass(branch.color)}`)) as HTMLButtonElement;
			button.type = 'button';
			button.style.transform = `translate(${end[0]}px, ${y - BUTTON_HEIGHT / 2}px)`;
			const icon = append(button, $('span.volt-wf-ghost-icon'));
			icon.appendChild(renderIcon(branch.icon));
			append(button, $('span.volt-wf-ghost-label')).textContent = branch.label;
			const hot = (on: boolean) => {
				group.classList.toggle('hot', on);
				button.classList.toggle('hot', on);
			};
			this.rendered.add(addDisposableListener(button, 'pointerenter', () => hot(true)));
			this.rendered.add(addDisposableListener(button, 'pointerleave', () => hot(false)));
			this.rendered.add(addDisposableListener(button, 'focus', () => hot(true)));
			this.rendered.add(addDisposableListener(button, 'blur', () => hot(false)));
			this.rendered.add(addDisposableListener(button, 'pointerdown', e => e.stopPropagation()));
			this.rendered.add(addDisposableListener(button, 'click', e => {
				e.stopPropagation();
				this.onPick(branch.id, button);
			}));
		});
	}
}
