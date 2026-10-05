/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Open-sidebar header chrome for the back/forward arrows.
 * The drag strip must stop this far from the sidebar's right edge or it covers the arrows.
 * A drag box in this window swallows clicks on controls over it, even ones marked no-drag.
 * CSS fallback: `--volt-agent-nav-drag-clearance, 58px` in agentHomePane.css.
 */
export const agentSidebarNavChrome = {
	edge: 8,
	button: 20,
	gap: 2,
	gapBeforeArrows: 8,
} as const;

export function agentSidebarNavDragClearance(metrics = agentSidebarNavChrome): number {
	return metrics.edge + metrics.button + metrics.gap + metrics.button + metrics.gapBeforeArrows;
}

export interface IAgentNavEntry {
	/** Same key means the same place, so a repeat visit does not grow the stack. */
	readonly key: string;
	open(): Promise<void>;
}

/**
 * Back/forward stack for places the user opened in the agent window:
 * a chat, settings, or another editor they navigated to.
 */
export class AgentNavHistory {

	private readonly entries: IAgentNavEntry[] = [];
	private index = -1;
	/** While a back/forward restore is opening its target, ignore the editor change it causes. */
	private suppress = 0;

	get canBack(): boolean {
		return this.index > 0;
	}

	get canForward(): boolean {
		return this.index >= 0 && this.index < this.entries.length - 1;
	}

	push(entry: IAgentNavEntry): void {
		if (this.suppress > 0) {
			return;
		}
		const current = this.entries[this.index];
		if (current?.key === entry.key) {
			this.entries[this.index] = entry;
			return;
		}
		this.entries.splice(this.index + 1);
		this.entries.push(entry);
		this.index = this.entries.length - 1;
		while (this.entries.length > 50) {
			this.entries.shift();
			this.index--;
		}
	}

	back(): Promise<void> {
		return this.move(-1);
	}

	forward(): Promise<void> {
		return this.move(1);
	}

	private async move(delta: number): Promise<void> {
		const next = this.index + delta;
		const entry = this.entries[next];
		if (!entry) {
			return;
		}
		this.index = next;
		this.suppress++;
		try {
			await entry.open();
		} finally {
			this.suppress--;
		}
	}
}
