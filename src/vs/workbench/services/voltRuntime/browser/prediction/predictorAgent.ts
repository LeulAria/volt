/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellation } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltEvent } from '../../common/events.js';
import { predictorPrimer, PredictorTask } from '../../common/prediction/predictorSkill.js';
import { IProviderProfile } from '../../common/profiles.js';
import { IAgentProvider, IAgentSessionHandle } from '../../common/providers.js';

/**
 * Prompts one session answers before a fresh one takes over. The agent re-reads its whole
 * conversation on every turn, so without a cap each request would cost a little more than the last.
 */
const ROTATE_AFTER_PROMPTS = 12;
/** The replacement boots this many prompts early, so the swap never waits for an agent to start. */
const STANDBY_LEAD_PROMPTS = 3;
/** After a session failed to start, requests fail fast for this long instead of each starting one. */
const RETRY_BOOT_MS = 15_000;
/** Teaching a session its skill is one short turn. */
const PRIME_TIMEOUT_MS = 60_000;

/** Two requests that want the session at once: the higher rank goes first; on a tie the newer one wins. */
const TASK_PRIORITY: Readonly<Record<PredictorTask, number>> = {
	'voice': 3,
	'code': 2,
	'writing': 2,
	'composer': 2,
	'next-edit': 1,
};

/** One text-only agent session, started for the predictor. */
export interface IPredictorLaunch {
	readonly provider: IAgentProvider;
	readonly handle: IAgentSessionHandle;
	readonly profile: IProviderProfile;
	/** The agent runs on the skill as its system prompt; otherwise its first prompt teaches it. */
	readonly ownPrompt: boolean;
}

/** Starts a text-only agent session for a catalog ref; throws when the ref cannot serve. */
export type PredictorLauncher = (ref: string) => Promise<IPredictorLaunch>;

interface IPredictorSession {
	readonly launch: IPredictorLaunch;
	prompts: number;
	inflight: number;
	retired: boolean;
}

/** A session on its way up, and what became of it once settled (undefined: it failed). */
interface IBoot {
	readonly ref: string;
	readonly ready: Promise<IPredictorSession | undefined>;
	settled: boolean;
	session?: IPredictorSession;
}

/** The request that has the session. */
interface ITurn {
	readonly priority: number;
	readonly cts: CancellationTokenSource;
	readonly done: Promise<void>;
}

/**
 * The predictor: one agent session over ACP that answers every prediction (Tab, the composer's
 * ghost text, next edits, dictation cleanup) for the agent that serves Tab. It starts with Volt,
 * so no keystroke waits for an agent to boot, and it learns its skill once, so a request is only
 * the task and its context. One request runs at a time: a newer one of the same or a higher rank
 * replaces the running one, a lower one waits for it.
 */
export class PredictorAgent extends Disposable {

	private ref: string | undefined;
	private active: IBoot | undefined;
	private standby: IBoot | undefined;
	private failedAt = 0;
	private turn: ITurn | undefined;
	private tickets = 0;
	/** The newest request: a waiting older one of no higher rank gives way to it. */
	private newest: { readonly ticket: number; readonly priority: number } | undefined;
	private disposed = false;

	constructor(
		private readonly launcher: PredictorLauncher,
		private readonly logService: ILogService,
	) {
		super();
	}

	/** Starts the predictor for `ref` unless it runs already, or stops it when `ref` is undefined. */
	warm(ref: string | undefined): void {
		if (this.disposed) {
			return;
		}
		if (ref !== this.ref) {
			this.stop();
			this.ref = ref;
			this.failedAt = 0;
		}
		if (ref && !this.active && Date.now() - this.failedAt >= RETRY_BOOT_MS) {
			this.active = this.boot(ref);
		}
	}

	/**
	 * Streams the answer to one request. Throws {@link CancellationError} when a newer request took
	 * the session, so a cut-off reply is never mistaken for the whole answer.
	 */
	async *ask(ref: string, task: PredictorTask, text: string, token: CancellationToken): AsyncIterable<IVoltEvent> {
		this.warm(ref);
		const ticket = ++this.tickets;
		const priority = TASK_PRIORITY[task];
		this.newest = { ticket, priority };
		for (let running = this.turn; running; running = this.turn) {
			if (priority >= running.priority) {
				running.cts.cancel();
				break;
			}
			await raceCancellation(running.done, token);
			if (token.isCancellationRequested) {
				return;
			}
			if (this.newest.ticket !== ticket && this.newest.priority >= priority) {
				throw new CancellationError();
			}
		}

		// Taken before the first await, so a request arriving meanwhile sees this one.
		const cts = new CancellationTokenSource(token);
		let finish = () => { };
		const turn: ITurn = { priority, cts, done: new Promise<void>(resolve => finish = resolve) };
		this.turn = turn;
		try {
			const session = await raceCancellation(this.session(ref), cts.token);
			if (!cts.token.isCancellationRequested) {
				if (!session) {
					yield { type: 'error', message: 'The prediction agent could not start. Check the agent in Volt Settings.' };
					return;
				}
				yield* this.send(session, text, cts.token);
			}
			if (cts.token.isCancellationRequested && !token.isCancellationRequested) {
				throw new CancellationError();
			}
		} finally {
			if (this.turn === turn) {
				this.turn = undefined;
			}
			cts.dispose();
			finish();
		}
	}

	private async *send(session: IPredictorSession, text: string, token: CancellationToken): AsyncIterable<IVoltEvent> {
		session.prompts++;
		session.inflight++;
		this.prepareStandby(session);
		try {
			yield* session.launch.provider.send(session.launch.handle, { text, mode: 'ask' }, session.launch.profile, token);
		} finally {
			session.inflight--;
			if (session.retired && !session.inflight) {
				this.release(session);
			}
		}
	}

	/** The session for `ref`: the active one, replaced by its standby once that is due and ready. */
	private session(ref: string): Promise<IPredictorSession | undefined> {
		const current = this.active?.session;
		const standby = this.standby;
		if (current && standby?.settled && current.prompts >= ROTATE_AFTER_PROMPTS) {
			this.standby = undefined;
			if (standby.session && isLive(standby.session)) {
				this.retire(current);
				this.active = standby;
			}
		}
		const active = this.active;
		if (active?.settled && (!active.session || !isLive(active.session))) {
			// It failed to start, or its process went away: start another (unless it just failed).
			if (active.session) {
				this.retire(active.session);
			}
			this.active = undefined;
			this.warm(ref);
		}
		return this.active?.ready ?? Promise.resolve(undefined);
	}

	/** Boots the next session while the active one still has a few prompts left. */
	private prepareStandby(session: IPredictorSession): void {
		if (this.standby || !this.ref || session !== this.active?.session || session.prompts < ROTATE_AFTER_PROMPTS - STANDBY_LEAD_PROMPTS || Date.now() - this.failedAt < RETRY_BOOT_MS) {
			return;
		}
		this.standby = this.boot(this.ref);
	}

	private boot(ref: string): IBoot {
		const boot: IBoot = { ref, ready: this.start(ref), settled: false };
		void boot.ready.then(session => {
			boot.settled = true;
			boot.session = session;
		});
		return boot;
	}

	private async start(ref: string): Promise<IPredictorSession | undefined> {
		const started = Date.now();
		let session: IPredictorSession | undefined;
		try {
			session = { launch: await this.launcher(ref), prompts: 0, inflight: 0, retired: false };
			if (!session.launch.ownPrompt) {
				await this.prime(session);
			}
		} catch (err) {
			if (session) {
				this.retire(session);
			}
			this.failedAt = Date.now();
			this.logService.warn(`[volt predictor] ${ref} could not start: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
		if (this.ref !== ref || this.disposed) {
			this.retire(session);
			return undefined;
		}
		this.logService.info(`[volt predictor] ${ref} ready in ${Date.now() - started}ms, skill ${session.launch.ownPrompt ? 'as its system prompt' : 'as its first prompt'}`);
		return session;
	}

	/** Teaches a session whose agent takes no system prompt its skill, before any request reaches it. */
	private async prime(session: IPredictorSession): Promise<void> {
		const cts = new CancellationTokenSource();
		const timer = setTimeout(() => cts.cancel(), PRIME_TIMEOUT_MS);
		try {
			for await (const event of session.launch.provider.send(session.launch.handle, { text: predictorPrimer(), mode: 'ask' }, session.launch.profile, cts.token)) {
				if (event.type === 'error') {
					throw new Error(event.message);
				}
			}
			if (cts.token.isCancellationRequested) {
				throw new Error('the agent did not take its instructions in time');
			}
		} finally {
			clearTimeout(timer);
			cts.dispose();
		}
	}

	/** Takes a session out of use; it stops once its last request has answered. */
	private retire(session: IPredictorSession): void {
		if (session.retired) {
			return;
		}
		session.retired = true;
		if (!session.inflight) {
			this.release(session);
		}
	}

	private release(session: IPredictorSession): void {
		void session.launch.provider.dispose(session.launch.handle).catch(() => undefined);
	}

	private stop(): void {
		for (const boot of [this.active, this.standby]) {
			void boot?.ready.then(session => session && this.retire(session));
		}
		this.active = undefined;
		this.standby = undefined;
		this.turn?.cts.cancel();
	}

	override dispose(): void {
		this.disposed = true;
		this.stop();
		super.dispose();
	}
}

function isLive(session: IPredictorSession): boolean {
	return session.launch.provider.isLive?.(session.launch.handle) ?? true;
}
