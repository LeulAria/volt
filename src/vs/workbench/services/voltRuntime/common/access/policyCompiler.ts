/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICompiledPolicy, ICompiledRule, IPermissionRule, PermissionAction, PermissionEffect } from './accessTypes.js';
import { compilePattern } from './wildcard.js';

export interface IPolicyLayers {
	system?: readonly IPermissionRule[];
	preset?: readonly IPermissionRule[];
	project?: readonly IPermissionRule[];
	agent?: readonly IPermissionRule[];
	session?: readonly IPermissionRule[];
	overlay?: readonly IPermissionRule[];
}

function compileRule(rule: IPermissionRule, fallback: ICompiledRule['source']): ICompiledRule {
	return {
		action: rule.action,
		resource: rule.resource,
		effect: rule.effect,
		source: rule.source ?? fallback,
		matchesAction: compilePattern(rule.action),
		matchesResource: compilePattern(rule.resource),
	};
}

function compileList(rules: readonly IPermissionRule[] | undefined, source: ICompiledRule['source']): ICompiledRule[] {
	return (rules ?? []).map(rule => compileRule(rule, source));
}

export function compilePolicy(layers: IPolicyLayers): ICompiledPolicy {
	return {
		system: compileList(layers.system, 'system'),
		configured: [
			...compileList(layers.preset, 'preset'),
			...compileList(layers.project, 'project'),
			...compileList(layers.agent, 'agent'),
		],
		saved: compileList(layers.session, 'session'),
		overlay: compileList(layers.overlay, 'overlay'),
	};
}

export interface IRuleMatch {
	effect: PermissionEffect;
	rule?: ICompiledRule;
}

export function lastMatch(rules: readonly ICompiledRule[], action: PermissionAction, resource: string): IRuleMatch {
	for (let i = rules.length - 1; i >= 0; i--) {
		const rule = rules[i];
		if (rule.matchesAction(action) && rule.matchesResource(resource)) {
			return { effect: rule.effect, rule };
		}
	}
	return { effect: 'ask' };
}

export function configuredDenied(policy: ICompiledPolicy, action: PermissionAction, resource: string): ICompiledRule | undefined {
	const system = lastMatch(policy.system, action, resource);
	if (system.rule && system.effect === 'deny') {
		return system.rule;
	}
	const match = lastMatch(policy.configured, action, resource);
	return match.rule && match.effect === 'deny' ? match.rule : undefined;
}
