/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IVoltAwakeService = createDecorator<IVoltAwakeService>('voltAwakeService');
export const VOLT_AWAKE_CHANNEL_NAME = 'voltAwake';

/** Keep the computer from idle sleep while agents work (no permission needed on any OS). */
export const AWAKE_WHILE_AGENTS_WORK_SETTING = 'volt.awake.whileAgentsWork';
/** Lid-Closed Mode: agents keep working with the laptop lid shut. */
export const AWAKE_LID_CLOSED_MODE_SETTING = 'volt.awake.lidClosedMode';
export const AWAKE_GRACE_MINUTES_SETTING = 'volt.awake.graceMinutes';
export const AWAKE_MAX_HOURS_SETTING = 'volt.awake.maxHours';
export const AWAKE_BATTERY_FLOOR_SETTING = 'volt.awake.batteryFloorPercent';

export interface IAwakePrefs {
	readonly whileAgentsWork: boolean;
	readonly lidClosedMode: boolean;
	/** How long the hold outlasts the last run, so queued follow-ups and subagent reports land. */
	readonly graceMinutes: number;
	/** Lid-Closed Mode lets go after this long without a break in agent work. */
	readonly maxHours: number;
	/** On battery, Lid-Closed Mode lets go below this charge. 0 turns the floor off. */
	readonly batteryFloorPercent: number;
}

export const DEFAULT_AWAKE_PREFS: IAwakePrefs = {
	whileAgentsWork: true,
	lidClosedMode: true,
	graceMinutes: 2,
	maxHours: 12,
	batteryFloorPercent: 20,
};

/** What one window reports: its busy chats, and the battery as its renderer sees it. */
export interface IAwakeLease {
	/** Chats with a turn running or subagents still working. */
	readonly working: number;
	/** Chats stopped on an approval or a question. They do not keep the computer awake. */
	readonly waitingOnUser: number;
	/** 0–100, from the renderer's Battery Status API; absent on desktops and when unreadable. */
	readonly batteryPercent?: number;
}

export type AwakeThermalState = 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical';

/** Whether this computer can keep working with the lid closed, and what it needs first. */
export type LidCapability =
	| { readonly kind: 'ready' }
	/** A one-time approval is missing (macOS: the administrator grant for `pmset`). */
	| { readonly kind: 'needsSetup'; readonly detail: string }
	/** No lid, no systemd, a locked power plan, ... `detail` says which. */
	| { readonly kind: 'unsupported'; readonly detail: string }
	/** Sleep was already turned off by another app or by hand; Volt leaves that setting alone. */
	| { readonly kind: 'foreign'; readonly detail: string }
	| { readonly kind: 'checking' };

export type AwakeTier = 'none' | 'idle' | 'lid';

export type AwakeBlock = 'battery' | 'thermal' | 'cap' | 'snoozed';

export interface IAwakeState {
	readonly tier: AwakeTier;
	/** `agents`: a chat is working now; `grace`: the last one finished moments ago. */
	readonly reason: 'agents' | 'grace' | 'none';
	/** Why Lid-Closed Mode is not holding even though agents work. */
	readonly blockedBy?: AwakeBlock;
	readonly lid: LidCapability;
	/** macOS only, while Lid-Closed Mode holds: the lid as last read. */
	readonly lidClosed?: boolean;
	readonly working: number;
	readonly onBattery: boolean;
	readonly batteryPercent?: number;
	/** The last thing that went wrong, with the command to fix it by hand when there is one. */
	readonly lastError?: string;
}

export interface IVoltAwakeService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<IAwakeState>;

	getState(): Promise<IAwakeState>;

	/** A window's busy chats and the settings it reads. Also the heartbeat: send it at least every 30 s. */
	setLease(windowId: number, lease: IAwakeLease, prefs: IAwakePrefs): Promise<void>;

	/** Lets the computer sleep until every agent has finished (the next run holds again). */
	allowSleepNow(): Promise<void>;

	/** The one-time approval for Lid-Closed Mode. May show an OS password dialog. */
	setUpLidClosedMode(): Promise<LidCapability>;

	/** Undoes {@link setUpLidClosedMode} (macOS: removes the administrator grant). */
	removeLidClosedModePermission(): Promise<LidCapability>;

	/** Checks the capability again (after the user changed something outside Volt). */
	refreshCapability(): Promise<LidCapability>;

	/** True once per app launch: the window that gets it may ask the user to set up Lid-Closed Mode. */
	claimSetupPrompt(): Promise<boolean>;
}

//#region Policy

export interface IAwakePolicyInput {
	readonly now: number;
	readonly prefs: IAwakePrefs;
	/** Busy chats across every live window. */
	readonly working: number;
	readonly lastBusyAt: number | undefined;
	/** When the current unbroken hold began. */
	readonly episodeStartedAt: number | undefined;
	readonly snoozed: boolean;
	readonly onBattery: boolean;
	readonly batteryPercent: number | undefined;
	readonly thermal: AwakeThermalState;
}

export interface IAwakeDecision {
	/** Hold off idle sleep. */
	readonly idle: boolean;
	/** Hold off lid-close sleep (the backend does what the capability allows). */
	readonly lid: boolean;
	readonly reason: IAwakeState['reason'];
	readonly blockedBy?: AwakeBlock;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Pure: what to hold right now. The main service calls it on every lease, power event and tick. */
export function decideAwake(input: IAwakePolicyInput): IAwakeDecision {
	const { prefs } = input;
	if (!prefs.whileAgentsWork && !prefs.lidClosedMode) {
		return { idle: false, lid: false, reason: 'none' };
	}
	const busy = input.working > 0;
	const inGrace = !busy && input.lastBusyAt !== undefined && input.now - input.lastBusyAt < Math.max(0, prefs.graceMinutes) * MINUTE;
	if (!busy && !inGrace) {
		return { idle: false, lid: false, reason: 'none' };
	}
	const reason = busy ? 'agents' : 'grace';
	if (input.snoozed) {
		return { idle: false, lid: false, reason, blockedBy: 'snoozed' };
	}
	if (!prefs.lidClosedMode) {
		return { idle: true, lid: false, reason };
	}
	const floor = Math.max(0, prefs.batteryFloorPercent);
	if (input.onBattery && floor > 0 && input.batteryPercent !== undefined && input.batteryPercent < floor) {
		return { idle: true, lid: false, reason, blockedBy: 'battery' };
	}
	if (input.thermal === 'critical') {
		return { idle: true, lid: false, reason, blockedBy: 'thermal' };
	}
	if (input.episodeStartedAt !== undefined && input.now - input.episodeStartedAt > Math.max(1, prefs.maxHours) * HOUR) {
		return { idle: true, lid: false, reason, blockedBy: 'cap' };
	}
	return { idle: true, lid: true, reason };
}

/** Reads the settings with their defaults; out-of-range numbers are clamped. */
export function readAwakePrefs(get: (key: string) => unknown): IAwakePrefs {
	const bool = (key: string, fallback: boolean) => {
		const value = get(key);
		return typeof value === 'boolean' ? value : fallback;
	};
	const num = (key: string, fallback: number, min: number, max: number) => {
		const value = get(key);
		return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
	};
	return {
		whileAgentsWork: bool(AWAKE_WHILE_AGENTS_WORK_SETTING, DEFAULT_AWAKE_PREFS.whileAgentsWork),
		lidClosedMode: bool(AWAKE_LID_CLOSED_MODE_SETTING, DEFAULT_AWAKE_PREFS.lidClosedMode),
		graceMinutes: num(AWAKE_GRACE_MINUTES_SETTING, DEFAULT_AWAKE_PREFS.graceMinutes, 0, 60),
		maxHours: num(AWAKE_MAX_HOURS_SETTING, DEFAULT_AWAKE_PREFS.maxHours, 1, 72),
		batteryFloorPercent: num(AWAKE_BATTERY_FLOOR_SETTING, DEFAULT_AWAKE_PREFS.batteryFloorPercent, 0, 90),
	};
}

//#endregion

//#region Parsers (pure, shared by the backends and tests)

/** `pmset -g`: whether the `SleepDisabled` line reads 1. */
export function parsePmsetSleepDisabled(output: string): boolean {
	return /^\s*SleepDisabled\s+1\s*$/m.test(output);
}

/** `ioreg -r -k AppleClamshellState -d 1`: the lid state, or undefined when the machine has no lid. */
export function parseClamshellState(output: string): boolean | undefined {
	const match = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(output);
	return match ? match[1] === 'Yes' : undefined;
}

/** `powercfg /getactivescheme`: the active scheme's GUID (the label around it is localized). */
export function parseActiveSchemeGuid(output: string): string | undefined {
	return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(output)?.[0].toLowerCase();
}

/**
 * `powercfg /q <scheme> SUB_BUTTONS LIDACTION`: the AC and DC lid actions. The labels are localized,
 * so this takes the last two `0x` values, which powercfg always prints AC first.
 */
export function parseLidAction(output: string): { ac: number; dc: number } | undefined {
	const values = output.match(/0x[0-9a-f]{8}/gi);
	if (!values || values.length < 2) {
		return undefined;
	}
	const ac = parseInt(values[values.length - 2], 16);
	const dc = parseInt(values[values.length - 1], 16);
	return Number.isFinite(ac) && Number.isFinite(dc) ? { ac, dc } : undefined;
}

/** `key=value` lines (the registry's file format, readable from sh and PowerShell). */
export function parseKeyValues(text: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const at = line.indexOf('=');
		if (at > 0) {
			map.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
		}
	}
	return map;
}

export function formatKeyValues(map: ReadonlyMap<string, string>): string {
	return [...map].map(([key, value]) => `${key}=${value}`).join('\n') + (map.size ? '\n' : '');
}

//#endregion
