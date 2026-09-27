/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ContextKeyExpr, ContextKeyExpression, ContextKeyExprType } from '../../../../platform/contextkey/common/contextkey.js';
import { type LayoutMode } from './layoutModeStartup.js';

/** Context key set to `agent` or `ide` for the whole window. */
export const LAYOUT_MODE_CONTEXT_KEY = 'volt.layoutMode';

/** New Untitled File. Its Cmd+N binding is IDE-only, so the menu drops that accelerator in Agent mode. */
export const NEW_UNTITLED_FILE_COMMAND_ID = 'workbench.action.files.newUntitledFile';

export type LayoutKeybindingMode = LayoutMode;

const agentEquals = ContextKeyExpr.equals(LAYOUT_MODE_CONTEXT_KEY, 'agent');
const ideEquals = ContextKeyExpr.equals(LAYOUT_MODE_CONTEXT_KEY, 'ide');
const notAgent = ContextKeyExpr.notEquals(LAYOUT_MODE_CONTEXT_KEY, 'agent');
const notIde = ContextKeyExpr.notEquals(LAYOUT_MODE_CONTEXT_KEY, 'ide');

/**
 * The layout mode a when clause is exclusively for.
 * A clause with no layout constraint is shared, so it does not occupy either mode.
 * The window only has these two modes, so `!= 'agent'` is IDE and `!= 'ide'` is Agent.
 */
export function explicitLayoutMode(when: string | undefined): LayoutKeybindingMode | undefined {
	if (!when?.trim()) {
		return undefined;
	}
	const parsed = ContextKeyExpr.deserialize(when);
	if (!parsed) {
		return undefined;
	}
	return explicitLayoutModeExpr(parsed);
}

/** Keep the rest of a when clause and pin it to one layout mode. */
export function withLayoutModeWhen(when: string | undefined, mode: LayoutKeybindingMode): string {
	const modeExpr = ContextKeyExpr.equals(LAYOUT_MODE_CONTEXT_KEY, mode);
	const parsed = when?.trim() ? ContextKeyExpr.deserialize(when) : undefined;
	const rest = parsed ? withoutLayoutMode(parsed) : undefined;
	return ContextKeyExpr.and(rest, modeExpr)?.serialize() ?? modeExpr.serialize();
}

export interface ILayoutModeKeybindingRef {
	readonly command: string;
	readonly commandLabel: string;
	readonly key: string | undefined;
	readonly when: string;
}

/**
 * The other command that already owns `key` in `mode`.
 * The binding being edited is skipped. A key may exist once per mode.
 */
export function layoutModeKeybindingConflict(
	items: readonly ILayoutModeKeybindingRef[],
	key: string,
	mode: LayoutKeybindingMode,
	except?: { readonly command: string; readonly key: string | undefined; readonly when: string },
): ILayoutModeKeybindingRef | undefined {
	const wanted = normalizeKeybindingLabel(key);
	if (!wanted) {
		return undefined;
	}
	for (const item of items) {
		if (normalizeKeybindingLabel(item.key) !== wanted) {
			continue;
		}
		if (item.command.charAt(0) === '-') {
			continue;
		}
		if (explicitLayoutMode(item.when) !== mode) {
			continue;
		}
		if (except
			&& item.command === except.command
			&& item.when === except.when
			&& normalizeKeybindingLabel(item.key) === normalizeKeybindingLabel(except.key)) {
			continue;
		}
		return item;
	}
	return undefined;
}

export function normalizeKeybindingLabel(key: string | undefined): string {
	return (key ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function directLayoutMode(expr: ContextKeyExpression): LayoutKeybindingMode | undefined {
	if (expr.equals(agentEquals) || expr.equals(notIde)) {
		return 'agent';
	}
	if (expr.equals(ideEquals) || expr.equals(notAgent)) {
		return 'ide';
	}
	return undefined;
}

function explicitLayoutModeExpr(expr: ContextKeyExpression): LayoutKeybindingMode | undefined {
	const direct = directLayoutMode(expr);
	if (direct) {
		return direct;
	}
	if (expr.type === ContextKeyExprType.And) {
		return singleMode(expr.expr, false);
	}
	if (expr.type === ContextKeyExprType.Or) {
		return singleMode(expr.expr, true);
	}
	return undefined;
}

function singleMode(parts: readonly ContextKeyExpression[], everyPartMustMatch: boolean): LayoutKeybindingMode | undefined {
	let found: LayoutKeybindingMode | undefined;
	for (const part of parts) {
		const mode = explicitLayoutModeExpr(part);
		if (!mode) {
			if (everyPartMustMatch) {
				return undefined;
			}
			continue;
		}
		if (found && found !== mode) {
			return undefined;
		}
		found = mode;
	}
	return found;
}

function withoutLayoutMode(expr: ContextKeyExpression): ContextKeyExpression | undefined {
	if (directLayoutMode(expr)) {
		return undefined;
	}
	if (expr.type === ContextKeyExprType.And) {
		const parts: ContextKeyExpression[] = [];
		for (const part of expr.expr) {
			const kept = withoutLayoutMode(part);
			if (kept) {
				parts.push(kept);
			}
		}
		return ContextKeyExpr.and(...parts);
	}
	return expr;
}
