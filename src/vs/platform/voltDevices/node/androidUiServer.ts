/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcess } from 'child_process';

/** Where the reader's dex lives on the device; the number changes with `UiServer.VERSION`. */
export const ANDROID_UI_SERVER_JAR = '/data/local/tmp/volt-ui-1.jar';

/** The shell command that starts the reader on the device. */
export const ANDROID_UI_SERVER_COMMAND = `CLASSPATH=${ANDROID_UI_SERVER_JAR} app_process / volt.UiServer`;

/** Android's KeyEvent codes for the keys Volt presses through the reader. */
export const ANDROID_KEY_NUMBERS: Readonly<Record<string, number>> = {
	KEYCODE_HOME: 3,
	KEYCODE_BACK: 4,
	KEYCODE_VOLUME_UP: 24,
	KEYCODE_VOLUME_DOWN: 25,
	KEYCODE_POWER: 26,
	KEYCODE_ENTER: 66,
	KEYCODE_DEL: 67,
	KEYCODE_MOVE_END: 123,
	KEYCODE_APP_SWITCH: 187,
	KEYCODE_ASSIST: 219,
};

interface IWaiter {
	readonly resolve: (line: string) => void;
	readonly reject: (err: Error) => void;
}

/**
 * Talks to `UiServer` on one device: one command per line out, one reply per line back, in order.
 * The process starts on the first request (after `start` pushes the dex) and is started again
 * after it exits. A request that does not answer in time kills it, so a stuck device never
 * blocks the next one; the caller falls back to `uiautomator`.
 */
export class AndroidUiServer {

	private child: ChildProcess | undefined;
	private starting: Promise<ChildProcess> | undefined;
	private buffer = '';
	private readonly waiting: IWaiter[] = [];
	private queue: Promise<unknown> = Promise.resolve();
	private disposed = false;

	constructor(private readonly start: () => Promise<ChildProcess>) { }

	/** Sends `command` once the requests before it are answered. */
	request(command: string, timeoutMs: number): Promise<string> {
		const next = this.queue.then(() => this.send(command, timeoutMs));
		this.queue = next.catch(() => undefined);
		return next;
	}

	dispose(): void {
		this.disposed = true;
		this.stop(new Error('The UI reader was closed.'));
	}

	private stop(err: Error): void {
		const child = this.child;
		this.child = undefined;
		this.starting = undefined;
		this.buffer = '';
		for (const waiter of this.waiting.splice(0)) {
			waiter.reject(err);
		}
		if (child && child.exitCode === null) {
			child.kill();
		}
	}

	private running(): Promise<ChildProcess> {
		if (this.disposed) {
			return Promise.reject(new Error('The UI reader was closed.'));
		}
		if (this.child) {
			return Promise.resolve(this.child);
		}
		this.starting ??= this.launch().catch(err => {
			// The next request tries a fresh start.
			this.starting = undefined;
			throw err;
		});
		return this.starting;
	}

	private async launch(): Promise<ChildProcess> {
		const child = await this.start();
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			this.buffer += chunk;
			for (let at = this.buffer.indexOf('\n'); at >= 0; at = this.buffer.indexOf('\n')) {
				const line = this.buffer.slice(0, at).replace(/\r$/, '');
				this.buffer = this.buffer.slice(at + 1);
				this.waiting.shift()?.resolve(line);
			}
		});
		const ended = (err: Error) => {
			// While starting, `this.child` is not set yet: the hello waiter is the one to fail.
			if (this.child === child || !this.child) {
				this.stop(err);
			}
		};
		child.on('exit', () => ended(new Error('The UI reader exited.')));
		child.on('error', err => ended(err));
		// The first line says it connected: `VOLT-UI <version> <sdk>`.
		const hello = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				ended(new Error('The UI reader did not start in time.'));
				if (child.exitCode === null) {
					child.kill();
				}
			}, 8000);
			this.waiting.push({
				resolve: line => {
					clearTimeout(timer);
					resolve(line);
				},
				reject: err => {
					clearTimeout(timer);
					reject(err);
				},
			});
		});
		if (!hello.startsWith('VOLT-UI ')) {
			child.kill();
			throw new Error(`The UI reader did not start: ${hello.slice(0, 200)}`);
		}
		this.child = child;
		return child;
	}

	private async send(command: string, timeoutMs: number): Promise<string> {
		const child = await this.running();
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.stop(new Error(`The UI reader did not answer "${command.split(' ')[0]}" in time.`));
			}, timeoutMs);
			this.waiting.push({
				resolve: line => {
					clearTimeout(timer);
					resolve(line);
				},
				reject: err => {
					clearTimeout(timer);
					reject(err);
				},
			});
			child.stdin?.write(`${command}\n`);
		});
	}
}
