/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { stripAnsi } from '../../../../services/voltRuntime/common/ide/testReports.js';
import { Task, TaskEventKind, TaskRunSource } from '../../../tasks/common/tasks.js';
import { ITaskService } from '../../../tasks/common/taskService.js';
import { ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';

const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 15 * 60_000;
const OUTPUT_LINES = 40;
/** Task detection (npm, gulp, make...) can be slow on a cold project. */
const LIST_TIMEOUT_MS = 15_000;

export interface ITaskToolResult {
	readonly text: string;
	readonly isError?: boolean;
}

/** Tells the chat's card about tasks an agent runs. */
export interface ITaskWatcher {
	started(task: Task, title: string): void;
	ended(task: Task, exitCode: number | undefined): void;
}

/**
 * The tasks tool over VS Code's task service: tasks.json and every detected task (npm scripts,
 * make, gulp...) run exactly as the Run Task command runs them, in a task terminal the user sees,
 * with their problem matchers feeding the Problems view.
 */
export class IdeTasks {

	constructor(
		private readonly taskService: ITaskService,
		private readonly terminalService: ITerminalService,
	) { }

	/**
	 * `own`: a sandboxed chat's call, which sees the state, output and stop of only the tasks it
	 * started itself (a task's terminal is the user's otherwise), and runs none: a task runs outside
	 * the sandbox (the gate refuses it too).
	 */
	async invoke(root: URI | undefined, op: string, name: string | undefined, waitMs: number | undefined, watcher: ITaskWatcher | undefined, token: CancellationToken, own?: (task: Task) => boolean): Promise<ITaskToolResult> {
		switch (op) {
			case 'list': return this.list(root);
			case 'status': return this.status(own);
			case 'run':
				if (own) {
					return { text: 'The task did not run: this chat runs in Volt\'s sandbox, and a task runs its command in a terminal outside it. Run the command with your own shell tool instead.', isError: true };
				}
				return this.run(name, waitMs, watcher, token);
			case 'output': {
				const task = await this.find(name, true, own);
				return typeof task === 'string' ? { text: task, isError: true } : { text: this.output(task) || `${task._label} has no output yet.` };
			}
			case 'stop': {
				const task = await this.find(name, true, own);
				if (typeof task === 'string') {
					return { text: task, isError: true };
				}
				const response = await this.taskService.terminate(task);
				return { text: response.success ? `Stopped ${task._label}.` : `${task._label} did not stop.`, isError: !response.success };
			}
		}
		return { text: `Unknown op ${op}.`, isError: true };
	}

	private async all(): Promise<Task[]> {
		return await raceTimeout(this.taskService.tasks(), LIST_TIMEOUT_MS) ?? [];
	}

	private async list(root: URI | undefined): Promise<ITaskToolResult> {
		const tasks = await this.all();
		if (!tasks.length) {
			return { text: 'No tasks. tasks.json defines them; npm scripts, make, gulp and others are detected when their files exist.' };
		}
		const active = new Set((await this.taskService.getActiveTasks()).map(task => task.getMapKey()));
		const lines = tasks.slice(0, 80).map(task => {
			const group = typeof task.configurationProperties.group === 'string' ? task.configurationProperties.group : task.configurationProperties.group?._id;
			const folder = task.getWorkspaceFolder();
			const where = folder && root && folder.uri.toString() !== root.toString() ? ` (${relativePath(root, folder.uri) ?? folder.name})` : '';
			return `- ${task._label}${group ? ` [${group}]` : ''}${task.configurationProperties.isBackground ? ' (watch)' : ''}${active.has(task.getMapKey()) ? ' RUNNING' : ''}${where}`;
		});
		return { text: `${tasks.length} task${tasks.length === 1 ? '' : 's'}:\n${lines.join('\n')}${tasks.length > 80 ? `\n[${tasks.length - 80} more]` : ''}` };
	}

	private async status(own?: (task: Task) => boolean): Promise<ITaskToolResult> {
		const active = (await this.taskService.getActiveTasks()).filter(task => !own || own(task));
		if (!active.length) {
			return { text: own ? 'No task this chat started is running.' : 'No tasks are running.' };
		}
		const busy = new Set((await this.taskService.getBusyTasks()).map(task => task.getMapKey()));
		return { text: active.map(task => `- ${task._label}: ${busy.has(task.getMapKey()) ? 'busy' : task.configurationProperties.isBackground ? 'watching (idle)' : 'running'}`).join('\n') };
	}

	/** The task named exactly, else the only one containing the name. */
	private async find(name: string | undefined, activeFirst: boolean, own?: (task: Task) => boolean): Promise<Task | string> {
		if (!name?.trim()) {
			return 'Pass name (tasks list shows them).';
		}
		const wanted = name.trim().toLowerCase();
		const pools = (activeFirst ? [await this.taskService.getActiveTasks(), await this.all()] : [await this.all()]).map(pool => own ? pool.filter(own) : pool);
		for (const pool of pools) {
			const exact = pool.find(task => task._label.toLowerCase() === wanted || task.getQualifiedLabel().toLowerCase() === wanted);
			if (exact) {
				return exact;
			}
			const partial = pool.filter(task => task._label.toLowerCase().includes(wanted));
			if (partial.length === 1) {
				return partial[0];
			}
			if (partial.length > 1) {
				return `"${name}" matches ${partial.map(task => JSON.stringify(task._label)).join(', ')}; pass the full label.`;
			}
		}
		return own ? `No task "${name}" that this chat started. A sandboxed chat reads and stops only its own tasks.` : `No task "${name}". tasks list shows them.`;
	}

	private async run(name: string | undefined, waitMs: number | undefined, watcher: ITaskWatcher | undefined, token: CancellationToken): Promise<ITaskToolResult> {
		const task = await this.find(name, false);
		if (typeof task === 'string') {
			return { text: task, isError: true };
		}
		const background = !!task.configurationProperties.isBackground;
		const store = new DisposableStore();
		let exitCode: number | undefined;
		const settled = new Promise<'exited' | 'ready'>(resolve => {
			store.add(this.taskService.onDidStateChange(event => {
				if (event.kind === TaskEventKind.Changed || event.__task?.getMapKey() !== task.getMapKey()) {
					return;
				}
				if (event.kind === TaskEventKind.ProcessEnded) {
					exitCode = event.exitCode;
					resolve('exited');
				} else if (event.kind === TaskEventKind.End) {
					resolve('exited');
				} else if (background && event.kind === TaskEventKind.Inactive) {
					resolve('ready'); // a watch task finished its first build
				}
			}));
		});
		try {
			watcher?.started(task, task._label);
			void this.taskService.run(task, undefined, TaskRunSource.User).catch(() => undefined);
			const limit = Math.min(Math.max(waitMs ?? DEFAULT_WAIT_MS, 1_000), MAX_WAIT_MS);
			const outcome = await raceTimeout(Promise.race([settled, new Promise<undefined>(resolve => store.add(token.onCancellationRequested(() => resolve(undefined))))]), limit);
			if (outcome === 'exited') {
				watcher?.ended(task, exitCode);
			}
			const state = outcome === 'exited'
				? `${task._label} exited${exitCode !== undefined ? ` with code ${exitCode}` : ''}.`
				: outcome === 'ready' ? `${task._label} is watching; its first build finished.` : `${task._label} is still running after ${Math.round(limit / 1000)}s (it keeps going; read it with op output, stop it with op stop).`;
			const problems = this.problems(task);
			const output = this.output(task);
			return { text: [state, problems, output ? `Output (last ${OUTPUT_LINES} lines):\n${output}` : ''].filter(Boolean).join('\n') };
		} finally {
			store.dispose();
		}
	}

	private terminal(task: Task): ITerminalInstance | undefined {
		const uri = this.taskService.getTerminalsForTasks(task)?.[0];
		return uri ? this.terminalService.getInstanceFromResource(uri) : undefined;
	}

	private output(task: Task): string {
		const instance = this.terminal(task);
		const buffer = instance?.xterm?.raw.buffer.active;
		if (!buffer) {
			return '';
		}
		const end = buffer.baseY + buffer.cursorY;
		const lines: string[] = [];
		for (let y = Math.max(0, end - 400); y <= end; y++) {
			lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
		}
		return stripAnsi(lines.join('\n')).trim().split('\n').slice(-OUTPUT_LINES).join('\n');
	}

	/** What the task's problem matchers found (the Problems view's entries for this run). */
	private problems(task: Task): string {
		const instance = this.terminal(task);
		const found = instance ? this.taskService.getTaskProblems(instance.instanceId) : undefined;
		if (!found?.size) {
			return '';
		}
		const lines: string[] = [];
		let errors = 0;
		for (const { resources, markers } of found.values()) {
			markers.forEach((marker, index) => {
				if (marker.severity === MarkerSeverity.Error) {
					errors++;
				}
				if (lines.length < 30) {
					const resource = resources[index] ?? resources[0];
					lines.push(`${resource?.fsPath ?? ''}:${marker.startLineNumber}:${marker.startColumn} ${marker.severity === MarkerSeverity.Error ? 'error' : 'warning'}: ${marker.message.split('\n')[0]}`);
				}
			});
		}
		return `Problems (${errors} error${errors === 1 ? '' : 's'}):\n${lines.join('\n')}`;
	}
}
