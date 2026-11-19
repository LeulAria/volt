/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { formatHttpPerfMs, formatHttpPerfNumber, formatHttpPerfPercent, HTTP_PERF_AGENT_MAX_SECONDS, HTTP_PERF_AGENT_MAX_USERS, httpPerfMarkdownReport, httpPerfRunText, IHttpPerfRun } from '../../../../voltHttp/common/httpPerformance.js';
import { IHttpPerfEntry, IVoltHttpPerformance } from '../../../../voltHttp/browser/voltHttpPerformance.js';
import { display, fail, IIdeCapabilityContext, IIdeCapabilityResult, ok, resolvePath, str } from './capability.js';

const PERF_OPS = new Set(['perf_list', 'perf_get', 'perf_save', 'perf_run', 'perf_report']);
const MAX_REPORT_CHARS = 24_000;

/** Why an op that sends load is refused for this chat, or undefined. */
function runRefusal(ctx: IIdeCapabilityContext): string | undefined {
	return ctx.confinement ? 'A sandboxed chat cannot run performance tests: the load is sent from Volt\'s process, outside the chat\'s network rules. Ask the user to run the test in the Volt Client.' : undefined;
}

/** The test file an op names with `path` (a path or a test's name), or the project's only one. */
async function perfFile(args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext, performance: IVoltHttpPerformance): Promise<IHttpPerfEntry> {
	const raw = str(args, 'path') ?? str(args, 'test');
	const files = await performance.list(ctx.root);
	let uri: URI | undefined;
	if (raw) {
		const resolved = resolvePath(ctx.root, raw);
		uri = files.find(item => resolved && item.uri.toString() === resolved.toString())?.uri ?? files.find(item => item.name === raw)?.uri ?? resolved;
	} else if (files.length === 1) {
		uri = files[0].uri;
	} else {
		throw new Error(files.length ? `Say which test with path. The project has: ${files.map(item => display(ctx.root, item.uri)).join(', ')}.` : 'The project has no performance tests yet. op perf_save creates one.');
	}
	const entry = uri ? await performance.load(uri) : undefined;
	if (!entry) {
		throw new Error(`No performance test at "${raw}". op perf_list shows the project's tests.`);
	}
	if (entry.error) {
		throw new Error(`${display(ctx.root, entry.uri)} could not be read: ${entry.error}`);
	}
	return entry;
}

/** The run `run` names (an id), or the newest. */
function pickRun(entry: IHttpPerfEntry, args: Readonly<Record<string, unknown>>): IHttpPerfRun | undefined {
	const id = str(args, 'run');
	return id ? entry.file.runs.find(run => run.id === id || run.id.startsWith(id)) : entry.file.runs[0];
}

function runLine(run: IHttpPerfRun): string {
	return `${run.id.slice(0, 8)}  ${new Date(run.startedAt).toISOString()}  ${run.verdict.passed ? 'passed' : 'FAILED'}  ${run.config.users} ${run.mode === 'http' ? 'users' : 'connections'}, ${formatHttpPerfNumber(run.rate)}/s, p95 ${formatHttpPerfMs(run.metrics.p95)}, errors ${formatHttpPerfPercent(run.metrics.errorRate)}${run.config.by === 'agent' ? ' (agent)' : ''}${run.ended === 'stopped' ? ' (stopped)' : ''}`;
}

/**
 * The `ide http perf_*` ops: load tests of the project's own services. Agents can read, define,
 * run (capped, and only against local or private hosts or hosts the user already confirmed for
 * that test in the Volt Client) and report tests. They can never confirm a host.
 * Answers undefined for an op that is not one of these.
 */
export async function runHttpPerformanceOp(op: string, args: Readonly<Record<string, unknown>>, ctx: IIdeCapabilityContext, performance: IVoltHttpPerformance): Promise<IIdeCapabilityResult | undefined> {
	if (!PERF_OPS.has(op)) {
		return undefined;
	}
	try {
		switch (op) {
			case 'perf_list': {
				const files = await performance.list(ctx.root);
				if (!files.length) {
					return ok('No performance tests in the project (*.volt-perf.json). op perf_save creates one from { name, mode, targets: [{ ref: { collection, path } } | { inline: { method, url, headers?, body? } }], load, thresholds }.');
				}
				return ok(files.map(item => `${display(ctx.root, item.uri)}  "${item.name}"  ${item.running ? 'running now' : item.detail ?? ''}`).join('\n'));
			}
			case 'perf_get': {
				const entry = await perfFile(args, ctx, performance);
				const file = entry.file;
				if (str(args, 'run')) {
					const run = pickRun(entry, args);
					return run ? ok(httpPerfRunText(file, run)) : fail(`No run ${str(args, 'run')} in ${display(ctx.root, entry.uri)}. op perf_get without run lists them.`);
				}
				const live = performance.runOf(entry.uri);
				return ok(JSON.stringify({
					path: display(ctx.root, entry.uri),
					name: file.name,
					description: file.description,
					mode: file.mode,
					targets: file.targets,
					load: file.load,
					...(file.mode === 'ws' ? { ws: file.ws } : {}),
					thresholds: file.thresholds,
					// What the user confirmed in this Volt; a host only written into the file does not count.
					confirmedHosts: performance.confirmedHostsOf(entry.uri),
					running: !!live?.running,
					runs: file.runs.map(runLine),
				}, null, 2));
			}
			case 'perf_save': {
				const raw = args.definition ?? args.test_definition ?? args.json;
				let definition: unknown = raw;
				if (typeof raw === 'string') {
					try {
						definition = JSON.parse(raw);
					} catch {
						return fail('definition is not valid JSON.');
					}
				}
				if (definition === undefined) {
					const { path: _path, ...rest } = args;
					definition = rest;
				}
				const target = str(args, 'path');
				const uri = target ? resolvePath(ctx.root, target) : undefined;
				if (ctx.confinement) {
					const check = uri ?? ctx.root;
					const refused = check && ctx.confinement.writeRefusal ? await ctx.confinement.writeRefusal(check.fsPath) : 'Volt cannot tell whether this sandboxed chat may write the test file';
					if (refused) {
						return fail(`Not saved: ${refused}.`);
					}
				}
				const saved = await performance.saveDefinition(ctx.root, definition, uri && await performance.load(uri) ? uri : undefined);
				const asRecord = typeof definition === 'object' && definition !== null ? definition as Record<string, unknown> : {};
				const ignored = ['confirmedHosts', 'runs'].filter(key => key in asRecord);
				const prepared = await performance.prepare(saved, ctx.root).catch(() => undefined);
				return ok([
					`Saved ${display(ctx.root, saved)}.`,
					...(ignored.length ? [`Ignored ${ignored.join(', ')}: only the user and the runs set those.`] : []),
					...(prepared?.problems.length ? ['Before it can run:', ...prepared.problems.map(problem => `- ${problem}`)] : []),
					...(prepared?.toConfirm.length ? [`${prepared.toConfirm.join(', ')} must be confirmed by the user (press Run in the Volt Client once) before an agent may load ${prepared.toConfirm.length === 1 ? 'it' : 'them'}.`] : []),
				].join('\n'));
			}
			case 'perf_run': {
				const refused = runRefusal(ctx);
				if (refused) {
					return fail(refused);
				}
				const entry = await perfFile(args, ctx, performance);
				if (performance.runOf(entry.uri)?.running) {
					return fail(`${entry.file.name} is running already. Wait for it (op perf_get shows when it ended) or ask the user to stop it.`);
				}
				const prepared = await performance.prepare(entry.uri, ctx.root);
				if (prepared.problems.length) {
					return fail(['The test cannot run:', ...prepared.problems.map(problem => `- ${problem}`)].join('\n'));
				}
				if (prepared.toConfirm.length) {
					return fail(`Not run: ${prepared.toConfirm.join(', ')} ${prepared.toConfirm.length === 1 ? 'is' : 'are'} neither this machine nor a private network, and the user has not confirmed load on ${prepared.toConfirm.length === 1 ? 'it' : 'them'} for this test. Ask the user to press Run on the test in the Volt Client once; an agent cannot confirm a host.`);
				}
				const load = entry.file.load;
				const capped = load.users > HTTP_PERF_AGENT_MAX_USERS || (load.warmupSec + (load.durationSec ?? 0)) > HTTP_PERF_AGENT_MAX_SECONDS || (!load.durationSec && !!load.requests);
				const state = await performance.run(entry.uri, { ...(ctx.root ? { root: ctx.root } : {}), caps: { maxUsers: HTTP_PERF_AGENT_MAX_USERS, maxSeconds: HTTP_PERF_AGENT_MAX_SECONDS }, by: 'agent', token: ctx.token });
				if (state.error) {
					return fail(`The run failed: ${state.error}`);
				}
				if (!state.result) {
					return fail('The run ended without a result.');
				}
				const file = performance.get(entry.uri)?.file ?? entry.file;
				return ok([
					httpPerfRunText(file, state.result),
					...(capped ? ['', `An agent's run is capped at ${HTTP_PERF_AGENT_MAX_USERS} users and ${HTTP_PERF_AGENT_MAX_SECONDS} s: this one ran with ${state.config.users} users${state.config.durationSec ? ` for at most ${state.config.durationSec} s` : ''}. The user can run the full test in the Volt Client.`] : []),
					'',
					`Saved as run ${state.result.id.slice(0, 8)} in ${display(ctx.root, entry.uri)}. op perf_report gives the full report.`,
				].join('\n'));
			}
			case 'perf_report': {
				const entry = await perfFile(args, ctx, performance);
				const run = pickRun(entry, args);
				if (!run) {
					return fail(str(args, 'run') ? `No run ${str(args, 'run')} in the test.` : 'The test has not run yet. op perf_run runs it.');
				}
				const index = entry.file.runs.findIndex(item => item.id === run.id);
				const report = httpPerfMarkdownReport(entry.file, run, index >= 0 ? entry.file.runs[index + 1] : undefined);
				return ok(report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS)}\n\n[${report.length - MAX_REPORT_CHARS} more characters: export the full report from the Volt Client]` : report);
			}
		}
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
	return undefined;
}
