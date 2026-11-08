/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { FileAccess } from '../../../base/common/network.js';
import { dirname, isAbsolute, join, normalize, sep } from '../../../base/common/path.js';
import { IResolvedSandboxPolicy, resolvedPolicyAllows } from '../../voltSandbox/common/sandboxResolved.js';
import { ISafeOpenOptions, ISafeOpenRequest, realPathOfNearest, SafeOpenError, safeReadFile, safeWriteFile } from './safeOpen.js';

/**
 * Files Volt reads and writes for a sandboxed workload (ACP `fs/*`): the workload's own policy,
 * checked on the real path, then a race-free open (`safeOpen.ts`) whose final path is checked
 * again. The deepest folder of the policy that holds the file is the open's root.
 */

/** Where `volt-fsd` (the Linux helper) is: bundled with the app, or built into `.build` in a checkout. */
export function defaultFsdPath(): string | undefined {
	if (process.platform !== 'linux') {
		return undefined;
	}
	const appRoot = dirname(FileAccess.asFileUri('').fsPath);
	return [join(appRoot, 'bin', 'volt-fsd'), join(appRoot, '.build', 'volt-fsd')].find(path => existsSync(path));
}

function inside(path: string, root: string, fold: (s: string) => string): boolean {
	const p = fold(path);
	const r = fold(root);
	return r === sep || p === r || p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

/** The safe-open request for `path` under `policy`, or a refusal (thrown) when the policy does not allow it. */
export async function policyFileRequest(policy: IResolvedSandboxPolicy, path: string, access: 'read' | 'write'): Promise<ISafeOpenRequest> {
	const verb = access === 'write' ? 'writing' : 'reading';
	if (!isAbsolute(path)) {
		throw new SafeOpenError('outside', `${path} is not an absolute path`);
	}
	const given = normalize(path);
	const resolved = await realPathOfNearest(given);
	// Both spellings must pass: the OS checks the resolved path, and the agent named the given one.
	if (!resolvedPolicyAllows(policy, given, access) || !resolvedPolicyAllows(policy, resolved, access)) {
		throw new SafeOpenError('floor', `the sandbox does not allow ${verb} ${path}`);
	}
	const fold = policy.platform === 'darwin' || policy.platform === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s;
	const roots = [
		...policy.write,
		...policy.writeFiles.map(file => dirname(file)),
		...(access === 'read' ? policy.read : []),
	].filter(root => isAbsolute(root) && resolved !== root && inside(resolved, root, fold));
	let root = roots.sort((a, b) => b.length - a.length)[0];
	if (!root && access === 'read' && policy.readAll) {
		root = resolved.slice(0, resolved.indexOf(sep) + 1) || sep;
	}
	if (!root) {
		throw new SafeOpenError('floor', `the sandbox does not allow ${verb} ${path}`);
	}
	return {
		root,
		path: resolved,
		refuseHardLinks: access === 'write',
		floor: final => resolvedPolicyAllows(policy, final, access) ? undefined : `the sandbox does not allow ${verb} ${final}`,
	};
}

/** Reads `path` for a workload under `policy`. Throws a {@link SafeOpenError} on refusal. */
export async function brokerReadFile(policy: IResolvedSandboxPolicy, path: string, options: ISafeOpenOptions = {}): Promise<{ readonly content: Buffer; readonly finalPath: string }> {
	return safeReadFile(await policyFileRequest(policy, path, 'read'), options);
}

/** Writes `path` for a workload under `policy`. Throws a {@link SafeOpenError} on refusal. */
export async function brokerWriteFile(policy: IResolvedSandboxPolicy, path: string, content: Uint8Array, options: ISafeOpenOptions = {}): Promise<{ readonly before: Buffer | undefined; readonly finalPath: string }> {
	return safeWriteFile(await policyFileRequest(policy, path, 'write'), content, options);
}
