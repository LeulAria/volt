/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltAccessMode } from './accessModes.js';
import { IAccessDecision, IAccessRequest, ICompiledPolicy, ICompiledRule, PermissionAction, PermissionEffect, maxEffect } from './accessTypes.js';
import { configuredDenied, lastMatch } from './policyCompiler.js';
import { autoAllowsRisk } from './riskClassifier.js';
import { alwaysAllowPattern } from './wildcard.js';

const ROUTINE_ACTIONS = new Set<PermissionAction>(['shell', 'git', 'web', 'browser', 'network', 'read', 'search', 'question']);

export interface IEvaluateOptions {
	accessMode?: VoltAccessMode;
	/** Provider already reviewed medium-risk actions (Codex auto_review). */
	delegateMedium?: boolean;
}

function sourceOf(rule: ICompiledRule | undefined, fallback: string): string {
	if (!rule) {
		return fallback;
	}
	return `${rule.source}:${rule.action}:${rule.resource}`;
}

export function evaluateAccess(request: IAccessRequest, policy: ICompiledPolicy, options: IEvaluateOptions = {}): IAccessDecision {
	const resource = request.resource.value;
	const denied = configuredDenied(policy, request.action, resource);
	if (denied) {
		return {
			requestId: request.id,
			effect: 'deny',
			scope: 'once',
			policySource: sourceOf(denied, 'system'),
			risk: request.risk,
		};
	}

	const configured = lastMatch(policy.configured, request.action, resource);
	const saved = lastMatch(policy.saved, request.action, resource);
	let effect: PermissionEffect = configured.rule ? configured.effect : 'ask';
	let rule = configured.rule;
	if (saved.effect === 'allow') {
		effect = 'allow';
		rule = saved.rule ?? rule;
	}

	const overlay = lastMatch(policy.overlay, request.action, resource);
	if (policy.overlay.length && overlay.rule) {
		const tightened = maxEffect(effect, overlay.effect);
		if (tightened !== effect) {
			effect = tightened;
			rule = overlay.rule;
		}
	}

	if (effect === 'ask' && shouldAutoAllow(request, options)) {
		effect = 'allow';
		rule = rule ?? { action: request.action, resource: '*', effect: 'allow', source: 'preset', matchesAction: () => true, matchesResource: () => true };
	}

	return {
		requestId: request.id,
		effect,
		scope: 'once',
		pattern: alwaysAllowPattern(request.action, resource),
		policySource: sourceOf(rule, options.accessMode ?? 'preset'),
		risk: request.risk,
	};
}

function shouldAutoAllow(request: IAccessRequest, options: IEvaluateOptions): boolean {
	if (options.accessMode === 'auto' && options.delegateMedium && request.risk === 'medium') {
		return true;
	}
	if (!autoAllowsRisk(request.risk)) {
		return false;
	}
	if (request.action === 'edit') {
		return options.accessMode === 'auto' || options.accessMode === 'auto-accept-edits';
	}
	if (options.accessMode === 'auto') {
		return true;
	}
	return ROUTINE_ACTIONS.has(request.action);
}

export function memoKey(action: string, resource: string): string {
	return `${action}\0${resource}`;
}
