/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** When an OS notification tells you a chat finished or needs you. Off by default. */
export const AGENT_NOTIFY_THREAD_SETTING = 'volt.notifications.threadFinished';
/** Also notify when a chat waits for an approval or an answer. */
export const AGENT_NOTIFY_INPUT_SETTING = 'volt.notifications.needsInput';
/** The sound played with a chat notification. */
export const AGENT_NOTIFY_SOUND_SETTING = 'volt.notifications.sound';
/** The app icon badge (dock, taskbar, launcher) with the number of chats that finished out of sight. */
export const AGENT_BADGE_SETTING = 'volt.notifications.badge';

export type AgentNotifyMode = 'off' | 'whenUnfocused' | 'always';
export type AgentNotifySound = 'none' | 'system' | 'chime' | 'ping' | 'bell';

export const AGENT_NOTIFY_MODES: readonly AgentNotifyMode[] = ['off', 'whenUnfocused', 'always'];
export const AGENT_NOTIFY_SOUNDS: readonly AgentNotifySound[] = ['none', 'system', 'chime', 'ping', 'bell'];

export function agentNotifyMode(value: unknown): AgentNotifyMode {
	return AGENT_NOTIFY_MODES.includes(value as AgentNotifyMode) ? value as AgentNotifyMode : 'off';
}

export function agentNotifySound(value: unknown): AgentNotifySound {
	return AGENT_NOTIFY_SOUNDS.includes(value as AgentNotifySound) ? value as AgentNotifySound : 'chime';
}

/** Where the user is: is the window focused, and is the chat on screen in it. */
export interface IAgentAttentionContext {
	readonly windowFocused: boolean;
	readonly threadVisible: boolean;
}

/** A chat runs in the background unless it is on screen in a focused window. */
export function isBackgroundThread(context: IAgentAttentionContext): boolean {
	return !(context.windowFocused && context.threadVisible);
}

/**
 * - `whenUnfocused`: only while Volt is not the focused app.
 * - `always`: also while Volt is focused, unless you are looking at that chat.
 */
export function shouldNotifyThread(mode: AgentNotifyMode, context: IAgentAttentionContext): boolean {
	switch (mode) {
		case 'off': return false;
		case 'whenUnfocused': return !context.windowFocused;
		case 'always': return isBackgroundThread(context);
	}
}

/** What the attention model needs from an orchestrator thread. */
export interface IAgentThreadSnapshot {
	readonly activeTurnId?: string;
	readonly inputs: readonly { readonly id: string; readonly kind: 'approval' | 'question' }[];
	readonly last?: { readonly turnId: string; readonly outcome: 'done' | 'failed' | 'cancelled' | 'interrupted'; readonly error?: string };
	/** Has more queued prompts that will run next (the chat is not done yet). */
	readonly queued: number;
}

export type AgentThreadAttentionEvent =
	| { readonly kind: 'finished'; readonly outcome: 'done' | 'failed'; readonly error?: string }
	| { readonly kind: 'input'; readonly input: 'approval' | 'question' };

/**
 * The events worth telling the user about between two states of one chat: its run ended on its
 * own (done or failed; a stop you pressed is not news) with nothing queued behind it, or it opened
 * a new approval or question.
 */
export function threadAttentionEvents(previous: IAgentThreadSnapshot | undefined, next: IAgentThreadSnapshot): AgentThreadAttentionEvent[] {
	const events: AgentThreadAttentionEvent[] = [];
	if (previous?.activeTurnId && !next.activeTurnId && next.queued === 0) {
		const last = next.last;
		if (last && last.turnId === previous.activeTurnId && (last.outcome === 'done' || last.outcome === 'failed')) {
			events.push(last.outcome === 'failed'
				? { kind: 'finished', outcome: 'failed', ...(last.error ? { error: last.error } : {}) }
				: { kind: 'finished', outcome: 'done' });
		}
	}
	const known = new Set(previous?.inputs.map(input => input.id) ?? []);
	for (const input of next.inputs) {
		if (!known.has(input.id)) {
			events.push({ kind: 'input', input: input.kind });
		}
	}
	return events;
}

/**
 * Chats that finished out of sight and were not looked at since: the app badge counts them and
 * the sidebar marks them. A chat leaves once it is on screen in a focused window.
 */
export class AgentUnreadThreads {

	private readonly ids = new Set<string>();

	get count(): number {
		return this.ids.size;
	}

	has(id: string): boolean {
		return this.ids.has(id);
	}

	values(): readonly string[] {
		return [...this.ids];
	}

	/** Returns whether the set changed. */
	finished(id: string, context: IAgentAttentionContext): boolean {
		if (!isBackgroundThread(context) || this.ids.has(id)) {
			return false;
		}
		this.ids.add(id);
		return true;
	}

	/** The chats on screen; they count as seen while the window has focus. Returns whether the set changed. */
	seen(visible: Iterable<string>, windowFocused: boolean): boolean {
		if (!windowFocused) {
			return false;
		}
		let changed = false;
		for (const id of visible) {
			changed = this.ids.delete(id) || changed;
		}
		return changed;
	}

	/** The chat was opened, deleted or marked read elsewhere. */
	clear(id: string): boolean {
		return this.ids.delete(id);
	}

	clearAll(): boolean {
		const changed = this.ids.size > 0;
		this.ids.clear();
		return changed;
	}
}

/** "Finished", "Failed: …", "Needs your approval", for a notification's body. */
export function attentionKey(event: AgentThreadAttentionEvent): 'done' | 'failed' | 'approval' | 'question' {
	return event.kind === 'finished' ? event.outcome : event.input;
}
