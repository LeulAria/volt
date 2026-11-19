/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ResourceMap, ResourceSet } from '../../../../../base/common/map.js';
import { ISettableObservable, observableValue, transaction } from '../../../../../base/common/observable.js';
import { Schemas } from '../../../../../base/common/network.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { dirname, isEqual, isEqualOrParent, joinPath, relativePath } from '../../../../../base/common/resources.js';
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
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { env } from '../../../../../base/common/process.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IChatExec, userExec } from '../../../../services/voltRuntime/common/execContext.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { IFileCoverageDetail, parseCoverageDetailed } from '../../../../services/voltRuntime/common/ide/coverageReports.js';
import { describeMissing, IFolderProbe, IMissingTool, ITestCommand, ITestCommandOptions, ITestDebugPlan, ITestSelection, TestFamily, commandNotFound, toolInstallHint } from '../../../../services/voltRuntime/common/ide/testAdapter.js';
import { isUnittestOnly } from '../../../../services/voltRuntime/common/ide/testAdapterPython.js';
import { detectTestProjects, familyOf, IDetectedTestProject, isTestMarker, ITestAdapter, markerFamilies, resolveTestProject, TEST_EXCLUDE_GLOB, TEST_FRAMEWORK_NAMES, testAdapter, testFileSearches, testMarkers } from '../../../../services/voltRuntime/common/ide/testFrameworks.js';
import { failureFromText, ITestFileError, ITestOutcome, ITestRef, ITestReport, mergeTestReports, parseCompileErrors, parseTestReport, stripAnsi } from '../../../../services/voltRuntime/common/ide/testReports.js';
import { createTestStream, TestStreamEvent } from '../../../../services/voltRuntime/common/ide/testStreams.js';
import { IConfig, IDebugService } from '../../../debug/common/debug.js';
import { TestCoverage } from '../../../testing/common/testCoverage.js';
import { ITestProfileService } from '../../../testing/common/testProfileService.js';
import { ITestResult, LiveTestResult } from '../../../testing/common/testResult.js';
import { ITestResultService } from '../../../testing/common/testResultService.js';
import { IMainThreadTestController, ITestService } from '../../../testing/common/testService.js';
import { CoverageDetails, DetailType, ICallProfileRunHandler, IStartControllerTests, IStartControllerTestsResult, ITestErrorMessage, ITestMessageStackFrame, ResolvedTestRunRequest, TestControllerCapability, TestDiffOpType, TestItemExpandState, TestMessageType, TestResultState, TestRunProfileBitset, TestsDiff } from '../../../testing/common/testTypes.js';
import { IVoltCaseNode, IVoltFileNode, IVoltTestProject, VoltTestNode, VoltTestTree } from './voltTestTree.js';

export const VOLT_TEST_CONTROLLER_ID = 'volt';
export const VOLT_TEST_RUNNER_SETTING = 'volt.testing.runner';

const RUN_PROFILE = 1;
const DEBUG_PROFILE = 2;
const COVERAGE_PROFILE = 3;

/** Who a Testing run's commands run for, when an agent started it (the tests tool). */
export interface IAgentTestRun {
	/** The calling chat's: its principal, and its sandbox when it has one. */
	readonly exec: IChatExec;
	/** A sandboxed chat's: the gate's read rule, for the report its sandboxed run wrote. */
	readonly readRefusal?: (path: string) => Promise<string | undefined>;
	/** A sandboxed chat's temp folder, which its sandbox may write (the report goes there). */
	readonly tmpdir?: string;
}

/**
 * Runs an agent started, by their request (`LiveTestResult.request`, the object the run was
 * started with, so nothing else can claim it): the tests tool registers the calling chat's exec
 * before it starts the run, and Volt's controller runs that run's commands with it. A run nobody
 * registered is the user's own (Run Test, the gutter, the Test Explorer): `userExec()`.
 */
export const agentTestRuns = new WeakMap<ResolvedTestRunRequest, IAgentTestRun>();

/** An agent's runs whose commands its sandbox refused, with why: nothing ran (the card says so instead of "failed"). */
export const refusedTestRuns = new WeakMap<ITestResult, string>();

/**
 * Runs that could not start, with the one line that says why: the runner or its toolchain is not
 * installed (pytest for the project's interpreter, `node_modules`, `dotnet`), or the framework
 * has no debugger in this window. Their tests are left as they were, not failed.
 */
export const unstartedTestRuns = new WeakMap<ITestResult, string>();

/** What a run's report could not place or explain, for the tests tool: compile and collection errors by file. */
export const testRunFileErrors = new WeakMap<ITestResult, { readonly file: string; readonly message: string }[]>();

/**
 * Folders whose tests Volt's runner discovers besides the window's workspace folders: a chat's
 * project or worktree (the agent window and the agent server have no workspace folder, so
 * discovery found no tests at all and the tests tool answered "No test controller found tests in
 * this workspace" for every project chat, 2026-11-12 IDE round 2). The tests tool adds the calling
 * chat's folder before it lists or runs, and the Tests tab the folder of the chat it shows; the
 * controller scans it then.
 */
export const voltTestRoots = new class {
	private add: ((root: URI) => Promise<void>) | undefined;
	private readonly roots = new ResourceSet();
	/** The chats' folders asked for so far: a run of "all tests" in one of them runs its own tests, not every project's. */
	list(): readonly URI[] {
		return [...this.roots];
	}
	/** Set by the controller. */
	serve(add: (root: URI) => Promise<void>): IDisposable {
		this.add = add;
		return toDisposable(() => this.add = this.add === add ? undefined : this.add);
	}
	/** Resolves once `root`'s test files are in the Testing view (at once when they already are). */
	ensure(root: URI): Promise<void> {
		if (root.scheme === Schemas.file) {
			this.roots.add(root);
		}
		return this.add?.(root) ?? Promise.resolve();
	}
};

/** Files a scan takes (test files and project marker files together), and the size past which a file is not parsed. */
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_MARKER_BYTES = 256 * 1024;
/** Marker files whose presence is all that matters: never read. */
const UNREAD_MARKERS = /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile|mvnw|gradlew|conftest\.py|requirements\.txt|tox\.ini|setup\.py|setup\.cfg|pytest\.ini)$/;
/** A test run gets this long before its process tree is stopped. */
const RUN_TIMEOUT_MS = 30 * 60_000;
/** A run of this many files or fewer reads them first, so its tests show as queued; a larger one reads a file when its first result arrives. */
const EAGER_PARSE_FILES = 200;
/** How long a runner check (is pytest installed?) is trusted. */
const PROBE_TTL_MS = 5 * 60_000;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'volt',
	properties: {
		[VOLT_TEST_RUNNER_SETTING]: {
			type: 'string',
			enum: ['auto', 'always', 'off'],
			enumDescriptions: [
				localize('voltTesting.runner.auto', "Discover tests in files no test extension covers ({0}).", TEST_FRAMEWORK_NAMES),
				localize('voltTesting.runner.always', "Discover them even when a test extension also covers the file."),
				localize('voltTesting.runner.off', "Leave testing to installed test extensions."),
			],
			default: 'auto',
			description: localize('voltTesting.runner', "Volt's built-in test runner. Its tests show in the Testing view and agents run them with the tests tool."),
		},
	},
});

interface IRunEntry {
	readonly file: IVoltFileNode;
	/** A suite or test inside the file; the whole file without it. */
	readonly node?: IVoltCaseNode;
}

interface IExecResult {
	readonly code: number | null;
	/** The end of the output, for messages; all of it when the output is the report. */
	readonly tail: string;
	readonly full?: string;
	readonly refused?: string;
	readonly timedOut?: boolean;
}

/** What one project's run works with. */
interface IProjectRun {
	readonly result: LiveTestResult;
	readonly taskId: string;
	readonly project: IVoltTestProject;
	adapter: ITestAdapter;
	readonly entries: readonly IRunEntry[];
	/** The tests reported so far (ids), so the rest can be told apart at the end. */
	readonly reported: Set<string>;
	/** Tests the report named that Volt could not find in any file. */
	unplaced: number;
	readonly located: Map<string, Promise<IVoltCaseNode | undefined>>;
}

/**
 * Volt's test controller: the tests of every framework in `testFrameworks.ts` (JS runners,
 * pytest and unittest, go, cargo, CTest, dotnet, JUnit on Maven and Gradle) in the Testing view
 * (explorer, gutter, peek, results, coverage), for files no installed test extension covers.
 *
 * Discovery is a file search: folders and files show without a file being read, and a file's
 * tests are read when its node is expanded, when it opens in an editor, when a run needs them or
 * when an agent lists them, and again only when that file changes. Nothing is kept on disk.
 * Runs go through the project's own runner; tests turn passed or failed as the runner reports
 * them where it can, and messages, expected/actual, stack traces and coverage land in the same
 * live results an extension's would, so the user and the agents' tests tool see one source of truth.
 */
export class VoltTestController extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.voltTestController';

	private readonly tree = new VoltTestTree(VOLT_TEST_CONTROLLER_ID, 'Volt');
	private readonly pendingChanges = new ResourceMap<FileChangeType>();
	private readonly applyChangesSoon = this._register(new RunOnceScheduler(() => void this.applyChanges(), 600));
	private readonly recheckCoverage = this._register(new RunOnceScheduler(() => this.dropCoveredFiles(), 1_500));
	private readonly queryBuilder: QueryBuilder;
	/** Whether the root item is in the Testing service. */
	private rootShown = false;
	/** A scan has finished: the tree holds the test files. */
	private scanned = false;
	private scanning: Promise<void> | undefined;
	/** Chats' folders outside the window's workspace (`voltTestRoots`). */
	private readonly extraRoots = new ResourceSet();
	/** The marker files a scan found, by folder, with their text. */
	private readonly probes = new ResourceMap<IFolderProbe>();
	private readonly detected = new Map<string, readonly IDetectedTestProject[]>();
	private readonly projects = new Map<string, IVoltTestProject>();
	private readonly parsing = new Map<string, Promise<void>>();
	private readonly runtimeChecks = new Map<string, { at: number; ok: Promise<boolean> }>();
	/** Run on save: what each continuous run watches. */
	private readonly continuous = new Set<{ readonly request: ICallProfileRunHandler; running: boolean; again: Set<string> }>();

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
		@IUriIdentityService private readonly uriIdentity: IUriIdentityService,
		@INotificationService private readonly notifications: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this.queryBuilder = instantiationService.createInstance(QueryBuilder);
		const controller: IMainThreadTestController = {
			id: VOLT_TEST_CONTROLLER_ID,
			label: observableValue('volt.label', 'Volt'),
			capabilities: observableValue('volt.capabilities', TestControllerCapability.Refresh | TestControllerCapability.CodeRelatedToTest),
			syncTests: () => this.ensureScanned(),
			refreshTests: () => this.scan(true),
			configureRunProfile: () => { },
			expandTest: id => this.expand(id),
			getRelatedCode: async (testId): Promise<Location[]> => {
				const node = this.tree.get(testId);
				return node?.type === 'case' ? [{ uri: node.file.uri, range: new Range(node.line, 1, node.endLine, 1) }] : [];
			},
			startContinuousRun: (requests, token) => this.startContinuousRun(requests, token),
			runTests: (requests, token) => this.runTests(requests, token),
		};
		this._register(testService.registerTestController(VOLT_TEST_CONTROLLER_ID, controller));
		const profile = (profileId: number, label: string, group: TestRunProfileBitset, supportsContinuousRun: boolean) => profiles.addProfile(controller, {
			controllerId: VOLT_TEST_CONTROLLER_ID, profileId, label, group, isDefault: true, tag: null, hasConfigurationHandler: false, supportsContinuousRun,
		});
		profile(RUN_PROFILE, localize('voltTesting.run', "Run"), TestRunProfileBitset.Run, true);
		profile(DEBUG_PROFILE, localize('voltTesting.debug', "Debug"), TestRunProfileBitset.Debug, false);
		profile(COVERAGE_PROFILE, localize('voltTesting.coverage', "Run with Coverage"), TestRunProfileBitset.Coverage, true);
		this._register(toDisposable(() => profiles.removeProfile(VOLT_TEST_CONTROLLER_ID)));

		this._register(workspace.onDidChangeWorkspaceFolders(() => this.rescanIfScanned()));
		this._register(voltTestRoots.serve(root => this.addRoot(root)));
		this._register(configuration.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VOLT_TEST_RUNNER_SETTING)) {
				this.showRoot();
				this.rescanIfScanned();
			}
		}));
		this._register(fileService.onDidFilesChange(e => {
			if (!this.scanned && !this.continuous.size) {
				return;
			}
			const note = (resources: readonly URI[], type: FileChangeType) => {
				for (const resource of resources) {
					this.pendingChanges.set(resource, type);
				}
			};
			note(e.rawAdded, FileChangeType.ADDED);
			note(e.rawUpdated, FileChangeType.UPDATED);
			note(e.rawDeleted, FileChangeType.DELETED);
			if (this.pendingChanges.size) {
				this.applyChangesSoon.schedule();
			}
		}));
		this._register(testService.onDidProcessDiff(diff => {
			if (this.mode() === 'auto' && diff.some(op => op.op === TestDiffOpType.Add && op.item.controllerId !== VOLT_TEST_CONTROLLER_ID)) {
				this.recheckCoverage.schedule();
			}
		}));
		// A test file on screen gets its tests read, so the gutter has its run buttons and results.
		this._register(this.editorService.onDidVisibleEditorsChange(() => this.readVisibleFiles()));
		this._register(toDisposable(() => this.continuous.clear()));
		// The root alone, at no cost: the first thing that needs tests (the Test Explorer opening, a
		// test file in an editor, a run, an agent) expands it, and that is when the folders are searched.
		this.showRoot();
		this.readVisibleFiles();
	}

	private mode(): 'auto' | 'always' | 'off' {
		const value = this.configuration.getValue<string>(VOLT_TEST_RUNNER_SETTING);
		return value === 'always' || value === 'off' ? value : 'auto';
	}

	private publish(diff: TestsDiff): void {
		if (diff.length) {
			this.testService.publishDiff(VOLT_TEST_CONTROLLER_ID, diff);
		}
	}

	/** The root item: there until a scan finds no test file at all (an empty node in the Test Explorer would only confuse). */
	private showRoot(): void {
		const wanted = this.mode() !== 'off' && (!this.scanned || this.tree.size > 0);
		if (wanted === this.rootShown) {
			return;
		}
		this.rootShown = wanted;
		this.publish(wanted
			? [{ op: TestDiffOpType.Add, item: { controllerId: VOLT_TEST_CONTROLLER_ID, expand: this.scanned ? TestItemExpandState.Expanded : TestItemExpandState.Expandable, item: this.tree.item(this.tree.root) } }]
			: [{ op: TestDiffOpType.Remove, itemId: this.tree.root.id }]);
	}

	// --- Discovery ---------------------------------------------------------------------------

	private ensureScanned(): Promise<void> {
		return this.scanned && !this.scanning ? Promise.resolve() : this.scan();
	}

	private rescanIfScanned(): void {
		if (this.scanned || this.scanning) {
			void this.scan(true);
		}
	}

	/** `again`: a scan already running started before the latest change, so another follows it. */
	private scan(again = false): Promise<void> {
		if (this.scanning) {
			return again ? this.scanning.then(() => this.scan()) : this.scanning;
		}
		this.scanning = this.doScan().catch(err => this.logService.warn('[volt tests] discovery failed', err)).finally(() => this.scanning = undefined);
		return this.scanning;
	}

	private async expand(id: string): Promise<void> {
		if (id === this.tree.root.id) {
			return this.ensureScanned();
		}
		const node = this.tree.get(id);
		if (node?.type === 'file') {
			await this.ensureParsed(node);
		}
	}

	/** A chat's folder: scanned with the workspace's from now on (once; a folder inside one already scanned adds nothing). */
	private async addRoot(root: URI): Promise<void> {
		if (root.scheme !== Schemas.file || this.scanRootOf(root)) {
			await this.ensureScanned();
			return;
		}
		this.extraRoots.add(root);
		// Outside the workspace nothing watches it: test files the agent adds or changes reach the Testing view through this.
		this._register(this.fileService.watch(root, { recursive: true, excludes: ['**/node_modules/**', '**/.git/**', '**/target/**', '**/bin/**', '**/obj/**', '**/build/**', '**/.venv/**'] }));
		// A scan already going started without it.
		await this.scan(true);
	}

	private scanRoots(): URI[] {
		const all = [...this.workspace.getWorkspace().folders.map(folder => folder.uri).filter(uri => uri.scheme === Schemas.file), ...this.extraRoots];
		// A folder inside another scanned folder is covered by it.
		return all.filter((root, index) => !all.some((other, at) => at !== index && (isEqual(other, root) ? at < index : isEqualOrParent(root, other))));
	}

	/** The scanned folder (a workspace folder, or a chat's) a file belongs to. */
	private scanRootOf(uri: URI): URI | undefined {
		return this.scanRoots().find(root => isEqualOrParent(uri, root));
	}

	private async doScan(): Promise<void> {
		const started = Date.now();
		const roots = this.scanRoots();
		const files = new ResourceMap<IVoltTestProject>();
		this.probes.clear();
		this.detected.clear();
		let markerReads = 0;
		if (this.mode() !== 'off' && roots.length) {
			const searches = testFileSearches();
			const markers = testMarkers();
			// One search finds the test files that go by name and every project's marker files.
			const query = this.queryBuilder.file(roots, {
				includePattern: [...searches.byName, `**/{${[...markers.names].join(',')}}`, ...markers.extensions.map(extension => `**/*${extension}`)],
				excludePattern: [{ pattern: TEST_EXCLUDE_GLOB }],
				maxResults: MAX_FILES,
			});
			const complete = await this.searchService.fileSearch(query, CancellationToken.None).catch(() => undefined);
			const candidates: URI[] = [];
			const markerFiles: URI[] = [];
			const families = new Set<TestFamily>();
			for (const { resource } of complete?.results ?? []) {
				const name = resource.path.slice(resource.path.lastIndexOf('/') + 1);
				if (isTestMarker(name)) {
					markerFiles.push(resource);
					markerFamilies(name).forEach(family => families.add(family));
				}
				if (familyOf(resource.path)) {
					candidates.push(resource);
				}
			}
			markerReads = await this.readMarkers(markerFiles);
			// Languages whose tests sit in any source file (Rust, C++, C#): the files that hold a test, found by a text search, where such a project exists.
			for (const search of searches.byContent) {
				if (!families.has(search.family)) {
					continue;
				}
				const found = await this.searchContent(roots, search.globs, search.pattern);
				candidates.push(...found);
			}
			const covered = this.mode() === 'auto';
			for (const uri of candidates) {
				if (files.has(uri) || (covered && this.coveredElsewhere(uri))) {
					continue;
				}
				const project = this.projectFor(uri);
				if (project) {
					files.set(uri, project);
				}
			}
		}
		this.scanned = true;
		const diff = this.tree.setScan({ roots, files });
		if (!files.size) {
			// No test file at all: no root either (an empty node in the Test Explorer would only confuse).
			if (this.rootShown) {
				this.rootShown = false;
				this.publish([{ op: TestDiffOpType.Remove, itemId: this.tree.root.id }]);
			}
		} else if (!this.rootShown) {
			// The root first: a file's item needs its parents.
			this.rootShown = true;
			this.publish([{ op: TestDiffOpType.Add, item: { controllerId: VOLT_TEST_CONTROLLER_ID, expand: TestItemExpandState.Expanded, item: this.tree.item(this.tree.root) } }, ...diff]);
		} else {
			this.publish([...diff, { op: TestDiffOpType.Update, item: { extId: this.tree.root.id, expand: TestItemExpandState.Expanded } }]);
		}
		this.logService.info(`[volt tests] discovery: ${files.size} test files in ${roots.length} folder(s), ${markerReads} project files read, 0 test files read, ${Date.now() - started} ms`);
		this.readVisibleFiles();
	}

	/** Reads the marker files a scan found (small, a few per project) into `probes`. */
	private async readMarkers(markerFiles: readonly URI[]): Promise<number> {
		const byFolder = new ResourceMap<Map<string, string>>();
		let reads = 0;
		const read = async (uri: URI) => {
			const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
			const folder = dirname(uri);
			let text = '';
			if (!UNREAD_MARKERS.test(name)) {
				try {
					const stat = await this.fileService.stat(uri);
					if (stat.size <= MAX_MARKER_BYTES) {
						text = (await this.fileService.readFile(uri)).value.toString();
						reads++;
					}
				} catch {
					return;
				}
			}
			const files = byFolder.get(folder) ?? new Map<string, string>();
			files.set(name, text);
			byFolder.set(folder, files);
		};
		for (let index = 0; index < markerFiles.length; index += 32) {
			await Promise.all(markerFiles.slice(index, index + 32).map(read));
		}
		for (const [folder, files] of byFolder) {
			this.probes.set(folder, { files });
		}
		return reads;
	}

	/** The files under `roots` matching `globs` whose text matches `pattern`: found by the search process, never read here. */
	private async searchContent(roots: readonly URI[], globs: readonly string[], pattern: string): Promise<URI[]> {
		try {
			const query = this.queryBuilder.text({ pattern, isRegExp: true, isCaseSensitive: true }, [...roots], {
				includePattern: [...globs],
				excludePattern: [{ pattern: TEST_EXCLUDE_GLOB }],
				maxResults: MAX_FILES,
				previewOptions: { matchLines: 1, charsPerLine: 1 },
			});
			const complete = await this.searchService.textSearch(query, CancellationToken.None);
			return complete.results.map(result => result.resource);
		} catch (err) {
			this.logService.trace('[volt tests] content search failed', err);
			return [];
		}
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

	/** The project that runs a test file: the nearest folder set up for a framework of the file's language that claims it. */
	private projectFor(uri: URI): IVoltTestProject | undefined {
		const scanRoot = this.scanRootOf(uri);
		const relative = scanRoot && relativePath(scanRoot, uri);
		const family = relative ? familyOf(relative) : undefined;
		if (!scanRoot || !relative || !family) {
			return undefined;
		}
		const folders: { path: string; projects: readonly IDetectedTestProject[] }[] = [];
		const segments = relative.split('/').slice(0, -1);
		for (let depth = segments.length; depth >= 0; depth--) {
			const path = segments.slice(0, depth).join('/');
			const key = `${scanRoot.toString()}\u0000${path}\u0000${family}`;
			let projects = this.detected.get(key);
			if (!projects) {
				const probe = this.probes.get(path ? joinPath(scanRoot, path) : scanRoot);
				projects = probe ? detectTestProjects(family, probe) : [];
				this.detected.set(key, projects);
			}
			folders.push({ path, projects });
		}
		const resolved = resolveTestProject(relative, folders);
		if (!resolved) {
			return undefined;
		}
		const root = resolved.root ? joinPath(scanRoot, resolved.root) : scanRoot;
		const key = `${root.toString()}\u0000${resolved.adapter.id}`;
		let project = this.projects.get(key);
		if (!project || JSON.stringify(project.data ?? {}) !== JSON.stringify(resolved.data ?? {})) {
			project = { root, adapter: resolved.adapter, scanRoot, ...(resolved.data ? { data: resolved.data } : {}) };
			this.projects.set(key, project);
		}
		return project;
	}

	/** Reads a file's tests, unless they were read from the file as it is now (same time and size). */
	private ensureParsed(file: IVoltFileNode): Promise<void> {
		const running = this.parsing.get(file.id);
		if (running) {
			return running;
		}
		const done = this.parse(file).catch(err => this.logService.trace('[volt tests] could not read', file.uri.toString(), err)).finally(() => this.parsing.delete(file.id));
		this.parsing.set(file.id, done);
		return done;
	}

	private async parse(file: IVoltFileNode): Promise<void> {
		const stat = await this.fileService.stat(file.uri);
		const stamp = `${stat.mtime}:${stat.size}`;
		if (file.stamp === stamp || this.tree.file(file.uri) !== file) {
			return;
		}
		const relative = relativePath(file.project.root, file.uri) ?? file.label;
		const tests = stat.size > MAX_FILE_BYTES ? [] : file.project.adapter.parse((await this.fileService.readFile(file.uri)).value.toString(), relative);
		if (this.tree.file(file.uri) !== file) {
			return;
		}
		this.publish(this.tree.setTests(file, tests, stamp, file.project.adapter.prefix?.(relative) ?? []));
		if (!this.tree.size) {
			this.showRoot();
		}
	}

	/** The test files on screen get their tests read (the gutter's run buttons and results need them). */
	private readVisibleFiles(): void {
		for (const editor of this.editorService.visibleEditors) {
			const resource = editor.resource;
			if (!resource || resource.scheme !== Schemas.file || !familyOf(resource.path)) {
				continue;
			}
			if (!this.scanned) {
				// The first test-like file opened is what starts discovery in a window that never showed the Testing view.
				if (this.scanRootOf(resource) && !this.scanning && this.mode() !== 'off') {
					void this.scan();
				}
				continue;
			}
			const file = this.tree.file(resource);
			if (file) {
				void this.ensureParsed(file);
			}
		}
	}

	private async applyChanges(): Promise<void> {
		const changes = [...this.pendingChanges];
		this.pendingChanges.clear();
		if (!this.scanned) {
			return;
		}
		const saved: URI[] = [];
		let rescan = false;
		for (const [uri, type] of changes) {
			if (!this.scanRootOf(uri) || TEST_EXCLUDE_PATH.test(uri.path)) {
				continue;
			}
			const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
			if (isTestMarker(name)) {
				// A project file changed: which framework runs what may have.
				rescan = true;
				continue;
			}
			if (type !== FileChangeType.DELETED) {
				saved.push(uri);
			}
			const file = this.tree.file(uri);
			if (type === FileChangeType.DELETED) {
				if (file) {
					this.publish(this.tree.removeFile(uri));
				}
				continue;
			}
			if (file) {
				// Only a file whose tests were read is read again; the others are read when needed, as before.
				if (file.stamp !== undefined) {
					await this.ensureParsed(file);
				}
				continue;
			}
			if (!familyOf(uri.path) || (this.mode() === 'auto' && this.coveredElsewhere(uri))) {
				continue;
			}
			const project = this.projectFor(uri);
			if (!project) {
				continue;
			}
			const added = this.tree.addFile(uri, project);
			if (!this.rootShown) {
				this.rootShown = true;
				added.diff.unshift({ op: TestDiffOpType.Add, item: { controllerId: VOLT_TEST_CONTROLLER_ID, expand: TestItemExpandState.Expanded, item: this.tree.item(this.tree.root) } });
			}
			this.publish(added.diff);
			// A source file of a language whose tests sit anywhere (Rust, C++, C#) is a test file only if it holds one.
			if (added.file && project.adapter.contentPattern) {
				await this.ensureParsed(added.file);
			}
		}
		if (rescan) {
			await this.scan(true);
		} else if (!this.tree.size) {
			this.showRoot();
		}
		if (saved.length) {
			this.runOnSave(saved);
		}
	}

	private dropCoveredFiles(): void {
		for (const file of this.tree.files()) {
			if (this.coveredElsewhere(file.uri)) {
				this.publish(this.tree.removeFile(file.uri));
			}
		}
		if (this.scanned && !this.tree.size) {
			this.showRoot();
		}
	}

	// --- Run on save -------------------------------------------------------------------------

	/** Continuous run: from now until the token is cancelled, a saved file reruns the tests it affects among `request`'s. */
	private async startContinuousRun(requests: readonly ICallProfileRunHandler[], token: CancellationToken): Promise<IStartControllerTestsResult[]> {
		await this.ensureScanned();
		for (const request of requests) {
			const entry = { request, running: false, again: new Set<string>() };
			this.continuous.add(entry);
			token.onCancellationRequested(() => this.continuous.delete(entry));
		}
		return requests.map(() => ({}));
	}

	/** The test files a saved file affects: itself when it is one, else the tests its framework ties to it (the same package, the same name). */
	private affectedBy(saved: URI): IVoltFileNode[] {
		const own = this.tree.file(saved);
		if (own) {
			return [own];
		}
		return this.tree.files().filter(file => {
			if (!isEqualOrParent(saved, file.project.root)) {
				return false;
			}
			const changed = relativePath(file.project.root, saved);
			const testFile = relativePath(file.project.root, file.uri);
			return !!changed && !!testFile && (file.project.adapter.affects?.(changed, testFile) ?? false);
		});
	}

	private runOnSave(saved: readonly URI[]): void {
		if (!this.continuous.size) {
			return;
		}
		const affected = new Set(saved.flatMap(uri => this.affectedBy(uri)));
		for (const entry of this.continuous) {
			const watched = new Set(entry.request.testIds.flatMap(id => {
				const node = this.tree.get(id);
				return node ? this.tree.filesUnder(node) : [];
			}));
			const excluded = new Set(entry.request.excludeExtIds);
			const ids = [...affected].filter(file => watched.has(file) && !excluded.has(file.id)).map(file => {
				// A watched test or suite inside the file reruns alone; a watched file or folder reruns the file.
				const inside = entry.request.testIds.filter(id => this.tree.get(id)?.type === 'case' && (this.tree.get(id) as IVoltCaseNode).file === file);
				return inside.length ? inside : [file.id];
			}).flat();
			if (!ids.length) {
				continue;
			}
			ids.forEach(id => entry.again.add(id));
			void this.drainContinuous(entry);
		}
	}

	/** One run at a time per continuous request: saves during a run are run after it. */
	private async drainContinuous(entry: { readonly request: ICallProfileRunHandler; running: boolean; again: Set<string> }): Promise<void> {
		if (entry.running) {
			return;
		}
		entry.running = true;
		try {
			while (entry.again.size && this.continuous.has(entry)) {
				const testIds = [...entry.again];
				entry.again.clear();
				const group = entry.request.profileId === COVERAGE_PROFILE ? TestRunProfileBitset.Coverage : TestRunProfileBitset.Run;
				const result = this.results.createLiveResult({ id: generateUuid(), controllerId: VOLT_TEST_CONTROLLER_ID, include: testIds, exclude: [...entry.request.excludeExtIds], profile: { group, id: entry.request.profileId }, persist: true, continuous: true, preserveFocus: true });
				const source = new CancellationTokenSource();
				try {
					await this.runRequest(result, { runId: result.id, controllerId: VOLT_TEST_CONTROLLER_ID, profileId: entry.request.profileId, excludeExtIds: [...entry.request.excludeExtIds], testIds }, source.token);
				} catch (err) {
					this.logService.warn('[volt tests] run on save failed', err);
				} finally {
					source.dispose();
					if (!result.completedAt) {
						result.markComplete();
					}
				}
			}
		} finally {
			entry.running = false;
		}
	}

	// --- Running -----------------------------------------------------------------------------

	private async runTests(requests: readonly IStartControllerTests[], token: CancellationToken): Promise<IStartControllerTestsResult[]> {
		await this.ensureScanned();
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
			// Group by project: each project runs once with every selection it holds.
			const groups = new Map<IVoltTestProject, { entries: IRunEntry[]; whole: boolean }>();
			const add = (entry: IRunEntry) => {
				const group = groups.get(entry.file.project) ?? { entries: [], whole: false };
				groups.set(entry.file.project, group);
				if (group.entries.some(other => other.file === entry.file && (!other.node || other.node === entry.node))) {
					return; // the whole file, or this very test, is in already
				}
				if (!entry.node) {
					// A whole file replaces the tests picked inside it.
					group.entries = group.entries.filter(other => other.file !== entry.file);
				}
				group.entries.push(entry);
			};
			for (const id of request.testIds) {
				const node = this.tree.get(id);
				if (!node || excluded.has(id)) {
					continue;
				}
				if (node.type === 'case') {
					add({ file: node.file, node });
				} else {
					for (const file of this.tree.filesUnder(node)) {
						if (!excluded.has(file.id) && !this.hasExcludedAncestor(file, excluded)) {
							add({ file });
						}
					}
				}
			}
			for (const [project, group] of groups) {
				// Every file of the project, whole, with nothing left out: the runner's own "run everything".
				const all = this.tree.files().filter(file => file.project === project);
				group.whole = group.entries.length === all.length && group.entries.every(entry => !entry.node) && ![...excluded].some(id => { const node = this.tree.get(id); return node?.type === 'case' && node.file.project === project; });
			}
			// An agent's run runs for its chat (in its sandbox); any other is the user's.
			const agent = agentTestRuns.get(result.request as ResolvedTestRunRequest);
			for (const [project, group] of groups) {
				if (token.isCancellationRequested) {
					break;
				}
				await this.runProject(result, taskId, project, group.entries, group.whole, request.profileId, excluded, agent, token);
			}
		} finally {
			result.markTaskComplete(taskId);
		}
	}

	private hasExcludedAncestor(node: VoltTestNode, excluded: ReadonlySet<string>): boolean {
		for (let current = node.parent; current; current = current.parent) {
			if (excluded.has(current.id)) {
				return true;
			}
		}
		return false;
	}

	/** What the runner is asked to run for a node. */
	private selectionOf(project: IVoltTestProject, adapter: ITestAdapter, node: IVoltCaseNode): ITestSelection {
		const file = relativePath(project.root, node.file.uri) ?? node.file.uri.fsPath;
		const common = { file, ...(node.scope ? { scope: node.scope } : {}), ...(node.flavor ? { flavor: node.flavor } : {}), suiteDepth: node.suiteDepth };
		if (node.variant) {
			if (adapter.variants === 'subpath') {
				return { ...common, path: [...node.path, node.variant], kind: 'test' };
			}
			if (adapter.variants === 'suffix') {
				return { ...common, path: [...node.path.slice(0, -1), `${node.path.at(-1)}${node.variant}`], kind: 'test' };
			}
			// The runner cannot pick one case: the test runs with all of them.
			return this.selectionOf(project, adapter, node.parent as IVoltCaseNode);
		}
		// A part of a test (a Catch2 section, a doctest subcase) runs with its test.
		let unit = node;
		while (unit.parent?.type === 'case' && unit.parent.kind === 'test') {
			unit = unit.parent;
		}
		return { ...common, path: unit.path, kind: unit.kind };
	}

	private async runProject(result: LiveTestResult, taskId: string, project: IVoltTestProject, entries: readonly IRunEntry[], whole: boolean, profileId: number, excluded: ReadonlySet<string>, agent: IAgentTestRun | undefined, token: CancellationToken): Promise<void> {
		const run: IProjectRun = { result, taskId, project, adapter: project.adapter, entries, reported: new Set(), unplaced: 0, located: new Map() };
		const say = (text: string) => result.appendOutput(VSBuffer.fromString(`${text.replace(/\r?\n/g, '\r\n')}\r\n`), taskId);
		const wholeFiles = entries.filter(entry => !entry.node).map(entry => entry.file);
		// The tests of the files to run, when they are few enough to read first: they show as queued, and a runner that selects by name gets the names.
		const byName = project.adapter.selectsFiles === false && !whole;
		if (byName || wholeFiles.length <= EAGER_PARSE_FILES) {
			await Promise.all(wholeFiles.map(file => this.ensureParsed(file)));
		}
		const live = (entry: IRunEntry) => this.tree.file(entry.file.uri) === entry.file && (!entry.node || this.tree.get(entry.node.id) === entry.node);
		const units = entries.filter(live).flatMap(entry => entry.node ? this.tree.unitsOf(entry.node) : this.tree.unitsOf(entry.file)).filter(unit => !excluded.has(unit.id) && !this.hasExcludedAncestor(unit, excluded));
		const sandboxed = !!agent?.exec.sandbox;
		const debug = profileId === DEBUG_PROFILE;
		if (debug && sandboxed) {
			// A debugger starts the tests and its adapter outside any sandbox.
			this.refuse(run, units, 'The tests did not run: this chat runs in Volt\'s sandbox, and a debug run starts the debugger outside it. Run them with the tests tool (they run in the sandbox) or your own shell tool.');
			return;
		}

		// The interpreter or wrapper the project uses, then whether the runner is there at all.
		const windows = isWindows;
		const runtime = await this.resolveRuntime(project, project.adapter, windows);
		// A sandboxed run writes its report where its sandbox may write: the chat's temp folder.
		const reportDir = sandboxed ? joinPath(URI.file(agent?.tmpdir ?? env['TMPDIR'] ?? '/tmp'), 'volt-tests') : joinPath(this.environment.cacheHome, 'volt-tests');
		const options = (adapter: ITestAdapter, reportFile: string): ITestCommandOptions & { readonly cwd: string } => ({
			reportFile, windows, coverage: profileId === COVERAGE_PROFILE && !!adapter.coverage, cwd: project.root.fsPath,
			...(project.data ? { data: project.data } : {}), ...(runtime ? { runtime } : {}),
		});
		const exec = agent?.exec ?? userExec();
		const probe = project.adapter.probe?.(options(project.adapter, ''));
		if (probe && !debug && !(await this.probeOk(project, probe.command, exec, token))) {
			const fallback = probe.fallback ? testAdapter(probe.fallback) : undefined;
			// The fallback runs only what it can run: every file to run declares nothing else.
			const files = whole ? this.tree.files().filter(file => file.project === project) : [...new Set(entries.map(entry => entry.file))];
			if (fallback && files.length <= 500) {
				await Promise.all(files.map(file => this.ensureParsed(file)));
			}
			const usable = !!fallback && files.length <= 500 && files.every(file => this.tree.file(file.uri) === file && isUnittestOnly([...file.children.values()].filter((child): child is IVoltCaseNode => child.type === 'case').map(child => ({ name: child.label, kind: child.kind, line: child.line, endLine: child.endLine, children: [], ...(child.flavor ? { flavor: child.flavor } : {}) }))));
			if (!usable) {
				this.notStarted(run, describeMissing(probe.missing, this.projectLabel(project)), !agent);
				return;
			}
			say(`\x1b[2m${probe.missing.what} is not installed${probe.missing.for ? ` for ${probe.missing.for}` : ''}: running these ${fallback.label} tests with ${fallback.label}.\x1b[0m`);
			run.adapter = fallback;
		}
		const adapter = run.adapter;

		const selection: ITestSelection[] = whole ? [] : entries.filter(live).flatMap((entry): ITestSelection[] => {
			if (entry.node) {
				return [this.selectionOf(project, adapter, entry.node)];
			}
			const file = relativePath(project.root, entry.file.uri) ?? entry.file.uri.fsPath;
			if (adapter.selectsFiles !== false) {
				return [{ file, path: [] }];
			}
			// The runner cannot run a file by its path: the file's top-level suites and tests, by name.
			return [...entry.file.children.values()].filter((child): child is IVoltCaseNode => child.type === 'case' && !child.dynamic && !excluded.has(child.id)).map(child => this.selectionOf(project, adapter, child));
		});
		if (!whole && !selection.length) {
			say('\x1b[2mNo tests to run in the selection.\x1b[0m');
			return;
		}
		await this.fileService.createFolder(reportDir).catch(() => undefined);
		const reportFile = joinPath(reportDir, `${generateUuid()}${/^junit/.test(adapter.command([], options(adapter, 'x')).format) ? '.xml' : adapter.id === 'dotnet' ? '' : '.json'}`);
		const commandOptions = options(adapter, reportFile.fsPath);

		if (profileId === COVERAGE_PROFILE && !adapter.coverage) {
			say(`\x1b[2m${adapter.label} writes no coverage Volt can read: the tests run without it.\x1b[0m`);
		}
		for (const unit of units) {
			this.addToRun(result, unit);
			result.updateState(unit.id, taskId, TestResultState.Queued);
		}

		let exit: IExecResult;
		let command: ITestCommand | undefined;
		let plan: ITestDebugPlan | undefined;
		const startedAt = Date.now();
		if (debug) {
			const planned = adapter.debug?.(selection, commandOptions) ?? `${adapter.label} tests cannot be debugged from Volt's runner.`;
			const unavailable = typeof planned === 'string' ? planned : this.debuggerMissing(adapter, planned);
			if (unavailable) {
				this.notStarted(run, unavailable, !agent);
				return;
			}
			plan = planned as ITestDebugPlan;
			say(`\x1b[2mDebugging with ${plan.type}\x1b[0m`);
			exit = await this.debugCommand(plan, project.root, token);
		} else {
			command = adapter.command(selection, commandOptions);
			const stream = createTestStream(command.stream);
			// A runner that says when each test starts shows them running one by one; with the others they all run until they report.
			if (command.stream !== 'go-json') {
				for (const unit of units) {
					result.updateState(unit.id, taskId, TestResultState.Running);
				}
			}
			say(`\x1b[2m$ ${command.command}${sandboxed ? '   (in the chat\'s sandbox)' : ''}\x1b[0m`);
			let chain: Promise<void> = Promise.resolve();
			exit = await this.execCommand(command.command, project.root, output => {
				const read = stream?.push(output);
				const shown = read?.display ?? output;
				if (shown) {
					result.appendOutput(VSBuffer.fromString(shown.replace(/\r?\n/g, '\r\n')), taskId);
				}
				for (const event of read?.events ?? []) {
					chain = chain.then(() => this.applyStreamEvent(run, event)).catch(() => undefined);
				}
			}, exec, command.report.kind === 'stdout', token);
			await chain;
		}
		const cleanup = async () => {
			const source = command?.report ?? plan?.report;
			if (source && (source.kind === 'file' || source.kind === 'folder')) {
				await this.fileService.del(URI.file(source.path), { recursive: true }).catch(() => undefined);
			}
			await this.fileService.del(reportFile, { recursive: true }).catch(() => undefined);
			if (command?.coverageFile) {
				await this.fileService.del(URI.file(command.coverageFile.replace(/[\\/](?:lcov\.info)$/, '')), { recursive: true }).catch(() => undefined);
			}
		};
		if (exit.refused) {
			await cleanup();
			this.refuse(run, units, `The test command did not run: ${exit.refused}`);
			return;
		}
		if (token.isCancellationRequested) {
			await cleanup();
			say('\x1b[2mCancelled: the run\'s processes were stopped.\x1b[0m');
			return;
		}
		// The runner, its packages or its toolchain are not there: nothing ran, and that is not a failed test.
		const missing = debug ? undefined : (adapter.missing?.(stripAnsi(exit.tail), exit.code, commandOptions) ?? this.missingCommand(exit, windows));
		if (missing && !run.reported.size) {
			await cleanup();
			this.notStarted(run, describeMissing(missing, this.projectLabel(project)), !agent);
			return;
		}

		let parsed: ITestReport | undefined;
		let reportError: string | undefined;
		const source = command?.report ?? plan?.report;
		const format = command?.format ?? plan?.format;
		try {
			if (source && format) {
				const texts = await this.readReport(source, exit, project, startedAt, sandboxed ? agent : undefined, sandboxed);
				if (typeof texts === 'string') {
					reportError = texts;
				} else {
					parsed = mergeTestReports(texts.map(text => parseTestReport(format, text)));
					if (!texts.length) {
						throw new Error('no report');
					}
				}
			}
		} catch {
			reportError = exit.timedOut ? undefined : `No report was written (exit code ${exit.code ?? 'none'}).`;
		}
		const coverage = command?.coverageFile ? await this.readCoverage(command.coverageFile, project).catch(() => undefined) : undefined;
		await cleanup();

		// What the report leaves out of a failure and the output has.
		const details = parsed?.outcomes.some(outcome => outcome.state === 'failed' && !outcome.stack && (outcome.message ?? '').split('\n').length < 2) ? adapter.failureDetails?.(exit.full ?? exit.tail) : undefined;
		for (const reported of parsed?.outcomes ?? []) {
			const detail = reported.state === 'failed' && !reported.stack ? details?.find(item => item.path.join('\u0000') === reported.path.join('\u0000')) : undefined;
			const outcome: ITestOutcome = detail ? { ...reported, ...failureFromText(detail.message) } : reported;
			const node = await this.locate(run, outcome);
			if (!node) {
				run.unplaced++;
				continue;
			}
			this.addToRun(result, node);
			run.reported.add(node.id);
			result.updateState(node.id, taskId, toState(outcome.state), outcome.durationMs);
			if (outcome.state === 'failed' || outcome.state === 'errored') {
				result.appendMessage(node.id, taskId, this.errorMessage(project, node, outcome));
			}
			this.settleParts(run, node, outcome);
		}
		if (coverage?.length) {
			this.attachCoverage(result, taskId, coverage);
		}

		// What no test explains: a file that did not compile or import, a run that crashed or timed out. One error per file, on the file.
		const fileErrors: ITestFileError[] = [...(parsed?.errors ?? [])];
		if (!parsed?.outcomes.length && !fileErrors.length && (reportError || exit.timedOut || (exit.code !== 0 && exit.code !== null))) {
			fileErrors.push(...parseCompileErrors(exit.tail));
		}
		const tailLines = stripAnsi(exit.tail).trim().split('\n').slice(-30).join('\n');
		const runError = exit.timedOut
			? `The test run timed out after ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes and was stopped.`
			: reportError && !fileErrors.length ? `${reportError}${tailLines ? `\n${tailLines}` : ''}` : undefined;
		const erroredFiles = new Map<string, { file: IVoltFileNode; messages: string[] }>();
		const blame = (file: IVoltFileNode, message: string) => {
			const entry = erroredFiles.get(file.id) ?? { file, messages: [] };
			entry.messages.push(message);
			erroredFiles.set(file.id, entry);
		};
		const selectedFiles = [...new Set(entries.filter(live).map(entry => entry.file))];
		const unplacedErrors: { file: string; message: string }[] = [];
		for (const error of fileErrors) {
			const file = this.fileOfError(run, error);
			const where = error.file ? `${error.file}${error.line ? `:${error.line}` : ''}: ` : '';
			if (file) {
				blame(file, error.message);
			} else if (selectedFiles.length === 1) {
				blame(selectedFiles[0], `${where}${error.message}`);
			} else {
				unplacedErrors.push({ file: error.file ?? error.fileHint ?? '', message: error.message });
			}
		}
		if (unplacedErrors.length || runError) {
			// Not one file's doing: every selected file whose tests did not report carries it once (never each test).
			const message = [runError, ...unplacedErrors.map(error => `${error.file ? `${error.file}: ` : ''}${error.message}`)].filter(Boolean).join('\n\n');
			const silent = selectedFiles.filter(file => !this.tree.unitsOf(file).some(unit => run.reported.has(unit.id)) && !erroredFiles.has(file.id));
			for (const file of silent.length <= 20 ? silent : silent.slice(0, 1)) {
				blame(file, message);
			}
			if (!selectedFiles.length || silent.length > 20) {
				say(message);
			}
		}
		const recorded: { file: string; message: string }[] = [];
		for (const { file, messages } of erroredFiles.values()) {
			const message = messages.join('\n\n').slice(0, 8_000);
			result.addTestChainToRun(VOLT_TEST_CONTROLLER_ID, this.tree.chain(file));
			result.updateState(file.id, taskId, TestResultState.Errored);
			result.appendMessage(file.id, taskId, { type: TestMessageType.Error, message, expected: undefined, actual: undefined, contextValue: undefined, location: { uri: file.uri, range: new Range(1, 1, 1, 1) }, stackTrace: undefined });
			recorded.push({ file: relativePath(project.scanRoot, file.uri) ?? file.uri.fsPath, message });
		}
		if (recorded.length) {
			testRunFileErrors.set(result, [...(testRunFileErrors.get(result) ?? []), ...recorded]);
		}
		// Selected tests the report does not mention, in a run that did report: filtered out or skipped by the runner. Under an errored file they stay as they were.
		if (parsed?.outcomes.length) {
			for (const unit of units) {
				if (!run.reported.has(unit.id) && !erroredFiles.has(unit.file.id) && this.tree.get(unit.id) === unit && ![...unit.children.values()].some(child => run.reported.has(child.id))) {
					result.updateState(unit.id, taskId, TestResultState.Skipped);
				}
			}
		}
		if (run.unplaced) {
			say(`\x1b[2m${run.unplaced} result(s) named tests Volt found in no file of this project; they are in the output above.\x1b[0m`);
		}
	}

	/** Nothing ran: every selected test is errored with why, and the run is marked refused, so it reads as refused, not as failing tests. */
	private refuse(run: IProjectRun, units: readonly IVoltCaseNode[], why: string): void {
		refusedTestRuns.set(run.result, why);
		run.result.appendOutput(VSBuffer.fromString(`${why}\r\n`), run.taskId);
		for (const unit of units) {
			this.addToRun(run.result, unit);
			run.result.updateState(unit.id, run.taskId, TestResultState.Errored);
			run.result.appendMessage(unit.id, run.taskId, { type: TestMessageType.Error, message: why, expected: undefined, actual: undefined, contextValue: undefined, location: undefined, stackTrace: undefined });
		}
	}

	/**
	 * The run could not start: one line says what is missing and how to get it, and the tests stay
	 * as they were (queued ones return to unset when the task completes). The user's own run also
	 * gets the line as a notification; an agent's gets it as the tool's error.
	 */
	private notStarted(run: IProjectRun, why: string, notify: boolean): void {
		unstartedTestRuns.set(run.result, [unstartedTestRuns.get(run.result), why].filter(Boolean).join('\n'));
		run.result.appendOutput(VSBuffer.fromString(`\x1b[31m${why}\x1b[0m\r\n`), run.taskId);
		if (notify) {
			this.notifications.warn(why);
		}
	}

	private projectLabel(project: IVoltTestProject): string {
		return relativePath(project.scanRoot, project.root) || project.root.path.split('/').filter(Boolean).pop() || project.root.fsPath;
	}

	/** A command the shell could not find at all, when the adapter did not name it. */
	private missingCommand(exit: IExecResult, windows: boolean): IMissingTool | undefined {
		const command = commandNotFound(stripAnsi(exit.tail), exit.code);
		if (!command) {
			return undefined;
		}
		const name = command.split(/[\\/]/).pop() ?? command;
		const install = toolInstallHint(name, windows);
		return { what: `${name} (the command was not found)`, ...(install ? { install } : {}) };
	}

	/** Why a debug plan cannot start here, if it cannot: its debugger is not in this window. */
	private debuggerMissing(adapter: ITestAdapter, plan: ITestDebugPlan): string | undefined {
		const manager = this.debugService.getAdapterManager?.();
		if (!manager || manager.getDebugger(plan.type)) {
			return undefined;
		}
		return `The tests were not debugged: debugging ${adapter.label} tests needs ${plan.extension}, which is not installed in this window. Install it, or run the tests without the debugger.`;
	}

	/** The argv that starts the project's tool: the first of the adapter's candidates whose file exists in the project folder or above it. */
	private async resolveRuntime(project: IVoltTestProject, adapter: ITestAdapter, windows: boolean): Promise<readonly string[] | undefined> {
		const candidates = adapter.runtimes?.(windows);
		if (!candidates?.length) {
			return undefined;
		}
		const folders: URI[] = [];
		for (let folder = project.root; ; folder = dirname(folder)) {
			folders.push(folder);
			if (isEqual(folder, project.scanRoot) || !isEqualOrParent(folder, project.scanRoot) || dirname(folder).path === folder.path) {
				break;
			}
		}
		for (const candidate of candidates) {
			if (!candidate.exists?.length) {
				return candidate.argv;
			}
			for (const folder of folders) {
				for (const path of candidate.exists) {
					const uri = joinPath(folder, path);
					if (await this.fileService.exists(uri).catch(() => false)) {
						return candidate.argv.map(part => part === '{}' ? uri.fsPath : part);
					}
				}
			}
		}
		return undefined;
	}

	/** Whether the runner check passes (remembered a few minutes per project and command). */
	private probeOk(project: IVoltTestProject, command: string, exec: IChatExec, token: CancellationToken): Promise<boolean> {
		const key = `${project.root.toString()}\u0000${command}\u0000${exec.sandbox ? 'sandbox' : ''}`;
		const known = this.runtimeChecks.get(key);
		if (known && Date.now() - known.at < PROBE_TTL_MS) {
			return known.ok;
		}
		const ok = this.execCommand(command, project.root, () => { }, exec, false, token).then(exit => {
			// A check that could not run at all (refused, cancelled) decides nothing: the run itself will say.
			if (exit.refused || exit.code === null) {
				this.runtimeChecks.delete(key);
				return true;
			}
			if (exit.code !== 0) {
				// Not remembered: installing it is the very next thing someone does.
				this.runtimeChecks.delete(key);
			}
			return exit.code === 0;
		}, () => true);
		this.runtimeChecks.set(key, { at: Date.now(), ok });
		return ok;
	}

	/** The run's report text(s), or a sentence saying why it was not read. */
	private async readReport(source: NonNullable<ITestCommand['report']>, exit: IExecResult, project: IVoltTestProject, startedAt: number, agent: IAgentTestRun | undefined, sandboxed: boolean): Promise<string[] | string> {
		// What a sandboxed run wrote is read only where its sandbox reads (a link it left in the report's place is not followed out).
		const refusal = async (path: string) => sandboxed ? (agent?.readRefusal ? await agent.readRefusal(path) : 'Volt cannot tell whether this sandboxed chat may read it') : undefined;
		switch (source.kind) {
			case 'stdout':
				return [exit.full ?? exit.tail];
			case 'file': {
				const refused = await refusal(source.path);
				if (refused) {
					return `The run's report was not read: ${refused}.`;
				}
				return [(await this.fileService.readFile(URI.file(source.path))).value.toString()];
			}
			case 'folder': {
				const refused = await refusal(source.path);
				if (refused) {
					return `The run's report was not read: ${refused}.`;
				}
				const out: string[] = [];
				const walk = async (folder: URI, depth: number) => {
					const stat = await this.fileService.resolve(folder);
					for (const child of stat.children ?? []) {
						if (child.isDirectory && depth < 2) {
							await walk(child.resource, depth + 1);
						} else if (child.name.endsWith(source.extension)) {
							out.push((await this.fileService.readFile(child.resource)).value.toString());
						}
					}
				};
				await walk(URI.file(source.path), 0);
				return out;
			}
			case 'project': {
				// The build tool's own report files: the ones this run wrote (not an earlier run's leftovers).
				const query = this.queryBuilder.file([project.root], { includePattern: [...source.globs], disregardIgnoreFiles: true, disregardExcludeSettings: true, maxResults: 5_000 });
				const complete = await this.searchService.fileSearch(query, CancellationToken.None);
				const out: string[] = [];
				for (const { resource } of complete.results) {
					if (await refusal(resource.fsPath)) {
						continue;
					}
					const stat = await this.fileService.stat(resource).catch(() => undefined);
					if (stat && stat.mtime >= startedAt - 2_000) {
						out.push((await this.fileService.readFile(resource)).value.toString());
					}
				}
				return out;
			}
		}
	}

	private async readCoverage(path: string, project: IVoltTestProject): Promise<IFileCoverageDetail[]> {
		let file = URI.file(path);
		const stat = await this.fileService.resolve(file);
		if (stat.isDirectory) {
			// dotnet writes coverage.cobertura.xml into a folder named by a guid.
			const find = async (folder: URI, depth: number): Promise<URI | undefined> => {
				for (const child of (await this.fileService.resolve(folder)).children ?? []) {
					if (!child.isDirectory && /cobertura.*\.xml$|lcov\.info$/.test(child.name)) {
						return child.resource;
					}
					const inner = child.isDirectory && depth < 3 ? await find(child.resource, depth + 1) : undefined;
					if (inner) {
						return inner;
					}
				}
				return undefined;
			};
			const found = await find(file, 0);
			if (!found) {
				return [];
			}
			file = found;
		}
		const details = parseCoverageDetailed(file.path, (await this.fileService.readFile(file)).value.toString());
		const module = project.data?.module;
		return details.map(detail => {
			const normalized = detail.path.replace(/\\/g, '/');
			// go names files by import path: the module's name stands for the project folder.
			const relative = module && normalized.startsWith(`${module}/`) ? normalized.slice(module.length + 1) : normalized;
			return { ...detail, path: /^(?:\/|[A-Za-z]:\/)/.test(relative) ? relative : joinPath(project.root, relative).fsPath };
		}).filter(detail => !/[\\/](?:node_modules|site-packages)[\\/]/.test(detail.path));
	}

	/** The run's coverage in the Test Coverage view: per file, per function, and each line in the editor. */
	private attachCoverage(result: LiveTestResult, taskId: string, files: readonly IFileCoverageDetail[]): void {
		const task = result.tasks.find(candidate => candidate.id === taskId);
		if (!task) {
			return;
		}
		const details = new Map<string, IFileCoverageDetail>();
		transaction(tx => {
			let coverage = task.coverage.read(undefined);
			if (!coverage) {
				coverage = new TestCoverage(result, taskId, this.uriIdentity, {
					getCoverageDetails: async id => {
						const detail = details.get(id);
						if (!detail) {
							return [];
						}
						const out: CoverageDetails[] = detail.functions.map(fn => ({ type: DetailType.Declaration, name: fn.name, count: fn.hits, location: new Position(fn.line, 1) }));
						for (const [line, hits] of detail.lines) {
							out.push({ type: DetailType.Statement, count: hits, location: new Position(line, 1) });
						}
						return out;
					},
				});
				(task.coverage as ISettableObservable<TestCoverage | undefined>).set(coverage, tx);
			}
			for (const [index, file] of files.entries()) {
				const id = `${taskId}:${index}`;
				details.set(id, file);
				const covered = [...file.lines.values()].filter(hits => hits > 0).length;
				coverage.append({
					id,
					uri: URI.file(file.path),
					statement: { covered, total: file.lines.size },
					...(file.branches ? { branch: file.branches } : {}),
					...(file.functions.length ? { declaration: { covered: file.functions.filter(fn => fn.hits > 0).length, total: file.functions.length } } : {}),
				}, tx);
			}
		});
	}

	/** Adds the node and its parents (root, folders, file, suites) to the run's tree. */
	private addToRun(result: LiveTestResult, node: VoltTestNode): void {
		result.addTestChainToRun(VOLT_TEST_CONTROLLER_ID, this.tree.chain(node));
	}

	/** A test the runner just named: running, or done with its state. Its message comes with the report. */
	private async applyStreamEvent(run: IProjectRun, event: TestStreamEvent): Promise<void> {
		const node = await this.locate(run, event.test, false);
		if (!node) {
			return;
		}
		this.addToRun(run.result, node);
		if (event.type === 'started') {
			run.result.updateState(node.id, run.taskId, TestResultState.Running);
			return;
		}
		run.reported.add(node.id);
		run.result.updateState(node.id, run.taskId, toState(event.state), event.durationMs);
	}

	/** The parts of a test that ran with it (sections, subcases): passed with it; when it failed, the part the failure is in. */
	private settleParts(run: IProjectRun, node: IVoltCaseNode, outcome: ITestOutcome): void {
		const parts = [...node.children.values()].filter((child): child is IVoltCaseNode => child.type === 'case' && !child.variant && !child.dynamic);
		if (!parts.length || node.kind !== 'test') {
			return;
		}
		const failedLines = (outcome.stack ?? []).map(frame => frame.line);
		const walk = (part: IVoltCaseNode) => {
			const failedHere = failedLines.some(line => line >= part.line && line <= part.endLine);
			if (outcome.state === 'passed' || failedHere) {
				this.addToRun(run.result, part);
				run.result.updateState(part.id, run.taskId, outcome.state === 'passed' ? TestResultState.Passed : TestResultState.Failed);
			}
			[...part.children.values()].filter((child): child is IVoltCaseNode => child.type === 'case').forEach(walk);
		};
		parts.forEach(walk);
	}

	/**
	 * The test a runner's result is about. Its file comes from what the runner said (a path, a
	 * module or class name, a go package, a cargo module path); the file's tests are read if they
	 * were not yet. A test only the runner knows (it.each, a table) is added under its file; one
	 * generated case of a declared test (a subtest, a parameter set) under that test.
	 */
	private locate(run: IProjectRun, ref: ITestRef, fromReport = true): Promise<IVoltCaseNode | undefined> {
		const key = [fromReport, ref.file, ref.fileHint, ref.package, ref.scope, ref.path.join('\u0001'), ref.variant].join('\u0000');
		let found = run.located.get(key);
		if (!found) {
			found = this.doLocate(run, ref, fromReport).catch(() => undefined);
			run.located.set(key, found);
		}
		return found;
	}

	/** `fromReport` false: a line of live output, which names declared tests and their cases but never adds a test of its own (the report does that, from structured data). */
	private async doLocate(run: IProjectRun, ref: ITestRef, fromReport: boolean): Promise<IVoltCaseNode | undefined> {
		const project = run.project;
		const all = this.tree.files().filter(file => file.project === project);
		const selected = [...new Set(run.entries.map(entry => entry.file))];
		let candidates: IVoltFileNode[];
		let exact = false;
		if (ref.file) {
			candidates = all.filter(file => this.sameFile(project, ref.file!, file.uri));
			if (!candidates.length) {
				// A path relative to somewhere else (Playwright's test folder): the files that end with it.
				const suffix = `/${ref.file.replace(/\\/g, '/').replace(/^\.\//, '')}`;
				candidates = all.filter(file => file.uri.path.endsWith(suffix));
			}
			exact = candidates.length === 1;
		} else if (ref.fileHint) {
			const suffix = `/${ref.fileHint}`;
			candidates = all.filter(file => file.uri.path.replace(/\.[^./]+$/, '').endsWith(suffix));
			exact = candidates.length === 1;
		} else if (ref.package !== undefined && run.adapter.id === 'go') {
			// The package's import path ends with its folder: the deepest folder that fits holds its files.
			const module = project.data?.module;
			const folderOf = (file: IVoltFileNode) => relativePath(project.root, dirname(file.uri)) ?? '';
			const wanted = module && ref.package.startsWith(module) ? ref.package.slice(module.length).replace(/^\//, '') : undefined;
			candidates = wanted !== undefined ? all.filter(file => folderOf(file) === wanted) : all.filter(file => { const folder = folderOf(file); return folder ? ref.package!.endsWith(`/${folder}`) || ref.package === folder : true; }).sort((a, b) => folderOf(b).length - folderOf(a).length);
		} else if (run.adapter.prefix) {
			// cargo: the files whose module path starts the test's path, the longest first.
			const prefixOf = (file: IVoltFileNode) => run.adapter.prefix!(relativePath(project.root, file.uri) ?? '');
			candidates = all.filter(file => { const prefix = prefixOf(file); return prefix.every((name, index) => ref.path[index] === name); }).sort((a, b) => prefixOf(b).length - prefixOf(a).length);
		} else {
			candidates = [...selected, ...all.filter(file => !selected.includes(file))];
		}
		let home: IVoltFileNode | undefined;
		let found: IVoltCaseNode | undefined;
		for (const file of candidates.slice(0, 400)) {
			if (file.stamp === undefined) {
				await this.ensureParsed(file);
			}
			if (this.tree.file(file.uri) !== file) {
				continue;
			}
			home ??= file;
			found = this.tree.find(file, ref.path, ref.scope);
			if (!found && !ref.variant) {
				// it.each and template names: the declared test, with the generated name as one of its cases.
				const template = this.tree.findTemplate(file, ref.path);
				if (template) {
					const added = this.tree.variant(template, ref.path.at(-1)!);
					this.publish(added.diff);
					return added.node;
				}
			}
			if (!found && exact && fromReport && 'line' in ref && typeof (ref as ITestOutcome).line === 'number') {
				const at = this.tree.at(file, (ref as ITestOutcome).line!);
				found = at?.kind === 'test' ? at : undefined;
			}
			if (found) {
				break;
			}
		}
		if (!found) {
			// Not declared statically: a generated test. Its file is the reported one, or the only one run.
			const file = exact ? home : selected.length === 1 && this.tree.file(selected[0].uri) === selected[0] ? selected[0] : undefined;
			if (!file || !fromReport || !ref.path.some(Boolean)) {
				return undefined;
			}
			const added = this.tree.dynamic(file, ref.path, (ref as ITestOutcome).line, ref.scope);
			this.publish(added.diff);
			found = added.node;
		}
		if (ref.variant) {
			const added = this.tree.variant(found, ref.variant);
			this.publish(added.diff);
			return added.node;
		}
		return found;
	}

	/** The file a compile or collection error belongs to, when it is one of the project's test files. */
	private fileOfError(run: IProjectRun, error: ITestFileError): IVoltFileNode | undefined {
		const all = this.tree.files().filter(file => file.project === run.project);
		if (error.file) {
			const direct = all.find(file => this.sameFile(run.project, error.file!, file.uri));
			if (direct) {
				return direct;
			}
			const suffix = `/${error.file.replace(/\\/g, '/').replace(/^\.\//, '')}`;
			const bySuffix = all.filter(file => file.uri.path.endsWith(suffix));
			if (bySuffix.length === 1) {
				return bySuffix[0];
			}
		}
		if (error.fileHint) {
			const suffix = `/${error.fileHint}`;
			const byHint = all.filter(file => file.uri.path.replace(/\.[^./]+$/, '').endsWith(suffix));
			if (byHint.length === 1) {
				return byHint[0];
			}
		}
		return undefined;
	}

	private sameFile(project: IVoltTestProject, reported: string, uri: URI): boolean {
		const normalized = reported.replace(/\\/g, '/');
		const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) ? normalized : `${project.root.path.replace(/\/$/, '')}/${normalized.replace(/^\.\//, '')}`;
		return absolute.toLowerCase() === uri.path.toLowerCase() || (isWindows && absolute.toLowerCase() === uri.fsPath.replace(/\\/g, '/').toLowerCase());
	}

	private errorMessage(project: IVoltTestProject, node: IVoltCaseNode, outcome: ITestOutcome): ITestErrorMessage {
		const ownName = node.file.uri.path.slice(node.file.uri.path.lastIndexOf('/') + 1);
		const frames: ITestMessageStackFrame[] = (outcome.stack ?? []).map(frame => {
			// A JVM frame names only the file: the test's own file when the name is its.
			const uri = frame.path === ownName ? node.file.uri : this.resolvePath(project, frame.path);
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

	private resolvePath(project: IVoltTestProject, path: string): URI | undefined {
		if (/^(?:\/|[A-Za-z]:[\\/])/.test(path)) {
			return URI.file(path);
		}
		return path ? joinPath(project.root, path) : undefined;
	}

	/**
	 * Runs a command as a job, streaming its output; cancellation stops its process tree. `exec`: the
	 * Testing view's runs are the user's (Run Test, the gutter); an agent's are its chat's, in the
	 * chat's sandbox when it has one (`agentTestRuns`). A command its sandbox refused did not run.
	 * `keep`: the output is the run's report, so all of it is returned.
	 */
	private async execCommand(command: string, cwd: URI, onOutput: (text: string) => void, exec: IChatExec, keep: boolean, token: CancellationToken): Promise<IExecResult> {
		const id = `volt-test-${generateUuid()}`;
		const cancel = token.onCancellationRequested(() => void this.stdio.cancelExec(id));
		const started = Date.now();
		let tail = '';
		const all: string[] = [];
		const take = (text: string) => {
			if (text) {
				onOutput(text);
				tail = (tail + text).slice(-16_000);
				if (keep) {
					all.push(text);
				}
			}
		};
		const done = (code: number | null): IExecResult => ({ code, tail, ...(keep ? { full: all.join('') } : {}), ...(code === null && !token.isCancellationRequested && Date.now() - started >= RUN_TIMEOUT_MS - 1_000 ? { timedOut: true } : {}) });
		try {
			const first = await this.stdio.exec({ id, command, cwd: cwd.fsPath, timeoutMs: RUN_TIMEOUT_MS, background: true, backgroundWaitMs: 300, inlineChars: 4_000_000, ...exec });
			if (first.refused) {
				return { code: null, tail, refused: first.refused.reason };
			}
			if (!first.running) {
				take(first.combined);
				return { ...done(first.exitCode), ...(first.timedOut ? { timedOut: true } : {}) };
			}
			// Still running: the job's own log from its start, so nothing between the first answer and the first read is lost.
			let offset = 0;
			while (!token.isCancellationRequested) {
				const next = await this.stdio.jobWait(id, 1_000, undefined, offset);
				if (!next) {
					break;
				}
				take(next.output);
				offset = next.offset;
				if (!next.running) {
					return done(next.exitCode);
				}
			}
			return done(null);
		} finally {
			cancel.dispose();
		}
	}

	/** Runs a debug plan (the framework's debugger with the test selection) and waits for the session to end. */
	private async debugCommand(plan: ITestDebugPlan, cwd: URI, token: CancellationToken): Promise<IExecResult> {
		const name = `Debug tests (${generateUuid().slice(0, 4)})`;
		const store = new DisposableStore();
		const ended = new Promise<void>(resolve => {
			store.add(this.debugService.onDidEndSession(({ session }) => {
				if (session.configuration.name === name && !session.parentSession) {
					resolve();
				}
			}));
			store.add(token.onCancellationRequested(() => {
				const session = this.debugService.getModel().getSessions().find(candidate => candidate.configuration.name === name);
				void this.debugService.stopSession(session);
				resolve();
			}));
		});
		try {
			// eslint-disable-next-line local/code-no-dangerous-type-assertions
			const config = { ...plan.config, name, cwd: cwd.fsPath } as unknown as IConfig;
			const started = await this.debugService.startDebugging(undefined, config);
			if (!started) {
				return { code: null, tail: `The debugger did not start (is ${plan.extension} enabled?).` };
			}
			await ended;
			return { code: 0, tail: '' };
		} finally {
			store.dispose();
		}
	}
}

/** Paths under these folders are build output and dependencies: a change there is no test change. */
const TEST_EXCLUDE_PATH = /\/(?:node_modules|\.git|dist|out|target|\.venv|venv|__pycache__|\.next|coverage|vendor|obj|\.gradle|\.dart_tool|_build|deps|\.build|\.tox|\.mypy_cache|\.pytest_cache)\//;

function toState(state: ITestOutcome['state']): TestResultState {
	switch (state) {
		case 'passed': return TestResultState.Passed;
		case 'failed': return TestResultState.Failed;
		case 'skipped': return TestResultState.Skipped;
		case 'errored': return TestResultState.Errored;
	}
}
