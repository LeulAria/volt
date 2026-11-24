/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** Whether agents may drive the in-app browser at all. A chat's own choice overrides it. */
export const AGENT_BROWSER_ACCESS_SETTING = 'volt.browser.allowAgents';

/**
 * What `browser_import_cookies` does when an agent asks for the user's sign-ins: `ask` shows the
 * user the import dialog, `allow` imports the asked sites from the profile the user allowed (and
 * asks when there is none), `off` refuses without showing anything.
 */
export const AGENT_COOKIE_IMPORT_SETTING = 'volt.browser.agentCookieImport';
export type AgentCookieImportMode = 'ask' | 'allow' | 'off';

/** The browser profile (`IVoltCookieSource.id`) agents may import from without asking; application storage. */
export const AGENT_COOKIE_SOURCE_STORAGE_KEY = 'volt.browser.agentCookieSource';

export function agentCookieImportMode(value: unknown): AgentCookieImportMode {
	return value === 'allow' || value === 'off' ? value : 'ask';
}

export const IVoltBrowserAccessService = createDecorator<IVoltBrowserAccessService>('voltBrowserAccessService');

/** Why a chat's agent may not use the browser: the setting, or the user's choice in that chat. */
export type BrowserBlockReason = 'setting' | 'chat';

/**
 * The chat's own choice wins (the user made it there, for that chat); otherwise the setting
 * decides. Undefined when the agent may use the browser.
 */
export function browserBlockReason(allowedBySetting: boolean, chatChoice: boolean | undefined): BrowserBlockReason | undefined {
	if (chatChoice !== undefined) {
		return chatChoice ? undefined : 'chat';
	}
	return allowedBySetting ? undefined : 'setting';
}

/** The tool result an agent gets instead of running a browser tool. Tells it not to retry or work around it. */
export function browserBlockedMessage(tool: string, reason: BrowserBlockReason): string {
	const why = reason === 'chat'
		? 'the user turned off browser access for agents in this chat'
		: 'the user turned off browser access for agents in Volt\'s settings (volt.browser.allowAgents)';
	return `${tool} was not run: ${why}. Do not retry browser tools or open the page another way (curl, scripts, other tools). Continue without the browser, and if you need it, ask the user to allow it.`;
}

export interface IVoltBrowserAccessService {
	readonly _serviceBrand: undefined;
	/** Fires when the setting or a chat's choice changes. */
	readonly onDidChange: Event<void>;
	/** Undefined when the chat's agent may use the browser. */
	blockReason(sessionId: string | undefined): BrowserBlockReason | undefined;
	/** The chat's own choice, if the user made one. */
	chatChoice(sessionId: string): boolean | undefined;
	/** Sets the chat's choice; undefined goes back to the setting. */
	setChatChoice(sessionId: string, allowed: boolean | undefined): void;
	/** Every chat's own choice (the agent server gets a window's copy). */
	chatChoices(): Record<string, boolean>;
	/** Replaces every chat's choice at once (the agent server, from a window's copy). */
	setChatChoices(choices: Readonly<Record<string, boolean>>): void;
}
