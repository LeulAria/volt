/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProviderCapabilities } from '../capabilities.js';
import { VoltMode } from '../modes.js';
import { VoltLane } from './lanes.js';
import { needsResearch } from './requestShape.js';
import { ITaskIntel } from './taskIntel.js';

/**
 * The model router. Picks which model runs a turn, and which model runs it *instead* when the
 * first one fails or gets stuck.
 *
 * Two rules keep this honest:
 *
 *   1. **An explicit choice is never overridden.** If the user picked a model in the composer,
 *      that is the model, full stop. Silently routing someone's request to a cheaper model is
 *      the fastest way to lose their trust in the product. Routing only ever fills in a *gap*
 *      - no explicit pick, or an escalation the user's own harness asked for.
 *
 *   2. **Escalation is one-way and bounded.** Up the ladder on failure, never back down mid-run,
 *      and never past the top. A run that oscillates between models is worse than one that
 *      commits to the wrong one.
 */

export type ModelRole = 'fast' | 'reasoning' | 'coding' | 'vision' | 'local' | 'fallback';

export const MODEL_ROLES: readonly ModelRole[] = ['fast', 'reasoning', 'coding', 'vision', 'local', 'fallback'];

export interface IRoutableModel {
	readonly ref: string;
	readonly label: string;
	readonly kind: 'model' | 'agent';
	readonly providerId: string;
	readonly capabilities: IProviderCapabilities;
	readonly enabled: boolean;
	/** The last health check found the provider usable. Unhealthy models are never routed to. */
	readonly healthy?: boolean;
}

/** Slots the user configured explicitly, by role. */
export type IRoleAssignments = Partial<Record<ModelRole, string>>;

export interface IRoutingRequest {
	readonly lane: VoltLane;
	readonly mode: VoltMode;
	readonly intel: ITaskIntel;
	/** The model the user picked in the composer. Wins over everything. */
	readonly explicitRef?: string;
	/** The request carries an image, so the model must see. */
	readonly needsVision?: boolean;
	/** Tokens the turn is already expected to carry; a model that cannot hold it is unroutable. */
	readonly estimatedTokens?: number;
}

export interface IRoutingDecision {
	readonly ref: string;
	readonly role: ModelRole;
	/** One line for the trace: why this model and not another. */
	readonly reason: string;
	/** Models to try in order if this one errors, best first. */
	readonly fallbacks: readonly string[];
}

// --- role selection -------------------------------------------------------------------------

/** Complexity at or above which a coding lane wants the reasoning model rather than the default. */
const REASONING_AT = 0.55;

/**
 * Which *kind* of model the turn wants, before any question of what is installed. Derived from
 * the lane and the task's own complexity rather than from the mode alone, because "agent mode"
 * covers both a one-line rename and a schema migration.
 */
export function roleFor(request: IRoutingRequest): ModelRole {
	if (request.needsVision) {
		return 'vision';
	}
	switch (request.lane) {
		case 'chat':
			if (needsResearch(request.intel.shape)) {
				return 'coding';
			}
			return request.intel.complexityScore >= REASONING_AT ? 'reasoning' : 'fast';
		case 'fast':
			return needsResearch(request.intel.shape) ? 'coding' : 'fast';
		case 'mission':
			return 'reasoning';
		case 'agent':
		default:
			return request.intel.complexityScore >= REASONING_AT || request.mode === 'plan' || request.mode === 'debug'
				? 'reasoning'
				: 'coding';
	}
}

/** Roles to try when the preferred one has no model assigned, in order of how close they are. */
const ROLE_FALLBACK: Readonly<Record<ModelRole, readonly ModelRole[]>> = {
	fast: ['coding', 'reasoning', 'local', 'fallback'],
	reasoning: ['coding', 'fast', 'local', 'fallback'],
	coding: ['reasoning', 'fast', 'local', 'fallback'],
	vision: ['reasoning', 'coding', 'fast', 'fallback'],
	local: ['fast', 'coding', 'reasoning', 'fallback'],
	fallback: ['coding', 'reasoning', 'fast', 'local'],
};

// --- routing --------------------------------------------------------------------------------

export function route(request: IRoutingRequest, catalog: readonly IRoutableModel[], roles: IRoleAssignments): IRoutingDecision | undefined {
	const usable = catalog.filter(model => isUsable(model, request));
	if (!usable.length) {
		return undefined;
	}
	const byRef = new Map(usable.map(model => [model.ref, model]));

	if (request.explicitRef && byRef.has(request.explicitRef)) {
		return {
			ref: request.explicitRef,
			role: roleFor(request),
			reason: 'The model you selected.',
			fallbacks: rankFallbacks(request, usable, request.explicitRef),
		};
	}

	const wanted = roleFor(request);
	for (const role of [wanted, ...ROLE_FALLBACK[wanted]]) {
		const ref = roles[role];
		if (ref && byRef.has(ref)) {
			return {
				ref,
				role: wanted,
				reason: role === wanted
					? `${describeRole(wanted)} for this turn.`
					: `${describeRole(wanted)} for this turn; no ${role === 'fallback' ? 'fallback' : role} model is configured, using the ${role} slot.`,
				fallbacks: rankFallbacks(request, usable, ref),
			};
		}
	}

	// Nothing is assigned. Score the catalog and take the best fit rather than the first entry.
	const best = [...usable].sort((a, b) => fitness(b, wanted, request) - fitness(a, wanted, request))[0];
	return {
		ref: best.ref,
		role: wanted,
		reason: `No ${wanted} model is configured; ${best.label} is the closest fit.`,
		fallbacks: rankFallbacks(request, usable, best.ref),
	};
}

function isUsable(model: IRoutableModel, request: IRoutingRequest): boolean {
	if (!model.enabled || model.healthy === false) {
		return false;
	}
	if (request.needsVision && !model.capabilities.vision) {
		return false;
	}
	if (request.estimatedTokens && model.capabilities.contextWindow < request.estimatedTokens) {
		return false;
	}
	// Chat may skip tools for closed questions. A lookup still needs a model that can call them.
	const needsTools = request.lane !== 'chat' || request.intel.shape.lookup || needsResearch(request.intel.shape);
	return !needsTools || model.capabilities.toolCalling || model.capabilities.nativeAgent;
}

/**
 * How well a model matches a role, when nothing was configured. Deliberately coarse: guessing
 * from capability flags is a last resort, and a confidently wrong ranking is worse than an
 * obviously arbitrary one.
 */
function fitness(model: IRoutableModel, role: ModelRole, request: IRoutingRequest): number {
	const capabilities = model.capabilities;
	let score = 0;
	if (capabilities.toolCalling) { score += 2; }
	if (capabilities.streaming) { score += 1; }
	if (capabilities.promptCaching) { score += 1; }

	switch (role) {
		case 'reasoning':
			score += capabilities.reasoning ? 6 : 0;
			score += Math.min(3, capabilities.contextWindow / 200_000);
			break;
		case 'fast':
			// A reasoning model on a one-line question is a latency bug, not an upgrade.
			score += capabilities.reasoning ? -2 : 3;
			break;
		case 'coding':
			score += capabilities.parallelToolCalls ? 2 : 0;
			score += Math.min(2, capabilities.contextWindow / 200_000);
			break;
		case 'vision':
			score += capabilities.vision ? 8 : -8;
			break;
		case 'local':
		case 'fallback':
			break;
	}
	if (request.lane === 'mission' && capabilities.contextWindow >= 200_000) {
		score += 2;
	}
	return score;
}

/** Other usable models, best first, excluding the chosen one. Same provider last: if OpenAI is
 *  down, another OpenAI model is not a fallback. */
function rankFallbacks(request: IRoutingRequest, usable: readonly IRoutableModel[], chosenRef: string): string[] {
	const chosen = usable.find(model => model.ref === chosenRef);
	const role = roleFor(request);
	return usable
		.filter(model => model.ref !== chosenRef)
		.sort((a, b) => {
			const providerPenalty = (model: IRoutableModel) => model.providerId === chosen?.providerId ? 1 : 0;
			return providerPenalty(a) - providerPenalty(b) || fitness(b, role, request) - fitness(a, role, request);
		})
		.map(model => model.ref);
}

function describeRole(role: ModelRole): string {
	switch (role) {
		case 'fast': return 'A fast model';
		case 'reasoning': return 'A reasoning model';
		case 'coding': return 'A coding model';
		case 'vision': return 'A vision model';
		case 'local': return 'A local model';
		case 'fallback': return 'The fallback model';
	}
}

// --- escalation -------------------------------------------------------------------------------

export interface IEscalationResult {
	readonly ref: string;
	readonly reason: string;
}

/**
 * One rung up, when the recovery controller asks. Prefers the configured reasoning model; if the
 * run is already on it, takes the usable model with the largest context and reasoning support
 * that has not been tried.
 */
export function escalate(
	current: string,
	catalog: readonly IRoutableModel[],
	roles: IRoleAssignments,
	request: IRoutingRequest,
	alreadyTried: readonly string[] = [],
): IEscalationResult | undefined {
	const tried = new Set([current, ...alreadyTried]);
	const usable = catalog.filter(model => isUsable(model, request) && !tried.has(model.ref));
	if (!usable.length) {
		return undefined;
	}

	const configured = roles.reasoning && usable.find(model => model.ref === roles.reasoning);
	if (configured) {
		return { ref: configured.ref, reason: `Escalated to ${configured.label}, the configured reasoning model.` };
	}

	const stronger = [...usable].sort((a, b) => fitness(b, 'reasoning', request) - fitness(a, 'reasoning', request))[0];
	return stronger ? { ref: stronger.ref, reason: `Escalated to ${stronger.label}.` } : undefined;
}

/** Whether escalating is even possible, so the recovery controller can skip the rung. */
export function canEscalate(current: string, catalog: readonly IRoutableModel[], request: IRoutingRequest, alreadyTried: readonly string[] = []): boolean {
	const tried = new Set([current, ...alreadyTried]);
	return catalog.some(model => isUsable(model, request) && !tried.has(model.ref));
}
