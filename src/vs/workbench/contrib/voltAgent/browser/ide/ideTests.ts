/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { isEqualOrParent, joinPath, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { isAbsolute } from '../../../../../base/common/path.js';
import { stripAnsi } from '../../../../services/voltRuntime/common/ide/testReports.js';
import { canUseProfileWithTest, ITestProfileService } from '../../../testing/common/testProfileService.js';
import { ITestResult } from '../../../testing/common/testResult.js';
import { ITestResultService } from '../../../testing/common/testResultService.js';
import { ITestService } from '../../../testing/common/testService.js';
import { IncrementalTestCollectionItem, InternalTestItem, ITestErrorMessage, ITestRunProfile, ResolvedTestRunRequest, TestItemExpandState, TestMessageType, TestResultItem, TestResultState, TestRunProfileBitset } from '../../../testing/common/testTypes.js';
import { TestId } from '../../../testing/common/testId.js';
import { agentTestRuns, IAgentTestRun, VOLT_TEST_CONTROLLER_ID, voltTestRoots } from './voltTestController.js';

const MAX_LISTED_TESTS = 150;
const MAX_FAILURES = 12;
const MAX_MESSAGE_LINES = 14;
/** Extension controllers resolve children lazily; listing waits this long for them. */
const EXPAND_WAIT_MS = 8_000;

/** What a run reports back to the chat's card while it goes and when it ends. */
export interface ITestRunWatcher {
	started(result: ITestResult, title: string): void;
}

export interface ITestToolResult {
	readonly text: string;
	readonly isError?: boolean;
}

/** A sandboxed chat's call: the gate's read rule. Without it the chat sees no tests (Volt cannot tell which files it may read). */
export interface ITestConfinement {
	readonly readRefusal?: (path: string) => Promise<string | undefined>;
}

interface ITestEntry {
	readonly item: IncrementalTestCollectionItem;
	readonly file: URI;
	/** Labels below the file: suites then the test. */
	readonly names: readonly string[];
	readonly leaf: boolean;
}

/**
 * The tests tool over VS Code's Testing service. Every controller counts (test extensions and
 * Volt's runner), runs are real Testing runs (the Test Explorer, gutter and results update as they
 * go) and failures come back as the structured messages the peek view shows.
 */
export class IdeTests {

	/** The last run per chat (and for outside callers), for `failed: true` and `results`. */
	private readonly lastRun = new Map<string, string>();

	constructor(
		private readonly testService: ITestService,
		private readonly results: ITestResultService,
		private readonly profiles: ITestProfileService,
	) { }

	/** `confined`: a sandboxed chat's call, which sees only tests in files it may read. */
	async list(root: URI | undefined, path: string | undefined, query: string | undefined, confined?: ITestConfinement): Promise<ITestToolResult> {
		await this.settle(!!confined, root);
		const scope = path ? this.resolvePath(root, path) : undefined;
		const needle = query?.trim().toLowerCase();
		const visible = await this.visibleEntries(confined);
		const entries = visible.filter(entry => entry.leaf && (!scope || isEqualOrParent(entry.file, scope)) && (!needle || entry.names.join(' ').toLowerCase().includes(needle)));
		const controllers = new Map<string, number>();
		for (const entry of visible.filter(item => item.leaf)) {
			controllers.set(this.controllerLabel(entry.item), (controllers.get(this.controllerLabel(entry.item)) ?? 0) + 1);
		}
		if (!entries.length) {
			const known = controllers.size ? ` Known tests come from ${[...controllers.keys()].join(', ')}.` : ' No test controller found tests in this workspace: Volt\'s runner covers vitest, jest, mocha, pytest, go and cargo projects; other frameworks need their test extension (or run them with shell).';
			return { text: `No tests${scope ? ` under ${path}` : ''}${needle ? ` matching "${query}"` : ''}.${known}` };
		}
		const byFile = new Map<string, ITestEntry[]>();
		for (const entry of entries) {
			const key = this.display(root, entry.file);
			byFile.set(key, [...(byFile.get(key) ?? []), entry]);
		}
		const header = `${entries.length} test${entries.length === 1 ? '' : 's'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'} (${[...controllers].map(([label, count]) => `${label}: ${count}`).join(', ')}).`;
		const lines: string[] = [header];
		const detailed = entries.length <= MAX_LISTED_TESTS;
		for (const [file, tests] of byFile) {
			lines.push(`${file} (${tests.length})`);
			if (detailed) {
				for (const test of tests) {
					const line = test.item.item.range?.startLineNumber;
					lines.push(`  ${test.names.join(' \u203a ')}${line ? `  :${line}` : ''}`);
				}
			}
		}
		if (!detailed) {
			lines.push(`Narrow with path or query to see test names.`);
		}
		lines.push('Run with targets like "file", "file:line" or a test name.');
		return { text: lines.join('\n') };
	}

	/**
	 * Runs tests for `as` (the calling chat: its exec, in its sandbox when it has one). A sandboxed
	 * chat's run is Volt's runner only: a test extension's controller runs tests in its extension
	 * host, outside any sandbox.
	 */
	async run(key: string, root: URI | undefined, args: { readonly targets?: readonly string[]; readonly failed?: boolean; readonly coverage?: boolean }, watcher: ITestRunWatcher | undefined, token: CancellationToken, as?: IAgentTestRun & ITestConfinement): Promise<ITestToolResult> {
		const sandboxed = !!as?.exec.sandbox;
		await this.settle(sandboxed, root);
		let tests: InternalTestItem[];
		let title: string;
		let skipped = '';
		if (args.failed) {
			const last = this.lastResult(key);
			if (!last) {
				return { text: 'No earlier test run to take failures from. Run tests first.', isError: true };
			}
			tests = [...last.tests].filter(item => item.ownComputedState === TestResultState.Failed || item.ownComputedState === TestResultState.Errored)
				.map(item => this.testService.collection.getNodeById(item.item.extId))
				.filter((item): item is IncrementalTestCollectionItem => !!item);
			if (!tests.length) {
				return { text: 'The last run had no failures.' };
			}
			title = `Rerun ${tests.length} failed`;
		} else if (args.targets?.length) {
			const resolved = this.resolveTargets(root, args.targets, sandboxed ? await this.visibleEntries(as) : undefined);
			if ('error' in resolved) {
				return { text: resolved.error, isError: true };
			}
			tests = resolved.tests;
			title = args.targets.join(', ');
		} else {
			tests = [...this.testService.collection.rootItems];
			if (sandboxed) {
				const others = tests.filter(test => test.controllerId !== VOLT_TEST_CONTROLLER_ID);
				tests = tests.filter(test => test.controllerId === VOLT_TEST_CONTROLLER_ID);
				skipped = others.length ? `\n(Not run: the tests of ${[...new Set(others.map(test => this.controllerLabel(test)))].join(', ')}, whose extension runs them outside this chat's sandbox. Run those with your own shell tool: it runs inside the sandbox.)` : '';
			}
			if (!tests.length) {
				return { text: `No tests in this workspace to run.${skipped}`, isError: true };
			}
			title = 'All tests';
		}
		if (sandboxed) {
			const foreign = tests.filter(test => test.controllerId !== VOLT_TEST_CONTROLLER_ID);
			if (foreign.length) {
				const owners = [...new Set(foreign.map(test => this.controllerLabel(test)))].join(', ');
				return { text: `The tests did not run: ${foreign.length === tests.length ? 'they belong' : `${foreign.length} of them belong`} to ${owners}, a test extension that runs them in its extension host, outside this chat's sandbox. Run them with your own shell tool instead (it runs inside the sandbox), or target tests Volt's runner covers (tests op list shows who runs each).`, isError: true };
			}
		}
		const coverage = !!args.coverage && tests.every(test => this.profiles.getControllerProfiles(test.controllerId).some(profile => profile.group & TestRunProfileBitset.Coverage));
		const request = this.resolveRun(tests, coverage ? TestRunProfileBitset.Coverage : TestRunProfileBitset.Run);
		if (!request.targets.length) {
			return { text: 'No test controller can run these tests (no run profile).', isError: true };
		}
		if (as) {
			// Before the run starts: Volt's controller runs its commands for the calling chat, in its sandbox.
			agentTestRuns.set(request, { exec: as.exec, ...(as.readRefusal ? { readRefusal: as.readRefusal } : {}), ...(as.tmpdir ? { tmpdir: as.tmpdir } : {}) });
		}
		const runPromise = this.testService.runResolvedTests(request, token);
		// The live result exists as soon as the run starts: the card shows it running.
		const live = this.results.results.find(candidate => candidate.request === request);
		if (live && !live.completedAt) {
			watcher?.started(live, title);
		}
		const result = await runPromise;
		this.lastRun.set(key, result.id);
		const note = args.coverage && !coverage ? '\n(No coverage profile for these tests; ran them without coverage.)' : '';
		return { text: this.summarize(root, result) + note + skipped };
	}

	/** The run request the Testing service would make for these tests, made here so the agent's run can be told apart (`agentTestRuns`). */
	private resolveRun(tests: readonly InternalTestItem[], group: TestRunProfileBitset): ResolvedTestRunRequest {
		const byProfile: { profile: ITestRunProfile; ids: string[] }[] = [];
		for (const test of tests) {
			const existing = byProfile.find(entry => canUseProfileWithTest(entry.profile, test));
			const profile = existing?.profile
				?? this.profiles.getDefaultProfileForTest(group, test)
				?? this.profiles.getControllerProfiles(test.controllerId).find(candidate => candidate.group === group && canUseProfileWithTest(candidate, test));
			if (!profile) {
				continue;
			}
			let entry = byProfile.find(item => item.profile === profile);
			if (!entry) {
				entry = { profile, ids: [] };
				byProfile.push(entry);
			}
			entry.ids.push(test.item.extId);
		}
		return {
			group,
			targets: byProfile.map(({ profile, ids }) => ({ profileId: profile.profileId, controllerId: profile.controllerId, testIds: ids })),
			preserveFocus: true,
		};
	}

	/** `confined`: a sandboxed chat's call: only its own runs, never another's (the user's, outside the sandbox). */
	async resultsFor(key: string, root: URI | undefined, target: string | undefined, confined?: ITestConfinement): Promise<ITestToolResult> {
		const last = this.lastResult(key) ?? (confined ? undefined : this.results.results.find(result => result.completedAt));
		if (!last) {
			return { text: confined ? 'This chat has run no tests yet. Run them with op run.' : 'No test results yet. Run tests first.' };
		}
		if (!target) {
			return { text: this.summarize(root, last) };
		}
		const resolved = this.resolveTargets(root, [target]);
		const ids = 'error' in resolved ? [] : resolved.tests.map(test => test.item.extId);
		const items = [...last.tests].filter(item => ids.includes(item.item.extId) || item.item.label === target);
		if (!items.length) {
			return { text: `${target} was not part of the last run.`, isError: true };
		}
		return { text: items.slice(0, 5).map(item => this.detail(root, last, item, true)).join('\n\n') };
	}

	/**
	 * Waits for controllers to publish and for lazily resolved children (bounded). `sandboxed`: only
	 * Volt's runner, which reads test files statically. Expanding an extension's tests runs its
	 * discovery in its extension host, outside the sandbox, which for pytest and friends imports the
	 * project's code: a sandboxed chat sees what those controllers already published, nothing more.
	 */
	private async settle(sandboxed: boolean, root: URI | undefined): Promise<void> {
		// The chat's folder may be outside the window's workspace (the agent window has none): Volt's runner discovers it now.
		if (root) {
			await raceTimeout(voltTestRoots.ensure(root), EXPAND_WAIT_MS * 2);
		}
		if (sandboxed) {
			await raceTimeout(this.testService.getTestController(VOLT_TEST_CONTROLLER_ID)?.syncTests(CancellationToken.None) ?? Promise.resolve(), EXPAND_WAIT_MS);
			return;
		}
		await raceTimeout(this.testService.syncTests(), EXPAND_WAIT_MS);
		const expandable = [...this.testService.collection.all].filter(item => item.expand === TestItemExpandState.Expandable).slice(0, 200);
		if (expandable.length) {
			await raceTimeout(Promise.all(expandable.map(item => this.testService.collection.expand(item.item.extId, Infinity).catch(() => undefined))), EXPAND_WAIT_MS);
		}
	}

	/** The tests a call may see: all of them, or for a sandboxed chat those in files it may read. */
	private async visibleEntries(confined: ITestConfinement | undefined): Promise<ITestEntry[]> {
		const entries = this.entries();
		if (!confined) {
			return entries;
		}
		const readable = new Map<string, boolean>();
		for (const entry of entries) {
			const key = entry.file.toString();
			if (!readable.has(key)) {
				readable.set(key, !!confined.readRefusal && !(await confined.readRefusal(entry.file.fsPath)));
			}
		}
		return entries.filter(entry => readable.get(entry.file.toString()));
	}

	private lastResult(key: string): ITestResult | undefined {
		const id = this.lastRun.get(key);
		return id ? this.results.getResult(id) : undefined;
	}

	private entries(): ITestEntry[] {
		const collection = this.testService.collection;
		const out: ITestEntry[] = [];
		for (const item of collection.all) {
			const uri = item.item.uri;
			if (!uri) {
				continue;
			}
			// Walk up while the parents are in the same file: those are the suites.
			const names = [item.item.label];
			let file: URI = uri;
			let parentId = parentOf(item);
			let isFileItem = true;
			while (parentId) {
				const parent = collection.getNodeById(parentId);
				if (!parent || parent.item.uri?.toString() !== uri.toString()) {
					break;
				}
				isFileItem = false;
				names.unshift(parent.item.label);
				file = parent.item.uri;
				parentId = parentOf(parent);
			}
			const leaf = item.children.size === 0 && !!item.item.range;
			if (isFileItem && !leaf) {
				continue; // the file node itself
			}
			// The file-level item's label is the file name, not a suite.
			const fileItem = names.length > 1 && this.isFileLabel(names[0], file) ? names.slice(1) : names;
			out.push({ item, file, names: fileItem, leaf });
		}
		return out;
	}

	private isFileLabel(label: string, file: URI): boolean {
		const base = file.path.split('/').pop() ?? '';
		return label === base || file.path.endsWith(`/${label}`) || label.endsWith(base);
	}

	private controllerLabel(item: InternalTestItem): string {
		return item.controllerId === VOLT_TEST_CONTROLLER_ID ? 'Volt runner' : this.testService.getTestController(item.controllerId)?.label.get() ?? item.controllerId;
	}

	private resolvePath(root: URI | undefined, raw: string): URI | undefined {
		const path = raw.trim();
		if (!path) {
			return undefined;
		}
		return isAbsolute(path) ? URI.file(path) : root ? joinPath(root, path) : undefined;
	}

	private resolveTargets(root: URI | undefined, targets: readonly string[], visible?: readonly ITestEntry[]): { readonly tests: InternalTestItem[] } | { readonly error: string } {
		const entries = visible ?? this.entries();
		const picked = new Map<string, InternalTestItem>();
		for (const target of targets) {
			const raw = target.trim();
			const lineMatch = /^(.*?):(\d+)$/.exec(raw);
			const asPath = this.resolvePath(root, lineMatch ? lineMatch[1] : raw);
			const inPath = asPath ? entries.filter(entry => isEqualOrParent(entry.file, asPath)) : [];
			if (inPath.length) {
				if (lineMatch) {
					const line = Number(lineMatch[2]);
					const atLine = inPath.filter(entry => {
						const range = entry.item.item.range;
						return range && range.startLineNumber <= line && range.endLineNumber >= line;
					}).sort((a, b) => (a.item.item.range!.endLineNumber - a.item.item.range!.startLineNumber) - (b.item.item.range!.endLineNumber - b.item.item.range!.startLineNumber))[0]
						?? inPath.filter(entry => entry.item.item.range && entry.item.item.range.startLineNumber <= line).sort((a, b) => b.item.item.range!.startLineNumber - a.item.item.range!.startLineNumber)[0];
					if (!atLine) {
						return { error: `No test at ${raw}. tests list shows the tests and their lines.` };
					}
					picked.set(atLine.item.item.extId, atLine.item);
				} else {
					// A file or folder: its top-level tests (their suites carry the rest).
					const ids = new Set(inPath.map(entry => entry.item.item.extId));
					for (const entry of inPath) {
						const parent = parentOf(entry.item);
						if (!parent || !ids.has(parent)) {
							picked.set(entry.item.item.extId, entry.item);
						}
					}
				}
				continue;
			}
			const needle = raw.toLowerCase();
			const byName = entries.filter(entry => entry.names.join(' ').toLowerCase() === needle || entry.names.join(' \u203a ').toLowerCase() === needle || entry.item.item.label.toLowerCase() === needle);
			const matches = byName.length ? byName : entries.filter(entry => entry.names.join(' ').toLowerCase().includes(needle));
			if (!matches.length) {
				return { error: `No test or file matches "${raw}". tests list shows what exists.` };
			}
			if (matches.length > 60) {
				return { error: `"${raw}" matches ${matches.length} tests; narrow it (a file, file:line or a longer name).` };
			}
			for (const match of matches) {
				picked.set(match.item.item.extId, match.item);
			}
		}
		return { tests: [...picked.values()] };
	}

	private summarize(root: URI | undefined, result: ITestResult): string {
		const items = [...result.tests].filter(item => item.ownComputedState !== TestResultState.Unset);
		const leaves = items.filter(item => !items.some(other => other !== item && parentOf(other) === item.item.extId));
		const count = (state: TestResultState) => leaves.filter(item => item.ownComputedState === state).length;
		const passed = count(TestResultState.Passed);
		const failed = count(TestResultState.Failed) + count(TestResultState.Errored);
		const skipped = count(TestResultState.Skipped);
		const started = (result as { startedAt?: number }).startedAt;
		const seconds = started && result.completedAt ? ` in ${((result.completedAt - started) / 1000).toFixed(1)}s` : '';
		const lines = [`${failed ? 'FAILED' : leaves.length ? 'PASSED' : 'NO TESTS RAN'}: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}${seconds}.`];
		const failures = leaves.filter(item => item.ownComputedState === TestResultState.Failed || item.ownComputedState === TestResultState.Errored);
		for (const item of failures.slice(0, MAX_FAILURES)) {
			lines.push('', this.detail(root, result, item, false));
		}
		if (failures.length > MAX_FAILURES) {
			lines.push('', `[${failures.length - MAX_FAILURES} more failures: tests results target=<name> shows one]`);
		}
		if (!leaves.length) {
			const output = result.tasks.map(task => stripAnsi(task.output.getRange(Math.max(0, task.output.length - 3_000), Math.min(3_000, task.output.length)).toString())).join('\n').trim();
			if (output) {
				lines.push('Output tail:', output.split('\n').slice(-25).join('\n'));
			}
		}
		if (coverageLine(result)) {
			lines.push('', coverageLine(result)!);
		}
		return lines.join('\n');
	}

	private detail(root: URI | undefined, result: ITestResult, item: TestResultItem, full: boolean): string {
		const where = item.item.uri ? `${this.display(root, item.item.uri)}${item.item.range ? `:${item.item.range.startLineNumber}` : ''}` : '';
		const name = this.nameOf(item);
		const state = STATE_LABELS[item.ownComputedState] ?? 'UNKNOWN';
		const lines = [`${state} ${name}${where ? `  (${where})` : ''}${item.ownDuration ? ` ${Math.round(item.ownDuration)}ms` : ''}`];
		for (const [taskIndex, task] of item.tasks.entries()) {
			for (const message of task.messages) {
				if (message.type === TestMessageType.Error) {
					lines.push(...this.errorLines(root, message, full));
				} else if (full && message.type === TestMessageType.Output) {
					const output = result.tasks[taskIndex]?.output.getRange(message.offset, message.length).toString();
					if (output?.trim()) {
						lines.push(`  output: ${stripAnsi(output).trim().split('\n').slice(-40).join('\n  ')}`);
					}
				}
			}
		}
		return lines.join('\n');
	}

	private errorLines(root: URI | undefined, message: ITestErrorMessage, full: boolean): string[] {
		const text = stripAnsi(typeof message.message === 'string' ? message.message : message.message.value).trim();
		const limit = full ? 80 : MAX_MESSAGE_LINES;
		const body = text.split('\n');
		const lines = body.slice(0, limit).map(line => `  ${line}`);
		if (body.length > limit) {
			lines.push(`  [${body.length - limit} more lines]`);
		}
		if (message.expected !== undefined || message.actual !== undefined) {
			lines.push(`  expected: ${clip(message.expected)}`, `  actual:   ${clip(message.actual)}`);
		}
		const frames = (message.stackTrace ?? []).filter(frame => frame.uri && frame.position).slice(0, full ? 12 : 4);
		for (const frame of frames) {
			lines.push(`  at ${this.display(root, frame.uri!)}:${frame.position!.lineNumber}${frame.label && !frame.label.includes('/') ? ` (${frame.label})` : ''}`);
		}
		if (!frames.length && message.location) {
			lines.push(`  at ${this.display(root, message.location.uri)}:${message.location.range.startLineNumber}`);
		}
		return lines;
	}

	private nameOf(item: TestResultItem): string {
		const node = this.testService.collection.getNodeById(item.item.extId);
		if (node && item.item.uri) {
			const entry = this.entries().find(candidate => candidate.item.item.extId === node.item.extId);
			if (entry) {
				return entry.names.join(' \u203a ');
			}
		}
		return item.item.label;
	}

	private display(root: URI | undefined, uri: URI): string {
		return (root && relativePath(root, uri)) || uri.fsPath;
	}
}

const STATE_LABELS: Partial<Record<TestResultState, string>> = {
	[TestResultState.Passed]: 'PASSED',
	[TestResultState.Failed]: 'FAILED',
	[TestResultState.Errored]: 'ERRORED',
	[TestResultState.Skipped]: 'SKIPPED',
	[TestResultState.Running]: 'RUNNING',
	[TestResultState.Queued]: 'QUEUED',
};

function parentOf(item: InternalTestItem): string | undefined {
	return TestId.parentId(item.item.extId);
}

function clip(value: string | undefined): string {
	if (value === undefined) {
		return '(none)';
	}
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length > 300 ? `${flat.slice(0, 300)}\u2026` : flat;
}

/** Statement coverage of the run, when a coverage profile produced any. */
function coverageLine(result: ITestResult): string | undefined {
	for (const task of result.tasks) {
		const coverage = task.coverage.get();
		if (!coverage) {
			continue;
		}
		let covered = 0;
		let total = 0;
		const low: { path: string; pct: number }[] = [];
		for (const [uri, file] of coverage.getAllFiles()) {
			covered += file.statement.covered;
			total += file.statement.total;
			if (file.statement.total) {
				low.push({ path: uri.path.split('/').slice(-2).join('/'), pct: file.statement.covered / file.statement.total });
			}
		}
		if (total) {
			const worst = low.sort((a, b) => a.pct - b.pct).slice(0, 5).map(item => `${item.path} ${(item.pct * 100).toFixed(0)}%`).join(', ');
			return `Coverage: ${((covered / total) * 100).toFixed(1)}% of statements (${covered}/${total}).${worst ? ` Lowest: ${worst}.` : ''}`;
		}
	}
	return undefined;
}
