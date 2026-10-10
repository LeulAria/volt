/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVoltVisualConsoleMessage } from '../common/voltVisualPreview.js';

interface IRemoteObject {
	readonly type?: string;
	readonly value?: unknown;
	readonly description?: string;
	readonly unserializableValue?: string;
}

interface IStackFrame {
	readonly functionName?: string;
	readonly url?: string;
	readonly lineNumber?: number;
	readonly columnNumber?: number;
}

function describeArg(arg: IRemoteObject): string {
	if (arg.type === 'string' && typeof arg.value === 'string') {
		return arg.value;
	}
	if (arg.unserializableValue) {
		return arg.unserializableValue;
	}
	if (arg.value !== undefined) {
		try {
			return JSON.stringify(arg.value);
		} catch {
			// fall through to the description
		}
	}
	return arg.description ?? String(arg.type ?? '');
}

function describeStack(frames: readonly IStackFrame[] | undefined): string {
	return (frames ?? []).slice(0, 4).map(frame => {
		const file = frame.url ? frame.url.replace(/^.*\//, '') : 'page.html';
		return `\n    at ${frame.functionName || '<anonymous>'} (${file}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1})`;
	}).join('');
}

/** The parts of `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` and `Log.entryAdded` read here. */
export interface ICdpConsoleParams {
	readonly type?: string;
	readonly args?: readonly IRemoteObject[];
	readonly exceptionDetails?: { readonly text?: string; readonly exception?: { readonly description?: string }; readonly stackTrace?: { readonly callFrames?: readonly IStackFrame[] } };
	readonly entry?: { readonly level?: string; readonly text?: string; readonly url?: string };
}

/**
 * A DevTools protocol event as a console line: `console.*` calls, uncaught exceptions with their
 * stack, and the browser's own errors and warnings (failed loads, CORS). Undefined for other events.
 */
export function consoleMessageOf(method: string, params: ICdpConsoleParams): IVoltVisualConsoleMessage | undefined {
	if (method === 'Runtime.consoleAPICalled') {
		const level = params.type === 'error' || params.type === 'assert' ? 'error' : params.type === 'warning' ? 'warning' : params.type === 'info' ? 'info' : 'log';
		return { level, text: (params.args ?? []).map(describeArg).join(' ').slice(0, 2000) };
	}
	if (method === 'Runtime.exceptionThrown') {
		const details = params.exceptionDetails ?? {};
		return { level: 'error', text: `Uncaught ${details.exception?.description ?? details.text ?? 'error'}${details.exception?.description ? '' : describeStack(details.stackTrace?.callFrames)}`.slice(0, 2000) };
	}
	if (method === 'Log.entryAdded') {
		const entry = params.entry;
		if (entry?.level === 'error' || entry?.level === 'warning') {
			return { level: entry.level, text: `${entry.text ?? ''}${entry.url ? ` (${entry.url})` : ''}`.slice(0, 2000) };
		}
	}
	return undefined;
}
