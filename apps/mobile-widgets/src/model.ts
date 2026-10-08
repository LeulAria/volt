/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What the app hands to iOS: the Live Activity's attributes and content state, and the snapshot the
// widgets read from the App Group. These shapes are the JSON contract with the Swift side
// (ios/Shared/VoltActivityAttributes.swift, targets/widget/VoltWidgetData.swift) and with the APNs
// payloads the agent server sends (src/apns.ts). Times are Unix seconds (Double in Swift) so a push
// payload decodes without any date strategy. Change both sides together.

/**
 * - `working`: a turn is running.
 * - `input`: the agent is blocked on an approval or a question.
 * - `stopping`: Stop was pressed; the run is cancelling.
 * - `limited`: the turn stopped at the provider's usage limit.
 * - `done` / `failed` / `stopped`: the turn ended (the activity ends with this state).
 */
export type AgentActivityPhase = 'working' | 'input' | 'stopping' | 'limited' | 'done' | 'failed' | 'stopped';

export const ACTIVE_PHASES: ReadonlySet<AgentActivityPhase> = new Set(['working', 'input', 'stopping']);

export type AgentInputKind = 'approval' | 'question';

/** Fixed for the life of an activity (ActivityAttributes). */
export interface IAgentActivityAttributes {
	readonly chatId: string;
	/** Provider family (`claude`, `codex`, `cursor`, `grok`, `opencode`, …): picks the glyph. */
	readonly provider: string;
	/** Project or branch the chat works in. */
	readonly workspace?: string;
	/** The paired server's address, so a Stop from the Lock Screen reaches the right machine. */
	readonly server?: string;
}

/** Changes with every update (ActivityAttributes.ContentState). */
export interface IAgentActivityContentState {
	readonly phase: AgentActivityPhase;
	readonly title: string;
	/** The live step, as the agent window's status line says it ("Running npm", "Edited auth.ts"). */
	readonly step: string;
	/** When the turn started (Unix seconds); the elapsed timer counts from here. */
	readonly startedAt: number;
	/** When the turn ended (Unix seconds); freezes the timer. */
	readonly endedAt?: number;
	readonly filesChanged: number;
	/** Prompts waiting in the chat's queue. */
	readonly queued: number;
	/** Subagents of this chat still running. */
	readonly subagents: number;
	readonly inputKind?: AgentInputKind;
	/** The question or the action awaiting approval. */
	readonly inputPrompt?: string;
	/** Short model name ("Opus 4.6"). */
	readonly model?: string;
	/** Other chats working or waiting that have no activity of their own. */
	readonly others: number;
	/** `limited`: when the provider says the limit resets (Unix seconds). */
	readonly limitResetAt?: number;
	readonly updatedAt: number;
}

//#region Widgets

export interface IWidgetLimitWindow {
	readonly id: string;
	/** The provider's own words ("Current session", "Weekly limit"). */
	readonly label: string;
	/** Compact name for small widgets: `5h`, `Week`, `Month`, or the label. */
	readonly short: string;
	/** "Opus", "All models". */
	readonly scope?: string;
	/** 0–100, used (as the Usage page shows it). */
	readonly usedPercent: number;
	/** Unix seconds. */
	readonly resetsAt?: number;
	readonly windowSeconds?: number;
	/** At the current pace the window runs out at this time, before it resets (Unix seconds). */
	readonly runsOutAt?: number;
	/** Using the window faster than it refills. */
	readonly ahead?: boolean;
}

export interface IWidgetProviderUsage {
	readonly provider: string;
	readonly label: string;
	readonly plan?: string;
	readonly windows: readonly IWidgetLimitWindow[];
	readonly resetCredits?: number;
	readonly error?: string;
	/** Unix seconds. */
	readonly checkedAt: number;
}

export interface IWidgetAgent {
	readonly chatId: string;
	readonly title: string;
	readonly provider: string;
	readonly phase: AgentActivityPhase;
	readonly step?: string;
	readonly startedAt?: number;
	readonly inputKind?: AgentInputKind;
	readonly workspace?: string;
	readonly model?: string;
	readonly url: string;
}

/** Everything the widgets draw, written by the app to the App Group as one JSON file. */
export interface IWidgetSnapshot {
	readonly version: 1;
	/** Unix seconds. */
	readonly generatedAt: number;
	readonly server?: { readonly name?: string; readonly connected: boolean };
	readonly usage?: {
		readonly checkedAt: number;
		readonly providers: readonly IWidgetProviderUsage[];
	};
	readonly agents: {
		readonly working: number;
		readonly needsInput: number;
		/** Needs input first, then working (newest first), then recently finished. At most 8. */
		readonly items: readonly IWidgetAgent[];
	};
	readonly links: {
		readonly home: string;
		readonly usage: string;
		readonly newChat: string;
	};
}

//#endregion

export const toSeconds = (ms: number): number => Math.round(ms) / 1000;
