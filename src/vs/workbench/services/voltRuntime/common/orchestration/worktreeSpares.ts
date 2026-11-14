/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Worktrees made ahead for worktree subagents, each with a warm agent started in it.
 *
 * A warm agent spare is bound to its folder (an agent's session cannot change folder), so the
 * spares a chat warms in its project folder never fit a subagent that works in a worktree of its
 * own: every such subagent made its worktree and then started its agent cold (ADEMark C1 on the
 * base build: 9 s for the four worktrees, then about 21 s per agent, all on the critical path,
 * while three spares in the project folder went unused). When a chat that is about to delegate
 * asks for worktrees, the worktrees are made first and a spare agent starts in each; a worktree
 * task takes one instead of making its own, and its agent adopts that spare.
 *
 * A spare is a fresh `volt/<id>` checkout at the repository's HEAD with no work of its own. If
 * HEAD moved before it is taken, its branch moves there too and its agent (whose session saw the
 * old commit) is stopped. One not taken within its time to live is removed with its branch.
 */

export interface IWorktreeSpare {
	readonly path: string;
	readonly branch: string;
	/** The commit it was made at (or moved to). */
	readonly commit: string;
}

export interface IWorktreeSpareHost {
	/** A fresh `volt/<id>` checkout of `repoRoot` at its HEAD. */
	create(repoRoot: string): Promise<IWorktreeSpare>;
	/** The commit `repoRoot` has checked out; undefined when git cannot tell. */
	head(repoRoot: string): Promise<string | undefined>;
	/** Moves the spare's branch and checkout to `commit` (it has no work of its own); false on failure. */
	moveTo(spare: IWorktreeSpare, commit: string): Promise<boolean>;
	/** Removes a spare nobody took, and its branch. */
	remove(repoRoot: string, spare: IWorktreeSpare): Promise<void>;
}

/** Starts a warm agent in `spare`; returns what stops it. Called again (a no-op if it is up) on a refill. */
export type WarmWorktreeSpare = (spare: IWorktreeSpare) => () => void;

interface IEntry {
	readonly repoRoot: string;
	made?: IWorktreeSpare;
	ready?: Promise<IWorktreeSpare | undefined>;
	warm: WarmWorktreeSpare;
	stopAgent?: () => void;
	timer?: ReturnType<typeof setTimeout>;
	state: 'waiting' | 'taken' | 'dropped';
}

export class WorktreeSpares {

	/** Per repository, oldest first: spares made or being made that nobody took yet. */
	private readonly entries = new Map<string, IEntry[]>();

	constructor(
		private readonly host: IWorktreeSpareHost,
		private readonly ttlMs: number,
		private readonly onError: (err: unknown) => void = () => undefined,
	) { }

	/** Spares of `repoRoot` made or on their way, not taken. */
	count(repoRoot: string): number {
		return this.list(repoRoot).length;
	}

	/**
	 * Has `count` spares of `repoRoot` made or on their way. Those already there get a new time to
	 * live and their agent is warmed again if it stopped meanwhile (the agent pool's own time to live).
	 */
	fill(repoRoot: string, count: number, warm: WarmWorktreeSpare): void {
		for (const entry of this.list(repoRoot)) {
			entry.warm = warm;
			this.arm(entry);
			if (entry.made) {
				entry.stopAgent = warm(entry.made);
			}
		}
		for (let missing = count - this.list(repoRoot).length; missing > 0; missing--) {
			this.start(repoRoot, warm);
		}
	}

	private start(repoRoot: string, warm: WarmWorktreeSpare): void {
		const entry: IEntry = { repoRoot, warm, state: 'waiting' };
		this.entries.set(repoRoot, [...this.list(repoRoot), entry]);
		this.arm(entry);
		entry.ready = this.host.create(repoRoot).then(async made => {
			entry.made = made;
			if (entry.state === 'dropped') {
				await this.host.remove(repoRoot, made).catch(err => this.onError(err));
				return undefined;
			}
			// Also when it was taken while being made: the subagent's agent adopts this spare.
			entry.stopAgent = entry.warm(made);
			return made;
		}, err => {
			this.forget(entry);
			this.onError(err);
			return undefined;
		});
	}

	/**
	 * Hands over a spare of `repoRoot` at its HEAD now: one already made first, else the oldest
	 * still being made (it is further along than a new worktree would be). Undefined when there is
	 * none, or it could not be made or moved.
	 */
	async take(repoRoot: string): Promise<IWorktreeSpare | undefined> {
		const list = this.list(repoRoot);
		const entry = list.find(candidate => !!candidate.made) ?? list[0];
		if (!entry?.ready) {
			return undefined;
		}
		this.forget(entry);
		entry.state = 'taken';
		const made = await entry.ready;
		if (!made) {
			return undefined;
		}
		const head = await this.host.head(repoRoot);
		if (!head || head === made.commit) {
			return made;
		}
		// The repository moved on since: the spare follows, and its agent (whose session saw the old commit) goes.
		entry.stopAgent?.();
		if (await this.host.moveTo(made, head)) {
			return { ...made, commit: head };
		}
		await this.host.remove(repoRoot, made).catch(err => this.onError(err));
		return undefined;
	}

	/** Removes every spare nobody took. */
	clear(): void {
		for (const entry of [...this.entries.values()].flat()) {
			this.drop(entry);
		}
	}

	private arm(entry: IEntry): void {
		clearTimeout(entry.timer);
		entry.timer = setTimeout(() => this.drop(entry), this.ttlMs);
	}

	private drop(entry: IEntry): void {
		if (entry.state !== 'waiting') {
			return;
		}
		this.forget(entry);
		entry.state = 'dropped';
		entry.stopAgent?.();
		// One still being made is removed by its own creation once it settles.
		if (entry.made) {
			this.host.remove(entry.repoRoot, entry.made).catch(err => this.onError(err));
		}
	}

	private forget(entry: IEntry): void {
		clearTimeout(entry.timer);
		const rest = this.list(entry.repoRoot).filter(candidate => candidate !== entry);
		if (rest.length) {
			this.entries.set(entry.repoRoot, rest);
		} else {
			this.entries.delete(entry.repoRoot);
		}
	}

	private list(repoRoot: string): readonly IEntry[] {
		return this.entries.get(repoRoot) ?? [];
	}
}
