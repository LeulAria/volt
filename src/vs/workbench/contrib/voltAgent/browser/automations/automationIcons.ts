/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveDocument } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { AutomationRunStatus, AutomationRunToolKind, AutomationToolKind, AutomationToolStatus, RunStatusBucket } from '../../../../services/voltRuntime/common/automations/automations.js';
import { AutomationTemplateIcon } from '../../../../services/voltRuntime/common/automations/automationTemplates.js';
import { AutomationProvider, AutomationTriggerGroup } from '../../../../services/voltRuntime/common/automations/automationTriggers.js';

/**
 * The marks of the services automations talk to, drawn as 16px SVG in the text color (Slack in
 * its own four colors, as it appears in the trigger chips), and the run status glyphs. Built from
 * a few path strings, no image files.
 */

const NS = 'http://www.w3.org/2000/svg';

type Shape = { readonly d: string; readonly fill?: string; readonly stroke?: boolean; readonly width?: number; readonly dash?: string };

function svg(shapes: readonly Shape[], viewBox = '0 0 16 16', className = ''): SVGSVGElement {
	const doc = getActiveDocument();
	const root = doc.createElementNS(NS, 'svg');
	root.setAttribute('viewBox', viewBox);
	root.setAttribute('width', '16');
	root.setAttribute('height', '16');
	root.setAttribute('aria-hidden', 'true');
	root.setAttribute('class', `volt-automation-svg ${className}`.trim());
	for (const shape of shapes) {
		const path = doc.createElementNS(NS, 'path');
		path.setAttribute('d', shape.d);
		if (shape.stroke) {
			path.setAttribute('fill', 'none');
			path.setAttribute('stroke', shape.fill ?? 'currentColor');
			path.setAttribute('stroke-width', String(shape.width ?? 1.2));
			path.setAttribute('stroke-linecap', 'round');
			path.setAttribute('stroke-linejoin', 'round');
			if (shape.dash) {
				path.setAttribute('stroke-dasharray', shape.dash);
			}
		} else {
			path.setAttribute('fill', shape.fill ?? 'currentColor');
		}
		root.appendChild(path);
	}
	return root;
}

function rect(x: number, y: number, w: number, h: number): string {
	const r = Math.min(w, h) / 2;
	return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`;
}

function circle(cx: number, cy: number, r: number): string {
	return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 -${2 * r} 0`;
}

const GITHUB = 'M8 .2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2z';

/** The service's mark, 16px. */
export function providerIcon(provider: AutomationProvider | AutomationTriggerGroup | 'manual'): HTMLElement | SVGElement {
	switch (provider) {
		case 'github':
			return svg([{ d: GITHUB }]);
		case 'git':
			return svg([{ d: `M4.5 1.8v8.6${circle(4.5, 12.2, 1.8)}${circle(11.5, 5, 1.8)}M11.5 6.8c0 2.6-2.2 3.4-6.4 3.6`, stroke: true }]);
		case 'slack':
			return svg([
				{ d: rect(1, 6.8, 10.2, 4.2), fill: '#36C5F0' },
				{ d: rect(6.8, 1, 4.2, 4.2), fill: '#36C5F0' },
				{ d: rect(12.8, 1, 4.2, 10.2), fill: '#2EB67D' },
				{ d: rect(18.8, 6.8, 4.2, 4.2), fill: '#2EB67D' },
				{ d: rect(12.8, 12.8, 10.2, 4.2), fill: '#ECB22E' },
				{ d: rect(12.8, 18.8, 4.2, 4.2), fill: '#ECB22E' },
				{ d: rect(6.8, 12.8, 4.2, 10.2), fill: '#E01E5A' },
				{ d: rect(1, 12.8, 4.2, 4.2), fill: '#E01E5A' },
			], '0 0 24 24');
		case 'teams':
			return svg([
				{ d: 'M1.5 4.2h8.2v8.4H1.5z', stroke: true, width: 1.1 },
				{ d: 'M3.5 6.5h4.2M5.6 6.5v4.3', stroke: true, width: 1.3 },
				{ d: `${circle(13, 4.4, 1.3)}M11.2 7.2h3.6v3.3a1.8 1.8 0 0 1-3.6 0${circle(9.6, 2.6, 1.2)}`, stroke: true, width: 1.1 },
			]);
		case 'sentry':
			return svg([{ d: 'M1.6 13.6h2.2a6.4 6.4 0 0 0-3-5.2M5.4 13.6h1.4A9.6 9.6 0 0 0 2.3 5.6L8 2.4l6.4 11.2H11.9', stroke: true, width: 1.2 }]);
		case 'linear':
			return svg([
				{ d: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z', stroke: true, width: 1 },
				{ d: 'M2.4 9.6l4 4M1.8 6.9l7.3 7.3M2.9 4.4l8.7 8.7M4.8 2.7l8.5 8.5M7.4 1.7l6.9 6.9', stroke: true, width: 0.9 },
			]);
		case 'pagerduty':
			return svg([{ d: 'M4.3 15V9.6M4.3 9.6V1.6h4.3c2.3 0 3.6 1.2 3.6 3.3 0 2.2-1.4 3.4-3.6 3.4H4.3', stroke: true, width: 1.6 }]);
		case 'webhook':
			return renderIcon(Codicon.plug);
		case 'manual':
			return renderIcon(Codicon.play);
		case 'schedule':
		default:
			return clockIcon();
	}
}

export function clockIcon(color?: string): SVGSVGElement {
	return svg([{ d: 'M8 1.6a6.4 6.4 0 1 1 0 12.8A6.4 6.4 0 0 1 8 1.6zM8 4.6V8l-2.2 1.6', stroke: true, width: 1.1, ...(color ? { fill: color } : {}) }]);
}

/** Memories: a six-petal mark, as Cursor draws its memory tool. */
export function memoriesIcon(): SVGSVGElement {
	const petals = [90, 30, -30, -90, -150, 150].map(angle => {
		const rad = angle * Math.PI / 180;
		return circle(Math.round((8 + Math.cos(rad) * 3.6) * 100) / 100, Math.round((8 - Math.sin(rad) * 3.6) * 100) / 100, 2.2);
	});
	return svg([{ d: `${petals.join('')}${circle(8, 8, 1.4)}`, stroke: true, width: 0.95 }]);
}

/** The MCP mark: two linked strokes. */
export function mcpIcon(): SVGSVGElement {
	return svg([{ d: 'M2.5 8.2l5.3-5.3a1.9 1.9 0 0 1 2.7 2.7L6.4 9.7M6.4 9.7l4.2-4.2a1.9 1.9 0 0 1 2.7 2.7l-5 5a.7.7 0 0 0 0 1l.9.9M4.6 10.3l4-4a1.9 1.9 0 0 0-2.7-2.7', stroke: true, width: 1.1 }]);
}

export function toolKindIcon(kind: AutomationToolKind | AutomationRunToolKind): HTMLElement | SVGElement {
	switch (kind) {
		case 'memories': return memoriesIcon();
		case 'mcp': return mcpIcon();
		case 'slack':
		case 'slack_send':
		case 'slack_read': return providerIcon('slack');
		case 'teams':
		case 'teams_send':
		case 'teams_read': return providerIcon('teams');
		default: return providerIcon('github');
	}
}

const STATUS_COLORS = { running: '#E2A33B', failed: '#EE5D6C', succeeded: '#49B46B', skipped: 'currentColor' } as const;

/** Running (amber clock), Failed (red !), Succeeded (green check), Skipped (dashed chevrons). */
export function statusIcon(status: RunStatusBucket | AutomationRunStatus | AutomationToolStatus): SVGSVGElement {
	switch (status) {
		case 'running':
		case 'queued':
		case 'pending':
			return clockIcon(STATUS_COLORS.running);
		case 'failed':
		case 'cancelled':
			return svg([{ d: 'M8 1.6a6.4 6.4 0 1 1 0 12.8A6.4 6.4 0 0 1 8 1.6zM8 4.6v4.1M8 11.1v.1', stroke: true, width: 1.2, fill: STATUS_COLORS.failed }]);
		case 'succeeded':
		case 'success':
			return svg([{ d: 'M8 1.6a6.4 6.4 0 1 1 0 12.8A6.4 6.4 0 0 1 8 1.6zM5.3 8.2l1.8 1.8 3.6-3.8', stroke: true, width: 1.2, fill: STATUS_COLORS.succeeded }]);
		case 'skipped':
		default:
			return svg([{ d: 'M3.5 4l4 4-4 4M8.5 4l4 4-4 4', stroke: true, width: 1, dash: '1.4 1.4' }], '0 0 16 16', 'skipped');
	}
}

export function templateIcon(icon: AutomationTemplateIcon): ThemeIcon {
	switch (icon) {
		case 'bug': return Codicon.bug;
		case 'search': return Codicon.search;
		case 'book': return Codicon.book;
		case 'check': return Codicon.passFilled;
		case 'review': return Codicon.codeReview;
		case 'shield': return Codicon.shield;
		case 'key': return Codicon.key;
		case 'pulse': return Codicon.pulse;
		case 'flame': return Codicon.flame;
		case 'graph': return Codicon.graph;
		case 'chat': return Codicon.commentDiscussion;
		case 'package': return Codicon.package;
		case 'broom': return Codicon.clearAll;
		case 'beaker': return Codicon.beaker;
		case 'rocket': return Codicon.rocket;
		case 'git': return Codicon.gitPullRequest;
	}
}

/** The arrow of the All Runs link. */
export function arrowUpRightIcon(): SVGSVGElement {
	return svg([{ d: 'M4.5 11.5l7-7M5.5 4.5h6v6', stroke: true, width: 1.2 }]);
}
