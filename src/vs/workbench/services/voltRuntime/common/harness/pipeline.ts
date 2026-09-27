/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VoltMode } from '../modes.js';
import { IRoutableModel, IRoleAssignments, IRoutingDecision, IRoutingRequest, roleFor, route } from './modelRouter.js';
import { IExecutionRoute, IExecutionTarget, routeExecution } from './execRouter.js';
import { IClarification, decideClarification } from './clarification.js';
import { RequestKind, requestKindOf } from './decision.js';
import { IRequestEnvelope, createEnvelope } from './envelope.js';
import { ICapabilityResolution, IEnvironmentUnderstanding, resolveCapabilities, understandEnvironment } from './environment.js';
import { IIntent, IIntentContext } from './intent.js';
import { IIntake, IIntentSignals, INormalizedRequest, intake } from './intake.js';
import { IMissionState, draftMission, submitPlan } from './mission.js';
import { IOrchestration, orchestrate } from './orchestrator.js';
import { IExecutionPlan, IPlanValidation, buildPlan, validatePlan } from './plan.js';
import { ISafetyPosture, safetyPosture } from './safety.js';
import { IStrategyPlan, applyStrategy, overlayLaneBudget, selectStrategy } from './strategy.js';
import { framingForShape } from './requestShape.js';
import { ITaskIntel, ITaskIntelContext, analyzeTask } from './taskIntel.js';
import { applyEvalHints } from './optimizer.js';
import { IOptimizerHint } from './observability.js';
import { IToolPlan, planTools } from './toolPlanner.js';
import { laneDefinition } from './lanes.js';

/**
 * The pre-loop pipeline. Every box on the left-hand side of the architecture - intake,
 * normalize, intent, signals, task intelligence, clarify, plan, validate, orchestrate,
 * execution route, model role, tool plan, safety - runs here, in that order, with no I/O.
 *
 * A caller that skips this and jumps into `runNativeLoop` is running a model, not a harness:
 * it will have no plan to recover against, no gates to complete against, and no record of
 * why the lane was chosen.
 */

export interface IPrepareInput {
	readonly text: string;
	readonly mode: VoltMode;
	readonly intentContext?: IIntentContext;
	readonly intelContext?: ITaskIntelContext;
	readonly attachments?: readonly string[];
	readonly provider?: IExecutionTarget;
	readonly catalog?: readonly IRoutableModel[];
	readonly roles?: IRoleAssignments;
	readonly explicitRef?: string;
	readonly needsVision?: boolean;
	readonly estimatedTokens?: number;
	readonly sessionId?: string;
	readonly conversationId?: string;
	readonly workspaceId?: string;
	readonly accessMode?: string;
	readonly environment?: Partial<IEnvironmentUnderstanding>;
	/** Prior-run eval hints. The optimizer is the only thing allowed to act on them. */
	readonly evalHints?: readonly IOptimizerHint[];
}

export interface IPreparedRun {
	readonly request: INormalizedRequest;
	readonly intent: IIntent;
	readonly signals: IIntentSignals;
	readonly intel: ITaskIntel;
	/** Set when the clarify gate trips. The runtime must ask, not start the loop. */
	readonly clarify?: string;
	readonly plan?: IExecutionPlan;
	readonly planValidation?: IPlanValidation;
	readonly orchestration: IOrchestration;
	readonly execution: IExecutionRoute;
	readonly routing?: IRoutingDecision;
	readonly tools: IToolPlan;
	readonly safety: ISafetyPosture;
	readonly envelope: IRequestEnvelope;
	readonly environment: IEnvironmentUnderstanding;
	readonly capabilities: ICapabilityResolution;
	readonly strategy: IStrategyPlan;
	readonly mission?: IMissionState;
	readonly requestKind: RequestKind;
	readonly clarification: IClarification;
	/** Chat answers in place; everything else is dispatched. */
	readonly dispatch: 'direct' | 'loop';
	readonly forceCompact?: boolean;
	readonly preferEscalate?: boolean;
}

export function prepareRun(input: IPrepareInput): IPreparedRun {
	const taken: IIntake = intake(input.text, input.mode, {
		...(input.intentContext ?? {}),
		attachments: input.attachments ?? input.intelContext?.attachments ?? [],
	});

	const intel = analyzeTask(taken.request.raw, taken.intent, {
		...(input.intelContext ?? {}),
		attachments: input.attachments ?? input.intelContext?.attachments,
	});

	const clarification = decideClarification(intel, {
		hasWorkspace: input.intentContext?.hasWorkspace !== false,
		hasPriorTurns: input.intelContext?.hasPriorTurns,
		attachments: input.attachments ?? input.intelContext?.attachments ?? [],
	});
	const clarify = clarification.path === 'ask' ? clarification.question : undefined;

	const environment = understandEnvironment({
		hasWorkspace: input.intentContext?.hasWorkspace !== false,
		hasNetwork: true,
		...(input.environment ?? {}),
	});
	const capabilities = resolveCapabilities(taken.intent, environment);
	let strategy = selectStrategy(intel, { ...taken.intent, groups: capabilities.granted }, taken.signals, input.mode);
	const intent = {
		...taken.intent,
		groups: capabilities.granted,
		budget: overlayLaneBudget(taken.intent.budget, strategy.budgets),
	};

	const rawPlan = !clarify && intent.lane !== 'chat'
		? buildPlan(intel, intent.lane)
		: undefined;
	const plan = applyStrategy(rawPlan, strategy.strategy, taken.signals);
	const planValidation = plan ? validatePlan(plan) : undefined;
	const usablePlan = plan && planValidation?.ok !== false ? plan : undefined;

	const orchestration = orchestrate(intel, intent.lane, usablePlan);
	const execution = routeExecution(input.provider);
	const safety = safetyPosture(taken.signals, intent);
	let tools = planTools(
		intent,
		intel,
		orchestration.workers[0]?.role ?? 'general',
		taken.signals,
		input.attachments ?? [],
	);
	const optimized = applyEvalHints(strategy, tools, input.evalHints ?? []);
	strategy = optimized.strategy;
	tools = optimized.tools;
	const envelope = createEnvelope({
		id: input.sessionId ? `${input.sessionId}:prep` : 'prep',
		sessionId: input.sessionId ?? 'session',
		conversationId: input.conversationId ?? input.sessionId ?? 'conversation',
		mode: input.mode,
		permissions: capabilities.granted.filter((group): group is 'read' | 'search' | 'edit' | 'shell' | 'web' | 'browser' | 'git' | 'mcp' | 'agents' | 'memory' => group !== 'meta'),
		...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
		...(input.accessMode ? { accessMode: input.accessMode } : {}),
	});
	const drafted = !clarify && intent.lane === 'mission' ? draftMission(envelope.id, intel) : undefined;
	const submitted = drafted ? submitPlan(drafted) : undefined;
	const mission = submitted && !('error' in submitted) ? submitted : drafted;

	const routingRequest: IRoutingRequest = {
		lane: intent.lane,
		mode: input.mode,
		intel,
		...(input.explicitRef ? { explicitRef: input.explicitRef } : {}),
		...(input.needsVision ? { needsVision: true } : {}),
		...(input.estimatedTokens ? { estimatedTokens: input.estimatedTokens } : {}),
	};
	const routing = input.catalog?.length
		? route(routingRequest, input.catalog, input.roles ?? {})
		: undefined;

	return {
		request: taken.request,
		intent,
		signals: taken.signals,
		intel,
		...(clarify ? { clarify } : {}),
		...(usablePlan ? { plan: usablePlan } : {}),
		...(planValidation ? { planValidation } : {}),
		orchestration,
		execution,
		...(routing ? { routing } : {}),
		tools,
		safety,
		envelope,
		environment,
		capabilities,
		strategy,
		...(mission ? { mission } : {}),
		requestKind: requestKindOf(intent, taken.signals, intel, strategy),
		clarification,
		dispatch: intent.lane === 'chat' || clarify ? 'direct' : 'loop',
		...(optimized.forceCompact ? { forceCompact: true } : {}),
		...(optimized.preferEscalate ? { preferEscalate: true } : {}),
	};
}

export function preparedLaneFraming(prepared: IPreparedRun): string {
	const allowWrites = prepared.intent.lane !== 'chat';
	const shaped = framingForShape(prepared.intel.shape, prepared.intent.wantsWeb, { allowWrites });
	const parts = allowWrites
		? [laneDefinition(prepared.intent.lane).framing, ...(shaped ? [shaped] : [])]
		: [shaped ?? laneDefinition(prepared.intent.lane).framing];
	if (prepared.orchestration.mode !== 'single') {
		parts.push(`Orchestration: ${prepared.orchestration.mode} (${prepared.orchestration.reason})`);
	}
	if (prepared.tools.suggested.length) {
		parts.push(`Start with: ${prepared.tools.suggested.join(', ')}.`);
	}
	return parts.join('\n');
}

export { roleFor };
