/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { IWorkflowEdge, IWorkflowIssue, WorkflowPortKind } from '../../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { setAgentTooltip } from '../../chrome/agentTooltip.js';
import { IEdgeRoute } from './workflowCanvasGeometry.js';

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(doc: Document, tag: K, className?: string): SVGElementTagNameMap[K] {
	const el = doc.createElementNS(SVG_NS, tag);
	if (className) {
		el.setAttribute('class', className);
	}
	return el;
}

export type EdgeFlag = 'hover' | 'selected' | 'traversed' | 'detached' | 'issue-error' | 'issue-warning' | 'related';

/**
 * One connection: a wide invisible stroke to hover and click, the visible line and its arrowhead,
 * all in one group so a class on the group restyles just this edge. Labels and issue dots sit in
 * an HTML layer at the route's midpoint.
 */
export class WorkflowEdgeView {

	readonly group: SVGGElement;
	private readonly hit: SVGPathElement;
	private readonly line: SVGPathElement;
	private readonly arrow: SVGPathElement;
	private readonly flags = new Set<EdgeFlag>();
	private kindValue: WorkflowPortKind = 'neutral';
	private routeValue: IEdgeRoute | undefined;
	private badge: HTMLElement | undefined;
	private label: HTMLElement | undefined;

	constructor(doc: Document, public edge: IWorkflowEdge, private readonly badgeLayer: HTMLElement) {
		this.group = svg(doc, 'g');
		this.group.dataset.edge = edge.id;
		this.hit = this.group.appendChild(svg(doc, 'path', 'hit'));
		this.line = this.group.appendChild(svg(doc, 'path', 'line'));
		this.arrow = this.group.appendChild(svg(doc, 'path', 'arrow'));
		this.applyClasses();
		this.setLabel(edge.label);
	}

	get route(): IEdgeRoute | undefined {
		return this.routeValue;
	}

	get kind(): WorkflowPortKind {
		return this.kindValue;
	}

	has(flag: EdgeFlag): boolean {
		return this.flags.has(flag);
	}

	setKind(kind: WorkflowPortKind): void {
		if (kind !== this.kindValue) {
			this.kindValue = kind;
			this.applyClasses();
		}
	}

	setRoute(route: IEdgeRoute | undefined): void {
		if (route && this.routeValue && route.d === this.routeValue.d) {
			return;
		}
		this.routeValue = route;
		const d = route?.d ?? '';
		this.hit.setAttribute('d', d);
		this.line.setAttribute('d', d);
		this.arrow.setAttribute('d', route?.arrow ?? '');
		this.placeBadges();
	}

	setFlag(flag: EdgeFlag, on: boolean): void {
		if (on === this.flags.has(flag)) {
			return;
		}
		if (on) {
			this.flags.add(flag);
		} else {
			this.flags.delete(flag);
		}
		this.applyClasses();
	}

	/** Plays the dash flow once (a run just went along this edge); the line is solid again after. */
	flow(): void {
		this.line.animate([
			{ strokeDasharray: '7 5', strokeDashoffset: '48' },
			{ strokeDasharray: '7 5', strokeDashoffset: '0' },
		], { duration: 720, easing: 'linear', iterations: 1 });
	}

	setLabel(text: string | undefined): void {
		if (!text) {
			this.label?.remove();
			this.label = undefined;
			return;
		}
		if (!this.label) {
			this.label = append(this.badgeLayer, $('.volt-wf-edge-label'));
		}
		this.label.textContent = text;
		setAgentTooltip(this.label, text);
		this.placeBadges();
	}

	setIssues(issues: readonly IWorkflowIssue[]): void {
		const error = issues.some(issue => issue.severity === 'error');
		this.setFlag('issue-error', error);
		this.setFlag('issue-warning', !error && issues.length > 0);
		if (!issues.length) {
			this.badge?.remove();
			this.badge = undefined;
			return;
		}
		if (!this.badge) {
			this.badge = append(this.badgeLayer, $('span.volt-wf-badge.issue.edge-issue'));
		}
		this.badge.classList.toggle('error', error);
		this.badge.classList.toggle('warning', !error);
		this.badge.replaceChildren(renderIcon(error ? Codicon.error : Codicon.warning));
		setAgentTooltip(this.badge, issues.map(issue => issue.message).join('\n'));
		this.placeBadges();
	}

	private placeBadges(): void {
		const mid = this.routeValue?.mid;
		if (!mid) {
			return;
		}
		if (this.label) {
			this.label.style.transform = `translate(${mid[0]}px, ${mid[1]}px) translate(-50%, -50%)`;
		}
		if (this.badge) {
			this.badge.style.transform = `translate(${mid[0]}px, ${mid[1] - (this.label ? 18 : 0)}px) translate(-50%, -50%)`;
		}
	}

	private applyClasses(): void {
		this.group.setAttribute('class', ['volt-wf-edge', `k-${this.kindValue}`, ...this.flags].join(' '));
	}

	dispose(): void {
		this.group.remove();
		this.label?.remove();
		this.badge?.remove();
	}
}
