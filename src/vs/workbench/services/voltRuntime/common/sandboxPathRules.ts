/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute } from '../../../../base/common/path.js';
import { basename, dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { filesPlan, ISandboxPathContext } from '../../../../platform/voltFiles/common/filesBroker.js';
import { chatSubject } from '../../../../platform/voltSandbox/common/principals.js';
import { IVoltSandboxSettings } from '../../../../platform/voltSandbox/common/sandboxPolicy.js';
import type { IVoltHostToolCall } from './hostTools.js';
import { isSandboxed } from './hostToolSandbox.js';

/**
 * The files broker's rules for a sandboxed chat's call, where the gate's own functions are not at
 * hand: a window serving a tool call for the agent server gets the call's sandbox and the folders
 * the gate judged by (`sandboxPaths`), never the gate's closures. Same plan as the gate's
 * (`filesPlan` on the real path); the gate's Policy Authority already decided the call itself.
 */
export function sandboxPathRules(settings: IVoltSandboxSettings, sessionId: string | undefined, context: ISandboxPathContext, realPath: (path: string) => Promise<string>): Pick<IVoltHostToolCall, 'readRefusal' | 'writeRefusal'> {
	const subject = chatSubject(sessionId ?? '(none)');
	const scope = { roots: context.roots, platform: context.platform, chat: settings, ...(context.home ? { home: context.home } : {}), ...(context.tmpdir ? { tmpdir: context.tmpdir } : {}) };
	const rule = (access: 'read' | 'write') => async (path: string): Promise<string | undefined> => {
		if (!isAbsolute(path)) {
			return `${path} is not an absolute path`;
		}
		return filesPlan(subject, await realPath(path), access, scope).refusal;
	};
	return { readRefusal: rule('read'), writeRefusal: rule('write') };
}

/**
 * A call as a provider should see it: a sandboxed chat's call that arrived without the gate's rules
 * (over the agent server's socket) gets them from `sandboxPaths`; without those it stays without,
 * and providers that need them refuse.
 */
export function withSandboxPathRules(call: IVoltHostToolCall, fileService: IFileService): IVoltHostToolCall {
	if (!isSandboxed(call.sandbox) || (call.readRefusal && call.writeRefusal) || !call.sandboxPaths) {
		return call;
	}
	return { ...call, ...sandboxPathRules(call.sandbox, call.sessionId, call.sandboxPaths, path => realPathThrough(fileService, URI.file(path))) };
}

/** `uri` through symlinks: its own real path, or its deepest existing folder's plus the rest (a file about to be created). */
export async function realPathThrough(fileService: IFileService, uri: URI): Promise<string> {
	let current = uri;
	const rest: string[] = [];
	for (let depth = 0; depth < 64; depth++) {
		const real = await fileService.realpath(current).catch(() => undefined);
		if (real) {
			return (rest.length ? joinPath(real, ...[...rest].reverse()) : real).fsPath;
		}
		const parent = dirname(current);
		if (parent.path === current.path) {
			break;
		}
		rest.push(basename(current));
		current = parent;
	}
	return uri.fsPath;
}
