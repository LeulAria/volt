/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isTerminalPhase, TaskLifecycle, TaskPhase } from './lifecycle.js';

/**
 * Session control plane. Create / resume / pause / cancel / fork / redirect are operations
 * on a registry, not methods scattered across the runtime. The lifecycle machine still owns
 * legal transitions; this layer decides *which* transition an operator action maps to, and
 * keeps the forked/redirected identity so a branch is never confused with its parent.
 */

export type SessionOp = 'create' | 'resume' | 'pause' | 'cancel' | 'fork' | 'redirect';

export interface ISessionRecord {
	readonly sessionId: string;
	readonly conversationId: string;
	readonly parentSessionId?: string;
	readonly forkedFrom?: string;
	readonly redirectedFrom?: string;
	readonly createdAt: number;
}

export interface ISessionOpResult {
	readonly op: SessionOp;
	readonly session: ISessionRecord;
	readonly phase: TaskPhase;
	readonly ok: boolean;
	readonly reason: string;
}

export class SessionManager {

	private readonly records = new Map<string, ISessionRecord>();
	private readonly lives = new Map<string, TaskLifecycle>();

	create(sessionId: string, conversationId: string, now = Date.now()): ISessionOpResult {
		if (this.records.has(sessionId)) {
			return this.result('create', this.records.get(sessionId)!, this.lives.get(sessionId)!, false, 'Session already exists.');
		}
		const record: ISessionRecord = { sessionId, conversationId, createdAt: now };
		const life = new TaskLifecycle(now);
		this.records.set(sessionId, record);
		this.lives.set(sessionId, life);
		return this.result('create', record, life, true, 'Created.');
	}

	get(sessionId: string): ISessionRecord | undefined {
		return this.records.get(sessionId);
	}

	phase(sessionId: string): TaskPhase | undefined {
		return this.lives.get(sessionId)?.current;
	}

	/** Waiting or paused work comes back; a failed run may be retried. */
	resume(sessionId: string, now = Date.now()): ISessionOpResult | undefined {
		const found = this.pair(sessionId);
		if (!found) {
			return undefined;
		}
		try {
			found.life.resume(now);
			return this.result('resume', found.record, found.life, true, 'Resumed.');
		} catch (error) {
			return this.result('resume', found.record, found.life, false, error instanceof Error ? error.message : String(error));
		}
	}

	pause(sessionId: string, now = Date.now()): ISessionOpResult | undefined {
		const found = this.pair(sessionId);
		if (!found) {
			return undefined;
		}
		const snap = found.life.tryTransition('paused', now);
		return this.result('pause', found.record, found.life, !!snap, snap ? 'Paused.' : `Cannot pause from ${found.life.current}.`);
	}

	cancel(sessionId: string, now = Date.now()): ISessionOpResult | undefined {
		const found = this.pair(sessionId);
		if (!found) {
			return undefined;
		}
		if (isTerminalPhase(found.life.current) && found.life.current !== 'failed') {
			return this.result('cancel', found.record, found.life, false, `Already ${found.life.current}.`);
		}
		const snap = found.life.tryTransition('cancelled', now);
		return this.result('cancel', found.record, found.life, !!snap, snap ? 'Cancelled.' : `Cannot cancel from ${found.life.current}.`);
	}

	/**
	 * Branch the conversation. The child starts in `created` with the parent's identity
	 * recorded; it does not inherit the parent's in-flight phase - that would let a paused
	 * parent spawn a child that thinks it is already running.
	 */
	fork(sessionId: string, nextId: string, now = Date.now()): ISessionOpResult | undefined {
		const found = this.pair(sessionId);
		if (!found) {
			return undefined;
		}
		if (this.records.has(nextId)) {
			return this.result('fork', found.record, found.life, false, 'Fork id already exists.');
		}
		const child: ISessionRecord = {
			sessionId: nextId,
			conversationId: found.record.conversationId,
			parentSessionId: sessionId,
			forkedFrom: sessionId,
			createdAt: now,
		};
		const life = new TaskLifecycle(now);
		this.records.set(nextId, child);
		this.lives.set(nextId, life);
		return this.result('fork', child, life, true, `Forked from ${sessionId}.`);
	}

	/**
	 * Steer an in-flight session toward a new request. The session stays; only the phase
	 * moves back to planning so the next send() rebuilds the pipeline against the new text.
	 */
	redirect(sessionId: string, now = Date.now()): ISessionOpResult | undefined {
		const found = this.pair(sessionId);
		if (!found) {
			return undefined;
		}
		if (found.life.current === 'cancelled') {
			return this.result('redirect', found.record, found.life, false, 'Cannot redirect a cancelled session.');
		}
		const snap = found.life.tryTransition('planning', now) ?? (found.life.current === 'planning' ? found.life.snapshot : undefined);
		if (!snap && found.life.current === 'created') {
			found.life.tryTransition('planning', now);
		}
		const ok = found.life.current === 'planning' || found.life.current === 'running' || found.life.current === 'waiting';
		return this.result('redirect', {
			...found.record,
			redirectedFrom: sessionId,
		}, found.life, ok, ok ? 'Redirected; next send rebuilds the plan.' : `Cannot redirect from ${found.life.current}.`);
	}

	mark(sessionId: string, phase: TaskPhase, now = Date.now()): TaskPhase | undefined {
		return this.lives.get(sessionId)?.tryTransition(phase, now)?.phase;
	}

	all(): readonly ISessionRecord[] {
		return [...this.records.values()];
	}

	private pair(sessionId: string): { record: ISessionRecord; life: TaskLifecycle } | undefined {
		const record = this.records.get(sessionId);
		const life = this.lives.get(sessionId);
		return record && life ? { record, life } : undefined;
	}

	private result(op: SessionOp, session: ISessionRecord, life: TaskLifecycle, ok: boolean, reason: string): ISessionOpResult {
		return { op, session, phase: life.current, ok, reason };
	}
}
