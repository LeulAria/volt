/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { IVoltChatFileRequest, IVoltChatFileResult, IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IChatExec } from '../../common/execContext.js';
import { IVoltHostToolCall, IVoltHostToolService } from '../../common/hostTools.js';

/**
 * A sandboxed chat's files, as its native model's file tools reach them (SEC3-1). Those tools run in
 * Volt's own process, outside the OS sandbox the chat's shell runs in. So every operation is judged
 * first by the host-tool gate's rule on the path's real path, the same rule as a host tool's paths
 * (`IVoltHostToolService.sandboxFileRefusal`: the chat's workspace, allowed folders and temp; no
 * credential folders or secret files; no files that run code outside the sandbox; nothing written
 * at read-only), and then performed race-free by the execution host (`IVoltStdioService.chatFile`:
 * no symlink anywhere in the path, the rule judged again on the opened file). Where either half is
 * missing, the operation is refused, never done unconfined.
 */
export interface IFileToolSandbox {
	/** Why the chat may not `access` `uri`, or undefined when it may. */
	refusal(uri: URI, access: 'read' | 'write'): Promise<string | undefined>;
	read(uri: URI, options?: { readonly encoding?: 'utf8' | 'base64'; readonly maxBytes?: number }): Promise<IVoltChatFileResult>;
	/** `expected`: the text the file must hold now (the edit was made against it). */
	write(uri: URI, text: string, expected?: string): Promise<IVoltChatFileResult>;
	delete(uri: URI): Promise<IVoltChatFileResult>;
}

/** The sandbox of the chat `exec` runs for, as its file tools apply it; undefined when the chat is not sandboxed. */
export function fileToolSandbox(exec: IChatExec, hostTools: IVoltHostToolService, stdio: IVoltStdioService, root: URI | undefined): IFileToolSandbox | undefined {
	const request = exec.sandbox;
	if (!request) {
		return undefined;
	}
	const principal = exec.context.principal;
	const chatId = principal.startsWith('chat:') ? principal.slice('chat:'.length) : undefined;
	const settings: IVoltSandboxSettings = {
		level: request.level,
		network: request.network,
		...(request.extraWritableRoots?.length ? { extraWritableRoots: request.extraWritableRoots } : {}),
		...(request.allowedDomains?.length ? { allowedDomains: request.allowedDomains } : {}),
		...(request.listenPorts?.length ? { listenPorts: request.listenPorts } : {}),
	};
	const roots = [...new Set([...(root?.scheme === Schemas.file ? [root.fsPath] : []), ...request.workspaceRoots])];
	const call: IVoltHostToolCall = { ...(chatId ? { sessionId: chatId } : {}), source: 'native', sandbox: settings, ...(root?.scheme === Schemas.file ? { cwd: root.fsPath } : {}) };
	const judge = async (uri: URI, access: 'read' | 'write'): Promise<string | undefined> => {
		if (!chatId) {
			return 'Volt does not know which sandboxed chat this is for';
		}
		if (uri.scheme !== Schemas.file) {
			return `${uri.toString(true)} is not a local file`;
		}
		if (!hostTools.sandboxFileRefusal) {
			return 'Volt cannot judge this sandboxed chat\'s files here';
		}
		return hostTools.sandboxFileRefusal(call, uri.fsPath, access).catch(err => `Volt could not judge ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
	};
	const perform = async (uri: URI, access: 'read' | 'write', op: Omit<IVoltChatFileRequest, 'path' | 'chatId' | 'sandbox' | 'roots'>): Promise<IVoltChatFileResult> => {
		const why = await judge(uri, access);
		if (why) {
			return { ok: false, reason: why, refusal: 'floor' };
		}
		if (!stdio.chatFile) {
			return { ok: false, reason: 'Volt cannot open files safely for this sandboxed chat here' };
		}
		return stdio.chatFile({ ...op, path: uri.fsPath, chatId: chatId!, sandbox: settings, roots });
	};
	return {
		refusal: judge,
		read: (uri, options) => perform(uri, 'read', { op: 'read', ...(options?.encoding ? { encoding: options.encoding } : {}), ...(options?.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}) }),
		write: (uri, text, expected) => perform(uri, 'write', { op: 'write', content: text, ...(expected !== undefined ? { expected } : {}) }),
		delete: uri => perform(uri, 'write', { op: 'delete' }),
	};
}

/** What the model reads when its sandbox refused a file operation. */
export function sandboxedFileMessage(tool: string, shown: string, access: 'read' | 'write', reason: string): string {
	const rule = access === 'read'
		? 'A sandboxed chat reads files only in its workspace, the folders the user allowed, and temp folders, never credentials or secrets.'
		: 'A sandboxed chat changes files only where its sandbox lets its own commands write: not files that run code outside the sandbox (git config and hooks, editor tasks and settings, agent hooks), and nothing at read-only.';
	return `${tool} did not run on ${shown}: ${reason}. ${rule}`;
}
