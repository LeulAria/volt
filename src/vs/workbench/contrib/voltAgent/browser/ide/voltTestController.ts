/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { dirname, isEqualOrParent, joinPath, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Location } from '../../../../../editor/common/languages.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { FileChangeType, IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { buildTestCommand, detectJsFramework, familyOf, isJsTestPath, IStaticTest, ITestSelection, parseTests, PROJECT_MARKERS, rustModulePath, TEST_EXCLUDE_GLOB, TEST_FILE_GLOBS, TEST_FRAMEWORK_LABELS, TestFamily, TestFramework } from '../../../../services/voltRuntime/common/ide/testFrameworks.js';
import { ITestOutcome, ITestReport, parseTestReport, stripAnsi } from '../../../../services/voltRuntime/common/ide/testReports.js';
import { IConfig, IDebugService } from '../../../debug/common/debug.js';
import { ITestProfileService } from '../../../testing/common/testProfileService.js';
import { LiveTestResult } from '../../../testing/common/testResult.js';
import { ITestResultService } from '../../../testing/common/testResultService.js';
import { IMainThreadTestController, ITestService } from '../../../testing/common/testService.js';
import { TestId } from '../../../testing/common/testId.js';
import { IStartControllerTests, IStartControllerTestsResult, ITestErrorMessage, ITestItem, ITestMessageStackFrame, TestControllerCapability, TestDiffOpType, TestItemExpandState, TestMessageType, TestResultState, TestRunProfileBitset, TestsDiff } from '../../../testing/common/testTypes.js';

export const VOLT_TEST_CONTROLLER_ID = 'volt';
export const VOLT_TEST_RUNNER_SETTING = 'volt.testing.runner';

const RUN_PROFILE = 1;
const DEBUG_PROFILE = 2;
const COVERAGE_PROFILE = 3;
/** Test files read per scan, and the size past which a file is not parsed. */
const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 512 * 1024;
/** A test run gets this long before its process tree is stopped. */
const RUN_TIMEOUT_MS = 30 * 60_000;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt',
	properties: {
		[VOLT_TEST_RUNNER_SETTING]: {
			type: 'string',
			enum: ['auto', 'always', 'off'],
			enumDescriptions: [
				localize('voltTesting.runner.auto', "Discover vitest, jest, mocha, pytest, go and cargo tests in files no test extension covers."),
				localize('voltTesting.runner.always', "Discover them even when a test extension also covers the file."),
				localize('voltTesting.runner.off', "Leave testing to installed test extensions."),
			],
			default: 'auto',
			description: localize('voltTesting.runner', "Volt's built-in test runner. Its tests show in the Testing view and agents run them with the tests tool."),
		},
	},
});

interface IProject {
	readonly root: URI;
	readonly framework: TestFramework;
}

interface ITestNode {
	readonly id: string;
	readonly name: string;
	readonly kind: 'suite' | 'test';
	readonly line: number;
	readonly endLine: number;
	readonly children: ITestNode[];
	/** Names from the file down to this node. */
	readonly path: readonly string[];
	readonly file: ITestFile;
}

interface ITestFile {
	readonly id: string;
	readonly uri: URI;
	readonly project: IProject;
	readonly family: TestFamily;
	nodes: ITestNode[];
}

/**
 * Volt's test controller: the tests of vitest, jest, mocha, pytest, go and cargo projects in the
 * Testing view (explorer, gutter, peek, results), for files no installed test extension covers.
 * Discovery reads test files statically; runs go through the project's own runner with a JSON (or
 * JUnit) report, and outcomes, messages, expected/actual and stack traces land in the same live
 * results an extension's would, so the user and the agents' tests tool see one source of truth.
 */
export class VoltTestController extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltTestController';

	private readonly files = new ResourceMap<ITestFile>();
	private readonly nodes = new Map<string, ITestNode | ITestFile>();
	private readonly projects = new ResourceMap<IProject | null>();
	private readonly rootId = new TestId([VOLT_TEST_CONTROLLER_ID]).toString();
	private readonly pendingChanges = new ResourceMap<FileChangeType>();
	private readonly rescan = this._register(new RunOnceScheduler(() => void this.applyChanges(), 600));
	private readonly recheckCoverage = this._register(new RunOnceScheduler(() => this.dropCoveredFiles(), 1_500));
	private readonly queryBuilder: QueryBuilder;
	private published = false;
	private rootShown = false;
	private scanning: Promise<void> | undefined;

	constructor(
		@ITestService private readonly testService: ITestService,
		@ITestProfileService profiles: ITestProfileService,
		@ITestResultService private readonly results: ITestResultService,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IVoltStdioService private readonly stdio: IVoltStdioService,
		@IEnvironmentService private readonly environment: IEnvironmentService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDebugService private readonly debugService: IDebugService,
		@ILogService private readonly logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.queryBuilder = instantiationService.createInstance(QueryBuilder);
		const controller: IMainThreadTestController = {
			id: VOLT_TEST_CONTROLLER_ID,
			label: observableValue('volt.label', 'Volt'),
			capabilities: observableValue('volt.capabilities', TestControllerCapability.Refresh | TestControllerCapability.CodeRelatedToTest),
			syncTests: async () => { await this.scanning; },
			refreshTests: async () => { await this.scan(); },
			configureRunProfile: () => { },
			expandTest: async () => { },
			getRelatedCode: async (testId): Promise<Location[]> => {
				const node = this.nodes.get(testId);
				return node && 'line' in node ? [{ uri: node.file.uri, range: new Range(node.line, 1, node.endLine, 1) }] : [];
			},
			startContinuousRun: async () => [],
			runTests: (requests, token) => this.runTests(requests, token),
		};
		this._register(testService.registerTestController(VOLT_TEST_CONTROLLER_ID, controller));
		const profile = (profileId: number, label: string, group: TestRunProfileBitset, isDefault: boolean) => profiles.addProfile(controller, {
			controllerId: VOLT_TEST_CONTROLLER_ID, profileId, label, group, isDefault, tag: null, hasConfigurationHandler: false, supportsContinuousRun: false,
		});
		profile(RUN_PROFILE, localize('voltTesting.run', "Run"), TestRunProfileBitset.Run, true);
		profile(DEBUG_PROFILE, localize('voltTesting.debug', "Debug"), TestRunProfileBitset.Debug, true);
		profile(COVERAGE_PROFILE, localize('voltTesting.coverage', "Run with Coverage"), TestRunProfileBitset.Coverage, true);
		this._register(toDisposable(() => profiles.removeProfile(VOLT_TEST_CONTROLLER_ID)));

		this._register(workspace.onDidChangeWorkspaceFolders(() => void this.scan()));
		this._register(configuration.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VOLT_TEST_RUNNER_SETTING)) {
				void this.scan();
			}
		}));
		this._register(fileService.onDidFilesChange(e => {
			if (!this.published) {
				return;
			}
			const note = (resources: readonly URI[], type: FileChangeType) => {
				for (const resource of resources) {
					if (familyOf(resource.path) || resource.path.endsWith('/package.json')) {
						this.pendingChanges.set(resource, type);
					}
				}
			};
			note(e.rawAdded, FileChangeType.ADDED);
			note(e.rawUpdated, FileChangeType.UPDATED);
			note(e.rawDeleted, FileChangeType.DELETED);
			if (this.pendingChanges.size) {
				this.rescan.schedule();
			}
		}));
		this._register(testService.onDidProcessDiff(diff => {
			if (this.mode() === 'auto' && diff.some(op => op.op === TestDiffOpType.Add && op.item.controllerId !== VOLT_TEST_CONTROLLER_ID)) {
				this.recheckCoverage.schedule();
			}
		}));
		void this.scan();
	}

	private mode(): 'auto' | 'always' | 'off' {
		const value = this.configuration.getValue<string>(VOLT_TEST_RUNNER_SETTING);
		return value === 'always' || value === 'off' ? value : 'auto';
	}

	// --- Discovery ---------------------------------------------------------------------------

	private scan(): Promise<void> {
		this.scanning ??= this.doScan().catch(err => this.logService.warn('[volt tests] discovery failed', err)).finally(() => this.scanning = undefined);
		return this.scanning;
	}

	private async doScan(): Promise<void> {
		this.projects.clear();
		const folders = this.workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === Schemas.file);
		const found: URI[] = [];
		if (this.mode() !== 'off' && folders.length) {
			const query = this.queryBuilder.file(folders, {
				includePattern: [TEST_FILE_GLOBS.js, TEST_FILE_GLOBS.jsDir, TEST_FILE_GLOBS.python, TEST_FILE_GLOBS.go, TEST_FILE_GLOBS.rust],
				excludePattern: [{ pattern: TEST_EXCLUDE_GLOB }],
				maxResults: MAX_FILES,
			});
			const complete = await this.searchService.fileSearch(query, CancellationToken.None).catch(() => undefined);
			found.push(...(complete?.results.map(result => result.resource) ?? []));
		}
		const next = new ResourceMap<ITestFile>();
		await Promise.all(found.map(async uri => {
			const file = await this.readFile(uri).catch(() => undefined);
			if (file) {
				next.set(uri, file);
			}
		}));
		this.replaceAll(next);
	}

	/** The file's tests, or undefined when it holds none we can run (or a test extension has it). */
	private async readFile(uri: URI): Promise<ITestFile | undefined> {
		const family = familyOf(uri.path);
		if (!family || (this.mode() === 'auto' && this.coveredElsewhere(uri))) {
			return undefined;
		}
		const folder = this.workspace.getWorkspaceFolder(uri)?.uri;
		if (!folder) {
			return undefined;
		}
		if (family === 'js' && !isJsTestPath(relativePath(folder, uri) ?? uri.path)) {
			return undefined;
		}
		const project = await this.projectFor(uri, family, folder);
		if (!project) {
			return undefined;
		}
		const stat = await this.fileService.stat(uri);
		if (stat.size > MAX_FILE_BYTES) {
			return undefined;
		}
		const text = (await this.fileService.readFile(uri)).value.toString();
		const tests = parseTests(family, text);
		if (!tests.length) {
			return undefined;
		}
		const fileId = new TestId([VOLT_TEST_CONTROLLER_ID, uri.toString()]).toString();
		const file: ITestFile = { id: fileId, uri, project, family, nodes: [] };
		// Cargo names tests by module path; the file's own modules come first.
		const prefix = family === 'rust' ? rustModulePath(relativePath(project.root, uri) ?? '') : [];
		file.nodes = this.toNodes(file, tests, fileId, prefix);
		return file;
	}

	private toNodes(file: ITestFile, tests: readonly IStaticTest[], parentId: string, parentPath: readonly string[]): ITestNode[] {
		const used = new Set<string>();
		return tests.map(test => {
			let local = test.name;
			if (used.has(local)) {
				local = `${test.name}@${test.line}`;
			}
			used.add(local);
			const id = TestId.joinToString(parentId, local);
			const path = [...parentPath, test.name];
			const node: ITestNode = { id, name: test.name, kind: test.kind, line: test.line, endLine: test.endLine, children: [], path, file };
			node.children.push(...this.toNodes(file, test.children, id, path));
			return node;
		});
	}

	/** Whether another controller (a test extension) already shows tests from this file. */
	private coveredElsewhere(uri: URI): boolean {
		for (const item of this.testService.collection.getNodeByUrl(uri)) {
			if (item.controllerId !== VOLT_TEST_CONTROLLER_ID) {
				return true;
			}
		}
		return false;
	}

	private async projectFor(uri: URI, family: TestFamily, folder: URI): Promise<IProject | undefined> {
		let dir = dirname(uri);
		while (isEqualOrParent(dir, folder)) {
			const key = joinPath(dir, `.${family}`);
			const cached = this.projects.get(key);
			if (cached !== undefined) {
				if (cached) {
					return cached;
				}
			} else {
				const project = await this.projectAt(dir, family);
				this.projects.set(key, project ?? null);
				if (project) {
					return project;
				}
			}
			if (dir.path === folder.path || dirname(dir).path === dir.path) {
				break;
			}
			dir = dirname(dir);
		}
		// pytest runs from the folder root when there is no config at all.
		return family === 'python' ? { root: folder, framework: 'pytest' } : undefined;
	}

	private async projectAt(dir: URI, family: TestFamily): Promise<IProject | undefined> {
		for (const marker of PROJECT_MARKERS[family]) {
			const uri = joinPath(dir, marker);
			if (!await this.fileService.exists(uri)) {
				continue;
			}
			switch (family) {
				case 'js': {
					// A package without a test framework of its own may be run by its monorepo root's.
					const framework = detectJsFramework(await this.fileService.readFile(uri).then(file => file.value.toString(), () => undefined));
					return framework ? { root: dir, framework } : undefined;
				}
				case 'python': return { root: dir, framework: 'pytest' };
				case 'go': return { root: dir, framework: 'go' };
				case 'rust': return { root: dir, framework: 'cargo' };
			}
		}
		return undefined;
	}

	private async applyChanges(): Promise<void> {
		const changes = [...this.pendingChanges];
		this.pendingChanges.clear();
		if (changes.some(([uri]) => uri.path.endsWith('/package.json'))) {
			return this.scan();
		}
		const diff: TestsDiff = [];
		for (const [uri, type] of changes) {
			const previous = this.files.get(uri);
			const next = type === FileChangeType.DELETED ? undefined : await this.readFile(uri).catch(() => undefined);
			if (previous) {
				diff.push({ op: TestDiffOpType.Remove, itemId: previous.id });
				this.forget(previous);
			}
			if (next) {
				this.ensureRoot(diff);
				this.remember(next);
				diff.push(...this.addOps(next));
			}
		}
		if (diff.length) {
			this.testService.publishDiff(VOLT_TEST_CONTROLLER_ID, diff);
		}
	}

	private dropCoveredFiles(): void {
		const diff: TestsDiff = [];
		for (const file of [...this.files.values()]) {
			if (this.coveredElsewhere(file.uri)) {
				diff.push({ op: TestDiffOpType.Remove, itemId: file.id });
				this.forget(file);
			}
		}
		if (diff.length) {
			this.testService.publishDiff(VOLT_TEST_CONTROLLER_ID, diff);
		}
	}

	private replaceAll(next: ResourceMap<ITestFile>): void {
		const diff: TestsDiff = [];
		if (this.rootShown) {
			diff.push({ op: TestDiffOpType.Remove, itemId: this.rootId });
		}
		this.files.clear();
		this.nodes.clear();
		// No root without tests: an empty "Volt" node in the Test Explorer would only confuse.
		this.rootShown = next.size > 0;
		if (this.rootShown) {
			diff.push({ op: TestDiffOpType.Add, item: { controllerId: VOLT_TEST_CONTROLLER_ID, expand: TestItemExpandState.Expanded, item: this.item(this.rootId, 'Volt', undefined, undefined) } });
		}
		for (const file of next.values()) {
			this.remember(file);
			diff.push(...this.addOps(file));
		}
		this.published = true;
		if (diff.length) {
			this.testService.publishDiff(VOLT_TEST_CONTROLLER_ID, diff);
		}
	}

	/** A file added later needs the root first. */
	private ensureRoot(diff: TestsDiff): void {
		if (!this.rootShown) {
			this.rootShown = true;
			diff.push({ op: TestDiffOpType.Add, item: { controllerId: VOLT_TEST_CONTROLLER_ID, expand: TestItemExpandState.Expanded, item: this.item(this.rootId, 'Volt', undefined, undefined) } });
		}
	}

	private remember(file: ITestFile): void {
		this.files.set(file.uri, file);
		this.nodes.set(file.id, file);
		const walk = (nodes: readonly ITestNode[]) => nodes.forEach(node => {
			this.nodes.set(node.id, node);
			walk(node.children);
		});
		walk(file.nodes);
	}

	private forget(file: ITestFile): void {
		this.files.delete(file.uri);
		for (const [id, node] of [...this.nodes]) {
			if (node === file || ('file' in node && node.file === file)) {
				this.nodes.delete(id);
			}
		}
	}

	private addOps(file: ITestFile): TestsDiff {
		const folder = this.workspace.getWorkspaceFolder(file.uri)?.uri;
		const label = (folder && relativePath(folder, file.uri)) || file.uri.path.split('/').pop() || file.uri.path;
		const ops: TestsDiff = [{
			op: TestDiffOpType.Add,
			item: { controllerId: VOLT_TEST_CONTROLLER_ID, expand: TestItemExpandState.Expanded, item: { ...this.item(file.id, label, file.uri, undefined), description: TEST_FRAMEWORK_LABELS[file.project.framework] } },
		}];
		const walk = (nodes: readonly ITestNode[]) => nodes.forEach(node => {
			ops.push({ op: TestDiffOpType.Add, item: { controllerId: VOLT_TEST_CONTROLLER_ID, expand: node.children.length ? TestItemExpandState.Expanded : TestItemExpandState.NotExpandable, item: this.item(node.id, node.name, file.uri, new Range(node.line, 1, node.endLine, 1)) } });
			walk(node.children);
		});
		walk(file.nodes);
		return ops;
	}

	private item(extId: string, label: string, uri: URI | undefined, range: Range | undefined): ITestItem {
		return { extId, label, tags: [], busy: false, uri, range: range ?? null, description: null, error: null, sortText: range ? String(range.startLineNumber).padStart(6, '0') : null };
	}

	// --- Running -----------------------------------------------------------------------------

	private async runTests(requests: readonly IStartControllerTests[], token: CancellationToken): Promise<IStartControllerTestsResult[]> {
		await this.scanning;
		const out: IStartControllerTestsResult[] = [];
		for (const request of requests) {
			const result = this.results.getResult(request.runId);
			if (!(result instanceof LiveTestResult)) {
				out.push({ error: 'The test run is gone.' });
				continue;
			}
			try {
				await this.runRequest(result, request, token);
				out.push({});
			} catch (err) {
				out.push({ error: err instanceof Error ? err.message : String(err) });
			}
		}
		return out;
	}

	private async runRequest(result: LiveTestResult, request: IStartControllerTests, token: CancellationToken): Promise<void> {
		const taskId = generateUuid();
		result.addTask({ id: taskId, name: 'Volt', running: true, ctrlId: VOLT_TEST_CONTROLLER_ID });
		try {
			const excluded = new Set(request.excludeExtIds);
			const selected = request.testIds.flatMap(id => id === this.rootId ? [...this.files.values()] : this.nodes.get(id) ? [this.nodes.get(id)!] : []);
			// Group by project: each project runs once with every selection it holds.
			const groups = new Map<IProject, { file: ITestFile; node?: ITestNode }[]>();
			for (const entry of selected) {
				const file = 'file' in entry ? entry.file : entry;
				if (excluded.has(entry.id)) {
					continue;
				}
				const list = groups.get(file.project) ?? [];
				list.push({ file, ...('file' in entry ? { node: entry } : {}) });
				groups.set(file.project, list);
			}
			for (const [project, entries] of groups) {
				if (token.isCancellationRequested) {
					break;
				}
				await this.runProject(result, taskId, project, entries, request.profileId, token);
			}
		} finally {
			result.markTaskComplete(taskId);
		}
	}

	private async runProject(result: LiveTestResult, taskId: string, project: IProject, entries: readonly { file: ITestFile; node?: ITestNode }[], profileId: number, token: CancellationToken): Promise<void> {
		const leaves = entries.flatMap(entry => entry.node ? this.leavesOf([entry.node]) : this.leavesOf(entry.file.nodes));
		for (const leaf of leaves) {
			this.addToRun(result, leaf);
			result.updateState(leaf.id, taskId, TestResultState.Queued);
		}
		const wholeProject = entries.length === this.filesOf(project).length && entries.every(entry => !entry.node);
		const selection: ITestSelection[] = wholeProject ? [] : entries.map(entry => ({
			file: relativePath(project.root, entry.file.uri) ?? entry.file.uri.fsPath,
			path: entry.node ? entry.node.path : [],
		}));
		const reportDir = joinPath(this.environment.cacheHome, 'volt-tests');
		await this.fileService.createFolder(reportDir).catch(() => undefined);
		const report = joinPath(reportDir, `${generateUuid()}.${project.framework === 'pytest' ? 'xml' : 'json'}`);
		const command = buildTestCommand(project.framework, selection, {
			reportFile: report.fsPath,
			windows: isWindows,
			python: project.framework === 'pytest' ? await this.python(project.root) : undefined,
			coverage: profileId === COVERAGE_PROFILE,
		});
		for (const leaf of leaves) {
			result.updateState(leaf.id, taskId, TestResultState.Running);
		}
		result.appendOutput(VSBuffer.fromString(`\x1b[2m$ ${command.command}\x1b[0m\r\n`), taskId);
		const debug = profileId === DEBUG_PROFILE && (project.framework === 'vitest' || project.framework === 'jest' || project.framework === 'mocha');
		const exit = debug
			? await this.debugCommand(command.command, project.root, token)
			: await this.execCommand(command.command, project.root, output => result.appendOutput(VSBuffer.fromString(output.replace(/\r?\n/g, '\r\n')), taskId), token);
		let parsed: ITestReport | undefined;
		let reportError: string | undefined;
		try {
			const raw = (await this.fileService.readFile(report)).value.toString();
			parsed = parseTestReport(command.format, raw);
		} catch (err) {
			reportError = token.isCancellationRequested ? 'Cancelled.' : `No report was written (exit code ${exit.code ?? 'none'}). ${stripAnsi(exit.tail).trim().split('\n').slice(-30).join('\n')}`;
		} finally {
			this.fileService.del(report).catch(() => undefined);
		}
		const reported = new Set<string>();
		for (const outcome of parsed?.outcomes ?? []) {
			const node = this.match(project, outcome, entries);
			if (!node) {
				continue;
			}
			this.addToRun(result, node);
			reported.add(node.id);
			result.updateState(node.id, taskId, toState(outcome.state), outcome.durationMs);
			if (outcome.state === 'failed' || outcome.state === 'errored') {
				result.appendMessage(node.id, taskId, this.errorMessage(project, node, outcome));
			}
		}
		// Selected tests the report does not mention: a whole-file failure (syntax error, import
		// error) explains them; otherwise they did not run (filtered out, or skipped by the runner).
		const fileErrors = parsed?.errors ?? [];
		const runError = reportError ?? (fileErrors.length && !parsed?.outcomes.length ? fileErrors.map(error => error.message).join('\n\n') : undefined);
		for (const leaf of leaves) {
			if (reported.has(leaf.id)) {
				continue;
			}
			const fileError = fileErrors.find(error => error.file && this.sameFile(project, error.file, leaf.file.uri))?.message ?? runError;
			if (fileError) {
				result.updateState(leaf.id, taskId, TestResultState.Errored);
				result.appendMessage(leaf.id, taskId, { type: TestMessageType.Error, message: fileError.slice(0, 8_000), expected: undefined, actual: undefined, contextValue: undefined, location: undefined, stackTrace: undefined });
			} else {
				result.updateState(leaf.id, taskId, TestResultState.Skipped);
			}
		}
	}

	private filesOf(project: IProject): ITestFile[] {
		return [...this.files.values()].filter(file => file.project === project);
	}

	private leavesOf(nodes: readonly ITestNode[]): ITestNode[] {
		return nodes.flatMap(node => node.children.length ? this.leavesOf(node.children) : node.kind === 'test' ? [node] : []);
	}

	/** Adds the node and its parents (root, file, suites) to the run's tree. */
	private addToRun(result: LiveTestResult, node: ITestNode): void {
		const folder = this.workspace.getWorkspaceFolder(node.file.uri)?.uri;
		const chain: ITestItem[] = [this.item(this.rootId, 'Volt', undefined, undefined), this.item(node.file.id, (folder && relativePath(folder, node.file.uri)) || node.file.uri.path, node.file.uri, undefined)];
		const ids: string[] = [];
		for (let id: string | undefined = node.id; id && id !== node.file.id; id = TestId.parentId(id)) {
			ids.unshift(id);
		}
		for (const id of ids) {
			const step = this.nodes.get(id);
			if (step && 'line' in step) {
				chain.push(this.item(step.id, step.name, node.file.uri, new Range(step.line, 1, step.endLine, 1)));
			}
		}
		result.addTestChainToRun(VOLT_TEST_CONTROLLER_ID, chain);
	}

	/**
	 * The discovered test an outcome is about. Tests the runner made up (it.each, parametrize,
	 * table tests) are added under their file so they show and can be rerun.
	 */
	private match(project: IProject, outcome: ITestOutcome, entries: readonly { file: ITestFile }[]): ITestNode | undefined {
		let files = outcome.file ? this.filesOf(project).filter(file => this.sameFile(project, outcome.file!, file.uri)) : this.filesOf(project);
		if (outcome.package) {
			// go: files of the package first (its import path ends with the folder path).
			const inPackage = (file: ITestFile) => {
				const dir = relativePath(project.root, dirname(file.uri)) ?? '';
				return dir ? outcome.package!.endsWith(`/${dir}`) : true;
			};
			files = [...files.filter(inPackage), ...files.filter(file => !inPackage(file))];
		}
		const wanted = outcome.path.join(' ');
		for (const file of files) {
			const leaves = this.leavesOf(file.nodes);
			const exact = leaves.find(leaf => leaf.path.join(' ') === wanted) ?? (outcome.line ? leaves.find(leaf => leaf.line === outcome.line) : undefined);
			if (exact) {
				return exact;
			}
		}
		// Not declared statically: a generated test. Its file is the reported one, or the only one run.
		const home = outcome.file ? files[0] : entries.length === 1 ? entries[0].file : undefined;
		return home ? this.addDynamic(home, outcome) : undefined;
	}

	/** A test only the runner knows (generated by a loop or a table): added under its file. */
	private addDynamic(file: ITestFile, outcome: ITestOutcome): ITestNode {
		const name = outcome.path.at(-1) || 'test';
		const id = TestId.joinToString(file.id, `${outcome.path.join('\u203a')}`);
		const existing = this.nodes.get(id);
		if (existing && 'line' in existing) {
			return existing;
		}
		const line = outcome.line ?? 1;
		const node: ITestNode = { id, name: outcome.path.join(' \u203a '), kind: 'test', line, endLine: line, children: [], path: outcome.path, file };
		file.nodes.push(node);
		this.nodes.set(id, node);
		this.testService.publishDiff(VOLT_TEST_CONTROLLER_ID, [{ op: TestDiffOpType.Add, item: { controllerId: VOLT_TEST_CONTROLLER_ID, expand: TestItemExpandState.NotExpandable, item: this.item(id, name === node.name ? name : node.name, file.uri, new Range(line, 1, line, 1)) } }]);
		return node;
	}

	private sameFile(project: IProject, reported: string, uri: URI): boolean {
		const normalized = reported.replace(/\\/g, '/');
		const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) ? normalized : `${project.root.path.replace(/\/$/, '')}/${normalized.replace(/^\.\//, '')}`;
		return absolute.toLowerCase() === uri.path.toLowerCase() || (isWindows && absolute.toLowerCase() === uri.fsPath.replace(/\\/g, '/').toLowerCase());
	}

	private errorMessage(project: IProject, node: ITestNode, outcome: ITestOutcome): ITestErrorMessage {
		const frames: ITestMessageStackFrame[] = (outcome.stack ?? []).map(frame => {
			const uri = this.resolvePath(project, frame.path);
			return { label: frame.label ?? frame.path.split(/[\\/]/).pop() ?? frame.path, uri, position: uri ? new Position(frame.line, frame.column ?? 1) : undefined };
		});
		// The failure points at the deepest frame in the test file, else the test's declaration.
		const inFile = frames.find(frame => frame.uri && frame.uri.toString() === node.file.uri.toString() && frame.position);
		const location = inFile?.uri && inFile.position
			? { uri: inFile.uri, range: new Range(inFile.position.lineNumber, inFile.position.column, inFile.position.lineNumber, inFile.position.column) }
			: { uri: node.file.uri, range: new Range(node.line, 1, node.line, 1) };
		const message = [outcome.message ?? 'Failed', outcome.output && !outcome.message ? outcome.output : ''].filter(Boolean).join('\n');
		return { type: TestMessageType.Error, message, expected: outcome.expected, actual: outcome.actual, contextValue: undefined, location, stackTrace: frames.length ? frames : undefined };
	}

	private resolvePath(project: IProject, path: string): URI | undefined {
		if (/^(?:\/|[A-Za-z]:[\\/])/.test(path)) {
			return URI.file(path);
		}
		return path ? joinPath(project.root, path) : undefined;
	}

	/** The project's virtualenv Python when it has one, else the platform's. */
	private async python(root: URI): Promise<string> {
		const candidates = isWindows ? ['.venv/Scripts/python.exe', 'venv/Scripts/python.exe'] : ['.venv/bin/python', 'venv/bin/python'];
		for (const candidate of candidates) {
			const uri = joinPath(root, candidate);
			if (await this.fileService.exists(uri)) {
				return uri.fsPath;
			}
		}
		return isWindows ? 'python' : 'python3';
	}

	/** Runs a command as a job, streaming its output; cancellation stops its process tree. */
	private async execCommand(command: string, cwd: URI, onOutput: (text: string) => void, token: CancellationToken): Promise<{ code: number | null; tail: string }> {
		const id = `volt-test-${generateUuid()}`;
		const cancel = token.onCancellationRequested(() => void this.stdio.cancelExec(id));
		let tail = '';
		const take = (text: string) => {
			if (text) {
				onOutput(text);
				tail = (tail + text).slice(-16_000);
			}
		};
		try {
			const started = await this.stdio.exec({ id, command, cwd: cwd.fsPath, timeoutMs: RUN_TIMEOUT_MS, background: true, backgroundWaitMs: 300 });
			take(started.combined);
			if (!started.running) {
				return { code: started.exitCode, tail };
			}
			let offset = 0;
			const first = await this.stdio.jobOutput(id);
			offset = first?.offset ?? 0;
			while (!token.isCancellationRequested) {
				const next = await this.stdio.jobWait(id, 2_000, undefined, offset);
				if (!next) {
					break;
				}
				take(next.output);
				offset = next.offset;
				if (!next.running) {
					return { code: next.exitCode, tail };
				}
			}
			return { code: null, tail };
		} finally {
			cancel.dispose();
		}
	}

	/** Runs a JS test command under the debugger (js-debug's JavaScript Debug Terminal) and waits for it to end. */
	private async debugCommand(command: string, cwd: URI, token: CancellationToken): Promise<{ code: number | null; tail: string }> {
		const name = `Debug tests (${generateUuid().slice(0, 4)})`;
		const ended = new Promise<void>(resolve => {
			const listener = this.debugService.onDidEndSession(({ session }) => {
				if (session.configuration.name === name && !session.parentSession) {
					listener.dispose();
					resolve();
				}
			});
			token.onCancellationRequested(() => {
				const session = this.debugService.getModel().getSessions().find(candidate => candidate.configuration.name === name);
				void this.debugService.stopSession(session);
				listener.dispose();
				resolve();
			});
		});
		const config: IConfig & { readonly command: string; readonly cwd: string } = { type: 'node-terminal', request: 'launch', name, command, cwd: cwd.fsPath };
		const started = await this.debugService.startDebugging(undefined, config);
		if (!started) {
			return { code: null, tail: 'The debugger did not start (is the JavaScript debugger extension enabled?).' };
		}
		await ended;
		return { code: 0, tail: '' };
	}
}

function toState(state: ITestOutcome['state']): TestResultState {
	switch (state) {
		case 'passed': return TestResultState.Passed;
		case 'failed': return TestResultState.Failed;
		case 'skipped': return TestResultState.Skipped;
		case 'errored': return TestResultState.Errored;
	}
}
