/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A team's board: work items members claim one at a time (work flows to whoever is free, like a
 * work-stealing queue, instead of a split fixed up front), and notes everyone reads instead of
 * messaging each other. Every change is one pure step on the board, applied in order by the
 * service, so two members claiming at once never get the same item.
 */

export type BoardItemStatus = 'open' | 'claimed' | 'done' | 'blocked';

export type BoardNoteKind = 'note' | 'decision' | 'finding' | 'blocker';

export interface IBoardItem {
	/** `i1`, `i2`… in the order items were added. */
	readonly id: string;
	readonly title: string;
	readonly detail?: string;
	readonly status: BoardItemStatus;
	/** Items that must be done before this one can be claimed. */
	readonly after?: readonly string[];
	/** The member holding it (claimed) or that finished it (done): its name and task. */
	readonly owner?: string;
	readonly ownerTask?: string;
	readonly result?: string;
	/** Why it is blocked, or why it was last given back. */
	readonly reason?: string;
	/** Times it was claimed; an item given back too often is blocked for the lead. */
	readonly claims: number;
	readonly updatedAt: number;
}

export interface IBoardNote {
	readonly id: string;
	readonly author: string;
	readonly kind: BoardNoteKind;
	readonly text: string;
	readonly at: number;
}

export interface ITeamMemberRecord {
	readonly name: string;
	readonly taskId: string;
	readonly childId?: string;
	readonly modelLabel?: string;
	readonly role?: string;
}

export interface ITeamBoard {
	readonly version: 1;
	readonly id: string;
	readonly kind: 'team' | 'council';
	readonly name: string;
	readonly goal?: string;
	readonly rootId: string;
	/** The chat that started the team. */
	readonly leadId: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly members: readonly ITeamMemberRecord[];
	readonly items: readonly IBoardItem[];
	readonly notes: readonly IBoardNote[];
	/** How many members run at once, when the user chose it. */
	readonly parallel?: number;
	/** The spawn's client_request_id: the same key returns this team instead of starting another. */
	readonly key?: string;
	/** Council: anonymous labels of the answers ("A" -> model), for the status and the tally. */
	readonly seats?: readonly { readonly label: string; readonly model: string; readonly taskId: string }[];
	readonly nextItem: number;
	readonly nextNote: number;
}

/** Items a board holds, notes it keeps (the oldest notes go first), and their sizes. */
export const BOARD_LIMITS = { items: 500, notes: 200, title: 300, detail: 4_000, result: 6_000, note: 2_000 } as const;
/** Claims before an item that keeps coming back is blocked for the lead to look at. */
export const MAX_ITEM_CLAIMS = 3;

export interface IBoardItemInput {
	readonly title: string;
	readonly detail?: string;
	/** Earlier items that must be done first: ids (`i2`) or 1-based positions within this batch. */
	readonly after?: readonly string[];
}

export type BoardOp =
	| { readonly op: 'add'; readonly items: readonly IBoardItemInput[] }
	| { readonly op: 'claim'; readonly member: string; readonly taskId: string }
	| { readonly op: 'done'; readonly member: string; readonly taskId: string; readonly itemId?: string; readonly result: string }
	| { readonly op: 'release'; readonly member: string; readonly taskId: string; readonly itemId?: string; readonly reason?: string }
	| { readonly op: 'block'; readonly member: string; readonly itemId?: string; readonly taskId?: string; readonly reason: string }
	| { readonly op: 'note'; readonly member: string; readonly kind: BoardNoteKind; readonly text: string }
	/** A member's task ended: what it still held goes back on the board (or is blocked past the claim limit). */
	| { readonly op: 'memberEnded'; readonly taskId: string; readonly state: string };

export interface IBoardStep {
	readonly board: ITeamBoard;
	/** For the caller: the item claimed, finished or changed. */
	readonly item?: IBoardItem;
	readonly added?: readonly IBoardItem[];
	/** Refused, with what to do instead. The board is unchanged. */
	readonly error?: string;
	/** claim: nothing is left to do, or only items waiting on others. */
	readonly empty?: 'done' | 'waiting';
}

export function newTeamBoard(init: Pick<ITeamBoard, 'id' | 'kind' | 'name' | 'goal' | 'rootId' | 'leadId' | 'parallel' | 'seats' | 'key'> & { readonly at: number }): ITeamBoard {
	return {
		version: 1,
		id: init.id,
		kind: init.kind,
		name: init.name,
		...(init.goal ? { goal: init.goal } : {}),
		rootId: init.rootId,
		leadId: init.leadId,
		createdAt: init.at,
		updatedAt: init.at,
		members: [],
		items: [],
		notes: [],
		...(init.parallel ? { parallel: init.parallel } : {}),
		...(init.key ? { key: init.key } : {}),
		...(init.seats?.length ? { seats: init.seats } : {}),
		nextItem: 1,
		nextNote: 1,
	};
}

const clipText = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

function itemReady(board: ITeamBoard, item: IBoardItem): boolean {
	return (item.after ?? []).every(id => board.items.find(other => other.id === id)?.status === 'done');
}

function replaceItem(board: ITeamBoard, item: IBoardItem, at: number): ITeamBoard {
	return { ...board, items: board.items.map(other => other.id === item.id ? item : other), updatedAt: at };
}

/** The item a member holds now (one at a time). */
export function heldItem(board: ITeamBoard, taskId: string): IBoardItem | undefined {
	return board.items.find(item => item.status === 'claimed' && item.ownerTask === taskId);
}

export function applyBoardOp(board: ITeamBoard, op: BoardOp, at: number): IBoardStep {
	switch (op.op) {
		case 'add': {
			const room = BOARD_LIMITS.items - board.items.length;
			if (op.items.length > room) {
				return { board, error: `The board holds at most ${BOARD_LIMITS.items} items (${board.items.length} now).` };
			}
			let next = board.nextItem;
			const added: IBoardItem[] = [];
			for (const input of op.items) {
				const title = clipText(input.title.trim(), BOARD_LIMITS.title);
				if (!title) {
					return { board, error: 'Every item needs a title.' };
				}
				const after: string[] = [];
				for (const ref of input.after ?? []) {
					const value = ref.trim();
					// A position within this batch ("1") or an existing item id ("i4").
					const position = /^\d+$/.test(value) ? Number(value) : undefined;
					const id = position !== undefined ? added[position - 1]?.id : board.items.find(item => item.id === value)?.id ?? added.find(item => item.id === value)?.id;
					if (!id) {
						return { board, error: `Item "${title}" waits on ${value}, which is not an earlier item.` };
					}
					if (!after.includes(id)) {
						after.push(id);
					}
				}
				added.push({
					id: `i${next++}`,
					title,
					...(input.detail?.trim() ? { detail: clipText(input.detail.trim(), BOARD_LIMITS.detail) } : {}),
					status: 'open',
					...(after.length ? { after } : {}),
					claims: 0,
					updatedAt: at,
				});
			}
			return { board: { ...board, items: [...board.items, ...added], nextItem: next, updatedAt: at }, added };
		}
		case 'claim': {
			const held = heldItem(board, op.taskId);
			if (held) {
				// Claiming again returns what it holds: a retried call never takes a second item.
				return { board, item: held };
			}
			const ready = board.items.find(item => item.status === 'open' && itemReady(board, item));
			if (!ready) {
				const waiting = board.items.some(item => item.status === 'open' || item.status === 'claimed');
				return { board, empty: waiting ? 'waiting' : 'done' };
			}
			const item: IBoardItem = { ...ready, status: 'claimed', owner: op.member, ownerTask: op.taskId, claims: ready.claims + 1, updatedAt: at };
			return { board: replaceItem(board, item, at), item };
		}
		case 'done': {
			const target = op.itemId ? board.items.find(item => item.id === op.itemId) : heldItem(board, op.taskId);
			if (!target) {
				return { board, error: op.itemId ? `No item ${op.itemId} on the board.` : 'You hold no item. Claim one first.' };
			}
			if (target.status === 'done') {
				return { board, item: target };
			}
			if (target.status === 'claimed' && target.ownerTask !== op.taskId) {
				return { board, error: `${target.id} is held by ${target.owner}. Finish your own item.` };
			}
			const item: IBoardItem = { ...target, status: 'done', owner: op.member, ownerTask: op.taskId, result: clipText(op.result.trim() || '(no result)', BOARD_LIMITS.result), updatedAt: at };
			return { board: replaceItem(board, item, at), item };
		}
		case 'release': {
			const target = op.itemId ? board.items.find(item => item.id === op.itemId) : heldItem(board, op.taskId);
			if (!target || target.status !== 'claimed' || target.ownerTask !== op.taskId) {
				return { board, error: 'You hold no such item.' };
			}
			return releaseItem(board, target, op.reason, at);
		}
		case 'block': {
			const target = op.itemId ? board.items.find(item => item.id === op.itemId) : op.taskId ? heldItem(board, op.taskId) : undefined;
			if (!target) {
				return { board, error: 'Name the item to block (item_id).' };
			}
			if (target.status === 'done') {
				return { board, error: `${target.id} is already done.` };
			}
			const { owner: _owner, ownerTask: _ownerTask, ...rest } = target;
			const item: IBoardItem = { ...rest, status: 'blocked', reason: clipText(`${op.member}: ${op.reason.trim()}`, BOARD_LIMITS.detail), updatedAt: at };
			return { board: replaceItem(board, item, at), item };
		}
		case 'note': {
			const text = clipText(op.text.trim(), BOARD_LIMITS.note);
			if (!text) {
				return { board, error: 'A note needs text.' };
			}
			const note: IBoardNote = { id: `n${board.nextNote}`, author: op.member, kind: op.kind, text, at };
			const notes = [...board.notes, note];
			return { board: { ...board, notes: notes.length > BOARD_LIMITS.notes ? notes.slice(notes.length - BOARD_LIMITS.notes) : notes, nextNote: board.nextNote + 1, updatedAt: at } };
		}
		case 'memberEnded': {
			let next = board;
			for (const item of board.items.filter(candidate => candidate.status === 'claimed' && candidate.ownerTask === op.taskId)) {
				next = releaseItem(next, item, `its member ended (${op.state}) before finishing it`, at).board;
			}
			return { board: next };
		}
	}
}

function releaseItem(board: ITeamBoard, target: IBoardItem, reason: string | undefined, at: number): IBoardStep {
	const { owner: _owner, ownerTask: _ownerTask, ...rest } = target;
	const blocked = target.claims >= MAX_ITEM_CLAIMS;
	const item: IBoardItem = {
		...rest,
		status: blocked ? 'blocked' : 'open',
		...(reason?.trim() || blocked ? { reason: clipText(blocked ? `Given back ${target.claims} times${reason ? `; last: ${reason.trim()}` : ''}` : reason!.trim(), BOARD_LIMITS.detail) } : {}),
		updatedAt: at,
	};
	return { board: replaceItem(board, item, at), item };
}

export interface IBoardCounts {
	readonly open: number;
	readonly claimed: number;
	readonly done: number;
	readonly blocked: number;
}

export function boardCounts(board: Pick<ITeamBoard, 'items'>): IBoardCounts {
	const counts = { open: 0, claimed: 0, done: 0, blocked: 0 };
	for (const item of board.items) {
		counts[item.status]++;
	}
	return counts;
}

/** "12 items: 7 done, 3 in progress, 2 open". */
export function describeBoardCounts(board: Pick<ITeamBoard, 'items'>): string {
	if (!board.items.length) {
		return 'no items';
	}
	const counts = boardCounts(board);
	const parts = [`${counts.done} done`, counts.claimed ? `${counts.claimed} in progress` : '', counts.open ? `${counts.open} open` : '', counts.blocked ? `${counts.blocked} blocked` : ''].filter(Boolean);
	return `${board.items.length} ${board.items.length === 1 ? 'item' : 'items'}: ${parts.join(', ')}`;
}

/** The board as the agents read it. */
export function describeBoard(board: ITeamBoard, options: { readonly notes?: number; readonly results?: boolean } = {}): string {
	const lines = [`Team "${board.name}" (team_id: ${board.id})${board.goal ? `: ${board.goal}` : ''}`];
	if (board.members.length) {
		lines.push(`Members (${board.members.length}): ${board.members.map(member => `${member.name} [${member.taskId}]`).join(', ')}`);
	}
	if (board.items.length) {
		lines.push(`Board: ${describeBoardCounts(board)}`);
		for (const item of board.items) {
			const who = item.owner ? ` · ${item.owner}` : '';
			const wait = item.status === 'open' && item.after?.length && !itemReady(board, item) ? ` · waits on ${item.after.join(', ')}` : '';
			const why = item.reason && item.status !== 'done' ? ` · ${item.reason}` : '';
			lines.push(`- ${item.id} [${item.status}${who}] ${item.title}${wait}${why}`);
			if (options.results && item.status === 'done' && item.result) {
				lines.push(`  result: ${clipText(item.result.replace(/\s+/g, ' '), 400)}`);
			}
		}
	}
	const notes = board.notes.slice(-(options.notes ?? 15));
	if (notes.length) {
		lines.push(`Notes (latest ${notes.length} of ${board.notes.length}):`);
		for (const note of notes) {
			lines.push(`- ${note.id} ${note.kind} · ${note.author}: ${note.text}`);
		}
	}
	return lines.join('\n');
}

/** Items from a tool call: strings, or { title, detail?, after? }. */
export function parseBoardItems(value: unknown): IBoardItemInput[] | string {
	if (!Array.isArray(value)) {
		return 'items must be a list.';
	}
	const items: IBoardItemInput[] = [];
	for (const [index, entry] of value.entries()) {
		if (typeof entry === 'string') {
			if (entry.trim()) {
				items.push({ title: entry });
			}
			continue;
		}
		const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : undefined;
		const title = typeof record?.title === 'string' ? record.title : typeof record?.task === 'string' ? record.task : undefined;
		if (!title?.trim()) {
			return `items[${index}] needs a title.`;
		}
		const after = Array.isArray(record!.after) ? record!.after.map(ref => String(ref)).filter(ref => ref.trim()) : [];
		items.push({ title, ...(typeof record!.detail === 'string' ? { detail: record!.detail } : {}), ...(after.length ? { after } : {}) });
	}
	return items;
}

//#region Codec

const STATUSES = new Set<string>(['open', 'claimed', 'done', 'blocked']);
const NOTE_KINDS = new Set<string>(['note', 'decision', 'finding', 'blocker']);

export function normalizeNoteKind(value: unknown): BoardNoteKind {
	return typeof value === 'string' && NOTE_KINDS.has(value) ? value as BoardNoteKind : 'note';
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A saved board, or undefined when it is damaged; bad items and notes are dropped one by one. */
export function parseTeamBoard(value: unknown): ITeamBoard | undefined {
	const board = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
	if (!board || board.version !== 1 || !str(board.id) || !str(board.name) || !str(board.rootId) || !str(board.leadId) || num(board.createdAt) === undefined) {
		return undefined;
	}
	const items = (Array.isArray(board.items) ? board.items : []).flatMap((entry): IBoardItem[] => {
		const item = entry as Record<string, unknown> | undefined;
		if (!item || !str(item.id) || !str(item.title) || !STATUSES.has(item.status as string)) {
			return [];
		}
		return [{
			id: item.id as string,
			title: item.title as string,
			...(str(item.detail) ? { detail: item.detail as string } : {}),
			status: item.status as BoardItemStatus,
			...(Array.isArray(item.after) && item.after.length ? { after: item.after.filter((id): id is string => typeof id === 'string') } : {}),
			...(str(item.owner) ? { owner: item.owner as string } : {}),
			...(str(item.ownerTask) ? { ownerTask: item.ownerTask as string } : {}),
			...(str(item.result) ? { result: item.result as string } : {}),
			...(str(item.reason) ? { reason: item.reason as string } : {}),
			claims: num(item.claims) ?? 0,
			updatedAt: num(item.updatedAt) ?? 0,
		}];
	});
	const notes = (Array.isArray(board.notes) ? board.notes : []).flatMap((entry): IBoardNote[] => {
		const note = entry as Record<string, unknown> | undefined;
		return note && str(note.id) && str(note.author) && str(note.text) ? [{ id: note.id as string, author: note.author as string, kind: normalizeNoteKind(note.kind), text: note.text as string, at: num(note.at) ?? 0 }] : [];
	});
	const members = (Array.isArray(board.members) ? board.members : []).flatMap((entry): ITeamMemberRecord[] => {
		const member = entry as Record<string, unknown> | undefined;
		return member && str(member.name) && str(member.taskId) ? [{
			name: member.name as string,
			taskId: member.taskId as string,
			...(str(member.childId) ? { childId: member.childId as string } : {}),
			...(str(member.modelLabel) ? { modelLabel: member.modelLabel as string } : {}),
			...(str(member.role) ? { role: member.role as string } : {}),
		}] : [];
	});
	const seats = (Array.isArray(board.seats) ? board.seats : []).flatMap(entry => {
		const seat = entry as Record<string, unknown> | undefined;
		return seat && str(seat.label) && str(seat.model) && str(seat.taskId) ? [{ label: seat.label as string, model: seat.model as string, taskId: seat.taskId as string }] : [];
	});
	const highest = (list: readonly { readonly id: string }[], prefix: string) => list.reduce((max, entry) => Math.max(max, Number(entry.id.slice(prefix.length)) || 0), 0) + 1;
	return {
		version: 1,
		id: board.id as string,
		kind: board.kind === 'council' ? 'council' : 'team',
		name: board.name as string,
		...(str(board.goal) ? { goal: board.goal as string } : {}),
		rootId: board.rootId as string,
		leadId: board.leadId as string,
		createdAt: board.createdAt as number,
		updatedAt: num(board.updatedAt) ?? (board.createdAt as number),
		members,
		items,
		notes,
		...(num(board.parallel) ? { parallel: board.parallel as number } : {}),
		...(str(board.key) ? { key: board.key as string } : {}),
		...(seats.length ? { seats } : {}),
		nextItem: Math.max(num(board.nextItem) ?? 1, highest(items, 'i')),
		nextNote: Math.max(num(board.nextNote) ?? 1, highest(notes, 'n')),
	};
}

//#endregion
