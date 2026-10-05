/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildTaskPrompt } from '../../../common/orchestration/agentTasks.js';
import { DEFAULT_ORCH_LIMITS, emptyOrchState, IOrchEventEnvelope, IOrchLimits, IOrchPrompt, IOrchState, IOrchTaskSpawn, OrchCommandBody, OrchDelivery, OrchEffect, OrchOutcome } from '../../../common/orchestration/orchestrator.js';
import { IOrchDecision, runOrchCommand } from '../../../common/orchestration/orchestratorDecider.js';

/**
 * A deterministic driver for the pure orchestrator: a fake clock, generated command ids, and a
 * record of every envelope and effect, so tests read like the conversation they model.
 */
export class OrchSim {

	state: IOrchState = emptyOrchState();
	now = 1_000;
	readonly log: IOrchEventEnvelope[] = [];
	readonly effects: OrchEffect[] = [];
	private commandCounter = 0;
	private idCounter = 0;

	constructor(readonly limits: IOrchLimits = DEFAULT_ORCH_LIMITS) { }

	run(body: OrchCommandBody, id = `c${++this.commandCounter}`): IOrchDecision {
		this.now += 10;
		const step = runOrchCommand(this.state, { ...body, id, at: this.now }, this.limits);
		this.state = step.state;
		this.log.push(...step.envelopes);
		this.effects.push(...step.effects);
		return step.decision;
	}

	nextId(prefix: string): string {
		return `${prefix}${++this.idCounter}`;
	}

	/** Effects of kind `kind` produced since index `from`. */
	effectsOf<K extends OrchEffect['kind']>(kind: K, from = 0): Extract<OrchEffect, { kind: K }>[] {
		return this.effects.slice(from).filter((effect): effect is Extract<OrchEffect, { kind: K }> => effect.kind === kind);
	}

	submit(threadId: string, text: string, delivery: OrchDelivery = 'auto', canSteer = false, turnId = this.nextId('turn')): { turnId: string; decision: IOrchDecision } {
		const decision = this.run({ type: 'thread.submit', threadId, turnId, prompt: prompt(text), delivery, canSteer });
		return { turnId, decision };
	}

	/** The runtime picked up the active turn of `threadId`. Returns the run id. */
	start(threadId: string, runId = this.nextId('run')): string {
		this.run({ type: 'run.started', threadId, runId, turnId: this.state.threads[threadId]?.active?.id });
		return runId;
	}

	settle(threadId: string, outcome: OrchOutcome = 'done', reply?: string, error?: string): void {
		const active = this.state.threads[threadId]?.active;
		this.run({ type: 'run.settled', threadId, runId: active?.runId, turnId: active?.id, outcome, ...(reply !== undefined ? { reply } : {}), ...(error ? { error } : {}) });
	}

	/** Start and finish whatever the thread is running. */
	complete(threadId: string, outcome: OrchOutcome = 'done', reply = 'ok'): void {
		const active = this.state.threads[threadId]?.active;
		if (!active) {
			throw new Error(`${threadId} has no active turn`);
		}
		if (!active.runId) {
			this.start(threadId);
		}
		this.settle(threadId, outcome, reply);
	}

	spawn(parentId: string, brief: string, extra: Partial<IOrchTaskSpawn> = {}): IOrchDecision {
		const taskId = extra.taskId ?? this.nextId('t-');
		const spawn: IOrchTaskSpawn = {
			parentId,
			brief,
			title: extra.title ?? brief.slice(0, 20),
			role: extra.role ?? 'general',
			origin: extra.origin ?? 'agent',
			isolation: extra.isolation ?? 'shared',
			taskId,
			childId: extra.childId ?? `child-${taskId}`,
			childPrompt: extra.childPrompt ?? prompt(buildTaskPrompt(brief, { role: extra.role ?? 'general', depth: 1, isolation: extra.isolation ?? 'shared' })),
			...(extra.modelRef ? { modelRef: extra.modelRef } : {}),
			...(extra.modelLabel ? { modelLabel: extra.modelLabel } : {}),
			...(extra.clientRequestId ? { clientRequestId: extra.clientRequestId } : {}),
			...(extra.toolCallId ? { toolCallId: extra.toolCallId } : {}),
			...(extra.scope ? { scope: extra.scope } : {}),
		};
		return this.run({ type: 'task.spawn', spawn });
	}

	/** Reads that TypeScript does not narrow across commands (assertions on `sim.state.x` would). */
	thread(id: string) {
		return this.state.threads[id];
	}

	conflicts(rootId: string) {
		return this.state.conflicts[rootId];
	}

	childOf(taskId: string): string {
		const childId = this.state.tasks[taskId]?.childId;
		if (!childId) {
			throw new Error(`no child for ${taskId}`);
		}
		return childId;
	}
}

export function prompt(text: string, extra: Partial<IOrchPrompt> = {}): IOrchPrompt {
	return { text, ...extra };
}

/** Mulberry32: small, fast, seedable. */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
