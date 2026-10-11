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

type Shape = { readonly d: string; readonly fill?: string; readonly stroke?: boolean; readonly width?: number; readonly dash?: string; readonly evenOdd?: boolean };

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
			if (shape.evenOdd) {
				path.setAttribute('fill-rule', 'evenodd');
			}
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

// Simple Icons marks (24px grid), via Aria Icons.
const SENTRY = 'M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.48 15.48 0 0 1 8.53 12.811h-2.221A13.3 13.3 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.2 5.2 0 0 0-1.614-.913L.296 19.275a2.18 2.18 0 0 0 .812 2.999a2.24 2.24 0 0 0 1.086.288h6.983a9.32 9.32 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.24 17.24 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287q.043.918 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z';
const LINEAR = 'M2.886 4.18A11.98 11.98 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556q-.787.496-1.65.866L.951 7.277q.371-.863.866-1.65ZM.322 9.163l14.515 14.515q-1.066.26-2.195.322L0 11.358a12 12 0 0 1 .322-2.195m-.17 4.862l9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z';
const PAGERDUTY = 'M16.965 1.18C15.085.164 13.769 0 10.683 0H3.73v14.55h6.926c2.743 0 4.8-.164 6.61-1.37c1.975-1.303 3.004-3.484 3.004-6.007c0-2.716-1.262-4.896-3.305-5.994zm-5.5 10.326h-4.21V3.113l3.977-.027c3.62-.028 5.43 1.234 5.43 4.128c0 3.113-2.248 4.292-5.197 4.292M3.73 17.61h3.525V24H3.73Z';
const JIRA = 'M11.571 11.513H0a5.22 5.22 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.22 5.22 0 0 0 5.215 5.214V6.758a1 1 0 0 0-1.001-1.001M23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1 1 0 0 0 23.013 0';
const ATLASSIAN = 'M7.12 11.084a.683.683 0 0 0-1.16.126L.075 22.974a.703.703 0 0 0 .63 1.018h8.19a.68.68 0 0 0 .63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.52 15.52 0 0 0-.906 15.317l3.95 7.9a.7.7 0 0 0 .628.388h8.19a.703.703 0 0 0 .63-1.017L12.63.38a.664.664 0 0 0-1.196.006';
const GITLAB = 'm23.6 9.593l-.033-.086L20.3.98a.85.85 0 0 0-.336-.405a.875.875 0 0 0-1 .054a.9.9 0 0 0-.29.44L16.47 7.818H7.537L5.333 1.07a.86.86 0 0 0-.29-.441a.875.875 0 0 0-1-.054a.86.86 0 0 0-.336.405L.433 9.502l-.032.086a6.066 6.066 0 0 0 2.012 7.01l.01.009l.03.021l4.977 3.727l2.462 1.863l1.5 1.132a1.01 1.01 0 0 0 1.22 0l1.499-1.132l2.461-1.863l5.006-3.75l.013-.01a6.07 6.07 0 0 0 2.01-7.002';
// The Model Context Protocol mark (24px grid, even-odd).
const MCP = [
	'M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z',
	'M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z',
];

/** A brand mark on the 24px grid, drawn at 16px in the text color. */
function brand(d: string): SVGSVGElement {
	return svg([{ d }], '0 0 24 24', 'brand');
}

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
		case 'gitlab':
			return brand(GITLAB);
		case 'sentry':
			return brand(SENTRY);
		case 'linear':
			return brand(LINEAR);
		case 'jira':
			return brand(JIRA);
		case 'atlassian':
			return brand(ATLASSIAN);
		case 'pagerduty':
			return brand(PAGERDUTY);
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

/** The Model Context Protocol mark. */
export function mcpIcon(): SVGSVGElement {
	return svg(MCP.map(d => ({ d, evenOdd: true })), '0 0 24 24', 'brand');
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
