/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { isWindows } from '../../../../../../base/common/platform.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { shellQuote } from '../../../../../services/voltRuntime/common/ide/testFrameworks.js';
import { stripAnsi } from '../../../../../services/voltRuntime/common/ide/testReports.js';
import { formatValue, frameLabel } from '../../../../../services/voltRuntime/common/profiler/profile.js';
import { describeFrame, findFrames, frameTimeRange, ITimeRange, summarizeComparison, summarizeProfile } from '../../../../../services/voltRuntime/common/profiler/profileAnalysis.js';
import { IVoltProfileFile } from '../../../../../services/voltRuntime/common/profiler/profileFormats.js';
import { USAGE_SAMPLER_SCRIPT, usageProfile } from '../../../../../services/voltRuntime/common/profiler/usageSampler.js';
import { ILoadedProfile, IVoltProfilerService, ProfilerView } from '../../profiler/voltProfilerService.js';
import { fail, IIdeCapability, IIdeCapabilityContext, IIdeCapabilityResult, num, ok, resolvePath, str } from './capability.js';

const VIEWS: readonly ProfilerView[] = ['chart', 'graph', 'heatmap', 'table', 'counters', 'diff'];

/**
 * Profiling with the user: record (V8 CPU and heap profiles, memory and CPU of any command, Chrome
 * traces and speedscope files from other tools), read (compact summaries by function and
 * file:line), compare two runs, and work in the Profiler tab beside the chat: focus its view on a
 * function or a moment, pin notes on what matters, read what the user selected. `show` turns any
 * data into a flame graph, lines or a heat map, so findings are shown, not drawn as HTML.
 */
export class ProfileCapability implements IIdeCapability {

	readonly id = 'profile';

	constructor(
		private readonly fileService: IFileService,
		private readonly profiler: IVoltProfilerService,
		/** The user's "open what the agent works on beside the chat" setting. */
		private readonly autoOpen: () => boolean,
	) { }

	/** Shows the profile beside the chat, without taking focus, unless the user turned that off. */
	private reveal(loaded: ILoadedProfile): void {
		if (this.autoOpen()) {
			void this.profiler.reveal(loaded.id, { background: true });
		}
	}

	async invoke(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		switch (op) {
			case 'cpu':
			case 'heap':
				return this.recordNode(op, args, ctx);
			case 'sample':
				return this.sample(args, ctx);
			case 'open':
				return this.open(args, ctx);
			case 'summary':
			case 'analyze':
				return this.analyze(args, ctx);
			case 'compare':
				return this.compare(args, ctx);
			case 'focus':
				return this.focus(args, ctx);
			case 'annotate':
				return this.annotate(args, ctx);
			case 'clear_notes': {
				const loaded = this.find(args, ctx);
				if (!loaded) {
					return this.missing(args);
				}
				this.profiler.clearNotes(loaded.id, 'agent');
				return ok(`Cleared your notes on ${loaded.id}.`);
			}
			case 'selection':
				return this.selection(args, ctx);
			case 'list':
				return this.list(ctx);
			case 'show':
				return this.show(args, ctx);
			case 'bench':
				return this.bench(args, ctx);
		}
		return fail(`profile has no op ${op}.`);
	}

	// --- Recording -----------------------------------------------------------------------------

	/** A folder for one recording, writable from the chat's sandbox. */
	private async recordingDir(): Promise<URI> {
		const dir = joinPath(this.profiler.profilesHome, `run-${generateUuid().slice(0, 12)}`);
		await this.fileService.createFolder(dir);
		return dir;
	}

	private async recordNode(op: 'cpu' | 'heap', args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const command = str(args, 'command');
		if (!command) {
			return fail(`${op} needs command (e.g. "node scripts/build.js" or "npm run bench").`);
		}
		const dir = await this.recordingDir();
		const flags = op === 'cpu'
			? `--cpu-prof --cpu-prof-dir=${dir.fsPath}${num(args, 'interval_us') ? ` --cpu-prof-interval=${Math.max(50, num(args, 'interval_us')!)}` : ''}`
			: `--heap-prof --heap-prof-dir=${dir.fsPath}`;
		const started = Date.now();
		// Every Node process the command starts writes one; the largest is the work (npm itself is Node too).
		const result = await ctx.cli.shell(command, { timeoutMs: num(args, 'timeout_ms') ?? 600_000, env: { NODE_OPTIONS: flags }, writable: [dir.fsPath] });
		const extension = op === 'cpu' ? '.cpuprofile' : '.heapprofile';
		const entries = (await this.fileService.resolve(dir).catch(() => undefined))?.children?.filter(child => child.name.endsWith(extension)) ?? [];
		if (!entries.length) {
			return fail(`No ${op === 'cpu' ? 'CPU' : 'heap'} profile was written (exit code ${result.code}). Only Node.js processes are profiled this way; for other languages record with their profiler (py-spy record --format speedscope, perf + stackcollapse, go test -cpuprofile then pprof -raw) and open the file, or use op sample for memory and CPU over time.\n${tailOf(result.stderr || result.stdout, 15)}`);
		}
		const sized = await Promise.all(entries.map(async entry => ({ uri: entry.resource, size: (await this.fileService.stat(entry.resource)).size })));
		const biggest = sized.sort((a, b) => b.size - a.size)[0];
		const loaded = await this.profiler.load(biggest.uri, this.loadOptions(ctx));
		this.reveal(loaded);
		const head = `Ran in ${((Date.now() - started) / 1000).toFixed(1)}s, exit code ${result.code}${entries.length > 1 ? `; ${entries.length} Node processes profiled, showing the largest` : ''}. Profile ${loaded.id} (${biggest.uri.fsPath}) is open in the Profiler beside the chat.`;
		return ok(`${head}\n${summarizeProfile(loaded.profile, this.summaryOptions(ctx, args))}${result.code ? `\nThe command failed:\n${tailOf(result.stderr || result.stdout, 10)}` : ''}`);
	}

	private async sample(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const command = str(args, 'command');
		if (!command) {
			return fail('sample needs command: any program (a server under load, a build, a test suite).');
		}
		if (isWindows) {
			return fail('sample needs a POSIX shell and ps (macOS or Linux).');
		}
		const dir = await this.recordingDir();
		const out = joinPath(dir, 'usage.txt');
		const interval = Math.max(0.05, Math.min(5, (num(args, 'interval_ms') ?? 200) / 1000));
		const started = Date.now();
		const line = ['sh', '-c', USAGE_SAMPLER_SCRIPT, 'volt-sample', out.fsPath, String(interval), command].map(part => shellQuote(part, false)).join(' ');
		const result = await ctx.cli.shell(line, { timeoutMs: num(args, 'timeout_ms') ?? 600_000, writable: [dir.fsPath] });
		const wall = Date.now() - started;
		const lines = await this.fileService.readFile(out).then(content => content.value.toString(), () => '');
		if (!lines.trim()) {
			return fail(`No samples were taken (exit code ${result.code}): the command ended before the first one, or ps is not available.\n${tailOf(result.stderr || result.stdout, 10)}`);
		}
		const data = usageProfile(lines, wall, command, result.code);
		const loaded = await this.profiler.saveCustom(data, this.loadOptions(ctx));
		this.reveal(loaded);
		return ok(`Profile ${loaded.id} (${loaded.file.fsPath}) is open in the Profiler.\n${summarizeProfile(loaded.profile)}${result.code ? `\nThe command exited with ${result.code}:\n${tailOf(result.stderr || result.stdout, 10)}` : ''}`);
	}

	private async bench(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const command = str(args, 'command');
		if (!command) {
			return fail('bench needs command.');
		}
		const runs = Math.min(Math.max(num(args, 'runs') ?? 10, 1), 200);
		const warmup = Math.min(num(args, 'warmup') ?? 1, 20);
		const hyperfine = await ctx.cli.run('hyperfine', ['--version'], { timeoutMs: 10_000 });
		if (!hyperfine.missing && hyperfine.code === 0) {
			const dir = await this.recordingDir();
			const report = joinPath(dir, 'bench.json');
			const result = await ctx.cli.run('hyperfine', ['--runs', String(runs), '--warmup', String(warmup), '--export-json', report.fsPath, '--style', 'none', command], { timeoutMs: 1_800_000, writable: [dir.fsPath] });
			const json = await this.fileService.readFile(report).then(file => JSON.parse(file.value.toString()) as { results: { mean: number; stddev: number; min: number; max: number; median: number }[] }, () => undefined);
			const stats = json?.results[0];
			return stats ? ok(`${command}: mean ${ms(stats.mean * 1000)} \u00b1 ${ms(stats.stddev * 1000)}, median ${ms(stats.median * 1000)}, min ${ms(stats.min * 1000)}, max ${ms(stats.max * 1000)} (${runs} runs, hyperfine).`) : fail(tailOf(result.stderr, 20));
		}
		const times: number[] = [];
		for (let i = 0; i < warmup + runs; i++) {
			const started = Date.now();
			const result = await ctx.cli.shell(command, { timeoutMs: 600_000 });
			if (result.code !== 0) {
				return fail(`Run ${i + 1} failed with exit code ${result.code}:\n${tailOf(result.stderr || result.stdout, 15)}`);
			}
			if (i >= warmup) {
				times.push(Date.now() - started);
			}
		}
		const mean = times.reduce((sum, value) => sum + value, 0) / times.length;
		const stddev = Math.sqrt(times.reduce((sum, value) => sum + (value - mean) ** 2, 0) / times.length);
		const sorted = [...times].sort((a, b) => a - b);
		return ok(`${command}: mean ${ms(mean)} \u00b1 ${ms(stddev)}, median ${ms(sorted[Math.floor(sorted.length / 2)])}, min ${ms(sorted[0])}, max ${ms(sorted[sorted.length - 1])} (${runs} runs, wall time incl. shell start; install hyperfine for precise numbers).`);
	}

	// --- Reading -------------------------------------------------------------------------------

	private async open(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const file = resolvePath(ctx.root, str(args, 'path'));
		if (!file) {
			return fail('open needs path to a profile: .cpuprofile, .heapprofile, speedscope JSON, Chrome trace JSON, folded stacks or a Volt profile.');
		}
		const base = resolvePath(ctx.root, str(args, 'compare_with'));
		const loaded = await this.profiler.load(file, { ...this.loadOptions(ctx), ...(base ? { compareWith: base } : {}) });
		this.reveal(loaded);
		const text = loaded.base ? summarizeComparison(loaded.base.profile, loaded.profile, ctx.root?.fsPath) : summarizeProfile(loaded.profile, this.summaryOptions(ctx, args));
		return ok(`Profile ${loaded.id} is open in the Profiler.\n${text}`);
	}

	private async analyze(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const loaded = await this.resolve(args, ctx);
		if (!loaded) {
			return this.missing(args);
		}
		const range = rangeArg(args);
		const fn = str(args, 'function');
		if (fn) {
			const frame = findFrames(loaded.profile, fn)[0];
			if (frame === undefined) {
				return fail(`No function matching "${fn}" in ${loaded.id}.`);
			}
			return ok(describeFrame(loaded.profile, frame, ctx.root?.fsPath, range));
		}
		return ok(`${loaded.id}: ${summarizeProfile(loaded.profile, { ...this.summaryOptions(ctx, args), ...(range ? { range } : {}) })}`);
	}

	private async compare(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const base = await this.resolve({ profile: args.base }, ctx);
		const next = await this.resolve({ profile: args.profile }, ctx);
		if (!base || !next) {
			return fail('compare needs base (the run before: a profile id or path) and profile (the run after; default this chat\'s newest).');
		}
		if (base.id === next.id) {
			return fail('base and profile are the same profile.');
		}
		const loaded = await this.profiler.load(next.file, { ...this.loadOptions(ctx), compareWith: base.file });
		this.reveal(loaded);
		return ok(`${summarizeComparison(base.profile, next.profile, ctx.root?.fsPath)}\nThe difference is open in the Profiler (${loaded.id}): red got slower, blue faster.`);
	}

	private selection(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): IIdeCapabilityResult {
		const loaded = this.find(args, ctx);
		if (!loaded) {
			return this.missing(args);
		}
		const { state, profile } = loaded;
		const lines = [`${loaded.id} "${profile.title}": view ${state.view}${state.search ? `, search "${state.search}"` : ''}${state.by === 'agent' ? ' (you set it last)' : ''}.`];
		if (state.range) {
			lines.push(`Window: ${formatValue(state.range.start, 'milliseconds')} to ${formatValue(state.range.end, 'milliseconds')}.`);
		}
		if (state.focusNode > 0) {
			const focus = profile.nodes[state.focusNode];
			if (focus) {
				lines.push(`Flame graph zoomed into ${frameLabel(profile.frames[focus.frame], ctx.root?.fsPath)}.`);
			}
		}
		if (state.selectedFrame !== undefined && profile.frames[state.selectedFrame]) {
			lines.push('Selected:', describeFrame(profile, state.selectedFrame, ctx.root?.fsPath, state.range));
		} else {
			lines.push('Nothing selected.');
		}
		if (loaded.notes.length) {
			lines.push(`Notes: ${loaded.notes.map(note => `#${note.id} ${note.text}`).join('; ')}`);
		}
		return ok(lines.join('\n'));
	}

	private list(ctx: IIdeCapabilityContext): IIdeCapabilityResult {
		const profiles = this.profiler.list(ctx.chatId);
		if (!profiles.length) {
			return ok('No profiles in this chat yet. Record one (cpu, heap, sample) or open a file (open).');
		}
		return ok(profiles.map(item => `${item.id}  ${item.profile.title}  (${item.profile.format}, ${item.profile.kind})  ${item.file.fsPath}`).join('\n'));
	}

	// --- Working in the tab with the user ------------------------------------------------------

	private async focus(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const loaded = await this.resolve(args, ctx);
		if (!loaded) {
			return this.missing(args);
		}
		const fn = str(args, 'function');
		const frame = fn ? findFrames(loaded.profile, fn)[0] : undefined;
		if (fn && frame === undefined) {
			return fail(`No function matching "${fn}" in ${loaded.id}.`);
		}
		const view = str(args, 'view') as ProfilerView | undefined;
		if (view && !VIEWS.includes(view)) {
			return fail(`view must be one of ${VIEWS.join(', ')}.`);
		}
		let range = rangeArg(args);
		if (!range && frame !== undefined && args.zoom !== false) {
			const span = frameTimeRange(loaded.profile, frame);
			range = span ? { start: span.start - (span.end - span.start) * 0.05, end: span.end + (span.end - span.start) * 0.05 } : undefined;
		}
		const search = typeof args.search === 'string' ? args.search : undefined;
		this.profiler.update(loaded.id, {
			...(view ? { view } : {}),
			...(frame !== undefined ? { selectedFrame: frame } : {}),
			...(range ? { range } : args.reset === true ? { range: undefined } : {}),
			...(search !== undefined ? { search } : {}),
			...(args.reset === true ? { focusNode: 0 } : {}),
		}, 'agent');
		this.reveal(loaded);
		const shown = [
			view ? `view ${view}` : '',
			frame !== undefined ? `selected ${frameLabel(loaded.profile.frames[frame], ctx.root?.fsPath)}` : '',
			range ? `window ${formatValue(range.start, 'milliseconds')} to ${formatValue(range.end, 'milliseconds')}` : '',
			search !== undefined ? `search "${search}"` : '',
		].filter(Boolean).join(', ');
		return ok(`The user now sees ${loaded.id}${shown ? `: ${shown}` : ''}.`);
	}

	private async annotate(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const loaded = await this.resolve(args, ctx);
		if (!loaded) {
			return this.missing(args);
		}
		const text = str(args, 'note');
		if (!text) {
			return fail('annotate needs note: one or two sentences the user reads on the profile.');
		}
		const fn = str(args, 'function');
		const frame = fn ? findFrames(loaded.profile, fn)[0] : undefined;
		if (fn && frame === undefined) {
			return fail(`No function matching "${fn}" in ${loaded.id}.`);
		}
		const range = rangeArg(args);
		const note = this.profiler.addNote(loaded.id, { text: text.slice(0, 500), ...(frame !== undefined ? { frame } : {}), ...(range ? { range } : {}), by: 'agent' });
		this.reveal(loaded);
		return ok(`Note #${note?.id} is on ${loaded.id}${frame !== undefined ? `, pinned to ${loaded.profile.frames[frame].name}` : ''}.`);
	}

	private async show(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<IIdeCapabilityResult> {
		const data: IVoltProfileFile = {
			$volt: 'profile',
			title: str(args, 'title') ?? 'Data',
			...(typeof args.unit === 'string' ? { unit: args.unit as IVoltProfileFile['unit'] } : {}),
			...(typeof args.kind === 'string' ? { kind: args.kind as IVoltProfileFile['kind'] } : {}),
			...(args.stacks !== undefined ? { stacks: args.stacks as IVoltProfileFile['stacks'] } : {}),
			...(args.series !== undefined ? { series: args.series as IVoltProfileFile['series'] } : {}),
			...(args.matrix !== undefined ? { matrix: args.matrix as IVoltProfileFile['matrix'] } : {}),
		};
		try {
			const loaded = await this.profiler.saveCustom(data, this.loadOptions(ctx));
			this.reveal(loaded);
			return ok(`Shown as ${loaded.id} (${loaded.file.fsPath}) in the Profiler.\n${summarizeProfile(loaded.profile)}`);
		} catch (err) {
			return fail(`${err instanceof Error ? err.message : String(err)} Arguments: stacks (folded text "a;b;c 42" per line, or [{stack: ["a","b"], value: 42}]), series ([{name, unit, points: [[ms, value], ...]}]) or matrix ({rows, columns, values: [[...]], unit}); unit is milliseconds, bytes, samples, count or percent.`);
		}
	}

	// --- Helpers -------------------------------------------------------------------------------

	private loadOptions(ctx: IIdeCapabilityContext) {
		return { ...(ctx.chatId ? { chatId: ctx.chatId } : {}), ...(ctx.root ? { root: ctx.root.fsPath } : {}) };
	}

	private summaryOptions(ctx: IIdeCapabilityContext, args: Readonly<Record<string, unknown>>) {
		const limit = num(args, 'limit');
		const filter = str(args, 'filter');
		return { ...(ctx.root ? { root: ctx.root.fsPath } : {}), ...(limit ? { limit: Math.min(40, Math.max(3, limit)) } : {}), ...(filter ? { filter } : {}) };
	}

	/** A loaded profile by id, else a path loaded now; this chat's newest when none is named. */
	private async resolve(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): Promise<ILoadedProfile | undefined> {
		const ref = typeof args.profile === 'string' && args.profile.trim() ? args.profile.trim() : str(args, 'path');
		const found = this.profiler.find(ref, ctx.chatId);
		if (found || !ref) {
			return found;
		}
		const file = resolvePath(ctx.root, ref);
		return file ? this.profiler.load(file, this.loadOptions(ctx)).catch(() => undefined) : undefined;
	}

	private find(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext): ILoadedProfile | undefined {
		return this.profiler.find(typeof args.profile === 'string' ? args.profile : undefined, ctx.chatId);
	}

	private missing(args: Readonly<Record<string, unknown>>): IIdeCapabilityResult {
		return fail(typeof args.profile === 'string' ? `No profile ${args.profile}. Call op list.` : 'No profile in this chat yet: record one (cpu, heap, sample), open a file (open), or name one with profile.');
	}
}

/** `window: [start_ms, end_ms]`, or `start_ms` / `end_ms`. */
function rangeArg(args: Readonly<Record<string, unknown>>): ITimeRange | undefined {
	const window = Array.isArray(args.window) ? args.window : undefined;
	const start = typeof window?.[0] === 'number' ? window[0] : num(args, 'start_ms');
	const end = typeof window?.[1] === 'number' ? window[1] : num(args, 'end_ms');
	return start !== undefined && end !== undefined && end > start ? { start, end } : undefined;
}

function tailOf(text: string, lines: number): string {
	return stripAnsi(text).trim().split('\n').slice(-lines).join('\n');
}

function ms(value: number): string {
	return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(1)}ms`;
}
