/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { codexContextIndex, parseCodexModels } from '../../common/models/harnessCatalog.js';
import { IModelInfo } from '../../common/providers.js';
import { probeCodexAuth, readHomeFile, runCli } from './cliAgents.js';

const QUERY_TIMEOUT_MS = 12_000;

/**
 * Codex builds that speak `app-server`. The npm `codex` shim on PATH is often an older CLI
 * whose `acp` command never returns a model list, so these are tried first.
 */
const CODEX_APP_SERVER_CANDIDATES = [
	'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
	'/Applications/Conductor.app/Contents/Resources/bin/codex',
];

let resolvedCommand: string | undefined;
let inflight: Promise<IModelInfo[]> | undefined;

interface IRpcMessage {
	id?: string | number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message?: string };
}

/**
 * Logged-in Codex models, with effort, fast mode, and context windows from the CLI.
 * The first successful read is reused until the process restarts.
 */
export async function listCodexModels(stdio: IVoltStdioService, preferredCommand?: string): Promise<IModelInfo[]> {
	const auth = await probeCodexAuth(stdio).catch(() => undefined);
	if (!auth) {
		inflight = undefined;
		return [];
	}
	if (!inflight) {
		inflight = loadCodexModels(stdio, preferredCommand).then(models => {
			if (!models.length) {
				inflight = undefined;
			}
			return models;
		}, err => {
			inflight = undefined;
			throw err;
		});
	}
	return inflight;
}

async function loadCodexModels(stdio: IVoltStdioService, preferredCommand?: string): Promise<IModelInfo[]> {
	const auth = await probeCodexAuth(stdio).catch(() => undefined);
	if (!auth) {
		return [];
	}
	const cacheRaw = await readHomeFile(stdio, '.codex/models_cache.json');
	const context = codexContextIndex(parseJson(cacheRaw));
	const live = await queryAppServer(stdio, preferredCommand);
	if (live.length) {
		return parseCodexModels(live, context);
	}
	return parseCodexModels(parseJson(cacheRaw));
}

function parseJson(raw: string | undefined): unknown {
	if (!raw) {
		return undefined;
	}
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

async function queryAppServer(stdio: IVoltStdioService, preferredCommand?: string): Promise<unknown[] | undefined> {
	const command = resolvedCommand ?? await resolveCodexCommand(stdio, preferredCommand);
	if (!command) {
		return undefined;
	}
	const listed = await requestModelList(stdio, command);
	if (listed) {
		resolvedCommand = command;
	}
	return listed;
}

async function resolveCodexCommand(stdio: IVoltStdioService, preferredCommand?: string): Promise<string | undefined> {
	const plugin = isWindows
		? undefined
		: await runCli(stdio, '/bin/sh', ['-c', 'printf %s "$HOME/.codex/plugins/.plugin-appserver/codex-cli/bin/codex"'], 3000);
	const candidates = [...CODEX_APP_SERVER_CANDIDATES, plugin?.trim(), preferredCommand].filter((value): value is string => !!value);
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		const help = await runCli(stdio, candidate, ['app-server', '--help'], 4000);
		if (help?.includes('stdio://')) {
			return candidate;
		}
	}
	return undefined;
}

async function requestModelList(stdio: IVoltStdioService, command: string): Promise<unknown[] | undefined> {
	let processId: string;
	try {
		processId = await stdio.spawn({ command, args: ['app-server', '--stdio'] });
	} catch {
		return undefined;
	}
	const store = new DisposableStore();
	let buffer = '';
	let nextId = 1;
	const pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
	const fail = (err: Error) => {
		for (const waiter of pending.values()) {
			waiter.reject(err);
		}
		pending.clear();
	};
	store.add(stdio.onData(event => {
		if (event.id !== processId) {
			return;
		}
		buffer += event.data;
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			let message: IRpcMessage;
			try {
				message = JSON.parse(trimmed) as IRpcMessage;
			} catch {
				continue;
			}
			if (message.id !== undefined && message.method) {
				void stdio.write(processId, JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
				continue;
			}
			if (message.id === undefined) {
				continue;
			}
			const waiter = pending.get(String(message.id));
			if (!waiter) {
				continue;
			}
			pending.delete(String(message.id));
			if (message.error) {
				waiter.reject(new Error(message.error.message || 'Codex model/list failed'));
			} else {
				waiter.resolve(message.result);
			}
		}
	}));
	store.add(stdio.onExit(event => {
		if (event.id === processId) {
			fail(new Error('Codex app-server exited'));
		}
	}));
	const request = (method: string, params: unknown) => {
		const id = nextId++;
		const result = new Promise<unknown>((resolve, reject) => pending.set(String(id), { resolve, reject }));
		void stdio.write(processId, JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n').catch(err => {
			fail(err instanceof Error ? err : new Error(String(err)));
		});
		return result;
	};
	const timer = setTimeout(() => fail(new Error('Codex model/list timed out')), QUERY_TIMEOUT_MS);
	try {
		await request('initialize', { clientInfo: { name: 'volt', title: 'Volt', version: '0.1.0' } });
		const pages: unknown[] = [];
		let cursor: string | undefined;
		do {
			const page = await request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }) as { data?: unknown[]; nextCursor?: string | null };
			pages.push(...(page?.data ?? []));
			cursor = page?.nextCursor || undefined;
		} while (cursor);
		return pages;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		store.dispose();
		await stdio.kill(processId).catch(() => undefined);
	}
}
