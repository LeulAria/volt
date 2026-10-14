/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the user has open beside a chat (its right panel), told to the agent in a few lines with
 * the turn, and only when it changed since the agent last heard it. The details (terminal output,
 * changed files, the device's screen) stay behind the workspace_status tool, so a turn that does
 * not need them costs nothing extra. Same idea as an editor telling its agent the open file only
 * when the user switches to another one.
 */

/** Runs in the window: `(sessionId) => IWorkspaceSnapshot | undefined` for the chat's right panel. */
export const WORKSPACE_SNAPSHOT_COMMAND_ID = 'volt.workspace.contextSnapshot';

export const WORKSPACE_STATUS_TOOL_NAME = 'workspace_status';

export type WorkspaceTabKind = 'browser' | 'device' | 'terminal' | 'file' | 'changes' | 'chat' | 'other';

export interface IWorkspaceTab {
	readonly kind: WorkspaceTabKind;
	/** The tab's title as the user sees it. */
	readonly title: string;
	/** The tab in front of the right panel. */
	readonly focused: boolean;
	/** Browser: its URL. File: its workspace-relative path. */
	readonly target?: string;
	/** Device: name, runtime and state joined by middle dots ("iPhone 16 / iOS 18.5 simulator / booted" with U+00B7 for "/"), and the app in front when known. */
	readonly device?: IWorkspaceDevice;
	/** Terminal: the command running now, else the last one and how it ended. */
	readonly terminal?: IWorkspaceTerminal;
	/** File: unsaved changes. */
	readonly dirty?: boolean;
}

export interface IWorkspaceDevice {
	readonly name: string;
	readonly platform: 'ios' | 'android';
	readonly kind: string;
	readonly runtime?: string;
	readonly state: string;
	/** Bundle id / package of the app in front ("com.apple.springboard" is the home screen). */
	readonly foreground?: string;
	/** The machine it runs on, when it is not this one. */
	readonly host?: string;
}

export interface IWorkspaceTerminal {
	readonly cwd?: string;
	readonly running?: string;
	readonly last?: string;
	readonly exitCode?: number;
	/** The last lines of output (workspace_status only). */
	readonly output?: string;
}

export interface IWorkspaceGit {
	readonly branch?: string;
	readonly ahead?: number;
	readonly behind?: number;
	readonly changed: number;
	/** `git status --porcelain` lines (workspace_status only). */
	readonly files?: readonly string[];
}

export interface IWorkspaceSnapshot {
	/** The right panel is open beside the chat (the user can see its tabs). */
	readonly panelOpen: boolean;
	readonly tabs: readonly IWorkspaceTab[];
	readonly git?: IWorkspaceGit;
}

/** At most this many tabs are named in the turn's lines; the rest are counted. */
const MAX_TABS = 8;
const MAX_TEXT = 90;

/** One line, capped, with nothing that could close the block's tag. */
function clip(text: string, max = MAX_TEXT): string {
	const single = text.replace(/\s+/g, ' ').replace(/</g, '\u2039').replace(/>/g, '\u203a').trim();
	return single.length > max ? `${single.slice(0, max - 1)}\u2026` : single;
}

/** Friendly names for apps whose bundle ids say little; others show their id. */
const APP_NAMES: Record<string, string> = {
	'com.apple.springboard': 'Home Screen',
	'com.apple.mobilesafari': 'Safari',
	'com.apple.Maps': 'Maps',
	'com.apple.Preferences': 'Settings',
	'com.apple.mobileslideshow': 'Photos',
	'com.apple.MobileSMS': 'Messages',
	'com.apple.news': 'News',
	'com.apple.mobilecal': 'Calendar',
	'com.apple.reminders': 'Reminders',
	'com.apple.Health': 'Health',
	'com.apple.Passbook': 'Wallet',
	'com.apple.DocumentsApp': 'Files',
	'com.apple.MobileAddressBook': 'Contacts',
	'com.apple.Fitness': 'Fitness',
	'host.exp.Exponent': 'Expo Go',
};

export function appLabel(foreground: string): string {
	const name = APP_NAMES[foreground];
	return name ? `${name} (${foreground})` : foreground;
}

function describeDevice(device: IWorkspaceDevice): string {
	const kind = device.platform === 'ios' ? `${device.runtime ?? 'iOS'} ${device.kind}` : `${device.runtime ?? 'Android'} ${device.kind}`;
	const parts = [`${device.name} (${kind}${device.host ? ` on ${device.host}` : ''}, ${device.state})`];
	if (device.foreground) {
		parts.push(`app in front: ${appLabel(device.foreground)}`);
	}
	return parts.join(', ');
}

function describeTerminal(terminal: IWorkspaceTerminal): string | undefined {
	if (terminal.running) {
		return `running \`${clip(terminal.running, 60)}\``;
	}
	if (terminal.last) {
		return `last ran \`${clip(terminal.last, 60)}\`${terminal.exitCode !== undefined ? ` (exit ${terminal.exitCode})` : ''}`;
	}
	return undefined;
}

/** One line per tab, as the turn's lines and the tool's summary list them. */
export function describeTab(tab: IWorkspaceTab): string {
	switch (tab.kind) {
		case 'device':
			return tab.device ? `Device preview: ${describeDevice(tab.device)}` : `Device preview: ${clip(tab.title)} (no device chosen)`;
		case 'browser':
			return `Browser: "${clip(tab.title, 60)}"${tab.target ? ` ${clip(tab.target)}` : ''}`;
		case 'terminal': {
			const state = tab.terminal ? describeTerminal(tab.terminal) : undefined;
			return `Terminal "${clip(tab.title, 40)}"${tab.terminal?.cwd ? ` in ${clip(tab.terminal.cwd, 60)}` : ''}${state ? `, ${state}` : ''}`;
		}
		case 'file':
			return `File: ${clip(tab.target ?? tab.title)}${tab.dirty ? ' (unsaved)' : ''}`;
		case 'changes':
			return 'Changes (the diff of this chat\'s edits)';
		case 'chat':
			return `Side chat: ${clip(tab.title, 60)}`;
		default:
			return clip(tab.title);
	}
}

function describeGit(git: IWorkspaceGit): string {
	const sync = [git.ahead ? `${git.ahead} ahead` : '', git.behind ? `${git.behind} behind` : ''].filter(Boolean).join(', ');
	const changed = git.changed === 0 ? 'clean' : `${git.changed} changed file${git.changed === 1 ? '' : 's'}`;
	return `Git: ${git.branch ? `on ${git.branch}` : 'detached'}${sync ? ` (${sync})` : ''}, ${changed}`;
}

/**
 * The block for the turn. Leads with the tab in front, because a short request ("open maps",
 * "reload it", "what does this say") most likely means it: a device in front means the app on the
 * simulator, not a website. Worded like Codex's and Cursor's ambient context, so the model treats
 * it as background rather than as part of the request.
 */
export function formatWorkspaceContext(snapshot: IWorkspaceSnapshot): string | undefined {
	const tabs = snapshot.tabs;
	if (!tabs.length && !snapshot.git) {
		return undefined;
	}
	const lines: string[] = [
		'<volt_workspace source="ambient-ui-state">',
		'Automatically supplied state of the Volt window around this chat, not part of the user\'s request; it may or may not be relevant. When a request is short or does not say where ("open maps", "reload it", "what does it say"), it most likely means the tab in front. The user\'s explicit wording always wins.',
	];
	if (tabs.length) {
		const focused = snapshot.panelOpen ? tabs.find(tab => tab.focused) : undefined;
		const others = tabs.filter(tab => tab !== focused);
		lines.push(snapshot.panelOpen ? 'Right panel tabs:' : 'Right panel tabs (panel closed, so none is in front):');
		if (focused) {
			lines.push(`- In front: ${describeTab(focused)}`);
		}
		for (const tab of others.slice(0, MAX_TABS)) {
			lines.push(`- ${describeTab(tab)}`);
		}
		if (others.length > MAX_TABS) {
			lines.push(`- [${others.length - MAX_TABS} more tabs omitted]`);
		}
		if (focused?.kind === 'device' && focused.device?.state === 'booted') {
			lines.push('The device is in front: requests about apps ("open maps", "tap...", "test the app") mean this device. Use the device_* tools (device_launch_app, device_tap, device_screenshot), not the browser.');
		} else if (focused?.kind === 'browser') {
			lines.push('The browser is in front: requests about "the page" or "the site" mean this tab (browser_* tools).');
		}
	}
	if (snapshot.git) {
		lines.push(describeGit(snapshot.git));
	}
	lines.push(`Call ${WORKSPACE_STATUS_TOOL_NAME} for details (terminal output, changed files, the device's app) when you need them.`);
	lines.push('</volt_workspace>');
	return lines.join('\n');
}

/**
 * Whether the turn should carry the lines: the agent has not heard them (a new or restarted agent
 * session), or what is open changed since. Git counts alone do not count as a change: the agent
 * makes most of them itself.
 */
export function workspaceContextKey(snapshot: IWorkspaceSnapshot): string {
	return JSON.stringify({
		open: snapshot.panelOpen,
		tabs: snapshot.tabs.map(tab => [tab.kind, tab.title, tab.focused, tab.target, tab.device?.name, tab.device?.state, tab.device?.foreground, tab.terminal?.running]),
		branch: snapshot.git?.branch,
	});
}

/** At most this many changed files are listed by workspace_status. */
const MAX_GIT_FILES = 40;

/** What workspace_status returns: every tab with its details, terminal output and changed files. */
export function formatWorkspaceStatus(snapshot: IWorkspaceSnapshot): string {
	const lines: string[] = [];
	if (!snapshot.tabs.length) {
		lines.push('The right panel beside this chat has no tabs.');
	} else {
		lines.push(`Right panel ${snapshot.panelOpen ? 'open' : 'closed'}, ${snapshot.tabs.length} tab${snapshot.tabs.length === 1 ? '' : 's'}:`);
		for (const tab of snapshot.tabs) {
			lines.push(`- ${tab.focused && snapshot.panelOpen ? '[in front] ' : ''}${describeTab(tab)}`);
			if (tab.kind === 'device' && tab.device?.state === 'booted') {
				lines.push('  device_screenshot shows its screen; device_launch_app opens an app by bundle id or URL.');
			}
			if (tab.kind === 'browser') {
				lines.push('  browser_snapshot reads the page; browser_navigate / browser_click drive it.');
			}
			const output = tab.terminal?.output?.trim();
			if (output) {
				lines.push('  Last output:', ...output.split('\n').map(line => `  | ${line.replace(/</g, '\u2039').replace(/>/g, '\u203a')}`));
			}
		}
	}
	const git = snapshot.git;
	if (git) {
		lines.push('', describeGit(git));
		for (const file of (git.files ?? []).slice(0, MAX_GIT_FILES)) {
			lines.push(`  ${file}`);
		}
		if ((git.files?.length ?? 0) > MAX_GIT_FILES) {
			lines.push(`  [${git.files!.length - MAX_GIT_FILES} more omitted]`);
		}
	}
	return lines.join('\n');
}
