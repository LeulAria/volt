/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltEvent } from '../events.js';
import { IntelligentCache } from './cache.js';
import { compact, needsCompaction, usableTokens } from './contextEngine.js';
import { EvalLedger } from './eval.js';
import { EventStore } from './eventStore.js';
import { FileTracker } from './fileTracker.js';
import { budgetFromLane, ResourceGovernor, tightenBudget } from './governor.js';
import { HarnessAction, HarnessController, IHarnessCapabilities } from './harnessController.js';
import { SteeringInbox } from './inbox.js';
import { RequestSeries } from './requestSeries.js';
import { titleFrom } from './sessionTitle.js';
import { SkillCatalog } from './skills.js';
import { repairTranscript } from './transcriptRepair.js';
import { laneDefinition } from './lanes.js';
import { WorkerLeaseManager } from './lease.js';
import { TaskLifecycle } from './lifecycle.js';
import { MemoryEngine } from './memory.js';
import { ILoopController, ILoopDirective, ILoopStep, INativeLoopMessage } from './nativeLoop.js';
import { Observability } from './observability.js';
import { IPreparedRun } from './pipeline.js';
import { planEntries } from './plan.js';
import { TaskScheduler } from './scheduler.js';
import { SeamRegistry } from './seams.js';
import { SessionManager } from './sessionControl.js';
import { SharedTaskState } from './sharedState.js';
import { StateManager } from './stateManager.js';
import { WorktreeAllocator } from './worktree.js';
import { countWork, IWorkCounts, ToolKind } from './workLog.js';
import { IProjectChecks } from './verification.js';

/**
 * The per-run bag the runtime holds. Pure pieces live here so `voltRuntimeService` only
 * has to stream, authorize, and apply filesystem rollback - not re-assemble the harness
 * on every step.
 */

export interface IRunHarness {
	readonly prepared: IPreparedRun;
	readonly controller: HarnessController;
	readonly lifecycle: TaskLifecycle;
	readonly state: StateManager;
	readonly memory: MemoryEngine;
	readonly cache: IntelligentCache;
	readonly store: EventStore;
	readonly obs: Observability;
	readonly governor: ResourceGovernor;
	readonly leases: WorkerLeaseManager;
	readonly shared: SharedTaskState;
	readonly worktrees: WorktreeAllocator;
	readonly sessions: SessionManager;
	readonly inbox: SteeringInbox;
	readonly evals: EvalLedger;
	readonly scheduler: TaskScheduler;
	readonly seams: SeamRegistry;
	readonly files: FileTracker;
	readonly skills: SkillCatalog;
	readonly series: RequestSeries;
	readonly title: string;
	forceCompact: boolean;
	paused: boolean;
	/** Set by `compactTurn` when a pass actually ran. The runtime emits it once. */
	lastCompaction?: IVoltEvent;
}

export function createRunHarness(prepared: IPreparedRun, checks: IProjectChecks, capabilities: () => IHarnessCapabilities): IRunHarness {
	const lane = laneDefinition(prepared.intent.lane);
	const leases = new WorkerLeaseManager();
	const scheduler = new TaskScheduler(leases);
	scheduler.load(prepared.orchestration, prepared.plan);
	const state = new StateManager();
	state.checkpoint('start', 0);
	const evals = new EvalLedger();
	const sessions = new SessionManager();
	const seams = new SeamRegistry();
	seams.register('eval', evals, 'runtime');
	seams.register('session', sessions, 'runtime');
	return {
		prepared,
		controller: new HarnessController({
			intel: prepared.intel,
			lane: prepared.intent.lane,
			checks,
			...(prepared.plan ? { plan: prepared.plan } : {}),
			readOnly: !lane.groups.includes('edit'),
			capabilities,
			budget: prepared.intent.budget,
			exit: prepared.strategy.exit,
			contingency: prepared.strategy.contingency,
		}),
		lifecycle: new TaskLifecycle(),
		state,
		memory: new MemoryEngine(),
		cache: new IntelligentCache(),
		store: new EventStore(),
		obs: new Observability(),
		governor: new ResourceGovernor(tightenBudget(budgetFromLane(prepared.intent.budget), prepared.strategy.budgets)),
		leases,
		shared: new SharedTaskState(),
		worktrees: new WorktreeAllocator(prepared.environment.cwd ?? '.volt/worktrees', prepared.strategy.policy.isolateWorkers ? 'worktree' : 'workspace'),
		sessions,
		inbox: new SteeringInbox(),
		evals,
		scheduler,
		seams,
		files: new FileTracker(),
		skills: new SkillCatalog(),
		series: new RequestSeries(),
		title: titleFrom(prepared.request.raw),
		forceCompact: !!prepared.forceCompact,
		paused: false,
		lastCompaction: undefined,
	};
}

export interface IHarnessHooks {
	readonly emit: (event: IVoltEvent) => void;
	readonly onAction?: (action: HarnessAction) => void | Promise<void>;
}

export function bindLoopController(harness: IRunHarness, hooks: IHarnessHooks): ILoopController {
	return {
		async afterStep(step: ILoopStep): Promise<ILoopDirective> {
			harness.governor.consume({ steps: 1, tools: step.results.length, tokens: (step.tokens?.input ?? 0) + (step.tokens?.output ?? 0) });
			const result = harness.controller.afterStep(step);
			hooks.emit({ type: 'ooda', phase: result.ooda.phase, cycle: result.ooda.cycle });
			if (result.confidence) {
				hooks.emit({ type: 'confidence', score: result.confidence.score, sufficient: result.confidence.sufficient, reasons: result.confidence.reasons });
			}
			if (result.proof) {
				hooks.emit({ type: 'proof', covered: result.proof.coverage.covered, total: result.proof.coverage.total, ok: result.proof.ok });
			}
			harness.obs.record(
				result.recovery.strategy === 'continue' ? 'decision' : 'recovery',
				result.recovery.strategy,
				result.recovery.strategy === 'continue' || result.directive.kind !== 'stop',
				result.recovery.reason,
			);
			if (result.progress.signals.stateChanged) {
				harness.cache.invalidateAfterMutation();
				if (result.recovery.strategy === 'continue') {
					const point = harness.state.checkpoint(`step-${result.progress.step}`, result.progress.step);
					hooks.emit({ type: 'checkpoint', id: point.id, label: point.label, kind: point.kind });
				}
			}
			if (harness.controller.plan) {
				hooks.emit({ type: 'plan', entries: planEntries(harness.controller.plan) });
			}
			if (result.action) {
				if (result.action === 'reset') {
					harness.forceCompact = true;
					harness.obs.record('recovery', 'reset', true, result.recovery.reason);
				}
				await hooks.onAction?.(result.action);
				hooks.emit({ type: 'decision', title: result.action, detail: result.recovery.reason });
			}
			if (step.wantsToFinish) {
				const snap = harness.lifecycle.tryTransition('verifying');
				if (snap) {
					hooks.emit({ type: 'lifecycle', phase: snap.phase });
				}
			}
			if (result.completion) {
				for (const kind of result.completion.failed) {
					hooks.emit({ type: 'verify', kind, pass: false });
				}
				for (const kind of result.completion.pending) {
					hooks.emit({ type: 'verify', kind, pass: false, detail: 'never run' });
				}
				for (const kind of result.completion.unavailable) {
					hooks.emit({ type: 'verify', kind, pass: false, detail: 'unavailable' });
				}
				if (result.completion.complete) {
					for (const gate of harness.controller.gates) {
						if (gate.status === 'passed' || !result.completion.failed.includes(gate.kind) && !result.completion.pending.includes(gate.kind)) {
							hooks.emit({ type: 'verify', kind: gate.kind, pass: true });
						}
					}
				}
			}
			return result.directive;
		},
	};
}

export function compactTurn(harness: IRunHarness, messages: INativeLoopMessage[], contextWindow = 128_000): INativeLoopMessage[] {
	const lane = laneDefinition(harness.prepared.intent.lane);
	const measured = harness.governor.snapshot().spent.tokens;
	if (!lane.compaction && !harness.forceCompact) {
		return withBudgetNotice(harness, messages);
	}
	const available = usableTokens({ total: contextWindow });
	if (!harness.forceCompact && !needsCompaction(messages, available, measured)) {
		return withBudgetNotice(harness, messages);
	}
	const result = compact(messages, {
		maxTokens: harness.forceCompact ? Math.floor(available * 0.45) : available,
		carryOver: harness.controller.evidence.digest(),
	});
	harness.forceCompact = false;
	if (result.compacted) {
		harness.lastCompaction = { type: 'compaction', stages: result.stages, dropped: result.droppedMessages };
		if (result.summary) {
			harness.memory.remember('session', `compact-${Date.now()}`, result.summary.slice(0, 240), 'compactor');
		}
	}
	const repaired = repairTranscript(result.messages);
	const system = result.messages.find(message => message.role === 'system')?.content ?? '';
	harness.series.observe(`${system.length}`);
	return withBudgetNotice(harness, repaired.messages);
}

export function compactionEvent(harness: IRunHarness): IVoltEvent | undefined {
	const event = harness.lastCompaction;
	harness.lastCompaction = undefined;
	return event;
}

function withBudgetNotice(harness: IRunHarness, messages: INativeLoopMessage[]): INativeLoopMessage[] {
	const notice = budgetNotice(harness);
	if (!notice) {
		return messages;
	}
	const last = messages[messages.length - 1];
	if (last?.role === 'user' && last.content.startsWith('[Budget]')) {
		return messages;
	}
	return [...messages, { role: 'user', content: notice }];
}

function budgetNotice(harness: IRunHarness): string | undefined {
	const snap = harness.governor.snapshot();
	if (snap.used < 0.5) {
		return undefined;
	}
	const bits: string[] = [];
	if (snap.cap.steps < 1e12) {
		bits.push(`${snap.remaining.steps} model steps`);
	}
	if (snap.cap.tools < 1e12) {
		bits.push(`${snap.remaining.tools} tool calls`);
	}
	if (snap.cap.timeMs < 1e12) {
		bits.push(`${Math.ceil(snap.remaining.timeMs / 1000)}s`);
	}
	if (!bits.length) {
		return undefined;
	}
	return `[Budget] ${bits.join(', ')} remain. Prefer finishing verified work over exploring.`;
}

export function workFromHarness(harness: IRunHarness): IWorkCounts {
	const kinds: ToolKind[] = harness.controller.evidence.all().map(item => {
		if (item.tag === 'mutation') {
			return 'edit';
		}
		if (item.tag === 'external') {
			return item.tool.startsWith('browser') ? 'browser' : 'fetch';
		}
		if (item.tool === 'shell') {
			return 'execute';
		}
		if (item.tool === 'grep' || item.tool === 'glob') {
			return 'search';
		}
		return 'read';
	});
	return countWork(kinds, harness.controller.evidence.changedFiles().length);
}
