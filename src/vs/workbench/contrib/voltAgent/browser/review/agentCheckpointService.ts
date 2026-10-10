/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler, raceTimeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isEqualOrParent, joinPath, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileChangesEvent, IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVoltGitDiffEntry, IVoltGitRestoreEntry, IVoltGitRestoreStep, IVoltGitService, IVoltGitSnapshot, IVoltGitSnapshotRepo, VOLT_SNAPSHOT_REF_PREFIX, VoltGitRestoreOutcome } from '../../../../../platform/voltGit/common/voltGit.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IVoltEventEnvelope } from '../../../../services/voltRuntime/common/events.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IVoltSessionContextService } from '../../../../services/voltRuntime/common/sessionContext.js';
import { setTurnWriteGate } from '../../../../services/voltRuntime/common/turnWriteGate.js';
import { ITextFileService, TextFileEditorModelState } from '../../../../services/textfile/common/textfiles.js';
import { IAgentEditsService } from './agentEditsService.js';

export const IAgentCheckpointService = createDecorator<IAgentCheckpointService>('voltAgentCheckpoints');

/** Command ids for the transcript UI. Args and results are documented on each registration in agentChangesActions.ts. */
export const CHECKPOINT_BEGIN_TURN_COMMAND_ID = 'voltAgent.checkpoint.beginTurn';
export const CHECKPOINT_RESTORE_COMMAND_ID = 'voltAgent.checkpoint.restore';
export const CHECKPOINT_HAS_CHANGES_COMMAND_ID = 'voltAgent.checkpoint.hasChangesSince';
export const CHECKPOINT_PREVIEW_COMMAND_ID = 'voltAgent.checkpoint.preview';
export const CHECKPOINT_REDO_COMMAND_ID = 'voltAgent.checkpoint.redo';

/**
 * A user turn: the transcript's turn id (`IAgentUserMessage.id`, known once the UI called
 * {@link IAgentCheckpointService.beginTurn}), the runtime run id, or the 0-based index of the
 * user message (the count `truncateSession` takes).
 */
export type AgentTurnRef = string | number;

export interface IAgentCheckpoint {
	readonly sessionId: string;
	readonly turnId: string;
	/** 0-based index of the user message that started the turn. */
	readonly userTurn: number;
	/** The project before the turn ran. */
	readonly before: string;
	/** The project after the agent's latest change in the turn; undefined when it changed nothing. */
	readonly after?: string;
	readonly running: boolean;
}

export interface IAgentRestoreFile {
	readonly uri: URI;
	/** Repo-relative. */
	readonly path: string;
	readonly action: IVoltGitRestoreEntry['action'];
	readonly outcome: VoltGitRestoreOutcome;
	readonly binary: boolean;
	/** The file changed after the agent's last write (by the user or another chat). */
	readonly editedSince: boolean;
}

export interface IAgentRestorePreview {
	readonly checkpoint: IAgentCheckpoint;
	/** Every file the agent changed since the checkpoint; `action: 'none'` ones already match. */
	readonly files: readonly IAgentRestoreFile[];
	/** Files that can't be restored without discarding later edits. */
	readonly conflicts: readonly IAgentRestoreFile[];
}

export interface IAgentRestoreResult extends IAgentRestorePreview {
	readonly applied: boolean;
	/** {@link IAgentCheckpointService.redo} can put the files back. */
	readonly canRedo: boolean;
}

/** A file a chat's agent changed, from its snapshots: tool edits, shell side effects, renames and binaries alike. */
export interface IAgentSnapshotChange {
	readonly uri: URI;
	readonly path: string;
	readonly oldPath?: string;
	readonly oldUri?: URI;
	readonly kind: 'added' | 'modified' | 'deleted' | 'renamed';
	readonly binary: boolean;
	readonly additions: number;
	readonly deletions: number;
	readonly repoRoot: string;
	readonly oldBlob?: string;
	readonly newBlob?: string;
	readonly turnId: string;
}

export interface IAgentBeginTurnOptions {
	/**
	 * Every change the turn makes to the files waits on the chat's turn write gate (Volt's own loop;
	 * an ACP agent that asks before it edits or runs commands). The snapshot then becomes that gate
	 * and {@link IAgentCheckpointService.beginTurn} resolves at once: the prompt goes out without waiting.
	 */
	readonly writesGated?: boolean;
}

export interface IAgentCheckpointService {
	readonly _serviceBrand: undefined;
	/** Fires with the session id when its checkpoints or redo state change. */
	readonly onDidChange: Event<string>;
	/**
	 * Call right before sending a prompt: snapshots the project under `turnId` so the checkpoint
	 * predates anything the agent does. Resolves when the snapshot is taken (at most ~2 s), or at
	 * once when nothing changed since the last turn's after-snapshot (which is then reused) or when
	 * `options.writesGated`. Without it the snapshot is taken at the run's start and keyed by the run id.
	 */
	beginTurn(sessionId: string, turnId: string, options?: IAgentBeginTurnOptions): Promise<void>;
	/** Loaded checkpoints, oldest first (empty until {@link loadCheckpoints} or the first run). */
	getCheckpoints(sessionId: string): readonly IAgentCheckpoint[];
	loadCheckpoints(sessionId: string): Promise<readonly IAgentCheckpoint[]>;
	/** What restoring to before `turn` would do, without writing anything. */
	previewRestore(sessionId: string, turn: AgentTurnRef): Promise<IAgentRestorePreview | undefined>;
	/**
	 * Puts every file the agent changed in `turn` and later turns of this chat back as it was
	 * before `turn` ran: edits, created and deleted files, and shell side effects. Edits made
	 * after the agent are kept where they merge; overlapping ones are left alone unless
	 * `overwrite`. The project is snapshotted first, so {@link redo} undoes the restore.
	 * Refuses (throws) while the chat's agent is running.
	 */
	restoreCheckpoint(sessionId: string, turn: AgentTurnRef, options?: { readonly overwrite?: boolean }): Promise<IAgentRestoreResult | undefined>;
	canRedo(sessionId: string): boolean;
	/** Undoes the latest restore of this chat (Cursor's "Redo checkpoint"), keeping edits made since where they merge. */
	redo(sessionId: string, options?: { readonly overwrite?: boolean }): Promise<IAgentRestoreResult | undefined>;
	/**
	 * Discard for one file: back to before this chat's agent first changed it. `unavailable` when
	 * no snapshot of this chat covers the file.
	 */
	restoreFile(sessionId: string, uri: URI, options?: { readonly overwrite?: boolean }): Promise<VoltGitRestoreOutcome | 'unavailable'>;
	/** What the agent changed: over the whole chat, in its latest turn that changed anything, or in one turn. */
	getChanges(sessionId: string, scope: 'session' | 'lastTurn' | { readonly turnId: string }): Promise<readonly IAgentSnapshotChange[]>;
	/** Drops a chat's snapshots (when the chat is deleted). */
	deleteCheckpoints(sessionId: string): Promise<void>;
}

/** Wait for a mutating tool batch to settle before snapshotting it. */
const BATCH_DELAY_MS = 400;
/** How long `beginTurn` holds up a send. */
const BEGIN_TURN_WAIT_MS = 2_000;
/** A `beginTurn` snapshot older than this is not adopted by a run. */
const BEGIN_TURN_TTL_MS = 60_000;
/** Checkpoints kept per chat; older turns' refs are dropped so git can reclaim them. */
const MAX_TURNS = 200;
/** Tool kinds that never change files. */
const READ_ONLY_KINDS = new Set(['read', 'search', 'think', 'fetch', 'browser']);

interface ITurn {
	readonly turnId: string;
	readonly userTurn: number;
	readonly runId?: string;
	readonly key: string;
	before: IVoltGitSnapshot | undefined;
	after: IVoltGitSnapshot | undefined;
	running: boolean;
	readonly startedAt: number;
	/** Paths whose snapshot changes were already handed to review (or seen resolved). */
	readonly handled: Set<string>;
}

interface ISession {
	readonly sessionId: string;
	repo: IVoltGitSnapshotRepo | undefined;
	/** The folder as Volt names it (it may reach the repo through a symlink). */
	folder: URI | undefined;
	turns: ITurn[];
	loaded: Promise<void> | undefined;
	redo: IVoltGitRestoreStep | undefined;
	/** Snapshots and restores of one chat run one after another. */
	chain: Promise<unknown>;
	/** Offering snapshot changes for review, in order but off {@link chain}: the next checkpoint never waits on it. */
	captures: Promise<void>;
	/** `reused`: the last turn's after-snapshot, taken over with no git work (nothing to publish or clean up). */
	pendingBegin: { readonly turnId: string; readonly at: number; readonly root: string | undefined; readonly snapshot: Promise<IVoltGitSnapshot | undefined>; readonly reused?: boolean } | undefined;
	/**
	 * The project as the chat's last finished turn left it: its final snapshot, the folder it is of,
	 * and the change generation of the work tree when that snapshot started reading it.
	 */
	settled: { readonly snapshot: IVoltGitSnapshot; readonly folder: string; readonly generation: number } | undefined;
	/** Runs of this chat between `run.start` and `run.end`. */
	readonly activeRuns: Set<string>;
	/** Mutating tool calls still running in the current turn. */
	readonly inFlight: Set<string>;
	readonly batch: RunOnceScheduler;
	/** Files the user kept or undid during the current turn: not re-offered from snapshots. Replaced, not cleared, per turn. */
	resolved: ResourceMap<true>;
}

export class AgentCheckpointService extends Disposable implements IAgentCheckpointService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange = this._onDidChange.event;

	private readonly sessions = new Map<string, ISession>();
	private readonly schedulers = this._register(new DisposableMap<string, RunOnceScheduler>());
	private readonly repos = new Map<string, Promise<IVoltGitSnapshotRepo | undefined>>();
	/** When the user last saved each file from an editor. */
	private readonly userSaves = new ResourceMap<number>();
	private readonly diffCache = new Map<string, Promise<IVoltGitDiffEntry[]>>();
	/**
	 * Per snapshot work tree (fs path): bumped on anything that may have changed a file in it (a file
	 * event, a save, an agent's tool or file change in any chat, a restore). An after-snapshot is
	 * only reused as the next checkpoint while its generation is still current.
	 */
	private readonly generations = new Map<string, number>();

	constructor(
		@IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
		@IVoltGitService private readonly git: IVoltGitService,
		@IAgentEditsService private readonly edits: IAgentEditsService,
		@IVoltSessionContextService private readonly sessionContext: IVoltSessionContextService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@ILogService private readonly logService: ILogService,
		@IFileService fileService: IFileService,
	) {
		super();
		this._register(runtime.onDidEmit(envelope => this.onEvent(envelope)));
		this._register(textFileService.files.onDidSave(e => {
			this.userSaves.set(e.model.resource, Date.now());
			this.bumpGenerations(workTree => isEqualOrParent(e.model.resource, URI.file(workTree)));
		}));
		this._register(fileService.onDidFilesChange(e => this.onFilesChange(e)));
		this._register(edits.onDidResolve(e => this.sessions.get(e.sessionId)?.resolved.set(e.uri, true)));
	}

	// --- turn tracking

	beginTurn(sessionId: string, turnId: string, options?: IAgentBeginTurnOptions): Promise<void> {
		const session = this.session(sessionId);
		const root = this.rootFor(sessionId)?.toString();
		// A run of this chat still winding down may change files yet: no after-snapshot stands for the project.
		const mayReuse = !session.activeRuns.size;
		const reused = mayReuse ? this.reusableSnapshot(session, root) : undefined;
		if (reused) {
			// Nothing changed since the last turn's after-snapshot: it is this turn's checkpoint, at no cost.
			session.pendingBegin = { turnId, at: Date.now(), root, snapshot: Promise.resolve(reused), reused: true };
			return Promise.resolve();
		}
		const snapshot = this.enqueue(session, async () => {
			const repo = await this.ensureRepo(session);
			if (!repo) {
				return undefined;
			}
			// The last turn's after-snapshot may have landed while this waited behind it.
			return (mayReuse ? this.reusableSnapshot(session, root) : undefined)
				?? this.snapshot(repo, `${this.prefix(sessionId)}pending/pre`, `volt: before turn ${turnId}`, this.settledSnapshot(session));
		});
		session.pendingBegin = { turnId, at: Date.now(), root, snapshot };
		if (options?.writesGated) {
			// The prompt goes out now; the agent's first write waits for the snapshot instead.
			setTurnWriteGate(sessionId, snapshot);
			return Promise.resolve();
		}
		return raceTimeout(snapshot.then(() => undefined), BEGIN_TURN_WAIT_MS).then(() => undefined);
	}

	/**
	 * The last turn's after-snapshot, when it still is the project: taken in this folder, no file
	 * event, save, agent change or restore since it began reading the tree, the folder is one the
	 * workbench watches (else changes go unseen), no other chat's agent is running in it and no
	 * editor is mid-save. Any doubt means a fresh snapshot.
	 */
	private reusableSnapshot(session: ISession, root: string | undefined): IVoltGitSnapshot | undefined {
		const settled = session.settled;
		const repo = session.repo;
		if (!settled || !repo || !root || settled.folder !== root || session.folder?.toString() !== root) {
			return undefined;
		}
		if (this.generation(repo.workTree) !== settled.generation || !this.isWatched(repo.workTree)) {
			return undefined;
		}
		for (const other of this.sessions.values()) {
			if (other !== session && other.repo?.workTree === repo.workTree && other.activeRuns.size) {
				return undefined;
			}
		}
		const workTree = URI.file(repo.workTree);
		if (this.textFileService.files.models.some(model => model.hasState(TextFileEditorModelState.PENDING_SAVE) && isEqualOrParent(model.resource, workTree))) {
			return undefined;
		}
		return settled.snapshot;
	}

	/** The last after-snapshot of this folder, for a snapshot to return as is when the tree is unchanged. */
	private settledSnapshot(session: ISession): IVoltGitSnapshot | undefined {
		const settled = session.settled;
		return settled && settled.folder === session.folder?.toString() ? settled.snapshot : undefined;
	}

	/** Whether the workbench's file watcher covers `workTree` (a workspace folder is it, or holds it). */
	private isWatched(workTree: string): boolean {
		const resource = URI.file(workTree);
		return this.workspace.getWorkspace().folders.some(folder => folder.uri.scheme === Schemas.file && isEqualOrParent(resource, folder.uri));
	}

	private generation(workTree: string): number {
		let generation = this.generations.get(workTree);
		if (generation === undefined) {
			// Tracked from now on: later changes in this tree bump it.
			generation = 0;
			this.generations.set(workTree, generation);
		}
		return generation;
	}

	private bumpGenerations(affects: (workTree: string) => boolean = () => true): void {
		for (const [workTree, generation] of this.generations) {
			if (affects(workTree)) {
				this.generations.set(workTree, generation + 1);
			}
		}
	}

	/** A file event in a tracked work tree, outside its git folders (snapshots write there themselves), changes its generation. */
	private onFilesChange(e: FileChangesEvent): void {
		for (const [workTree, generation] of this.generations) {
			const root = URI.file(workTree);
			if (!e.affects(root)) {
				continue;
			}
			const inTree = (resource: URI) => {
				const path = isEqualOrParent(resource, root) ? relativePath(root, resource) : undefined;
				return path !== undefined && !path.split('/').includes('.git');
			};
			if (e.rawAdded.some(inTree) || e.rawUpdated.some(inTree) || e.rawDeleted.some(inTree)) {
				this.generations.set(workTree, generation + 1);
			}
		}
	}

	private onEvent(envelope: IVoltEventEnvelope): void {
		const event = envelope.event;
		switch (event.type) {
			case 'run.start': {
				// One run per chat: a new one supersedes any that never reported its end.
				const runs = this.session(envelope.sessionId).activeRuns;
				runs.clear();
				runs.add(event.runId);
				this.startTurn(envelope.sessionId, event.runId);
				break;
			}
			case 'tool.start':
				if (!event.kind || !READ_ONLY_KINDS.has(event.kind)) {
					this.sessions.get(envelope.sessionId)?.inFlight.add(event.callId);
					// Any chat's agent may be about to change files in a tree another chat would reuse a snapshot of.
					this.bumpGenerations();
				}
				break;
			case 'tool.end': {
				const session = this.sessions.get(envelope.sessionId);
				if (session && (session.inFlight.delete(event.callId) || event.diffs?.length || event.card === 'terminal' || event.card === 'diff') && !session.inFlight.size) {
					session.batch.schedule();
				}
				this.bumpGenerations();
				break;
			}
			case 'file.change':
				this.sessions.get(envelope.sessionId)?.batch.schedule();
				this.bumpGenerations();
				break;
			case 'run.end':
				this.sessions.get(envelope.sessionId)?.activeRuns.delete(event.runId);
				this.endTurn(envelope.sessionId, event.runId);
				break;
		}
	}

	private startTurn(sessionId: string, runId: string): void {
		const session = this.session(sessionId);
		const users = this.runtime.getOrCreateSession(sessionId).messages.filter(message => message.role === 'user' && !(message as { steer?: boolean }).steer);
		const userTurn = Math.max(0, users.length - 1);
		const begin = session.pendingBegin && Date.now() - session.pendingBegin.at < BEGIN_TURN_TTL_MS ? session.pendingBegin : undefined;
		session.pendingBegin = undefined;
		const turnId = begin?.turnId ?? runId;
		const turn: ITurn = { turnId, userTurn, runId, key: turnKey(userTurn, turnId), before: undefined, after: undefined, running: true, startedAt: Date.now(), handled: new Set() };
		session.inFlight.clear();
		// A new map: the last turn's review offers, which may still be queued, keep reading its own.
		session.resolved = new ResourceMap();
		void this.enqueue(session, async () => {
			await this.load(session);
			const repo = await this.ensureRepo(session);
			if (!repo) {
				return;
			}
			// Turns at or after this index belong to history the user rewrote.
			const abandoned = session.turns.filter(other => other.userTurn >= userTurn && other !== turn);
			session.turns = session.turns.filter(other => !abandoned.includes(other));
			session.turns.push(turn);
			const pre = `${this.prefix(sessionId)}${turn.key}/pre`;
			// A first send into a new worktree moves the chat after beginTurn snapshotted the old folder.
			const early = begin && begin.root === session.folder?.toString() ? await begin.snapshot : undefined;
			if (early) {
				await this.git.updateRef({ repoRoot: repo.repoRoot, ref: pre, commit: early.commit });
				if (!begin?.reused) {
					await this.git.updateRef({ repoRoot: repo.repoRoot, ref: `${this.prefix(sessionId)}pending/pre` });
				}
				turn.before = early;
			} else {
				const settled = this.settledSnapshot(session);
				turn.before = await this.snapshot(repo, pre, `volt: before turn ${turnId}`, settled);
				if (settled && turn.before.commit === settled.commit) {
					// An unchanged tree comes back as the earlier snapshot without its ref written.
					await this.git.updateRef({ repoRoot: repo.repoRoot, ref: pre, commit: settled.commit });
				}
			}
			await this.dropTurns(session, repo, [...abandoned, ...session.turns.slice(0, Math.max(0, session.turns.length - MAX_TURNS))]);
			this._onDidChange.fire(sessionId);
		});
	}

	private endTurn(sessionId: string, runId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}
		session.batch.cancel();
		session.inFlight.clear();
		// The final snapshot below stands for the project again once it lands.
		session.settled = undefined;
		// Looked up after the queued work: the turn is recorded once its first snapshot lands.
		void this.snapshotAfter(session, true).finally(() => {
			const turn = session.turns.find(candidate => candidate.runId === runId);
			if (turn) {
				turn.running = false;
			}
			this._onDidChange.fire(sessionId);
		});
	}

	/** After a batch of mutating tools (or at the end of the turn): snapshot, then offer new changes for review. */
	private snapshotAfter(session: ISession, final: boolean): Promise<void> {
		// This turn's decisions, even if the review offers run after the next turn started.
		const resolved = session.resolved;
		return this.enqueue(session, async () => {
			const turn = session.turns.at(-1);
			const repo = session.repo;
			if (!turn?.running || !turn.before || !repo) {
				return;
			}
			// Read before the scan: a change the scan may have missed bumps it past this.
			const generation = this.generation(repo.workTree);
			const previous = turn.after ?? turn.before;
			const after = await this.git.snapshot({
				repoRoot: repo.repoRoot,
				workTree: repo.workTree,
				indexFile: repo.indexFile,
				parent: previous.commit,
				ref: `${this.prefix(session.sessionId)}${turn.key}/post`,
				message: `volt: after turn ${turn.turnId}`,
				reuse: previous,
			}).catch(err => {
				this.logService.warn('[volt] checkpoint snapshot failed', err);
				return undefined;
			});
			if (after && final && session.repo === repo && session.folder) {
				// What the turn left: the next turn's checkpoint, for as long as nothing changes.
				session.settled = { snapshot: after, folder: session.folder.toString(), generation };
			}
			if (!after || after.commit === turn.before.commit) {
				return;
			}
			turn.after = after;
			// Off the snapshot queue: reading the changed files can take a while, and the next turn's
			// checkpoint must not wait for it. Offers still run in order, each for its own snapshot.
			const before = turn.before;
			session.captures = session.captures
				.then(() => this.capture(session, repo, turn, before, after, final, resolved))
				.catch(err => this.logService.warn('[volt] capturing snapshot changes failed', err));
		});
	}

	/**
	 * Offers what the turn changed between two of its snapshots that no edit tool reported (shell
	 * commands, agents writing files themselves, renames, binaries) for Keep/Undo, with the
	 * pre-turn text as the baseline. `resolved` holds the files the user settled during the turn.
	 */
	private async capture(session: ISession, repo: IVoltGitSnapshotRepo, turn: ITurn, before: IVoltGitSnapshot, after: IVoltGitSnapshot, final: boolean, resolved: ResourceMap<true>): Promise<void> {
		const entries = await this.git.diffSummary({ repoRoot: repo.repoRoot, from: before.commit, to: after.commit });
		const sessionId = session.sessionId;
		const offer = (path: string): URI | undefined => {
			const uri = this.toUri(session, path);
			if (turn.handled.has(path)) {
				return undefined;
			}
			turn.handled.add(path);
			const saved = this.userSaves.get(uri);
			// Already in review (any chat), settled by the user this turn, or the user's own save.
			if (this.edits.getPendingFile(uri) || resolved.has(uri) || (saved !== undefined && saved >= turn.startedAt)) {
				return undefined;
			}
			return uri;
		};
		const text = async (blob: string | undefined, path: string) => blob ? (await this.git.readBlob({ repoRoot: repo.repoRoot, sha: blob, path })).toString() : undefined;
		for (const entry of entries) {
			const oldPath = entry.oldPath ?? entry.path;
			if (entry.kind === 'renamed') {
				const oldUri = offer(oldPath);
				if (oldUri) {
					this.recordChange(sessionId, repo, oldUri, oldPath, entry.binary, entry.oldBlob, await (entry.binary ? undefined : text(entry.oldBlob, oldPath)));
				}
			}
			const uri = offer(entry.path);
			if (!uri) {
				continue;
			}
			const created = entry.kind === 'added' || entry.kind === 'renamed';
			const before = created || entry.binary ? undefined : await text(entry.oldBlob, oldPath);
			const agentText = final && !entry.binary ? await text(entry.newBlob, entry.path) : undefined;
			this.recordChange(sessionId, repo, uri, oldPath, entry.binary, created ? undefined : entry.oldBlob, before, agentText, entry.kind === 'renamed' ? this.toUri(session, oldPath) : undefined);
		}
	}

	private recordChange(sessionId: string, repo: IVoltGitSnapshotRepo, uri: URI, oldPath: string, binary: boolean, oldBlob: string | undefined, before: string | undefined, agentText?: string, renamedFrom?: URI): void {
		if (binary) {
			this.edits.recordBinaryBaseline(sessionId, uri, oldBlob ? { repoRoot: repo.repoRoot, blob: oldBlob, path: oldPath } : undefined, { renamedFrom });
		} else {
			this.edits.recordBaseline(sessionId, uri, oldBlob ? before ?? '' : undefined, { agentText, renamedFrom });
		}
	}

	/** Resolves once the chat's queued snapshot, restore and review-offer work is done. */
	async whenIdle(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		while (session) {
			const chain = session.chain;
			const captures = session.captures;
			await chain;
			await captures;
			if (chain === session.chain && captures === session.captures) {
				return;
			}
		}
	}

	// --- reading checkpoints

	getCheckpoints(sessionId: string): readonly IAgentCheckpoint[] {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return [];
		}
		return session.turns.filter(turn => !!turn.before).map(turn => this.toCheckpoint(sessionId, turn));
	}

	async loadCheckpoints(sessionId: string): Promise<readonly IAgentCheckpoint[]> {
		await this.load(this.session(sessionId));
		return this.getCheckpoints(sessionId);
	}

	canRedo(sessionId: string): boolean {
		return !!this.sessions.get(sessionId)?.redo;
	}

	async previewRestore(sessionId: string, turn: AgentTurnRef): Promise<IAgentRestorePreview | undefined> {
		const plan = await this.plan(sessionId, turn);
		if (!plan) {
			return undefined;
		}
		const result = await this.git.restore!({ repoRoot: plan.repo.repoRoot, workTree: plan.repo.workTree, steps: plan.steps, dryRun: true });
		return this.toPreview(this.session(sessionId), plan.checkpoint, result.entries);
	}

	async restoreCheckpoint(sessionId: string, turn: AgentTurnRef, options?: { readonly overwrite?: boolean }): Promise<IAgentRestoreResult | undefined> {
		this.assertIdle(sessionId);
		// Files are about to change: a turn sent meanwhile must not reuse the last after-snapshot.
		this.bumpGenerations();
		const plan = await this.plan(sessionId, turn);
		if (!plan) {
			return undefined;
		}
		return this.applySteps(this.session(sessionId), plan.repo, plan.checkpoint, plan.steps, options?.overwrite, true);
	}

	async redo(sessionId: string, options?: { readonly overwrite?: boolean }): Promise<IAgentRestoreResult | undefined> {
		this.assertIdle(sessionId);
		this.bumpGenerations();
		const session = this.session(sessionId);
		await this.load(session);
		const repo = await this.ensureRepo(session);
		const redo = session.redo;
		if (!repo || !redo || !this.git.restore) {
			return undefined;
		}
		const last = session.turns.at(-1);
		const checkpoint: IAgentCheckpoint = last ? this.toCheckpoint(sessionId, last) : { sessionId, turnId: 'redo', userTurn: 0, before: redo.before, running: false };
		const result = await this.applySteps(session, repo, checkpoint, [redo], options?.overwrite, false);
		if (result.applied && !result.conflicts.length) {
			session.redo = undefined;
			await this.git.deleteRefs({ repoRoot: repo.repoRoot, prefix: `${this.prefix(sessionId)}redo/` }).catch(() => undefined);
			this._onDidChange.fire(sessionId);
		}
		return { ...result, canRedo: !!session.redo };
	}

	async restoreFile(sessionId: string, uri: URI, options?: { readonly overwrite?: boolean }): Promise<VoltGitRestoreOutcome | 'unavailable'> {
		this.bumpGenerations();
		const session = this.session(sessionId);
		await this.load(session);
		const repo = await this.ensureRepo(session);
		const path = repo && this.toPath(session, uri);
		if (!repo || !path || !this.git.restore) {
			return 'unavailable';
		}
		const steps = this.steps(session.turns);
		if (!steps.length) {
			return 'unavailable';
		}
		const result = await this.enqueue(session, () => this.git.restore!({ repoRoot: repo.repoRoot, workTree: repo.workTree, steps, paths: [path], overwrite: options?.overwrite }).finally(() => this.bumpGenerations()));
		return result.entries[0]?.outcome ?? 'unavailable';
	}

	async getChanges(sessionId: string, scope: 'session' | 'lastTurn' | { readonly turnId: string }): Promise<readonly IAgentSnapshotChange[]> {
		const session = this.session(sessionId);
		await this.load(session);
		const repo = await this.ensureRepo(session);
		if (!repo) {
			return [];
		}
		const turns = session.turns.filter(turn => turn.before && turn.after && turn.after.commit !== turn.before.commit);
		const toChange = (entry: IVoltGitDiffEntry, turn: ITurn): IAgentSnapshotChange => ({
			uri: this.toUri(session, entry.path), path: entry.path, oldPath: entry.oldPath, oldUri: entry.oldPath ? this.toUri(session, entry.oldPath) : undefined, kind: entry.kind, binary: entry.binary,
			additions: entry.additions, deletions: entry.deletions, repoRoot: repo.repoRoot, oldBlob: entry.oldBlob, newBlob: entry.newBlob, turnId: turn.turnId,
		});
		if (scope !== 'session') {
			const turn = scope === 'lastTurn' ? turns.at(-1) : turns.find(candidate => candidate.turnId === scope.turnId);
			return turn ? (await this.diff(repo, turn.before!.commit, turn.after!.commit)).map(entry => toChange(entry, turn)) : [];
		}
		// Per path: the text before the first turn that touched it, and after the last one.
		const byPath = new Map<string, IAgentSnapshotChange>();
		for (const turn of turns) {
			for (const entry of await this.diff(repo, turn.before!.commit, turn.after!.commit)) {
				const change = toChange(entry, turn);
				const previous = byPath.get(entry.path) ?? (entry.oldPath ? byPath.get(entry.oldPath) : undefined);
				if (entry.oldPath) {
					byPath.delete(entry.oldPath);
				}
				if (!previous) {
					byPath.set(entry.path, change);
					continue;
				}
				const oldBlob = previous.oldBlob;
				const newBlob = change.newBlob;
				const kind = !oldBlob ? 'added' : !newBlob ? 'deleted' : previous.oldPath ? 'renamed' : 'modified';
				if (!oldBlob && !newBlob) {
					// Created and deleted again: nothing to review.
					byPath.delete(entry.path);
					continue;
				}
				byPath.set(entry.path, { ...change, kind, oldBlob, oldPath: previous.oldPath, oldUri: previous.oldUri, binary: previous.binary || change.binary, additions: previous.additions + change.additions, deletions: previous.deletions + change.deletions });
			}
		}
		return [...byPath.values()];
	}

	async deleteCheckpoints(sessionId: string): Promise<void> {
		const session = this.session(sessionId);
		const repo = await this.ensureRepo(session);
		session.turns = [];
		session.redo = undefined;
		// Its commit loses every ref below.
		session.settled = undefined;
		if (repo) {
			await this.git.deleteRefs({ repoRoot: repo.repoRoot, prefix: this.prefix(sessionId) });
		}
		this._onDidChange.fire(sessionId);
	}

	// --- restore internals

	private async plan(sessionId: string, ref: AgentTurnRef): Promise<{ repo: IVoltGitSnapshotRepo; checkpoint: IAgentCheckpoint; steps: IVoltGitRestoreStep[] } | undefined> {
		const session = this.session(sessionId);
		await this.load(session);
		await session.chain;
		const repo = await this.ensureRepo(session);
		if (!repo || !this.git.restore) {
			return undefined;
		}
		const index = typeof ref === 'number'
			// No checkpoint for that exact message (it ran before checkpoints existed): the next one is the same state.
			? session.turns.findIndex(turn => turn.userTurn >= ref)
			: session.turns.findIndex(turn => turn.turnId === ref || turn.runId === ref);
		const target = session.turns[index];
		if (!target?.before) {
			return undefined;
		}
		return { repo, checkpoint: this.toCheckpoint(sessionId, target), steps: this.steps(session.turns.slice(index)) };
	}

	/** Agent windows to walk back, newest first. A turn without an after-snapshot changed nothing. */
	private steps(turns: readonly ITurn[]): IVoltGitRestoreStep[] {
		return turns
			.filter(turn => turn.before && turn.after && turn.after.commit !== turn.before.commit)
			.map(turn => ({ before: turn.before!.commit, after: turn.after!.commit }))
			.reverse();
	}

	private applySteps(session: ISession, repo: IVoltGitSnapshotRepo, checkpoint: IAgentCheckpoint, steps: readonly IVoltGitRestoreStep[], overwrite: boolean | undefined, remember: boolean): Promise<IAgentRestoreResult> {
		return this.enqueue(session, async () => {
			const prefix = `${this.prefix(session.sessionId)}redo/`;
			const before = remember ? await this.snapshot(repo, `${prefix}before`, 'volt: before restore') : undefined;
			const result = await this.git.restore!({ repoRoot: repo.repoRoot, workTree: repo.workTree, steps, overwrite }).finally(() => this.bumpGenerations());
			if (before && result.entries.some(entry => entry.action !== 'none')) {
				const after = await this.git.snapshot({ repoRoot: repo.repoRoot, workTree: repo.workTree, indexFile: repo.indexFile, parent: before.commit, ref: `${prefix}after`, message: 'volt: after restore' });
				session.redo = { before: before.commit, after: after.commit };
				this._onDidChange.fire(session.sessionId);
			}
			return { ...this.toPreview(session, checkpoint, result.entries), applied: result.applied, canRedo: !!session.redo };
		});
	}

	private toPreview(session: ISession, checkpoint: IAgentCheckpoint, entries: readonly IVoltGitRestoreEntry[]): IAgentRestorePreview {
		const files = entries.map(entry => ({ ...entry, uri: this.toUri(session, entry.path) }));
		return { checkpoint, files, conflicts: files.filter(file => file.outcome === 'conflict') };
	}

	private assertIdle(sessionId: string): void {
		const status = this.runtime.getOrCreateSession(sessionId).activeRun?.status;
		if (status === 'running' || status === 'waiting' || status === 'queued') {
			throw new Error('Stop the agent before restoring a checkpoint.');
		}
	}

	// --- plumbing

	private session(sessionId: string): ISession {
		let session = this.sessions.get(sessionId);
		if (!session) {
			const batch = new RunOnceScheduler(() => void this.snapshotAfter(session!, false), BATCH_DELAY_MS);
			this.schedulers.set(sessionId, batch);
			session = { sessionId, repo: undefined, folder: undefined, turns: [], loaded: undefined, redo: undefined, chain: Promise.resolve(), captures: Promise.resolve(), pendingBegin: undefined, settled: undefined, activeRuns: new Set(), inFlight: new Set(), batch, resolved: new ResourceMap() };
			this.sessions.set(sessionId, session);
		}
		return session;
	}

	/** Runs `task` after the chat's earlier snapshot work; a failure does not block later tasks. */
	private enqueue<T>(session: ISession, task: () => Promise<T>): Promise<T> {
		const run = session.chain.then(task, task);
		session.chain = run.catch(err => this.logService.warn('[volt] checkpoint task failed', err));
		return run;
	}

	/** Reads the chat's checkpoints back from its refs (after a reload). */
	private load(session: ISession): Promise<void> {
		session.loaded ??= (async () => {
			const repo = await this.ensureRepo(session);
			if (!repo) {
				// The chat's folder is not known yet (its project registers after the chat opens on
				// a cold start): load again next time instead of keeping no checkpoints.
				session.loaded = undefined;
				return;
			}
			const prefix = this.prefix(session.sessionId);
			const refs = await this.git.listRefs({ repoRoot: repo.repoRoot, prefix }).catch(() => []);
			const turns = new Map<string, ITurn>();
			let redoBefore: string | undefined;
			let redoAfter: string | undefined;
			for (const { ref, commit } of refs) {
				const [key, phase] = ref.slice(prefix.length).split('/');
				if (key === 'redo') {
					if (phase === 'before') {
						redoBefore = commit;
					} else if (phase === 'after') {
						redoAfter = commit;
					}
					continue;
				}
				const match = /^(\d+)-(.+)$/.exec(key);
				if (!match || (phase !== 'pre' && phase !== 'post')) {
					continue;
				}
				const turn = turns.get(key) ?? { turnId: match[2], userTurn: Number(match[1]), key, before: undefined, after: undefined, running: false, startedAt: 0, handled: new Set<string>() };
				// Only the commit is needed to restore; the tree is filled in when a snapshot is reused live.
				turn[phase === 'pre' ? 'before' : 'after'] = { commit, tree: '' };
				turns.set(key, turn);
			}
			const loaded = [...turns.values()].filter(turn => turn.before).sort((a, b) => a.userTurn - b.userTurn);
			// Turns recorded live while loading stay; loaded ones fill in before them.
			const live = new Set(session.turns.map(turn => turn.key));
			session.turns = [...loaded.filter(turn => !live.has(turn.key)), ...session.turns].sort((a, b) => a.userTurn - b.userTurn);
			if (redoBefore && redoAfter && !session.redo) {
				session.redo = { before: redoBefore, after: redoAfter };
			}
			if (loaded.length || session.redo) {
				this._onDidChange.fire(session.sessionId);
			}
		})().catch(err => this.logService.warn('[volt] loading checkpoints failed', err));
		return session.loaded;
	}

	private async ensureRepo(session: ISession): Promise<IVoltGitSnapshotRepo | undefined> {
		const root = this.rootFor(session.sessionId);
		if (session.repo && root?.toString() === session.folder?.toString()) {
			return session.repo;
		}
		if (session.repo) {
			// The chat moved (into its worktree): earlier checkpoints live in the other repo.
			session.repo = undefined;
			session.turns = [];
			session.redo = undefined;
			session.loaded = undefined;
			session.settled = undefined;
		}
		if (!root || root.scheme !== Schemas.file || !this.git.resolveSnapshotRepo) {
			return undefined;
		}
		let repo = this.repos.get(root.fsPath);
		if (!repo) {
			repo = this.git.resolveSnapshotRepo(root.fsPath).catch(err => {
				this.logService.trace('[volt] no checkpoint repo', err);
				return undefined;
			});
			this.repos.set(root.fsPath, repo);
		}
		session.repo = await repo;
		session.folder = root;
		return session.repo;
	}

	/** Where the chat's agent works: its worktree, its project, or the open folder. */
	private rootFor(sessionId: string): URI | undefined {
		const worktree = this.runtime.getOrCreateSession(sessionId).worktreePath;
		return worktree ? URI.file(worktree) : this.sessionContext.rootFor(sessionId) ?? this.workspace.getWorkspace().folders[0]?.uri;
	}

	/** A repo path as a URI under the folder Volt uses (so it matches pending edits and editors). */
	private toUri(session: ISession, path: string): URI {
		const repo = session.repo!;
		const prefix = repo.folderPrefix ?? '';
		return session.folder && path.startsWith(prefix) ? joinPath(session.folder, path.slice(prefix.length)) : joinPath(URI.file(repo.workTree), path);
	}

	private toPath(session: ISession, uri: URI): string | undefined {
		const repo = session.repo!;
		const inFolder = session.folder && relativePath(session.folder, uri);
		if (inFolder !== undefined && inFolder !== '' && !inFolder.startsWith('..')) {
			return `${repo.folderPrefix ?? ''}${inFolder}`;
		}
		const inRepo = relativePath(URI.file(repo.workTree), uri);
		return inRepo && !inRepo.startsWith('..') ? inRepo : undefined;
	}

	/** With `reuse`, an unchanged tree returns that snapshot as is: no commit, and `ref` is left alone. */
	private snapshot(repo: IVoltGitSnapshotRepo, ref: string, message: string, reuse?: IVoltGitSnapshot): Promise<IVoltGitSnapshot> {
		return this.git.snapshot({ repoRoot: repo.repoRoot, workTree: repo.workTree, indexFile: repo.indexFile, ref, message, ...(reuse ? { reuse } : {}) });
	}

	private diff(repo: IVoltGitSnapshotRepo, from: string, to: string): Promise<IVoltGitDiffEntry[]> {
		const key = `${repo.repoRoot}\u0000${from}\u0000${to}`;
		let diff = this.diffCache.get(key);
		if (!diff) {
			diff = this.git.diffSummary({ repoRoot: repo.repoRoot, from, to });
			diff.catch(() => this.diffCache.delete(key));
			this.diffCache.set(key, diff);
		}
		return diff;
	}

	private async dropTurns(session: ISession, repo: IVoltGitSnapshotRepo, turns: readonly ITurn[]): Promise<void> {
		for (const turn of turns) {
			session.turns = session.turns.filter(other => other !== turn);
			await this.git.deleteRefs({ repoRoot: repo.repoRoot, prefix: `${this.prefix(session.sessionId)}${turn.key}/` }).catch(() => undefined);
		}
	}

	private toCheckpoint(sessionId: string, turn: ITurn): IAgentCheckpoint {
		return { sessionId, turnId: turn.turnId, userTurn: turn.userTurn, before: turn.before!.commit, after: turn.after?.commit, running: turn.running };
	}

	private prefix(sessionId: string): string {
		return `${VOLT_SNAPSHOT_REF_PREFIX}${refSegment(sessionId)}/`;
	}
}

/** `0003-<turn id>`: sorts by user turn, unique across edits of the same message. */
function turnKey(userTurn: number, turnId: string): string {
	return `${String(userTurn).padStart(4, '0')}-${refSegment(turnId)}`;
}

/** A string safe as one ref path segment (`git check-ref-format`). */
export function refSegment(value: string): string {
	const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_').replace(/^\.+|\.lock$|\.+$/g, '_');
	return safe || '_';
}

registerSingleton(IAgentCheckpointService, AgentCheckpointService, InstantiationType.Delayed);

/** Created at startup so the first run's start is never missed. */
class AgentCheckpointStartup implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.voltAgentCheckpoints';
	constructor(@IAgentCheckpointService _checkpoints: IAgentCheckpointService) { }
}

registerWorkbenchContribution2(AgentCheckpointStartup.ID, AgentCheckpointStartup, WorkbenchPhase.BlockStartup);
