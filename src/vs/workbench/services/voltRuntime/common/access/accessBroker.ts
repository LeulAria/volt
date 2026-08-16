/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltAccessMode } from './accessModes.js';
import { IAccessDecision, IAccessRequest, ICompiledPolicy, ICompiledRule, PermissionEffect, maxEffect } from './accessTypes.js';
import { configuredDenied, lastMatch } from './policyCompiler.js';
import { autoAllowsRisk } from './riskClassifier.js';
import { alwaysAllowPattern } from './wildcard.js';

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

	if (effect === 'ask' && options.accessMode === 'auto') {
		if (autoAllowsRisk(request.risk) || (options.delegateMedium && request.risk === 'medium')) {
			effect = 'allow';
			rule = rule ?? { action: request.action, resource: '*', effect: 'allow', source: 'preset', matchesAction: () => true, matchesResource: () => true };
		}
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

export function memoKey(action: string, resource: string): string {
	return `${action}\0${resource}`;
}
