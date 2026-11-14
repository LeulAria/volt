/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../../../base/common/path.js';
import { joinPath, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IConfig, IDebugService, IDebugSession, IExpression, IStackFrame, IThread, State } from '../../../debug/common/debug.js';

/** Ops that act on a session (the rest start one, or set breakpoints). */
const SESSION_OPS: ReadonlySet<string> = new Set(['continue', 'step', 'pause', 'run_to', 'state', 'variables', 'evaluate', 'watch', 'output', 'stop']);

const DEFAULT_WAIT_MS = 20_000;
const MAX_WAIT_MS = 120_000;
const MAX_FRAMES = 12;
const MAX_VARIABLES = 30;
const MAX_VALUE = 160;
const SOURCE_CONTEXT = 3;

export interface IDebugToolResult {
	readonly text: string;
	readonly isError?: boolean;
}

/** Tells the chat's card about the sessions an agent drives. */
export interface IDebugWatcher {
	started(session: IDebugSession, title: string): void;
}

export interface IDebugArgs {
	readonly op: string;
	readonly config?: string;
	readonly program?: string;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly stop_on_entry?: boolean;
	readonly port?: number;
	readonly pid?: number;
	readonly language?: string;
	readonly action?: string;
	readonly breakpoints?: readonly string[];
	readonly path?: string;
	readonly line?: number;
	readonly condition?: string;
	readonly log?: string;
	readonly exceptions?: string;
	readonly kind?: string;
	readonly expression?: string;
	readonly frame?: number;
	readonly variable?: string;
	readonly session?: string;
	readonly wait_ms?: number;
}

type PauseOutcome = 'paused' | 'ended' | 'running';

/**
 * The debug tool over VS Code's debug service (DAP): the sessions it starts are ordinary debug
 * sessions (Run and Debug view, editor highlight, debug toolbar), so the user watches the agent
 * step and can take over at any point. Every op that resumes waits for the next pause and answers
 * with the new state, so stepping costs one call per step.
 */
export class IdeDebug {

	/** Root session ids an agent started, per chat key, newest last. */
	private readonly started = new Map<string, string[]>();
	/** Breakpoint ids an agent set, so clear removes only those (never the user's). */
	private readonly agentBreakpoints = new Set<string>();
	/** How many debug console lines each session's output op has returned. */
	private readonly outputRead = new Map<string, number>();

	constructor(
		private readonly debugService: IDebugService,
		private readonly fileService: IFileService,
	) { }

	/**
	 * `ownOnly`: a sandboxed chat's call, which may act only on a session the chat itself started
	 * (never the user's: its program's state and output are theirs). The gate refuses it everything
	 * that would start or drive one.
	 */
	async invoke(key: string, root: URI | undefined, args: IDebugArgs, watcher: IDebugWatcher | undefined, token: CancellationToken, ownOnly = false): Promise<IDebugToolResult> {
		if (ownOnly && (args.op === 'start' || args.op === 'attach')) {
			// The gate refuses these; a debugger never starts for a sandboxed chat, whoever asks.
			return { text: 'The debugger was not started: this chat runs in Volt\'s sandbox, and a debug session runs the program outside it. Run it with your own shell tool instead.', isError: true };
		}
		if (ownOnly && args.op === 'breakpoints' && (args.condition?.trim() || args.log?.trim())) {
			// A condition or a logpoint is code the debuggee evaluates, outside the sandbox, the next time anyone debugs it.
			return { text: 'No breakpoint was set: this chat runs in Volt\'s sandbox, and a condition or logpoint runs code in a debug session outside it. Set a plain breakpoint, or add logging and run the program with your own shell tool.', isError: true };
		}
		if (ownOnly && SESSION_OPS.has(args.op)) {
			const own = this.session(key, args.session, true);
			if (!own) {
				return { text: 'This chat has no debug session of its own: it runs in Volt\'s sandbox, which a debugger cannot start in, and the user\'s sessions are theirs. Run the program with your own shell tool and add logging instead.', isError: true };
			}
			args = { ...args, session: own.getId() };
		}
		switch (args.op) {
			case 'start': return this.start(key, root, args, watcher, token, false);
			case 'attach': return this.start(key, root, args, watcher, token, true);
			case 'breakpoints': return this.breakpoints(root, args);
			case 'continue':
			case 'step':
			case 'pause':
			case 'run_to': return this.control(key, root, args, token);
			case 'state': {
				const session = this.session(key, args.session);
				return session ? { text: await this.describe(root, session, args.frame ?? 0) } : this.noSession();
			}
			case 'variables': return this.variables(key, args);
			case 'evaluate': return this.evaluate(key, args);
			case 'watch': return this.watch(key, args);
			case 'output': return this.output(key, args);
			case 'stop': {
				const session = this.session(key, args.session);
				if (!session) {
					return this.noSession();
				}
				await this.debugService.stopSession(this.rootOf(session));
				return { text: `Stopped ${this.rootOf(session).getLabel()}.` };
			}
		}
		return { text: `Unknown op ${args.op}.`, isError: true };
	}

	// --- Sessions ----------------------------------------------------------------------------

	private async start(key: string, root: URI | undefined, args: IDebugArgs, watcher: IDebugWatcher | undefined, token: CancellationToken, attach: boolean): Promise<IDebugToolResult> {
		const set = await this.setBreakpoints(root, args.breakpoints ?? []);
		if (typeof set === 'string') {
			return { text: set, isError: true };
		}
		const name = `Volt: ${args.config ?? args.command ?? args.program ?? (args.port ? `port ${args.port}` : args.pid ? `pid ${args.pid}` : 'debug')}`.slice(0, 80);
		const cwd = args.cwd ? this.resolve(root, args.cwd)?.fsPath : root?.fsPath;
		let launch: ReturnType<IDebugService['getConfigurationManager']>['selectedConfiguration']['launch'];
		let config: IConfig | string;
		if (args.config) {
			const launches = this.debugService.getConfigurationManager().getLaunches();
			launch = launches.find(candidate => candidate.getConfigurationNames().includes(args.config!));
			if (!launch) {
				const names = launches.flatMap(candidate => candidate.getConfigurationNames());
				return { text: `No launch configuration "${args.config}".${names.length ? ` Available: ${names.map(item => JSON.stringify(item)).join(', ')}.` : ' There is no launch.json; pass program or command instead.'}`, isError: true };
			}
			config = args.config;
		} else {
			const built = attach ? this.attachConfig(name, args) : this.launchConfig(name, root, cwd, args);
			if (typeof built === 'string') {
				return { text: built, isError: true };
			}
			config = built;
		}
		const tag = generateUuid();
		const store = new DisposableStore();
		let rootSession: IDebugSession | undefined;
		const first = new Promise<IDebugSession | undefined>(resolve => {
			store.add(this.debugService.onDidNewSession(session => {
				if (!rootSession && !session.parentSession && (session.configuration.name === (typeof config === 'string' ? config : config.name) || (session.configuration as IConfig & { __voltTag?: string }).__voltTag === tag)) {
					rootSession = session;
					resolve(session);
				}
			}));
			setTimeout(() => resolve(undefined), 30_000);
		});
		try {
			if (typeof config !== 'string') {
				(config as IConfig & { __voltTag?: string }).__voltTag = tag;
			}
			const ok = await this.debugService.startDebugging(launch, config, { suppressDebugView: false });
			if (!ok) {
				return { text: 'The debugger did not start. Check that a debugger for this language is installed (Node.js is built in; Python, Go and others need their extension) and the configuration is valid.', isError: true };
			}
			const session = await first;
			if (!session) {
				return { text: 'The debug session did not appear in time.', isError: true };
			}
			const list = this.started.get(key) ?? [];
			list.push(session.getId());
			this.started.set(key, list.slice(-8));
			watcher?.started(session, name.replace(/^Volt: /, ''));
			const outcome = await this.waitForPause(session, new Set(), this.waitMs(args), token);
			const bps = set.length ? `Breakpoints: ${set.join(', ')}.\n` : '';
			return { text: `${bps}${await this.afterWait(root, session, outcome)}` };
		} finally {
			store.dispose();
		}
	}

	private launchConfig(name: string, root: URI | undefined, cwd: string | undefined, args: IDebugArgs): IConfig | string {
		if (args.command) {
			// js-debug's JavaScript Debug Terminal: every Node process the command starts is debugged.
			return debugConfig({ type: 'node-terminal', request: 'launch', name, command: args.command, ...(cwd ? { cwd } : {}) });
		}
		if (!args.program) {
			return 'start needs config, program or command.';
		}
		const program = this.resolve(root, args.program);
		if (!program) {
			return `Cannot resolve ${args.program}.`;
		}
		const language = args.language ?? languageOf(program.path);
		const common = { name, request: 'launch', ...(cwd ? { cwd } : {}), ...(args.stop_on_entry ? { stopOnEntry: true } : {}) };
		switch (language) {
			case 'node':
				return debugConfig({ ...common, type: 'node', program: program.fsPath, args: [...(args.args ?? [])], skipFiles: ['<node_internals>/**'] });
			case 'typescript':
				return debugConfig({ ...common, type: 'node-terminal', command: ['npx', 'tsx', JSON.stringify(program.fsPath), ...(args.args ?? []).map(arg => JSON.stringify(arg))].join(' ') });
			case 'python':
				return debugConfig({ ...common, type: 'debugpy', program: program.fsPath, args: [...(args.args ?? [])], console: 'internalConsole', justMyCode: true });
			case 'go':
				return debugConfig({ ...common, type: 'go', mode: 'debug', program: program.fsPath, args: [...(args.args ?? [])] });
		}
		return `No built-in launch recipe for ${program.path.split('/').pop()}; add a launch.json configuration and pass config.`;
	}

	private attachConfig(name: string, args: IDebugArgs): IConfig | string {
		const language = args.language ?? 'node';
		if (language === 'python') {
			return args.port ? debugConfig({ type: 'debugpy', request: 'attach', name, connect: { host: 'localhost', port: args.port } }) : 'Python attach needs port (debugpy --listen).';
		}
		if (args.port) {
			return debugConfig({ type: 'node', request: 'attach', name, port: args.port, skipFiles: ['<node_internals>/**'] });
		}
		if (args.pid) {
			return debugConfig({ type: 'node', request: 'attach', name, processId: String(args.pid) });
		}
		return 'attach needs port or pid.';
	}

	/** The session to act on: the one named, else this chat's newest live one, else (unless `ownOnly`) the focused one. */
	private session(key: string, wanted: string | undefined, ownOnly = false): IDebugSession | undefined {
		const sessions = this.debugService.getModel().getSessions();
		const started = this.started.get(key) ?? [];
		const mine = (session: IDebugSession | undefined) => session && (!ownOnly || started.includes(this.rootOf(session).getId())) ? session : undefined;
		if (wanted) {
			const lower = wanted.toLowerCase();
			return mine(sessions.find(session => session.getId() === wanted) ?? sessions.find(session => session.getLabel().toLowerCase().includes(lower)));
		}
		for (const id of [...started].reverse()) {
			const own = sessions.find(session => session.getId() === id);
			if (own) {
				return this.pausedIn(own) ?? own;
			}
		}
		return ownOnly ? undefined : this.debugService.getViewModel().focusedSession ?? sessions[0];
	}

	private rootOf(session: IDebugSession): IDebugSession {
		let current = session;
		while (current.parentSession) {
			current = current.parentSession;
		}
		return current;
	}

	private tree(root: IDebugSession): IDebugSession[] {
		const top = this.rootOf(root);
		return this.debugService.getModel().getSessions().filter(session => this.rootOf(session) === top);
	}

	/** The session in `root`'s tree that is paused (child sessions do the work under js-debug). */
	private pausedIn(root: IDebugSession): IDebugSession | undefined {
		return this.tree(root).find(session => session.state === State.Stopped && session.getAllThreads().some(thread => thread.stopped));
	}

	private stoppedThread(session: IDebugSession): IThread | undefined {
		const focused = this.debugService.getViewModel().focusedThread;
		if (focused && focused.session === session && focused.stopped) {
			return focused;
		}
		return session.getAllThreads().find(thread => thread.stopped);
	}

	/** Stop details already seen, so a wait only counts a new pause. */
	private pauseMarks(root: IDebugSession): Set<unknown> {
		const marks = new Set<unknown>();
		for (const session of this.tree(root)) {
			for (const thread of session.getAllThreads()) {
				if (thread.stopped && thread.stoppedDetails) {
					marks.add(thread.stoppedDetails);
				}
			}
		}
		return marks;
	}

	private waitForPause(root: IDebugSession, seen: ReadonlySet<unknown>, waitMs: number, token: CancellationToken): Promise<PauseOutcome> {
		const top = this.rootOf(root);
		const check = (): PauseOutcome | undefined => {
			const live = this.tree(top);
			if (!live.length || live.every(session => session.state === State.Inactive)) {
				return 'ended';
			}
			for (const session of live) {
				for (const thread of session.getAllThreads()) {
					if (thread.stopped && thread.stoppedDetails && !seen.has(thread.stoppedDetails)) {
						return 'paused';
					}
				}
			}
			return undefined;
		};
		const now = check();
		if (now) {
			return Promise.resolve(now);
		}
		return new Promise<PauseOutcome>(resolve => {
			const store = new DisposableStore();
			const done = (outcome: PauseOutcome) => {
				store.dispose();
				clearTimeout(timer);
				resolve(outcome);
			};
			const timer = setTimeout(() => done('running'), waitMs);
			const recheck = () => {
				const outcome = check();
				if (outcome) {
					done(outcome);
				}
			};
			store.add(this.debugService.onDidChangeState(recheck));
			store.add(this.debugService.getModel().onDidChangeCallStack(recheck));
			store.add(this.debugService.onDidEndSession(({ session }) => {
				if (this.rootOf(session) === top && !session.parentSession) {
					done('ended');
				} else {
					recheck();
				}
			}));
			store.add(token.onCancellationRequested(() => done('running')));
		});
	}

	private async afterWait(root: URI | undefined, session: IDebugSession, outcome: PauseOutcome): Promise<string> {
		if (outcome === 'ended') {
			const output = this.consoleTail(session, 30);
			return `The program ran to the end without pausing${output ? `. Debug console:\n${output}` : '.'}`;
		}
		if (outcome === 'running') {
			return `Running (no pause yet). Wait again with op state, pause it with op pause, or check breakpoints with op breakpoints.\n${this.consoleTail(session, 15)}`.trim();
		}
		return this.describe(root, this.pausedIn(session) ?? session, 0);
	}

	private async control(key: string, root: URI | undefined, args: IDebugArgs, token: CancellationToken): Promise<IDebugToolResult> {
		const session = this.session(key, args.session);
		if (!session) {
			return this.noSession();
		}
		const paused = this.pausedIn(session);
		const seen = this.pauseMarks(session);
		if (args.op === 'pause') {
			if (paused) {
				return { text: await this.describe(root, paused, 0) };
			}
			const thread = this.tree(session).flatMap(candidate => candidate.getAllThreads())[0];
			if (!thread) {
				return { text: 'No thread to pause.', isError: true };
			}
			await thread.pause();
		} else {
			if (!paused) {
				return { text: `${session.getLabel()} is not paused. Use op pause, or set a breakpoint and wait with op state.`, isError: true };
			}
			const thread = this.stoppedThread(paused);
			if (!thread) {
				return { text: 'No paused thread.', isError: true };
			}
			if (args.op === 'continue') {
				await thread.continue();
			} else if (args.op === 'step') {
				await (args.kind === 'into' ? thread.stepIn() : args.kind === 'out' ? thread.stepOut() : thread.next());
			} else {
				const uri = this.resolve(root, args.path);
				if (!uri || !args.line) {
					return { text: 'run_to needs path and line.', isError: true };
				}
				const top = thread.getTopStackFrame();
				if (top) {
					await this.debugService.focusStackFrame(top, thread, paused, { preserveFocus: true });
				}
				await this.debugService.runTo(uri, args.line);
			}
		}
		const outcome = await this.waitForPause(session, seen, this.waitMs(args), token);
		return { text: await this.afterWait(root, session, outcome) };
	}

	// --- State -------------------------------------------------------------------------------

	/** Where it stopped and why, the stack, the source around the line and the frame's locals. */
	private async describe(root: URI | undefined, session: IDebugSession, frameIndex: number): Promise<string> {
		const paused = this.pausedIn(session) ?? session;
		const thread = this.stoppedThread(paused);
		const label = this.rootOf(paused).getLabel();
		if (!thread) {
			const state = paused.state === State.Running ? 'running' : paused.state === State.Initializing ? 'starting' : paused.state === State.Inactive ? 'ended' : 'not paused';
			return `${label}: ${state}.${this.consoleTail(paused, 10) ? `\nDebug console:\n${this.consoleTail(paused, 10)}` : ''}`;
		}
		await this.debugService.getModel().fetchCallstack(thread, MAX_FRAMES + 8).catch(() => undefined);
		const frames = thread.getCallStack();
		const frame = frames[Math.min(Math.max(0, frameIndex), Math.max(0, frames.length - 1))];
		const details = thread.stoppedDetails;
		const lines: string[] = [];
		const reason = details?.reason ?? 'paused';
		const where = frame ? `${frame.name} at ${this.display(root, frame)}` : 'unknown location';
		lines.push(`Paused (${reason}${details?.description && details.description !== reason ? `: ${details.description}` : ''}) in ${where}  [${label}, thread "${thread.name}"]`);
		if (reason === 'exception') {
			const info = await thread.exceptionInfo.catch(() => undefined);
			if (info) {
				lines.push(`Exception: ${info.id ?? ''} ${info.description ?? ''}`.trim());
				if (info.details?.stackTrace) {
					lines.push(info.details.stackTrace.split('\n').slice(0, 6).join('\n'));
				}
			} else if (details?.text) {
				lines.push(`Exception: ${details.text}`);
			}
		}
		if (frame) {
			const source = await this.sourceAround(frame);
			if (source) {
				lines.push(source);
			}
			await this.debugService.focusStackFrame(frame, thread, paused, { preserveFocus: true }).catch(() => undefined);
		}
		const shown = frames.slice(0, MAX_FRAMES).map((item, index) => {
			const subtle = item.presentationHint === 'subtle' || item.presentationHint === 'deemphasize' || item.source.presentationHint === 'deemphasize';
			return `${index === frameIndex ? '>' : ' '}#${index} ${item.name}  ${this.display(root, item)}${subtle ? ' (library)' : ''}`;
		});
		lines.push(`Stack (${frames.length} frame${frames.length === 1 ? '' : 's'}):\n${shown.join('\n')}${frames.length > MAX_FRAMES ? `\n  [${frames.length - MAX_FRAMES} more]` : ''}`);
		if (frame) {
			lines.push(await this.locals(frame));
		}
		return lines.join('\n');
	}

	private async sourceAround(frame: IStackFrame): Promise<string | undefined> {
		if (!frame.source.available) {
			return undefined;
		}
		const text = await this.fileService.readFile(frame.source.uri).then(file => file.value.toString(), () => undefined);
		if (!text) {
			return undefined;
		}
		const all = text.split('\n');
		const at = frame.range.startLineNumber;
		const from = Math.max(1, at - SOURCE_CONTEXT);
		const to = Math.min(all.length, at + SOURCE_CONTEXT);
		const out: string[] = [];
		for (let line = from; line <= to; line++) {
			out.push(`${line === at ? '>' : ' '}${String(line).padStart(5)} | ${all[line - 1]}`);
		}
		return out.join('\n');
	}

	private async locals(frame: IStackFrame): Promise<string> {
		const scopes = await frame.getScopes().catch(() => []);
		const parts: string[] = [];
		for (const scope of scopes.filter(item => !item.expensive).slice(0, 2)) {
			const children = await scope.getChildren().catch(() => [] as IExpression[]);
			if (!children.length) {
				continue;
			}
			const shown = children.slice(0, MAX_VARIABLES).map(child => `  ${child.name} = ${clipValue(child.value)}${child.type ? ` (${child.type})` : ''}${child.hasChildren ? ' \u2026' : ''}`);
			parts.push(`${scope.name}:\n${shown.join('\n')}${children.length > MAX_VARIABLES ? `\n  [${children.length - MAX_VARIABLES} more]` : ''}`);
		}
		return parts.length ? parts.join('\n') : 'No local variables.';
	}

	private async frameFor(key: string, args: IDebugArgs): Promise<{ session: IDebugSession; frame: IStackFrame } | string> {
		const session = this.session(key, args.session);
		if (!session) {
			return 'No debug session. Start one with op start.';
		}
		const paused = this.pausedIn(session);
		const thread = paused && this.stoppedThread(paused);
		if (!paused || !thread) {
			return `${session.getLabel()} is not paused; variables exist only at a pause.`;
		}
		await this.debugService.getModel().fetchCallstack(thread, MAX_FRAMES + 8).catch(() => undefined);
		const frames = thread.getCallStack();
		const frame = frames[Math.min(Math.max(0, args.frame ?? 0), frames.length - 1)];
		return frame ? { session: paused, frame } : 'No stack frame.';
	}

	private async variables(key: string, args: IDebugArgs): Promise<IDebugToolResult> {
		const found = await this.frameFor(key, args);
		if (typeof found === 'string') {
			return { text: found, isError: true };
		}
		if (!args.variable) {
			return { text: await this.locals(found.frame) };
		}
		const parts = args.variable.split(/\.|\[(\d+)\]/).filter(part => part !== undefined && part !== '');
		let level: IExpression[] = [];
		for (const scope of await found.frame.getScopes()) {
			level.push(...await scope.getChildren().catch(() => []));
			if (level.some(item => item.name === parts[0])) {
				break;
			}
		}
		let current: IExpression | undefined;
		for (const part of parts) {
			current = level.find(item => item.name === part || item.name === `[${part}]`);
			if (!current) {
				return { text: `No variable "${part}" in ${args.variable}. Available: ${level.slice(0, 30).map(item => item.name).join(', ')}.`, isError: true };
			}
			level = current.hasChildren ? await current.getChildren().catch(() => []) : [];
		}
		if (!current) {
			return { text: 'Nothing to expand.', isError: true };
		}
		const head = `${args.variable} = ${clipValue(current.value, 400)}${current.type ? ` (${current.type})` : ''}`;
		const children = level.slice(0, 50).map(child => `  ${child.name} = ${clipValue(child.value)}${child.type ? ` (${child.type})` : ''}${child.hasChildren ? ' \u2026' : ''}`);
		return { text: children.length ? `${head}\n${children.join('\n')}${level.length > 50 ? `\n  [${level.length - 50} more]` : ''}` : head };
	}

	private async evaluate(key: string, args: IDebugArgs): Promise<IDebugToolResult> {
		if (!args.expression) {
			return { text: 'evaluate needs expression.', isError: true };
		}
		const found = await this.frameFor(key, args);
		const session = typeof found === 'string' ? this.session(key, args.session) : found.session;
		if (!session) {
			return { text: 'No debug session. Start one with op start.', isError: true };
		}
		const response = await session.evaluate(args.expression, typeof found === 'string' ? undefined : found.frame.frameId, 'repl').catch((err: unknown) => err instanceof Error ? err.message : String(err));
		if (typeof response === 'string' || !response) {
			return { text: `Evaluation failed: ${response ?? 'no answer'}`, isError: true };
		}
		const body = response.body;
		return { text: `${args.expression} = ${clipValue(body.result, 2_000)}${body.type ? ` (${body.type})` : ''}${body.variablesReference ? ' (expandable: op evaluate on its properties)' : ''}` };
	}

	/** Adds a watch expression (the user sees it in the Watch view) and reads every watch at the pause. */
	private async watch(key: string, args: IDebugArgs): Promise<IDebugToolResult> {
		if (args.expression && !this.debugService.getModel().getWatchExpressions().some(watch => watch.name === args.expression)) {
			this.debugService.addWatchExpression(args.expression);
		}
		const watches = this.debugService.getModel().getWatchExpressions();
		if (!watches.length) {
			return { text: 'No watch expressions. Add one with expression.' };
		}
		const found = await this.frameFor(key, args);
		if (typeof found === 'string') {
			return { text: `Watching ${watches.map(watch => watch.name).join(', ')}. ${found}` };
		}
		const lines = await Promise.all(watches.map(async watch => {
			const response = await found.session.evaluate(watch.name, found.frame.frameId, 'watch').catch(() => undefined);
			return `${watch.name} = ${response ? `${clipValue(response.body.result, 400)}${response.body.type ? ` (${response.body.type})` : ''}` : '(not available)'}`;
		}));
		return { text: lines.join('\n') };
	}

	private output(key: string, args: IDebugArgs): IDebugToolResult {
		const session = this.session(key, args.session);
		if (!session) {
			return this.noSession();
		}
		const elements = this.tree(session).flatMap(item => item.getReplElements());
		const id = this.rootOf(session).getId();
		const from = this.outputRead.get(id) ?? 0;
		const fresh = elements.slice(from).map(element => element.toString()).join('\n');
		this.outputRead.set(id, elements.length);
		const text = fresh.trim() || (from ? '(no new output)' : '(the debug console is empty)');
		return { text: text.length > 8_000 ? `\u2026${text.slice(-8_000)}` : text };
	}

	private consoleTail(session: IDebugSession, lines: number): string {
		const all = this.tree(session).flatMap(item => item.getReplElements()).map(element => element.toString()).join('\n').trim();
		return all ? all.split('\n').slice(-lines).join('\n') : '';
	}

	// --- Breakpoints -------------------------------------------------------------------------

	private async breakpoints(root: URI | undefined, args: IDebugArgs): Promise<IDebugToolResult> {
		const model = this.debugService.getModel();
		if (args.exceptions) {
			const filters = model.getExceptionBreakpoints();
			if (!filters.length) {
				return { text: 'Exception breakpoints become available once a debug session has started. Start one, then set them.', isError: true };
			}
			for (const filter of filters) {
				const uncaught = /uncaught|unhandled/i.test(`${filter.filter} ${filter.label}`);
				const enable = args.exceptions === 'all' || (args.exceptions === 'uncaught' && uncaught);
				await this.debugService.enableOrDisableBreakpoints(enable, filter);
			}
			return { text: `Pausing on ${args.exceptions === 'none' ? 'no' : args.exceptions} exceptions (${filters.map(filter => `${filter.label}: ${filter.enabled ? 'on' : 'off'}`).join(', ')}).` };
		}
		const action = args.action ?? (args.path ? 'set' : 'list');
		if (action === 'list') {
			const all = model.getBreakpoints();
			if (!all.length) {
				return { text: 'No breakpoints.' };
			}
			return {
				text: all.slice(0, 60).map(bp => `${(root && relativePath(root, bp.uri)) || bp.uri.fsPath}:${bp.lineNumber}${bp.condition ? ` if ${bp.condition}` : ''}${bp.logMessage ? ` log "${bp.logMessage}"` : ''}${bp.enabled ? '' : ' (disabled)'}${bp.verified ? '' : bp.message ? ` (unverified: ${bp.message})` : ''}${this.agentBreakpoints.has(bp.getId()) ? ' [agent]' : ''}`).join('\n'),
			};
		}
		if (action === 'clear') {
			const ids = [...this.agentBreakpoints];
			for (const id of ids) {
				await this.debugService.removeBreakpoints(id);
			}
			this.agentBreakpoints.clear();
			return { text: `Removed ${ids.length} breakpoint${ids.length === 1 ? '' : 's'} the agent set (the user's stay).` };
		}
		if (action === 'remove') {
			const uri = this.resolve(root, args.path);
			const bp = uri && args.line ? model.getBreakpoints({ uri, lineNumber: args.line })[0] : undefined;
			if (!bp) {
				return { text: `No breakpoint at ${args.path}:${args.line}.`, isError: true };
			}
			await this.debugService.removeBreakpoints(bp.getId());
			this.agentBreakpoints.delete(bp.getId());
			return { text: `Removed the breakpoint at ${args.path}:${args.line}.` };
		}
		const entries = args.path && args.line ? [`${args.path}:${args.line}`] : [...(args.breakpoints ?? [])];
		const set = await this.setBreakpoints(root, entries, args.condition, args.log);
		return typeof set === 'string' ? { text: set, isError: true } : { text: set.length ? `Set ${set.join(', ')}.` : 'Nothing to set: pass path + line or breakpoints.' };
	}

	/** Sets "path:line" breakpoints; returns what was set, or why one could not be. */
	private async setBreakpoints(root: URI | undefined, entries: readonly string[], condition?: string, log?: string): Promise<string[] | string> {
		const done: string[] = [];
		for (const entry of entries) {
			const match = /^(.*?):(\d+)$/.exec(entry.trim());
			const uri = match ? this.resolve(root, match[1]) : undefined;
			if (!match || !uri) {
				return `Breakpoint "${entry}" must be path:line.`;
			}
			const lineNumber = Number(match[2]);
			const existing = this.debugService.getModel().getBreakpoints({ uri, lineNumber });
			if (existing.length && !condition && !log) {
				done.push(`${match[1]}:${lineNumber}`);
				continue;
			}
			const added = await this.debugService.addBreakpoints(uri, [{ lineNumber, ...(condition ? { condition } : {}), ...(log ? { logMessage: log } : {}) }], false);
			for (const bp of added) {
				this.agentBreakpoints.add(bp.getId());
			}
			done.push(`${match[1]}:${lineNumber}${condition ? ` if ${condition}` : ''}${log ? ' (logpoint)' : ''}`);
		}
		return done;
	}

	private resolve(root: URI | undefined, raw: string | undefined): URI | undefined {
		const path = raw?.trim();
		if (!path) {
			return undefined;
		}
		return isAbsolute(path) ? URI.file(path) : root ? joinPath(root, path) : undefined;
	}

	private display(root: URI | undefined, frame: IStackFrame): string {
		const uri = frame.source.uri;
		const path = frame.source.available ? ((root && relativePath(root, uri)) || uri.fsPath) : frame.source.name ?? uri.path;
		return `${path}:${frame.range.startLineNumber}`;
	}

	private waitMs(args: IDebugArgs): number {
		return Math.min(Math.max(args.wait_ms ?? DEFAULT_WAIT_MS, 500), MAX_WAIT_MS);
	}

	private noSession(): IDebugToolResult {
		return { text: 'No debug session. Start one with op start (config, program or command) or attach.', isError: true };
	}
}

function languageOf(path: string): string | undefined {
	if (/\.(?:m|c)?js$/.test(path)) {
		return 'node';
	}
	if (/\.(?:m|c)?tsx?$/.test(path)) {
		return 'typescript';
	}
	if (path.endsWith('.py')) {
		return 'python';
	}
	if (path.endsWith('.go')) {
		return 'go';
	}
	return undefined;
}

function clipValue(value: string, max = MAX_VALUE): string {
	const flat = value.replace(/\s+/g, ' ');
	return flat.length > max ? `${flat.slice(0, max)}\u2026` : flat;
}

/** A debug configuration with the adapter's own fields (command, program, port...), checked as IConfig. */
function debugConfig(config: IConfig & Readonly<Record<string, unknown>>): IConfig {
	return config;
}
