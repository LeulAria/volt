/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IVoltEvent } from '../../common/events.js';

/** A booted spare nobody asked for in this long is stopped; the next request boots a new one. */
const SPARE_IDLE_MS = 5 * 60_000;

interface ISpare {
	readonly id: Promise<string | undefined>;
	idleTimer: ReturnType<typeof setTimeout>;
}

type ProcessEvent = { readonly data: string } | { readonly exited: true };

/**
 * Print-mode agent processes started ahead of the request that uses them. Each one answers a
 * single prompt and is stopped, so nothing carries over between predictions; a fresh spare boots
 * as soon as one is taken, while the user is still reading the ghost text.
 */
export class WarmPrintAgents extends Disposable {

	/** One spare per command line (Tab, composer and next-edit prompts differ). */
	private readonly spares = new Map<string, ISpare>();
	private readonly listeners = new Map<string, (event: ProcessEvent) => void>();
	/** Spares nobody has taken yet, and the ones of those that exited while waiting. */
	private readonly waiting = new Set<string>();
	private readonly exitedEarly = new Set<string>();

	constructor(private readonly stdio: IVoltStdioService) {
		super();
		this._register(stdio.onData(event => this.listeners.get(event.id)?.({ data: event.data })));
		this._register(stdio.onExit(event => {
			const listener = this.listeners.get(event.id);
			if (listener) {
				listener({ exited: true });
			} else if (this.waiting.delete(event.id)) {
				this.exitedEarly.add(event.id);
			}
		}));
	}

	/**
	 * Streams the answer to `input` (one stream-json user message) from a booted process. Returns
	 * false when the process died without answering, so the caller can run the one-shot command.
	 */
	async *ask(argv: readonly string[], cwd: string | undefined, input: string, token: CancellationToken): AsyncGenerator<IVoltEvent, boolean> {
		const key = JSON.stringify([argv, cwd]);
		const taken = this.spares.get(key);
		this.spares.delete(key);
		if (taken) {
			clearTimeout(taken.idleTimer);
		}
		const id = await (taken?.id ?? this.spawn(argv, cwd));
		// Boot the next one now: by the next pause in typing it is ready.
		this.keepSpare(key, argv, cwd);
		if (!id) {
			return false;
		}
		this.waiting.delete(id);
		if (this.exitedEarly.delete(id)) {
			return false;
		}

		const source = new AsyncIterableSource<IVoltEvent>();
		const textId = `tab-${generateUuid().slice(0, 8)}`;
		let buffer = '';
		let answered = false;
		let exited = false;
		this.listeners.set(id, event => {
			if ('exited' in event) {
				exited = true;
				source.resolve();
				return;
			}
			buffer += event.data;
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				let message: { type?: string; is_error?: boolean; result?: string; event?: { type?: string; delta?: { type?: string; text?: string } } };
				try {
					message = JSON.parse(line) as typeof message;
				} catch {
					continue;
				}
				const delta = message.event?.delta;
				if (message.type === 'stream_event' && message.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
					answered = true;
					source.emitOne({ type: 'text.delta', id: textId, delta: delta.text });
				} else if (message.type === 'result') {
					if (message.is_error) {
						source.emitOne({ type: 'error', message: (message.result || 'The agent could not answer.').slice(0, 300) });
					}
					answered = true;
					source.resolve();
				}
			}
		});
		const cancel = token.onCancellationRequested(() => source.resolve());
		try {
			await this.stdio.write(id, input);
			yield { type: 'text.start', id: textId };
			yield* source.asyncIterable;
			yield { type: 'text.end', id: textId };
		} catch {
			// The process went away before it took the prompt.
			return false;
		} finally {
			cancel.dispose();
			this.listeners.delete(id);
			void this.stdio.kill(id).catch(() => undefined);
		}
		return answered || !exited || token.isCancellationRequested;
	}

	private keepSpare(key: string, argv: readonly string[], cwd: string | undefined): void {
		const spare: ISpare = {
			id: this.spawn(argv, cwd).then(id => {
				if (id) {
					this.waiting.add(id);
				}
				return id;
			}),
			idleTimer: setTimeout(() => {
				if (this.spares.get(key) === spare) {
					this.spares.delete(key);
					this.stop(spare);
				}
			}, SPARE_IDLE_MS),
		};
		this.spares.set(key, spare);
	}

	private stop(spare: ISpare): void {
		void spare.id.then(id => {
			if (id) {
				this.waiting.delete(id);
				return this.stdio.kill(id);
			}
			return undefined;
		}).catch(() => undefined);
	}

	private spawn(argv: readonly string[], cwd: string | undefined): Promise<string | undefined> {
		return this.stdio.spawn({ command: argv[0], args: argv.slice(1), cwd }).catch(() => undefined);
	}

	override dispose(): void {
		for (const spare of this.spares.values()) {
			clearTimeout(spare.idleTimer);
			this.stop(spare);
		}
		this.spares.clear();
		super.dispose();
	}
}
