/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ITerminalCommand, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { mentionsAny } from '../../../services/voltRuntime/common/prediction/retrieval.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';

const MAX_COMMANDS = 8;
const OUTPUT_TAIL_LINES = 6;
const OUTPUT_TAIL_CHARS = 400;
const COMMAND_CHARS = 160;

interface ITrackedCommand {
	readonly command: string;
	readonly exitCode: number | undefined;
	/** The end of the output, for failed commands only (that is where the error is). */
	readonly tail: string;
	readonly at: number;
}

/**
 * What ran in the integrated terminals: each finished command (shell integration), its exit code
 * and, when it failed, the end of its output. The composer sees the last few; Tab sees a failure
 * only when it names code near the cursor, so an unrelated build log costs nothing.
 */
export class TerminalCommandTracker extends Disposable {

	private readonly commands: ITrackedCommand[] = [];

	constructor(@ITerminalService terminalService: ITerminalService) {
		super();
		const finished = this._register(terminalService.createOnInstanceCapabilityEvent(TerminalCapability.CommandDetection, capability => capability.onCommandFinished));
		this._register(finished.event(({ data }) => this.record(data)));
	}

	private record(command: ITerminalCommand): void {
		const line = command.command.trim();
		if (!line || command.wasReplayed) {
			return;
		}
		const failed = command.exitCode !== undefined && command.exitCode !== 0;
		let tail = '';
		if (failed) {
			try {
				tail = tailOf(command.getOutput() ?? '');
			} catch {
				// The buffer moved on; the exit code is still worth knowing.
			}
		}
		this.commands.push({ command: clip(line, COMMAND_CHARS), exitCode: command.exitCode, tail, at: Date.now() });
		if (this.commands.length > MAX_COMMANDS) {
			this.commands.shift();
		}
	}

	/** The last commands of the last `maxAgeMs`, oldest first: `$ npm test (exit 1): ...`. */
	recent(maxAgeMs: number, max = 3): string[] {
		const since = Date.now() - maxAgeMs;
		return this.commands.filter(command => command.at >= since).slice(-max).map(render);
	}

	/** Failed commands of the last `maxAgeMs` whose output names one of `terms`. */
	failuresMentioning(terms: ReadonlyMap<string, number>, maxAgeMs: number): string[] {
		const since = Date.now() - maxAgeMs;
		return this.commands
			.filter(command => command.at >= since && command.tail && mentionsAny(command.tail, terms))
			.slice(-2)
			.map(render);
	}
}

function render(command: ITrackedCommand): string {
	const status = command.exitCode === undefined ? '' : command.exitCode === 0 ? ' (ok)' : ` (exit ${command.exitCode})`;
	return command.tail ? `$ ${command.command}${status}:\n${command.tail}` : `$ ${command.command}${status}`;
}

function tailOf(output: string): string {
	const lines = output.replace(/\r/g, '').split('\n').map(line => line.trimEnd()).filter(line => line.trim());
	const tail = lines.slice(-OUTPUT_TAIL_LINES).join('\n');
	// The end is where the error is: cut from the front.
	return tail.length <= OUTPUT_TAIL_CHARS ? tail : `...${tail.slice(-OUTPUT_TAIL_CHARS)}`;
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}...`;
}
