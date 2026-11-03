/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';

/**
 * How to open a URL here: `$BROWSER` when set (`none` turns it off), else the system's opener.
 * Undefined when there is no desktop to open it on (an SSH session, a server).
 * @param {string} url
 * @returns {{ command: string, args: string[], verbatim?: boolean } | undefined}
 */
export function browserCommand(url, { platform = process.platform, env = process.env } = {}) {
	if (env.BROWSER === 'none') {
		return undefined;
	}
	if (env.BROWSER) {
		return { command: env.BROWSER, args: [url] };
	}
	if (platform === 'darwin') {
		return env.SSH_CONNECTION && !env.TERM_PROGRAM ? undefined : { command: 'open', args: [url] };
	}
	if (platform === 'win32') {
		// `start` treats a first quoted argument as the window title, and & as a command separator.
		return { command: 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${url.replace(/&/g, '^&')}"`], verbatim: true };
	}
	if (env.WSL_DISTRO_NAME) {
		return { command: 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${url.replace(/&/g, '^&')}"`], verbatim: true };
	}
	return env.DISPLAY || env.WAYLAND_DISPLAY ? { command: 'xdg-open', args: [url] } : undefined;
}

/**
 * Opens the URL in the default browser. Resolves false when it could not (the caller prints it).
 * @param {string} url
 */
export function openBrowser(url, o = {}) {
	const command = browserCommand(url, o);
	if (!command) {
		return Promise.resolve(false);
	}
	return new Promise(resolve => {
		const child = spawn(command.command, command.args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: command.verbatim });
		child.once('error', () => resolve(false));
		child.once('spawn', () => {
			child.unref();
			resolve(true);
		});
	});
}
