/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IProcessDataEvent, IProcessProperty, IProcessPropertyMap, IProcessReadyEvent, ITerminalChildProcess, ITerminalLaunchError, ProcessPropertyType, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { isTerminalLive } from '../../../../services/voltRuntime/common/terminalTools.js';
import { AGENT_TERMINAL_ENV, describeAgentTerminalStatus, IAgentTerminalInfo } from '../../../../services/voltRuntime/common/terminals/managedTerminals.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalInstanceService } from '../../../terminal/browser/terminal.js';

/** The output file is read at most this often while the task runs. */
const READ_MS = 500;
/** Most of the file read in one go. */
const READ_CHUNK = 256 * 1024;

/**
 * A CLI agent's background command (it runs it itself and writes its output to a file) as a
 * read-only terminal: the command, everything it printed so far, then whatever it prints next,
 * and how it ended. Nothing is sent to the command; closing the view leaves it running.
 */
export class AgentTaskOutputProcess extends Disposable implements ITerminalChildProcess {

	readonly id = 0;
	readonly shouldPersist = false;

	private readonly _onProcessData = this._register(new Emitter<IProcessDataEvent | string>());
	readonly onProcessData = this._onProcessData.event;
	private readonly _onProcessReady = this._register(new Emitter<IProcessReadyEvent>());
	readonly onProcessReady = this._onProcessReady.event;
	private readonly _onDidChangeProperty = this._register(new Emitter<IProcessProperty<any>>());
	readonly onDidChangeProperty = this._onDidChangeProperty.event;
	private readonly _onProcessExit = this._register(new Emitter<number | undefined>());
	readonly onProcessExit = this._onProcessExit.event;

	private offset = 0;
	private readonly decoder = new TextDecoder();
	/** The last chunk ended in `\r`, so a `\n` opening the next is its line end, not a new one. */
	private endedInReturn = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private ended = false;

	constructor(
		private readonly file: URI,
		private readonly command: string,
		private readonly cwd: string,
		private readonly info: () => IAgentTerminalInfo | undefined,
		private readonly fileService: IFileService,
	) {
		super();
	}

	async start(): Promise<ITerminalLaunchError | undefined> {
		this._onProcessReady.fire({ pid: -1, cwd: this.cwd, windowsPty: undefined });
		this._onProcessData.fire(`\x1b[2m$ ${this.command.replace(/\r?\n/g, '\r\n  ')}\x1b[0m\r\n`);
		void this.follow();
		return undefined;
	}

	private async follow(): Promise<void> {
		this.timer = undefined;
		if (this.ended || this._store.isDisposed) {
			return;
		}
		const info = this.info();
		const live = !!info && isTerminalLive(info.status);
		await this.read();
		if (this._store.isDisposed) {
			return;
		}
		if (live) {
			this.timer = setTimeout(() => void this.follow(), READ_MS);
			return;
		}
		this.ended = true;
		const status = info ? describeAgentTerminalStatus(info) : localize('voltAgent.task.gone', "no longer tracked");
		const failed = info?.status === 'failed';
		this._onProcessData.fire(`\r\n\x1b[2m${failed ? '\x1b[31m' : ''}${localize('voltAgent.task.ended', "{0}: {1}", info?.label ?? this.command, status)}\x1b[0m\r\n`);
	}

	/** Everything the task wrote since the last read, until the file is caught up. */
	private async read(): Promise<void> {
		try {
			for (let i = 0; i < 64; i++) {
				const stat = await this.fileService.stat(this.file);
				if (stat.size <= this.offset || this._store.isDisposed) {
					return;
				}
				const content = await this.fileService.readFile(this.file, { position: this.offset, length: Math.min(READ_CHUNK, stat.size - this.offset) });
				this.offset += content.value.byteLength;
				this.write(this.decoder.decode(content.value.buffer, { stream: true }));
			}
		} catch {
			// Not written yet, or already cleaned up.
		}
	}

	/** The file holds plain `\n` line ends; a terminal needs `\r\n` to return to the first column. */
	private write(text: string): void {
		if (!text) {
			return;
		}
		let out = text.replace(/(?<!\r)\n/g, '\r\n');
		if (this.endedInReturn && text.startsWith('\n')) {
			out = out.slice(1);
		}
		this.endedInReturn = text.endsWith('\r');
		this._onProcessData.fire(out);
	}

	shutdown(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.ended = true;
		this._onProcessExit.fire(undefined);
	}

	input(): void { }
	sendSignal(): void { }
	async processBinary(): Promise<void> { }
	resize(): void { }
	clearBuffer(): void { }
	acknowledgeDataEvent(): void { }
	async setUnicodeVersion(): Promise<void> { }
	async getInitialCwd(): Promise<string> { return this.cwd; }
	async getCwd(): Promise<string> { return this.cwd; }

	async refreshProperty<T extends ProcessPropertyType>(property: T): Promise<IProcessPropertyMap[T]> {
		const value: Partial<IProcessPropertyMap> = { [ProcessPropertyType.Cwd]: this.cwd, [ProcessPropertyType.InitialCwd]: this.cwd, [ProcessPropertyType.Title]: this.command };
		return value[property] as IProcessPropertyMap[T];
	}

	async updateProperty(): Promise<void> { }

	override dispose(): void {
		clearTimeout(this.timer);
		super.dispose();
	}
}

/**
 * A terminal showing an agent's background task (`info.outputFile`), known to the terminal editors
 * like the agent's own terminals so the chat's Terminals tab can list and show it. Marked as the
 * agent's: closing the Terminals tab keeps it, and the task itself is never touched.
 */
export function createAgentTaskTerminal(
	info: IAgentTerminalInfo & { readonly outputFile: string },
	current: () => IAgentTerminalInfo | undefined,
	instanceService: ITerminalInstanceService,
	terminalEditorService: ITerminalEditorService,
	fileService: IFileService,
): ITerminalInstance {
	const file = URI.file(info.outputFile);
	const cwd = info.cwd ?? '';
	const instance = instanceService.createInstance({
		name: info.label,
		cwd: info.cwd,
		env: { [AGENT_TERMINAL_ENV]: '1' },
		customPtyImplementation: () => new AgentTaskOutputProcess(file, info.command, cwd, current, fileService),
		// Never revived on reload: it only shows a file.
		isTransient: true,
	}, TerminalLocation.Editor);
	terminalEditorService.resolveResource(instance);
	return instance;
}
