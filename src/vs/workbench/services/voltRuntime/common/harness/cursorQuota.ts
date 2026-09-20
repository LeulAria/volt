/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cursor ACP often returns the generic banner "Upgrade your plan to continue" for
 * usage-cap / Auto-smart / exhausted-premium errors, even when Auto and Composer
 * still work on the same account. Detect that dead-end text and fall back.
 */

export const CURSOR_PLAN_WALL = 'upgrade your plan to continue';

/** Models Cursor still accepts when a selected row is blocked at the cap. */
export const CURSOR_FALLBACK_MODELS = ['auto', 'composer-2.5'] as const;

const USAGE_LIMIT = /hit your usage limit|switch to a different model or set a spend limit|usage limits will reset/i;

export function normalizeCursorModelId(modelId: string | undefined): string | undefined {
	if (!modelId) {
		return undefined;
	}
	const trimmed = modelId.trim();
	if (!trimmed) {
		return undefined;
	}
	const base = trimmed.replace(/\[.*\]$/, '').toLowerCase();
	if (base === 'auto-smart' || base === 'default' || base === 'cursor-acp') {
		return 'auto';
	}
	return trimmed;
}

export function isCursorTransientError(text: string): boolean {
	const t = collapseWs(text);
	return t === 'internal error' || t === 'internal error.' || /\binternal server error\b|\bstatus(?: code)? 500\b/.test(t);
}

export function isCursorPlanWall(text: string): boolean {
	const t = collapseWs(text);
	if (!t) {
		return false;
	}
	if (t === CURSOR_PLAN_WALL || t === `${CURSOR_PLAN_WALL}.`) {
		return true;
	}
	if (t.includes(CURSOR_PLAN_WALL) && t.length < 96) {
		return true;
	}
	return USAGE_LIMIT.test(t) && t.length < 400;
}

/** True while streamed text still looks like the plan-wall banner (or its prefix). */
export function isCursorPlanWallPrefix(text: string): boolean {
	const t = collapseWs(text);
	if (!t) {
		return true;
	}
	if (CURSOR_PLAN_WALL.startsWith(t) || t.startsWith(CURSOR_PLAN_WALL)) {
		return true;
	}
	return isCursorPlanWall(text);
}

export function nextCursorFallback(alreadyTried: readonly string[]): string | undefined {
	const tried = new Set(alreadyTried.map(id => {
		const normalized = normalizeCursorModelId(id)?.replace(/\[.*\]$/, '').toLowerCase();
		return normalized || id.toLowerCase();
	}));
	return CURSOR_FALLBACK_MODELS.find(id => !tried.has(id));
}

function collapseWs(text: string): string {
	return text.replace(/\s+/g, ' ').trim().toLowerCase();
}
