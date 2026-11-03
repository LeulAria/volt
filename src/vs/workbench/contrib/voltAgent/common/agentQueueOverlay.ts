/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOrchPrompt, IOrchQueueItem } from '../../../services/voltRuntime/common/orchestration/orchestrator.js';

/**
 * Queue changes this window made whose orchestrator call has not answered yet. Against the agent
 * server every change is a round trip, seconds while the server is busy with agents, so the queue
 * card shows each change at once from here. A change lasts until its call settles (the function
 * each method returns): by then the orchestrator's queue has it, since the server publishes its
 * state before it answers, or it refused it.
 */
export class AgentQueueOverlay {

	private nextToken = 1;
	private readonly added: { readonly token: number; readonly item: IOrchQueueItem; readonly head: boolean }[] = [];
	private readonly removed = new Map<string, number>();
	private readonly edits = new Map<string, { readonly token: number; readonly prompt: IOrchPrompt }>();
	private order: { readonly token: number; readonly ids: readonly string[] } | undefined;

	get isEmpty(): boolean {
		return !this.added.length && !this.removed.size && !this.edits.size && !this.order;
	}

	/** A prompt on its way into the queue: at the end, or first (`head`, as Send now puts it). */
	add(item: IOrchQueueItem, head = false): () => void {
		const token = this.nextToken++;
		this.added.push({ token, item, head });
		return () => {
			const index = this.added.findIndex(entry => entry.token === token);
			if (index >= 0) {
				this.added.splice(index, 1);
			}
		};
	}

	remove(id: string): () => void {
		const token = this.nextToken++;
		this.removed.set(id, token);
		return () => {
			if (this.removed.get(id) === token) {
				this.removed.delete(id);
			}
		};
	}

	edit(id: string, prompt: IOrchPrompt): () => void {
		const token = this.nextToken++;
		this.edits.set(id, { token, prompt });
		return () => {
			if (this.edits.get(id)?.token === token) {
				this.edits.delete(id);
			}
		};
	}

	/** The queue in this order; ids it leaves out keep theirs, after it. */
	reorder(ids: readonly string[]): () => void {
		const token = this.nextToken++;
		this.order = { token, ids: ids.slice() };
		return () => {
			if (this.order?.token === token) {
				this.order = undefined;
			}
		};
	}

	/** The queue as this window shows it: the orchestrator's, with the changes still on their way. */
	apply(queue: readonly IOrchQueueItem[]): readonly IOrchQueueItem[] {
		if (this.isEmpty) {
			return queue;
		}
		const known = new Set(queue.map(item => item.id));
		const heads: IOrchQueueItem[] = [];
		const tails: IOrchQueueItem[] = [];
		for (const { item, head } of this.added) {
			if (!known.has(item.id)) {
				known.add(item.id);
				(head ? heads : tails).push(item);
			}
		}
		// Each Send now goes ahead of the ones before it, as the orchestrator puts it at the head.
		let items = [...heads.reverse(), ...queue, ...tails].filter(item => !this.removed.has(item.id));
		if (this.edits.size) {
			items = items.map(item => {
				const edit = this.edits.get(item.id);
				return edit ? { ...item, prompt: edit.prompt } : item;
			});
		}
		if (this.order) {
			const rank = new Map(this.order.ids.map((id, index) => [id, index]));
			const ranked = items.filter(item => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
			items = [...ranked, ...items.filter(item => !rank.has(item.id))];
		}
		return items;
	}
}
