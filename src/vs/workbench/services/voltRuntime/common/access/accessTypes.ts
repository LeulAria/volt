/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type PermissionEffect = 'allow' | 'ask' | 'deny';

export type PermissionAction =
	| 'read'
	| 'edit'
	| 'shell'
	| 'search'
	| 'web'
	| 'network'
	| 'mcp'
	| 'browser'
	| 'subagent'
	| 'git'
	| 'question';

export const PERMISSION_ACTIONS: readonly PermissionAction[] = [
	'read', 'edit', 'shell', 'search', 'web', 'network', 'mcp', 'browser', 'subagent', 'git', 'question',
];

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export const RISK_LEVELS: readonly RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];

export type PolicySource = 'system' | 'preset' | 'project' | 'agent' | 'session' | 'overlay';

export type AccessResourceType = 'file' | 'command' | 'url' | 'tool' | 'agent';

export type AccessDecisionScope = 'once' | 'always';

export interface IPermissionRule {
	action: string;
	resource: string;
	effect: PermissionEffect;
	source?: PolicySource;
}

export interface IAccessProfile {
	id: string;
	name: string;
	rules: IPermissionRule[];
}

export interface ICompiledRule {
	action: string;
	resource: string;
	effect: PermissionEffect;
	source: PolicySource;
	matchesAction: (action: string) => boolean;
	matchesResource: (resource: string) => boolean;
}

export interface ICompiledPolicy {
	system: ICompiledRule[];
	configured: ICompiledRule[];
	saved: ICompiledRule[];
	overlay: ICompiledRule[];
}

export interface IAccessResource {
	type: AccessResourceType;
	value: string;
}

export interface IAccessPreview {
	title?: string;
	detail?: string;
}

export interface IAccessRequest {
	id: string;
	sessionId: string;
	runId: string;
	providerId: string;
	agentId?: string;
	action: PermissionAction;
	resource: IAccessResource;
	risk: RiskLevel;
	preview?: IAccessPreview;
	reason?: string;
	createdAt: number;
}

export interface IAccessDecision {
	requestId: string;
	effect: PermissionEffect;
	scope: AccessDecisionScope;
	pattern?: string;
	policySource?: string;
	risk?: RiskLevel;
}

export interface IExecutionReceipt {
	executionId: string;
	sessionId: string;
	runId: string;
	providerId: string;
	agentId?: string;
	action: PermissionAction;
	resource: string;
	decision: 'allow' | 'approved' | 'denied';
	policySource: string;
	risk: RiskLevel;
	startedAt: number;
	completedAt?: number;
	result?: 'success' | 'failure' | 'cancelled';
}

export interface IAccessGate {
	evaluate(request: IAccessRequest): IAccessDecision | Promise<IAccessDecision>;
}

export interface IAccessReviewer {
	review(request: IAccessRequest): PermissionEffect | Promise<PermissionEffect>;
}

export const EFFECT_SEVERITY: Record<PermissionEffect, number> = {
	allow: 0,
	ask: 1,
	deny: 2,
};

export function maxEffect(a: PermissionEffect, b: PermissionEffect): PermissionEffect {
	return EFFECT_SEVERITY[a] >= EFFECT_SEVERITY[b] ? a : b;
}

export function isPermissionAction(value: string): value is PermissionAction {
	return (PERMISSION_ACTIONS as readonly string[]).includes(value);
}

export function describePolicySource(source: string | undefined): string {
	return source || 'policy';
}
