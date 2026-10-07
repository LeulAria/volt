/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../base/browser/dom.js';

export const AGENT_HOME_SEARCH_ICON_PATH = 'm21 21l-4.343-4.343m0 0A8 8 0 1 0 5.343 5.343a8 8 0 0 0 11.314 11.314';
export const AGENT_HOME_NEW_CHAT_ICON_PATH = 'm8.87 6.133l5.863-1.938c3.3-1.09 4.95-1.636 5.825-.76c.875.874.33 2.524-.761 5.825l-1.937 5.862c-1.236 3.74-1.854 5.61-2.98 5.838a2 2 0 0 1-.725.013c-1.136-.19-1.842-2.037-3.253-5.732c-.27-.703-.404-1.055-.645-1.328a2 2 0 0 0-.178-.178c-.273-.241-.624-.376-1.328-.644c-3.695-1.412-5.542-2.118-5.732-3.254c-.04-.24-.035-.486.013-.724c.228-1.126 2.098-1.744 5.838-2.98m3.93 5.054l2.698-2.698';
/** Folder-plus outline for New project; stroke follows currentColor, square caps. */
export const AGENT_HOME_NEW_PROJECT_ICON_PATH = 'M22 11V6H11L9 3.5H2V20h11m7-5v3m0 0v3m0-3h-3m3 0h3';
/** Folder outline from the agent sidebar spec; stroke follows currentColor. */
export const AGENT_HOME_FOLDER_ICON_PATH = 'M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2';
/** Folder on the chat-row hover card; stroke follows currentColor. */
export const AGENT_SESSION_HOVER_FOLDER_ICON_PATH = 'M4 21H20C21.1046 21 22 20.1046 22 19V8C22 6.89543 21.1046 6 20 6H11L9.29687 3.4453C9.1114 3.1671 8.79917 3 8.46482 3H4C2.89543 3 2 3.89543 2 5V19C2 20.1046 2.89543 21 4 21Z';
/** Filter bars for group headers; stroke follows currentColor. */
export const AGENT_HOME_FILTER_ICON_PATH = 'M2 5.5h20M5.333 12h13.334m-9.334 6.5h5.334';
/** Status arcs + center dot used in the home filter Grouping / Ordering menus. */
export const AGENT_HOME_STATUS_ICON_PATHS = [
	'M10.1 2.18a9.93 9.93 0 0 1 3.8 0',
	'M17.6 3.71a9.95 9.95 0 0 1 2.69 2.7',
	'M21.82 10.1a9.93 9.93 0 0 1 0 3.8',
	'M20.29 17.6a9.95 9.95 0 0 1-2.7 2.69',
	'M13.9 21.82a9.94 9.94 0 0 1-3.8 0',
	'M6.4 20.29a9.95 9.95 0 0 1-2.69-2.7',
	'M2.18 13.9a9.93 9.93 0 0 1 0-3.8',
	'M3.71 6.4a9.95 9.95 0 0 1 2.7-2.69',
] as const;

function createHomeSvgIcon(extraClass: string, pathD: string, options?: {
	readonly viewBox?: string;
	readonly strokeWidth?: string;
	readonly filled?: boolean;
	readonly strokeLinecap?: string;
	readonly strokeLinejoin?: string | null;
}): HTMLElement {
	const el = $(`span.volt-agent-svg-icon.${extraClass}`);
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', options?.viewBox ?? '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', pathD);
	if (options?.filled) {
		path.setAttribute('fill', 'currentColor');
		path.setAttribute('stroke', 'none');
	} else {
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', options?.strokeWidth ?? '2');
		path.setAttribute('stroke-linecap', options?.strokeLinecap ?? 'round');
		if (options?.strokeLinejoin !== null) {
			path.setAttribute('stroke-linejoin', options?.strokeLinejoin ?? 'round');
		}
	}
	svg.appendChild(path);
	el.appendChild(svg);
	return el;
}

export function createHomeSearchIcon(): HTMLElement {
	return createHomeSvgIcon('search', AGENT_HOME_SEARCH_ICON_PATH);
}

export function createHomeNewChatIcon(): HTMLElement {
	return createHomeSvgIcon('new-chat', AGENT_HOME_NEW_CHAT_ICON_PATH);
}

export function createHomeNewProjectIcon(): HTMLElement {
	return createHomeSvgIcon('new-project', AGENT_HOME_NEW_PROJECT_ICON_PATH, {
		strokeWidth: '2',
		strokeLinecap: 'square',
		strokeLinejoin: null,
	});
}

export function createHomeFolderIcon(): HTMLElement {
	return createHomeSvgIcon('folder', AGENT_HOME_FOLDER_ICON_PATH, { strokeWidth: '1' });
}

/** Folder glyph for the chat-row hover card (stroke 1.5, round caps). */
export function createSessionHoverFolderIcon(): HTMLElement {
	return createHomeSvgIcon('session-folder', AGENT_SESSION_HOVER_FOLDER_ICON_PATH, { strokeWidth: '1.5' });
}

export function createHomeFilterIcon(): HTMLElement {
	return createHomeSvgIcon('filter', AGENT_HOME_FILTER_ICON_PATH, { strokeWidth: '1.5' });
}

/** Broken-ring status glyph (stroke currentColor, width 1) for filter menu Status rows. */
export function createHomeStatusIcon(): HTMLElement {
	const el = $('span.volt-agent-svg-icon.status');
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	for (const d of AGENT_HOME_STATUS_ICON_PATHS) {
		const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d);
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', '1');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
	}
	const dot = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
	dot.setAttribute('cx', '12');
	dot.setAttribute('cy', '12');
	dot.setAttribute('r', '1');
	dot.setAttribute('fill', 'none');
	dot.setAttribute('stroke', 'currentColor');
	dot.setAttribute('stroke-width', '1');
	dot.setAttribute('stroke-linecap', 'round');
	dot.setAttribute('stroke-linejoin', 'round');
	svg.appendChild(dot);
	el.appendChild(svg);
	return el;
}

/** Two offset folders: a row that spans several folders or repositories. */
export const AGENT_HOME_FOLDERS_ICON_PATHS = [
	'M3 9h3.5l2 2H15a2 2 0 0 1 2 2v5a2 2 0 0 1 -2 2H3a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2',
	'M5 9V7a2 2 0 0 1 2 -2h3.5l2 2H19a2 2 0 0 1 2 2v5a2 2 0 0 1 -2 2h-2',
] as const;
/** Drive outline for the Environment grouping (status lights are drawn as dots). */
export const AGENT_HOME_ENVIRONMENT_ICON_PATH = 'M2 9a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2H4a2 2 0 0 1 -2 -2z';

function createHomeStrokeIcon(extraClass: string, paths: readonly string[], strokeWidth: string, dots: readonly [number, number][] = []): HTMLElement {
	const el = $(`span.volt-agent-svg-icon.${extraClass}`);
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('width', '16');
	svg.setAttribute('height', '16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('aria-hidden', 'true');
	for (const d of paths) {
		const path = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d);
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke', 'currentColor');
		path.setAttribute('stroke-width', strokeWidth);
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(path);
	}
	for (const [cx, cy] of dots) {
		const dot = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
		dot.setAttribute('cx', String(cx));
		dot.setAttribute('cy', String(cy));
		dot.setAttribute('r', '1');
		dot.setAttribute('fill', 'currentColor');
		svg.appendChild(dot);
	}
	el.appendChild(svg);
	return el;
}

export function createHomeFoldersIcon(): HTMLElement {
	return createHomeStrokeIcon('folders', AGENT_HOME_FOLDERS_ICON_PATHS, '1');
}

export function createHomeEnvironmentIcon(): HTMLElement {
	return createHomeStrokeIcon('environment', [AGENT_HOME_ENVIRONMENT_ICON_PATH], '1.25', [[15, 12], [18, 12]]);
}

/** Folder-plus on the Open Workspace header control; lighter than New project. */
export function createHomeOpenWorkspaceIcon(): HTMLElement {
	return createHomeSvgIcon('open-workspace', AGENT_HOME_NEW_PROJECT_ICON_PATH, { strokeWidth: '1.5' });
}

/** Laptop outline for On This Mac. */
export const AGENT_HOME_LAPTOP_ICON_PATHS = [
	'M5 5h14a1 1 0 0 1 1 1v10H4V6a1 1 0 0 1 1 -1',
	'M2 19h20',
] as const;
/** GitLab tanuki outline. */
export const AGENT_HOME_GITLAB_ICON_PATH = 'M12 21l-9.5-7l2.5-10l3 7h8l3-7l2.5 10z';
/** Bitbucket bucket outline. */
export const AGENT_HOME_BITBUCKET_ICON_PATHS = [
	'M3 4h18l-2.7 16H5.7z',
	'M9.3 10h5.4l-.8 4.5h-3.8z',
] as const;

export function createHomeLaptopIcon(): HTMLElement {
	return createHomeStrokeIcon('laptop', AGENT_HOME_LAPTOP_ICON_PATHS, '1.25');
}

export function createHomeGitLabIcon(): HTMLElement {
	return createHomeStrokeIcon('gitlab', [AGENT_HOME_GITLAB_ICON_PATH], '1.25');
}

export function createHomeBitbucketIcon(): HTMLElement {
	return createHomeStrokeIcon('bitbucket', AGENT_HOME_BITBUCKET_ICON_PATHS, '1.25');
}

const STATUS_RING = 'M21 12a9 9 0 1 1 -18 0a9 9 0 0 1 18 0';

/** Alarm clock: face, hands, the two bells on top and the feet. */
const STATUS_ALARM_PATHS = [
	'M20 13a8 8 0 1 1 -16 0a8 8 0 0 1 16 0',
	'M12 9v4l2 2',
	'M5 3L2 6',
	'M22 6l-3 -3',
	'M6.38 18.7L4 21',
	'M17.64 18.67L20 21',
];

/** Speech bubble with a question mark, tail at the bottom left. */
const STATUS_INPUT_PATHS = [
	'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719',
	'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3',
	'M12 17h.01',
];

/** Pencil writing over an open ring. */
const STATUS_DRAFT_PATHS = [
	'M12 15l8.385 -8.415a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3z',
	'M16 5l3 3',
	'M9 7.07a7 7 0 0 0 1 13.93a7 7 0 0 0 6.929 -6',
];

/** Ring with an exclamation mark: usage limit and failure share it, the color tells them apart. */
const STATUS_ALERT_PATHS = [STATUS_RING, 'M12 7.5v5.5', 'M12 16.5v.01'];

/** Glyph in an agent tab's status badge. Working spins a broken ring (agentHomePane.css). */
export function createHomeStatusBadgeIcon(kind: 'input' | 'working' | 'woke' | 'done' | 'draft' | 'limited' | 'failed'): HTMLElement {
	switch (kind) {
		case 'input':
			return createHomeStrokeIcon('status-input', STATUS_INPUT_PATHS, '2');
		case 'woke':
			return createHomeStrokeIcon('status-woke', STATUS_ALARM_PATHS, '2');
		case 'working':
			return createHomeStrokeIcon('status-working', AGENT_HOME_STATUS_ICON_PATHS, '2');
		case 'done':
			return createHomeStrokeIcon('status-done', [STATUS_RING, 'M8.5 12.5l2.5 2.5l4.5 -5'], '2');
		case 'draft':
			return createHomeStrokeIcon('status-draft', STATUS_DRAFT_PATHS, '2');
		case 'limited':
			return createHomeStrokeIcon('status-limited', STATUS_ALERT_PATHS, '2');
		case 'failed':
			return createHomeStrokeIcon('status-failed', STATUS_ALERT_PATHS, '2');
		default: {
			const unexpected: never = kind;
			return unexpected;
		}
	}
}
