/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Where Volt keeps things. The agent server's files are the desktop's own
// (src/vs/platform/voltAgentServer/node/agentServerFiles.ts), so `npx volt-run` and the Volt app
// find and share the same server, chats and settings.

import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import qualities from '../../../build/volt/qualities.json' with { type: 'json' };

export const CHANNELS = ['stable', 'beta', 'nightly'];

/**
 * A channel's names, as the release build stamps them into product.json.
 * @param {string} channel
 * @returns {{ nameShort: string, nameLong: string, applicationName: string, dataFolderName: string, win32DirName: string }}
 */
export function channelProduct(channel) {
	const product = qualities[channel]?.product;
	if (!product) {
		throw new Error(`Unknown channel "${channel}". Use ${CHANNELS.join(', ')}.`);
	}
	return product;
}

/**
 * The desktop's user data dir for a product name (src/vs/platform/environment/node/userDataPath.ts).
 * @param {string} productName
 * @param {{ platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, home?: string }} [o]
 */
export function userDataDir(productName, o = {}) {
	const platform = o.platform ?? process.platform;
	const env = o.env ?? process.env;
	const home = o.home ?? os.homedir();
	const p = platform === 'win32' ? path.win32 : path.posix;
	if (env.VSCODE_APPDATA) {
		return p.join(env.VSCODE_APPDATA, productName);
	}
	switch (platform) {
		case 'win32':
			return p.join(env.APPDATA || p.join(env.USERPROFILE || home, 'AppData', 'Roaming'), productName);
		case 'darwin':
			return p.join(home, 'Library', 'Application Support', productName);
		default:
			return p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), productName);
	}
}

/**
 * One profile's agent server files, named as the desktop names them.
 * @param {string} dir the profile (user data dir)
 */
export function agentServerPaths(dir) {
	const serverDir = path.join(dir, 'agentServer');
	return {
		userDataDir: dir,
		dir: serverDir,
		tokenFile: path.join(serverDir, 'token'),
		runtimeFile: path.join(serverDir, 'runtime.json'),
		networkFile: path.join(serverDir, 'network.json'),
		compileCacheDir: path.join(serverDir, 'compile-cache'),
		logFile: path.join(dir, 'logs', 'agent-server.log'),
		label: `com.volt.agent-server.${createHash('sha256').update(dir).digest('hex').slice(0, 12)}`,
	};
}

/**
 * The port a profile's server prefers (it takes another when this one is busy).
 * @param {string} dir
 */
export function preferredPort(dir) {
	return 47_100 + (createHash('sha256').update(dir).digest().readUInt16BE(0) % 800);
}

/** Downloaded Volt builds, one folder per version and platform. */
export function runtimeCacheDir(env = process.env, home = os.homedir()) {
	return env.VOLT_RUN_CACHE || path.join(home, '.volt', 'runtime');
}

/**
 * `~/Library/...` for a path under the home folder, for messages.
 * @param {string} file
 */
export function tildify(file, home = os.homedir()) {
	return file === home || file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file;
}
