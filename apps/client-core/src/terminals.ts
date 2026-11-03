/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VoltConnection } from './connection';

/**
 * The agents' terminals, as the desktop's Terminals tab shows them. The agent server publishes
 * each one in its `terminals` collection (serverTerminals.ts); a viewer `terminals.attach`es to
 * read what it wrote so far and then gets its output as `terminals.data` calls, and its end as
 * `terminals.exit`. Only Volt on the computer may type into one.
 */

/** Lifecycle of a managed terminal (voltRuntime/common/terminalTools.ts). */
export type TerminalStatus = 'starting' | 'running' | 'ready' | 'attention' | 'stopping' | 'completed' | 'failed' | 'stopped';

export interface ITerminalInfo {
	readonly id: string;
	/** The chat that owns it (a subagent's terminals belong to its parent chat). */
	readonly chatId: string;
	readonly command: string;
	readonly label: string;
	readonly cwd?: string;
	readonly status: TerminalStatus;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly lastActivity: number;
	readonly exitCode?: number;
	readonly urls: readonly string[];
	/** Why it failed, or the last error-looking line while it runs. */
	readonly error?: string;
	readonly viewable: boolean;
	/** `agent-task`: a command a CLI agent runs in the background itself; Volt only watches it. */
	readonly kind: 'terminal' | 'agent-task';
	readonly outputFile?: string;
}

export function isTerminalLive(status: TerminalStatus): boolean {
	return status === 'starting' || status === 'running' || status === 'ready' || status === 'attention' || status === 'stopping';
}

export function terminalStatusLabel(info: ITerminalInfo): string {
	switch (info.status) {
		case 'starting': return 'Starting';
		case 'running': return 'Running';
		case 'ready': return info.urls.length ? 'Ready' : 'Running';
		case 'attention': return 'Waiting for input';
		case 'stopping': return 'Stopping';
		case 'completed': return 'Done';
		case 'failed': return info.exitCode !== undefined ? `Failed (exit ${info.exitCode})` : 'Failed';
		case 'stopped': return 'Stopped';
	}
}

function asInfo(value: unknown): ITerminalInfo | undefined {
	const v = value as Partial<ITerminalInfo> | undefined;
	return v && typeof v.id === 'string' && typeof v.chatId === 'string' && typeof v.command === 'string' ? v as ITerminalInfo : undefined;
}

/** A chat's terminals: running ones first, then the rest, newest first. */
export function chatTerminals(collection: Readonly<Record<string, unknown>> | undefined, chatId: string): ITerminalInfo[] {
	const out: ITerminalInfo[] = [];
	for (const value of Object.values(collection ?? {})) {
		const info = asInfo(value);
		if (info && info.chatId === chatId && info.viewable !== false) {
			out.push(info);
		}
	}
	return out.sort((a, b) => Number(isTerminalLive(b.status)) - Number(isTerminalLive(a.status)) || b.startedAt - a.startedAt);
}

//#region Output

/** Characters of output a viewer keeps (the server keeps 1M; a phone needs the end). */
const KEEP_CHARS = 200_000;

// CSI (ESC [ … final), OSC (ESC ] … BEL or ESC \), and other two-character escapes.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b[()][0-9A-Za-z]/g;

/**
 * A terminal's output as plain text: escape sequences dropped, a carriage return rewriting its
 * line (progress bars), backspaces taking a character back. Raw chunks can split anywhere, so a
 * trailing partial escape waits for the next chunk.
 */
export class TerminalText {
	private lines: string[] = [''];
	private carry = '';
	private chars = 0;
	/** Characters of raw output taken in so far (the server's offset). */
	offset = 0;

	get text(): string {
		return this.lines.join('\n');
	}

	reset(): void {
		this.lines = [''];
		this.carry = '';
		this.chars = 0;
		this.offset = 0;
	}

	append(raw: string): void {
		this.offset += raw.length;
		let data = this.carry + raw;
		this.carry = '';
		const partial = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|\x1b?)?$/.exec(data);
		if (partial && partial[0]) {
			this.carry = partial[0];
			data = data.slice(0, partial.index);
		}
		data = data.replace(ESCAPES, '');
		let line = this.lines.pop() ?? '';
		let col = line.length;
		for (let i = 0; i < data.length; i++) {
			const ch = data[i];
			if (ch === '\n') {
				this.lines.push(line);
				this.chars += line.length + 1;
				line = '';
				col = 0;
			} else if (ch === '\r') {
				if (data[i + 1] !== '\n') {
					col = 0;
				}
			} else if (ch === '\b') {
				col = Math.max(0, col - 1);
			} else if (ch >= ' ' || ch === '\t') {
				line = col >= line.length ? line + ch : line.slice(0, col) + ch + line.slice(col + 1);
				col++;
			}
		}
		this.lines.push(line);
		if (this.chars > KEEP_CHARS) {
			while (this.chars > KEEP_CHARS * 0.8 && this.lines.length > 1) {
				this.chars -= this.lines.shift()!.length + 1;
			}
		}
	}
}

export interface ITerminalStreamState {
	readonly text: string;
	/** Set once it ended: its exit code, or null when it has none. */
	readonly exitCode?: number | null;
	readonly gone?: boolean;
	readonly loading: boolean;
}

const streams = new Map<string, Set<TerminalStream>>();
const installed = new WeakSet<VoltConnection>();

/** Routes the server's `terminals.data` / `terminals.exit` calls to the streams showing that terminal. */
function install(connection: VoltConnection): void {
	if (installed.has(connection)) {
		return;
	}
	installed.add(connection);
	connection.handle('terminals.data', (id, from, data) => {
		for (const stream of streams.get(String(id)) ?? []) {
			stream.receive(typeof from === 'number' ? from : 0, typeof data === 'string' ? data : '');
		}
		return true;
	});
	connection.handle('terminals.exit', (id, exitCode) => {
		for (const stream of streams.get(String(id)) ?? []) {
			stream.ended(typeof exitCode === 'number' ? exitCode : null);
		}
		return true;
	});
	connection.onWelcome(() => {
		// A new socket has no viewers on the server: every open stream attaches again where it was.
		for (const set of streams.values()) {
			for (const stream of set) {
				void stream.attach();
			}
		}
	});
}

/** One view of one terminal: attach, follow its output, detach on dispose. */
export class TerminalStream {
	private readonly buffer = new TerminalText();
	private state: ITerminalStreamState = { text: '', loading: true };
	private readonly listeners = new Set<(state: ITerminalStreamState) => void>();
	private disposed = false;
	private notifyTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly connection: VoltConnection, readonly id: string) {
		install(connection);
		let set = streams.get(id);
		if (!set) {
			set = new Set();
			streams.set(id, set);
		}
		set.add(this);
		void this.attach();
	}

	get current(): ITerminalStreamState {
		return this.state;
	}

	onChange(listener: (state: ITerminalStreamState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async attach(): Promise<void> {
		if (this.disposed || this.connection.status.phase !== 'open') {
			return;
		}
		try {
			const result = await this.connection.call<{ readonly from?: number; readonly data?: string; readonly exitCode?: number | null; readonly gone?: boolean }>('terminals.attach', [this.id, this.buffer.offset, 120, 30]);
			if (this.disposed) {
				return;
			}
			if (result?.gone) {
				this.set({ gone: true, loading: false });
				return;
			}
			this.receive(result?.from ?? 0, result?.data ?? '');
			this.set({ loading: false, ...(result && 'exitCode' in result && result.exitCode !== undefined ? { exitCode: result.exitCode } : {}) });
		} catch {
			this.set({ loading: false });
		}
	}

	receive(from: number, data: string): void {
		if (from < this.buffer.offset) {
			// Overlap: skip what is already here; when part of it rolled off the server, start over.
			if (from + data.length <= this.buffer.offset) {
				return;
			}
			data = data.slice(this.buffer.offset - from);
		} else if (from > this.buffer.offset) {
			this.buffer.reset();
			this.buffer.offset = from;
		}
		this.buffer.append(data);
		this.schedule();
	}

	ended(exitCode: number | null): void {
		this.set({ exitCode });
	}

	private schedule(): void {
		this.notifyTimer ??= setTimeout(() => {
			this.notifyTimer = undefined;
			this.set({});
		}, 50);
	}

	private set(patch: Partial<ITerminalStreamState>): void {
		this.state = { ...this.state, ...patch, text: this.buffer.text };
		for (const listener of this.listeners) {
			listener(this.state);
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.notifyTimer) {
			clearTimeout(this.notifyTimer);
		}
		this.listeners.clear();
		const set = streams.get(this.id);
		set?.delete(this);
		if (set && !set.size) {
			streams.delete(this.id);
			if (this.connection.status.phase === 'open') {
				this.connection.call('terminals.detach', [this.id]).catch(() => undefined);
			}
		}
	}
}

//#endregion
