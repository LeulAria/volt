/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../../base/common/uuid.js';
import { IAccessDecision, IAccessRequest, ICompiledPolicy, PermissionAction } from './accessTypes.js';
import { classifyRisk } from './riskClassifier.js';

export interface IAcpConfigOption {
	id?: string;
	name?: string;
	type?: string;
}

export interface IAcpSessionMode {
	id: string;
	name?: string;
}

export interface IAcpSessionCapabilities {
	configOptions?: IAcpConfigOption[];
	modes?: IAcpSessionMode[];
	nativePermissions?: boolean;
}

export interface IProviderAccessConfig {
	configOptions?: { id: string; value: string | boolean }[];
	sessionModeId?: string;
	spawnArgs?: string[];
}

export interface IAccessNormalizeContext {
	sessionId: string;
	runId: string;
	providerId: string;
	agentId?: string;
}

export interface IProviderAccessBridge {
	readonly id: string;
	readonly authority: 'volt' | 'hybrid';
	readonly delegatesMediumReview?: boolean;
	translate(policy: ICompiledPolicy, caps: IAcpSessionCapabilities): IProviderAccessConfig;
	normalize(method: string, params: unknown, context: IAccessNormalizeContext): IAccessRequest | undefined;
	toNativeResponse(decision: IAccessDecision, params: unknown): unknown;
}

export interface IAcpPermissionOption {
	optionId: string;
	name?: string;
	kind?: string;
}

export function advertisedConfigIds(caps: IAcpSessionCapabilities): Set<string> {
	return new Set((caps.configOptions ?? []).map(option => option.id).filter((id): id is string => !!id));
}

export function advertisedModeId(caps: IAcpSessionCapabilities, aliases: readonly string[]): string | undefined {
	const modes = caps.modes ?? [];
	for (const alias of aliases) {
		const match = modes.find(mode => mode.id === alias || mode.name?.toLowerCase() === alias.toLowerCase());
		if (match) {
			return match.id;
		}
	}
	return undefined;
}

export function pickAdvertised(caps: IAcpSessionCapabilities, updates: { id: string; value: string | boolean }[]): { id: string; value: string | boolean }[] {
	const ids = advertisedConfigIds(caps);
	if (!ids.size) {
		return [];
	}
	return updates.filter(update => ids.has(update.id));
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function acpPermissionOptions(params: unknown): IAcpPermissionOption[] {
	const body = asRecord(params);
	const raw = body.options;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map(item => {
		const option = asRecord(item);
		return {
			optionId: String(option.optionId ?? option.id ?? ''),
			name: typeof option.name === 'string' ? option.name : undefined,
			kind: typeof option.kind === 'string' ? option.kind : undefined,
		};
	}).filter(option => option.optionId);
}

function kindMatches(option: IAcpPermissionOption, kinds: readonly string[], names: readonly string[]): boolean {
	const kind = (option.kind ?? '').toLowerCase().replace(/-/g, '_');
	if (kinds.some(candidate => kind === candidate || kind.includes(candidate))) {
		return true;
	}
	const name = (option.name ?? option.optionId).toLowerCase();
	return names.some(candidate => name.includes(candidate));
}

export function selectAcpPermissionOption(params: unknown, decision: IAccessDecision): string | undefined {
	const options = acpPermissionOptions(params);
	if (!options.length) {
		return undefined;
	}
	if (decision.effect === 'deny') {
		return options.find(option => kindMatches(option, ['reject_once', 'reject', 'deny'], ['reject', 'deny', 'block']))?.optionId
			?? options.find(option => kindMatches(option, ['reject_always'], ['reject always', 'deny always']))?.optionId;
	}
	if (decision.scope === 'always') {
		return options.find(option => kindMatches(option, ['allow_always', 'allow_for_session'], ['always', 'session']))?.optionId
			?? options.find(option => kindMatches(option, ['allow_once', 'allow'], ['allow', 'approve', 'yes']))?.optionId;
	}
	return options.find(option => kindMatches(option, ['allow_once', 'allow'], ['allow once', 'allow', 'approve', 'yes']))?.optionId
		?? options.find(option => kindMatches(option, ['allow_always'], ['always']))?.optionId;
}

const KIND_TO_ACTION: Record<string, PermissionAction> = {
	read: 'read',
	edit: 'edit',
	delete: 'edit',
	move: 'edit',
	execute: 'shell',
	search: 'search',
	fetch: 'web',
	switch_mode: 'question',
};

export function actionFromToolKind(kind: string | undefined, name?: string): PermissionAction {
	const key = (kind ?? '').toLowerCase();
	if (KIND_TO_ACTION[key]) {
		return KIND_TO_ACTION[key];
	}
	const haystack = `${kind ?? ''} ${name ?? ''}`.toLowerCase();
	if (/\b(bash|shell|exec|command|terminal)\b/.test(haystack)) {
		return 'shell';
	}
	if (/\b(mcp|use_mcp)\b/.test(haystack)) {
		return 'mcp';
	}
	if (/\b(browser|playwright)\b/.test(haystack)) {
		return 'browser';
	}
	if (/\b(web|fetch|http)\b/.test(haystack)) {
		return 'web';
	}
	if (/\b(grep|glob|search|find)\b/.test(haystack)) {
		return 'search';
	}
	if (/\b(write|edit|patch|apply)\b/.test(haystack)) {
		return 'edit';
	}
	if (/\b(read|view|cat)\b/.test(haystack)) {
		return 'read';
	}
	if (/\b(subagent|task|delegate)\b/.test(haystack)) {
		return 'subagent';
	}
	return 'shell';
}

export function resourceFromParams(params: unknown, action: PermissionAction): { type: IAccessRequest['resource']['type']; value: string } {
	const body = asRecord(params);
	const toolCall = asRecord(body.toolCall ?? body.tool_call);
	const raw = asRecord(toolCall.rawInput ?? toolCall.input ?? body.rawInput ?? body.input ?? body.arguments);
	const command = firstString(raw, ['command', 'cmd', 'script', 'code']) ?? firstString(body, ['command']);
	const path = firstString(raw, ['path', 'file', 'uri', 'target']) ?? firstString(body, ['path', 'uri']);
	const url = firstString(raw, ['url', 'uri', 'href']);
	const tool = firstString(toolCall, ['title', 'kind']) ?? firstString(body, ['title', 'tool']);
	if (action === 'shell' || action === 'git') {
		return { type: 'command', value: command || tool || '' };
	}
	if (action === 'web' || action === 'network' || action === 'browser') {
		return { type: 'url', value: url || path || tool || '' };
	}
	if (action === 'mcp' || action === 'subagent') {
		return { type: 'tool', value: tool || command || '' };
	}
	return { type: path ? 'file' : 'tool', value: path || command || tool || '' };
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value) {
			return value;
		}
	}
	return undefined;
}

export function normalizeAcpPermission(method: string, params: unknown, context: IAccessNormalizeContext): IAccessRequest | undefined {
	if (method !== 'session/request_permission') {
		return undefined;
	}
	const body = asRecord(params);
	const toolCall = asRecord(body.toolCall ?? body.tool_call);
	const kind = typeof toolCall.kind === 'string' ? toolCall.kind : typeof body.kind === 'string' ? body.kind : undefined;
	const title = typeof toolCall.title === 'string' ? toolCall.title : typeof body.title === 'string' ? body.title : undefined;
	const action = actionFromToolKind(kind, title);
	const resource = resourceFromParams(params, action);
	const risk = classifyRisk(action, resource.value);
	return {
		id: generateUuid(),
		sessionId: context.sessionId,
		runId: context.runId,
		providerId: context.providerId,
		agentId: context.agentId,
		action,
		resource,
		risk,
		preview: { title, detail: resource.value },
		reason: title,
		createdAt: Date.now(),
	};
}

export function acpPermissionResponse(decision: IAccessDecision, params: unknown): unknown {
	const optionId = selectAcpPermissionOption(params, decision);
	if (!optionId) {
		return { outcome: { outcome: decision.effect === 'deny' ? 'cancelled' : 'selected', optionId: decision.effect === 'deny' ? 'reject' : 'allow-once' } };
	}
	return { outcome: { outcome: 'selected', optionId } };
}
