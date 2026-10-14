/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { IAgentServerRuntimeInfo } from '../common/protocol.js';

/**
 * Where one profile's agent server keeps its files. Everything lives under the profile's user
 * data dir, so a test profile gets its own server, port and token.
 */
export interface IAgentServerPaths {
	readonly userDataDir: string;
	/** `<userData>/agentServer` */
	readonly dir: string;
	readonly tokenFile: string;
	readonly runtimeFile: string;
	readonly storageDir: string;
	readonly logFile: string;
	/** launchd label (and other platforms' service name), unique per user data dir. */
	readonly label: string;
}

export function agentServerPaths(userDataDir: string): IAgentServerPaths {
	const dir = join(userDataDir, 'agentServer');
	return {
		userDataDir,
		dir,
		tokenFile: join(dir, 'token'),
		runtimeFile: join(dir, 'runtime.json'),
		storageDir: dir,
		logFile: join(userDataDir, 'logs', 'agent-server.log'),
		label: `com.volt.agent-server.${createHash('sha256').update(userDataDir).digest('hex').slice(0, 12)}`,
	};
}

/** The port a profile prefers, stable across restarts so web app URLs keep working. */
export function preferredAgentServerPort(userDataDir: string): number {
	const hash = createHash('sha256').update(userDataDir).digest();
	return 47_100 + (hash.readUInt16BE(0) % 800);
}

/** Reads the token, creating it (mode 0600) the first time. */
export async function ensureAgentServerToken(paths: IAgentServerPaths): Promise<string> {
	try {
		const token = (await fs.readFile(paths.tokenFile, 'utf8')).trim();
		if (/^[0-9a-f]{64}$/.test(token)) {
			return token;
		}
	} catch {
		// first start
	}
	await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
	const token = randomBytes(32).toString('hex');
	await writeFileAtomic(paths.tokenFile, token, 0o600);
	return token;
}

export async function readAgentServerToken(paths: IAgentServerPaths): Promise<string | undefined> {
	try {
		const token = (await fs.readFile(paths.tokenFile, 'utf8')).trim();
		return token || undefined;
	} catch {
		return undefined;
	}
}

export async function readAgentServerRuntime(paths: IAgentServerPaths): Promise<IAgentServerRuntimeInfo | undefined> {
	try {
		const info = JSON.parse(await fs.readFile(paths.runtimeFile, 'utf8')) as IAgentServerRuntimeInfo;
		return info && info.version === 1 && Number.isInteger(info.port) && Number.isInteger(info.pid) ? info : undefined;
	} catch {
		return undefined;
	}
}

export async function writeAgentServerRuntime(paths: IAgentServerPaths, info: IAgentServerRuntimeInfo): Promise<void> {
	await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
	await writeFileAtomic(paths.runtimeFile, JSON.stringify(info, undefined, '\t'), 0o600);
}

/** Removes runtime.json only if it still describes this process (a successor may have written its own). */
export async function clearAgentServerRuntime(paths: IAgentServerPaths, pid: number): Promise<void> {
	const current = await readAgentServerRuntime(paths);
	if (current?.pid === pid) {
		await fs.rm(paths.runtimeFile, { force: true });
	}
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

export async function writeFileAtomic(file: string, data: string, mode: number): Promise<void> {
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	await fs.writeFile(tmp, data, { mode });
	await fs.rename(tmp, file);
}
