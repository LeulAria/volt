/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// A deterministic micro-benchmark of the orchestrator's critical path. It loads the real decider and
// AgentOrchestratorService from out/ in plain Node (as the agent server does), on a real disk store
// under the temp folder, with a fake runtime and turn host that answer at once: every millisecond
// measured is Volt's own (durable saves, promise hops, CPU). No model is called.
//
// Usage (transpile first: npm run -s transpile-client-oxc):
//   node scripts/volt-e2e/orch/bench.mjs [--out file.json] [--runs 30] [--store disk|memory] [--dump dir]
// Compare two runs: node scripts/volt-e2e/orch/compare.mjs before.json after.json --md

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : fallback;
};
const RUNS = Number(flag('runs', '30'));
const OUT = flag('out', '/tmp/volt-orch-bench.json');
const STORE = flag('store', 'disk');
const DUMP = flag('dump', '');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const load = rel => import(pathToFileURL(path.join(repo, 'out/vs', rel)).href);

const { Emitter } = await load('base/common/event.js');
const { DisposableStore, toDisposable } = await load('base/common/lifecycle.js');
const { URI } = await load('base/common/uri.js');
const { VSBuffer } = await load('base/common/buffer.js');
const { FileService } = await load('platform/files/common/fileService.js');
const { DiskFileSystemProvider } = await load('platform/files/node/diskFileSystemProvider.js');
const { InMemoryFileSystemProvider } = await load('platform/files/common/inMemoryFilesystemProvider.js');
const { NullLogService } = await load('platform/log/common/log.js');
const { AgentOrchestratorService } = await load('workbench/services/voltRuntime/browser/orchestration/agentOrchestratorService.js');
const { VOLT_HOST_TOOLS } = await load('workbench/services/voltRuntime/common/hostTools.js');
const { AGENT_TASK_TOOLS, buildTaskNotification } = await load('workbench/services/voltRuntime/common/orchestration/agentTasks.js');
const { ORCH_MAX_PARALLEL_SETTING, ORCH_MAX_PARALLEL_TOTAL_SETTING, ORCH_MAX_PER_CALL_SETTING } = await load('workbench/services/voltRuntime/common/orchestration/orchestrator.js');
const { THREAD_TOOLS } = await load('workbench/services/voltRuntime/common/orchestration/agentThreadTools.js');
const { ORCHESTRA_TOOLS } = await load('workbench/services/voltRuntime/common/orchestration/orchestra.js');
const { TERMINAL_TOOLS } = await load('workbench/services/voltRuntime/common/terminalTools.js');
const { VOLT_MEMORY_TOOLS } = await load('workbench/services/voltRuntime/common/memory/voltMemory.js');
const { JOB_WATCH_TOOLS } = await load('workbench/services/voltRuntime/common/jobs/jobWatch.js');
const { WATCHED_TASK_TOOLS } = await load('workbench/services/voltRuntime/common/terminals/watchedTasks.js');
const { CODE_INTELLIGENCE_TOOLS } = await load('workbench/services/voltRuntime/common/codeIntelligence.js');
const { IDE_TOOLS } = await load('workbench/services/voltRuntime/common/ide/ideTools.js');
const { DEVICE_TOOLS, CAPTURE_TOOLS } = await load('workbench/services/voltRuntime/common/deviceTools.js');
const { DESKTOP_TOOLS } = await load('workbench/services/voltRuntime/common/desktopTools.js');
const { PLAYGROUND_TOOLS } = await load('workbench/services/voltRuntime/common/playgroundTools.js');
const { DEFAULT_SANDBOX_SETTINGS } = await load('platform/voltSandbox/common/sandboxPolicy.js');

const now = () => performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A user request and parent reply of realistic length, so capsules and saves are not empty. */
const USER_REQUEST = 'In the repo, add input validation to src/a.ts (reject negative and non-integer amounts with a RangeError), write unit tests for src/b.ts covering the edge cases, and review src/c.ts for bugs. Run these in parallel, then summarize what changed and what the review found. Keep the public API unchanged.';
const PARENT_REPLY = 'I will split this into three subagents: one implements the validation in src/a.ts, one writes tests for src/b.ts, and one reviews src/c.ts read-only. I will merge their reports when they finish.';
const CHILD_REPORT = ['## Outcome', 'Done: added the validation and its tests.', '', '## Changes', '- src/a.ts: `charge()` now throws RangeError for negative or non-integer amounts.', '- test/a.test.mjs: 4 cases.', '', '## Verification', '`node --test` passes (12 tests).', '', '## Open issues', 'None'].join('\n');

class BenchRuntime {
	constructor() {
		this.emitter = new Emitter();
		this.onDidEmit = this.emitter.event;
		this.seq = 0;
		this.runs = 0;
		this.sends = [];
		this.replies = new Map();
	}
	listCatalog() {
		return [
			{ ref: 'agent:claude', kind: 'agent', providerId: 'claude', profileId: 'p', id: 'sonnet', label: 'Claude Sonnet', enabled: true },
			{ ref: 'agent:haiku', kind: 'agent', providerId: 'claude', profileId: 'p', id: 'haiku', label: 'Claude Haiku', enabled: true },
		];
	}
	listProviderStatuses() { return []; }
	canSteer() { return false; }
	chatFor(id) { return id; }
	getModelOptions() { return {}; }
	rememberWorktree() { }
	releaseSession() { }
	getSandboxSettings() { return DEFAULT_SANDBOX_SETTINGS; }
	getAccessMode() { return 'full-access'; }
	async setAccessMode() { }
	async setSandboxSettings() { }
	getOrCreateSession(threadId) {
		const reply = this.replies.get(threadId);
		const messages = threadId.startsWith('agent-') ? [] : [{ role: 'user', content: USER_REQUEST }, { role: 'assistant', content: PARENT_REPLY }];
		return { providerRef: undefined, activeRun: undefined, messages: reply ? [...messages, { role: 'assistant', content: reply }] : messages };
	}
	async send(threadId, request) {
		const runId = `run${++this.runs}`;
		this.sends.push({ threadId, request, runId });
		this.emit(threadId, runId, { type: 'run.start', runId, mode: request.mode });
		return runId;
	}
	async cancel() { }
	emit(threadId, runId, event) {
		this.emitter.fire({ seq: ++this.seq, runId, sessionId: threadId, timestamp: Date.now(), event });
	}
	finish(threadId, reply = 'done') {
		const last = [...this.sends].reverse().find(send => send.threadId === threadId);
		if (!last) {
			throw new Error(`no run in ${threadId}`);
		}
		this.replies.set(threadId, reply);
		this.emit(threadId, last.runId, { type: 'run.end', runId: last.runId, reason: 'done' });
	}
	dispose() {
		this.emitter.dispose();
	}
}

/** Records when each turn start reaches the host, and lets a bench wait for one. */
class BenchHost {
	constructor(runtime) {
		this.runtime = runtime;
		this.started = [];
		this.onStart = new Emitter();
	}
	async startTurn(request) {
		this.started.push({ request, at: now() });
		this.onStart.fire();
		return this.runtime.send(request.threadId, { text: request.turn.prompt.text, mode: 'agent' });
	}
	/** Resolves with the time the `count`th start matching `match` arrived. */
	waitFor(match, count = 1) {
		const check = () => {
			const hits = this.started.filter(entry => match(entry.request));
			return hits.length >= count ? hits[count - 1].at : undefined;
		};
		const hit = check();
		if (hit !== undefined) {
			return Promise.resolve(hit);
		}
		return new Promise(resolve => {
			const listener = this.onStart.event(() => {
				const at = check();
				if (at !== undefined) {
					listener.dispose();
					resolve(at);
				}
			});
		});
	}
	dispose() {
		this.onStart.dispose();
	}
}

async function setup(settings = {}) {
	const disposables = new DisposableStore();
	const fileService = disposables.add(new FileService(new NullLogService()));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-orch-bench-'));
	disposables.add(toDisposable(() => fs.rmSync(home, { recursive: true, force: true })));
	disposables.add(fileService.registerProvider('file', disposables.add(STORE === 'disk' ? new DiskFileSystemProvider(new NullLogService()) : new InMemoryFileSystemProvider())));
	// Count what the orchestrator writes.
	const stats = { writes: 0, bytes: 0, ms: 0 };
	const write = fileService.writeFile.bind(fileService);
	fileService.writeFile = async (resource, content, options) => {
		const started = now();
		stats.writes++;
		stats.bytes += content instanceof VSBuffer ? content.byteLength : 0;
		try {
			return await write(resource, content, options);
		} finally {
			stats.ms += now() - started;
		}
	};
	const runtime = new BenchRuntime();
	disposables.add(toDisposable(() => runtime.dispose()));
	let tools;
	const service = disposables.add(new AgentOrchestratorService(
		runtime,
		fileService,
		{ userRoamingDataHome: URI.file(home) },
		new NullLogService(),
		{ whenReady: Promise.resolve(), get: () => undefined, sessionParent: () => undefined, open: () => ({ setMeta: () => undefined }) },
		{ registerToolProvider: provider => { tools = provider; return toDisposable(() => tools = undefined); } },
		{ create: async () => ({ path: '/wt/a', branch: 'volt/a' }), ensure: async (_root, p) => ({ path: p, recreated: false }) },
		{ rootFor: () => URI.file('/repo') },
		{ getValue: key => settings[key] ?? (key === 'volt.agent.resumeAfterRestart' ? 'off' : undefined), onDidChangeConfiguration: () => toDisposable(() => undefined) },
		{ run: async () => undefined, needsRetry: () => false },
		{ onWillShutdown: () => toDisposable(() => undefined) },
		{ invokeFunction: () => undefined },
		{ exec: async () => ({ exitCode: 0, stdout: '', stderr: '', combined: '', timedOut: false }), cancelExec: async () => undefined },
	));
	await service.whenReady;
	const host = new BenchHost(runtime);
	disposables.add(host);
	disposables.add(service.setTurnHost(host));
	const tool = async (threadId, name, toolArgs) => {
		const result = await tools.invoke(name, toolArgs, { sessionId: threadId });
		return result.error ?? result.text ?? '';
	};
	return { service, runtime, host, tool, stats, disposables, home };
}

/** A parent chat whose first turn is running. */
async function parentRunning(ctx) {
	await ctx.service.submit('parent', { text: USER_REQUEST, modelRef: 'agent:claude' }, 'auto', 'p1');
	await ctx.host.waitFor(request => request.threadId === 'parent');
}

const childStarts = request => request.threadId.startsWith('agent-') && request.turn.kind === 'brief';
const parentWake = request => request.threadId === 'parent' && request.turn.kind === 'notification';

function summarize(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
	const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
	const round = v => Math.round(v * 1000) / 1000;
	return { n: values.length, mean: round(mean), p50: round(pick(0.5)), p90: round(pick(0.9)), min: round(sorted[0] ?? 0), max: round(sorted.at(-1) ?? 0) };
}

async function repeat(runs, body, settings) {
	const samples = new Map();
	for (let i = 0; i < runs; i++) {
		const ctx = await setup(settings);
		try {
			const result = await body(ctx);
			for (const [key, value] of Object.entries(result)) {
				samples.set(key, [...(samples.get(key) ?? []), value]);
			}
		} finally {
			// Let the effect chain and pending writes finish before the files go.
			await sleep(20);
			ctx.disposables.dispose();
		}
	}
	return Object.fromEntries([...samples].map(([key, values]) => [key, summarize(values)]));
}

const tokens = chars => Math.round(chars / 4);
const toolSize = list => {
	const chars = list.reduce((sum, tool) => sum + JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length, 0);
	return { tools: list.length, chars, estTokens: tokens(chars) };
};

const results = { store: STORE, runs: RUNS, at: new Date().toISOString(), commit: process.env.VOLT_BENCH_COMMIT ?? '' };

results.submitToStart = await repeat(RUNS, async ctx => {
	const t0 = now();
	await ctx.service.submit('chat', { text: 'hello', modelRef: 'agent:claude' }, 'auto', 't1');
	const started = await ctx.host.waitFor(request => request.threadId === 'chat');
	return { ms: started - t0, writes: ctx.stats.writes, bytes: ctx.stats.bytes };
});

results.delegateToChildStart = await repeat(RUNS, async ctx => {
	await parentRunning(ctx);
	const w0 = ctx.stats.writes;
	const b0 = ctx.stats.bytes;
	const t0 = now();
	const text = await ctx.tool('parent', 'delegate_task', { task: 'Add validation to src/a.ts: reject negative and non-integer amounts with a RangeError.', title: 'Validate a.ts', role: 'implementation', scope: ['src/a.ts'], done_when: ['node --test passes'] });
	const returned = now();
	const started = await ctx.host.waitFor(childStarts);
	const brief = ctx.host.started.find(entry => childStarts(entry.request)).request.turn.prompt.text;
	if (DUMP) {
		fs.writeFileSync(path.join(DUMP, 'child-brief.txt'), brief);
		fs.writeFileSync(path.join(DUMP, 'delegate-result.txt'), text);
	}
	return { toolReturnMs: returned - t0, childStartMs: started - t0, writes: ctx.stats.writes - w0, bytes: ctx.stats.bytes - b0, toolResultChars: text.length, childPromptChars: brief.length };
});

results.childEndToParentWake = await repeat(RUNS, async ctx => {
	await parentRunning(ctx);
	await ctx.tool('parent', 'delegate_task', { task: 'Review src/c.ts for bugs.', role: 'review' });
	await ctx.host.waitFor(childStarts);
	ctx.runtime.finish('parent', 'Delegated; waiting for the report.');
	// The parent's turn settles (its write lands) before the child ends.
	await sleep(30);
	const child = ctx.service.tasksOf('parent')[0].childId;
	const w0 = ctx.stats.writes;
	const b0 = ctx.stats.bytes;
	const t0 = now();
	ctx.runtime.finish(child, CHILD_REPORT);
	const woken = await ctx.host.waitFor(parentWake);
	const wake = ctx.host.started.find(entry => parentWake(entry.request)).request.turn.prompt.text;
	if (DUMP) {
		fs.writeFileSync(path.join(DUMP, 'wake-prompt.txt'), wake);
	}
	return { ms: woken - t0, writes: ctx.stats.writes - w0, bytes: ctx.stats.bytes - b0, wakePromptChars: wake.length, reportChars: CHILD_REPORT.length };
});

results.waitTasksReturn = await repeat(RUNS, async ctx => {
	await parentRunning(ctx);
	await ctx.tool('parent', 'delegate_task', { task: 'Count the tests in test/.', role: 'research' });
	await ctx.host.waitFor(childStarts);
	const child = ctx.service.tasksOf('parent')[0].childId;
	let returned = 0;
	const waiting = ctx.tool('parent', 'wait_tasks', {}).then(text => { returned = now(); return text; });
	await sleep(5);
	const t0 = now();
	ctx.runtime.finish(child, CHILD_REPORT);
	const text = await waiting;
	return { ms: returned - t0, resultChars: text.length };
});

for (const fan of [5, 10, 20]) {
	const settings = { [ORCH_MAX_PARALLEL_SETTING]: fan, [ORCH_MAX_PARALLEL_TOTAL_SETTING]: fan, [ORCH_MAX_PER_CALL_SETTING]: fan };
	results[`fanOut${fan}`] = await repeat(Math.max(5, Math.round(RUNS / 3)), async ctx => {
		await parentRunning(ctx);
		const w0 = ctx.stats.writes;
		const b0 = ctx.stats.bytes;
		const wms0 = ctx.stats.ms;
		const t0 = now();
		const tasks = Array.from({ length: fan }, (_, i) => ({ task: `Part ${i + 1}: implement handler ${i + 1} in src/h${i + 1}.ts and its test.`, title: `Handler ${i + 1}`, role: 'implementation', scope: [`src/h${i + 1}.ts`] }));
		const text = await ctx.tool('parent', 'delegate_task', { tasks });
		const returned = now();
		const first = await ctx.host.waitFor(childStarts, 1);
		const all = await ctx.host.waitFor(childStarts, fan);
		const writes = ctx.stats.writes - w0;
		const bytes = ctx.stats.bytes - b0;
		const writeMs = ctx.stats.ms - wms0;
		if (DUMP && STORE === 'disk') {
			// What one saved chat tree holds, for size analysis.
			await sleep(300);
			const dir = path.join(ctx.home, 'voltOrchestrator', 'roots');
			for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
				fs.copyFileSync(path.join(dir, name), path.join(DUMP, `fan${fan}-${name}`));
			}
		}
		// Every child ends at once: how many times is the (idle) parent woken, and how fast?
		ctx.runtime.finish('parent', 'Started the parts.');
		await sleep(30);
		const e0 = now();
		for (const task of ctx.service.tasksOf('parent')) {
			ctx.runtime.finish(task.childId, CHILD_REPORT);
		}
		const woken = await ctx.host.waitFor(parentWake);
		await sleep(50);
		const wakes = ctx.host.started.filter(entry => parentWake(entry.request));
		return {
			toolReturnMs: returned - t0, firstChildMs: first - t0, allChildrenMs: all - t0, writes, kbWritten: bytes / 1024, writeMs,
			toolResultChars: text.length, allDoneToWakeMs: woken - e0, parentWakes: wakes.length, wakePromptChars: wakes[0]?.request.turn.prompt.text.length ?? 0,
		};
	}, settings);
}

// Three parts that finish 25 ms apart (live runs finish seconds apart), the parent answering each
// wake-up at once: how many turns does the parent spend on their reports? `oneCall` starts them
// with one delegate_task `tasks` call, `separateCalls` with three calls (how every `tasks` call
// behaved before its parts reported together).
for (const mode of ['oneCall', 'separateCalls']) {
	results[`staggered3_${mode}`] = await repeat(Math.max(5, Math.round(RUNS / 3)), async ctx => {
		await parentRunning(ctx);
		const tasks = Array.from({ length: 3 }, (_, i) => ({ task: `Part ${i + 1}: handler ${i + 1}.`, title: `Part ${i + 1}` }));
		if (mode === 'oneCall') {
			await ctx.tool('parent', 'delegate_task', { tasks });
		} else {
			for (const task of tasks) {
				await ctx.tool('parent', 'delegate_task', task);
			}
		}
		await ctx.host.waitFor(childStarts, 3);
		ctx.runtime.finish('parent', 'Started the parts.');
		await sleep(30);
		const answered = new Set();
		const answer = () => {
			for (const entry of ctx.host.started.filter(item => parentWake(item.request) && !answered.has(item))) {
				answered.add(entry);
				ctx.runtime.finish('parent', 'Noted.');
			}
		};
		let lastChildEnd = 0;
		for (const task of ctx.service.tasksOf('parent')) {
			lastChildEnd = now();
			ctx.runtime.finish(task.childId, CHILD_REPORT);
			await sleep(25);
			answer();
		}
		const woken = await ctx.host.waitFor(parentWake, 1);
		await sleep(50);
		answer();
		await sleep(50);
		const wakes = ctx.host.started.filter(entry => parentWake(entry.request));
		const lastWake = wakes.at(-1).at;
		return { parentWakes: wakes.length, wakePromptCharsTotal: wakes.reduce((sum, entry) => sum + entry.request.turn.prompt.text.length, 0), lastChildDoneToLastWakeMs: Math.max(0, lastWake - lastChildEnd), firstWakeAfterLastChild: woken >= lastChildEnd ? 1 : 0 };
	});
}

results.afterChain5 = await repeat(Math.max(5, Math.round(RUNS / 3)), async ctx => {
	await parentRunning(ctx);
	const tasks = Array.from({ length: 5 }, (_, i) => ({ task: `Step ${i + 1} of the migration.`, title: `Step ${i + 1}`, ...(i ? { after: [String(i)] } : {}) }));
	await ctx.tool('parent', 'delegate_task', { tasks });
	let hops = 0;
	for (let i = 1; i <= 5; i++) {
		await ctx.host.waitFor(childStarts, i);
		const task = ctx.service.tasksOf('parent').find(candidate => candidate.title === `Step ${i}`);
		const t0 = now();
		ctx.runtime.finish(task.childId, CHILD_REPORT);
		if (i < 5) {
			hops += (await ctx.host.waitFor(childStarts, i + 1)) - t0;
		}
	}
	const last = ctx.host.started.filter(entry => childStarts(entry.request)).at(-1).request.turn.prompt.text;
	return { meanHopMs: hops / 4, lastBriefChars: last.length };
});

const groups = {
	tasks: AGENT_TASK_TOOLS, threads: THREAD_TOOLS, orchestra: ORCHESTRA_TOOLS, hostCore: VOLT_HOST_TOOLS, terminal: TERMINAL_TOOLS,
	memory: VOLT_MEMORY_TOOLS, jobs: JOB_WATCH_TOOLS, watchedTasks: WATCHED_TASK_TOOLS, codeIntel: CODE_INTELLIGENCE_TOOLS, ide: IDE_TOOLS,
	devices: DEVICE_TOOLS, capture: CAPTURE_TOOLS, desktop: DESKTOP_TOOLS, playground: PLAYGROUND_TOOLS,
};
const sizes = {};
const every = [];
for (const [name, list] of Object.entries(groups)) {
	sizes[name] = toolSize(list);
	every.push(...list);
}
sizes.allStatic = toolSize(every);
sizes.perTool = Object.fromEntries([...AGENT_TASK_TOOLS, ...THREAD_TOOLS, ...ORCHESTRA_TOOLS].map(tool => [tool.name, tokens(JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length)]));
results.toolTokens = sizes;
const fake = { id: 't-000001', title: 'Validate a.ts', state: 'completed', role: 'implementation', modelLabel: 'Claude Haiku', startedAt: 0, endedAt: 42_000, files: ['src/a.ts'], rounds: 1, result: CHILD_REPORT };
results.notificationForOneReport = { chars: buildTaskNotification([fake], [], 42_000).length, reportChars: CHILD_REPORT.length };

fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`wrote ${OUT}`);
process.exit(0);
