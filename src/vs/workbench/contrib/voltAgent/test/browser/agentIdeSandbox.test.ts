/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { isEqualOrParent } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { IInstantiationService, ServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { IHostGitRequest } from '../../../../../platform/voltGit/common/hostGit.js';
import { IVoltExecFileRequest, IVoltExecRequest, IVoltExecResult, IVoltStdioService } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { runChatGit } from '../../../../services/voltRuntime/browser/tools/gitTools.js';
import { chatExec, IChatExec, voltExec } from '../../../../services/voltRuntime/common/execContext.js';
import { IVoltHostToolCall, IVoltHostToolProvider, IVoltHostToolService } from '../../../../services/voltRuntime/common/hostTools.js';
import { IAgentHistoryService } from '../../../../services/voltRuntime/common/history/agentHistory.js';
import { IAgentOrchestratorService } from '../../../../services/voltRuntime/common/orchestration/orchestrator.js';
import { IAgentRuntimeService } from '../../../../services/voltRuntime/common/runtime.js';
import { IDebugService, IDebugSession } from '../../../debug/common/debug.js';
import { INotebookEditorModelResolverService } from '../../../notebook/common/notebookEditorModelResolverService.js';
import { INotebookExecutionService } from '../../../notebook/common/notebookExecutionService.js';
import { INotebookExecutionStateService } from '../../../notebook/common/notebookExecutionStateService.js';
import { INotebookKernelService } from '../../../notebook/common/notebookKernelService.js';
import { Task } from '../../../tasks/common/tasks.js';
import { ITaskService } from '../../../tasks/common/taskService.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { TestId } from '../../../testing/common/testId.js';
import { ITestProfileService } from '../../../testing/common/testProfileService.js';
import { ITestResult, LiveTestResult } from '../../../testing/common/testResult.js';
import { ITestResultService } from '../../../testing/common/testResultService.js';
import { IMainThreadTestController, ITestService } from '../../../testing/common/testService.js';
import { InternalTestItem, ITestRunProfile, ResolvedTestRunRequest, TestItemExpandState, TestResultState, TestRunProfileBitset, TestsDiff } from '../../../testing/common/testTypes.js';
import { IVoltHttpService } from '../../../voltHttp/browser/voltHttpService.js';
import { AgentIdeService } from '../../browser/ide/agentIdeService.js';
import { IdeCli } from '../../browser/ide/capabilities/capability.js';
import { IdeDebug } from '../../browser/ide/ideDebug.js';
import { IdeTasks } from '../../browser/ide/ideTasks.js';
import { IdeTests } from '../../browser/ide/ideTests.js';
import { AgentJobWaitsService } from '../../browser/jobs/agentJobWaits.js';
import { IAgentTerminalsService } from '../../browser/terminals/agentTerminals.js';
import { IAgentWorkspaceService } from '../../browser/workspace/agentWorkspace.js';
import { agentTestRuns, IAgentTestRun, refusedTestRuns, VOLT_TEST_CONTROLLER_ID, VoltTestController, voltTestRoots } from '../../browser/ide/voltTestController.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';

const WORKSPACE_WRITE: IVoltSandboxSettings = { level: 'workspace-write', network: false };

/** IVoltStdioService that runs nothing and records every request. */
class FakeStdio {
	readonly runs: IVoltExecRequest[] = [];
	readonly files: IVoltExecFileRequest[] = [];
	readonly gits: IHostGitRequest[] = [];
	respond: (request: IVoltExecRequest) => Promise<Partial<IVoltExecResult>> = async () => ({});
	async exec(request: IVoltExecRequest): Promise<IVoltExecResult> {
		this.runs.push(request);
		const extra = await this.respond(request);
		return { id: request.id, exitCode: 0, stdout: '', stderr: '', combined: '', truncated: false, durationMs: 1, timedOut: false, cancelled: false, running: false, ...extra };
	}
	async execFile(request: IVoltExecFileRequest) {
		this.files.push(request);
		return { exitCode: 0, stdout: '', stderr: '' };
	}
	async git(request: IHostGitRequest) {
		this.gits.push(request);
		return { exitCode: 0, stdout: '', stderr: '' };
	}
	async cancelExec(): Promise<void> { }
	async jobOutput() { return undefined; }
	async jobWait() { return undefined; }
	asService(): IVoltStdioService {
		return this as unknown as IVoltStdioService;
	}
}

/** A sandboxed exec's sandbox and who it runs for, as the tests compare them. */
function who(request: { readonly context: IVoltExecRequest['context']; readonly sandbox?: IVoltExecRequest['sandbox'] }) {
	return { principal: request.context.principal, sandboxed: request.context.sandboxed, level: request.sandbox?.level, network: request.sandbox?.network, roots: request.sandbox?.workspaceRoots };
}

suite('Volt agent IDE tools in the sandbox', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// --- Volt's test controller -------------------------------------------------------------

	function controllerRig() {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider(Schemas.file, store.add(new InMemoryFileSystemProvider())));
		const testFiles: URI[] = [];
		const write = async (path: string, text: string) => {
			await fileService.writeFile(URI.file(path), VSBuffer.fromString(text));
			if (/\.test\.js$/.test(path)) {
				testFiles.push(URI.file(path));
			}
		};
		const folder = { uri: URI.file('/ws'), name: 'ws', index: 0, toResource: (path: string) => URI.joinPath(URI.file('/ws'), path) };
		const workspace = {
			getWorkspace: () => ({ folders: [folder] }),
			getWorkspaceFolder: (uri: URI) => isEqualOrParent(uri, folder.uri) ? folder : null,
			onDidChangeWorkspaceFolders: Event.None,
		} as unknown as IWorkspaceContextService;
		// The query builder's query is just the folders; the search finds the test files under them.
		const instantiation = { createInstance: () => ({ file: (folders: (URI | { uri: URI })[]) => ({ folders }) }) } as unknown as IInstantiationService;
		const search = {
			fileSearch: async (query: { folders: (URI | { uri: URI })[] }) => ({
				results: testFiles.filter(file => query.folders.some(item => isEqualOrParent(file, URI.isUri(item) ? item : item.uri))).map(resource => ({ resource })),
			}),
		} as unknown as ISearchService;
		let controller: IMainThreadTestController | undefined;
		const diffs: TestsDiff[] = [];
		const testService = {
			registerTestController: (_id: string, registered: IMainThreadTestController) => {
				controller = registered;
				return toDisposable(() => controller = undefined);
			},
			publishDiff: (_id: string, diff: TestsDiff) => diffs.push(diff),
			collection: { getNodeByUrl: () => [] },
			onDidProcessDiff: Event.None,
		} as unknown as ITestService;
		const profiles = { addProfile: () => undefined, removeProfile: () => undefined } as unknown as ITestProfileService;
		const live = new Map<string, LiveTestResult>();
		const results = { getResult: (id: string) => live.get(id) } as unknown as ITestResultService;
		const stdio = new FakeStdio();
		let debugStarts = 0;
		const debug = { onDidEndSession: Event.None, startDebugging: async () => { debugStarts++; return true; }, getModel: () => ({ getSessions: () => [] }) } as unknown as IDebugService;
		const environment = { cacheHome: URI.file('/cache') } as unknown as IEnvironmentService;
		const create = () => store.add(new VoltTestController(testService, profiles, results, fileService, search, workspace, stdio.asService(), environment, new TestConfigurationService(), debug, new NullLogService(), instantiation));
		/** Runs every Volt test with `profileId`, as the Testing service would: for the user, or for an agent that registered the run. */
		const run = async (profileId: number, agent?: IAgentTestRun): Promise<LiveTestResult> => {
			const rootId = new TestId([VOLT_TEST_CONTROLLER_ID]).toString();
			const request: ResolvedTestRunRequest = { group: profileId === 2 ? TestRunProfileBitset.Debug : TestRunProfileBitset.Run, targets: [{ controllerId: VOLT_TEST_CONTROLLER_ID, profileId, testIds: [rootId] }] };
			const result = store.add(new LiveTestResult(generateUuid(), false, request, 0, NullTelemetryService));
			live.set(result.id, result);
			if (agent) {
				agentTestRuns.set(request, agent);
			}
			await controller!.runTests([{ runId: result.id, controllerId: VOLT_TEST_CONTROLLER_ID, profileId, excludeExtIds: [], testIds: [rootId] }], CancellationToken.None);
			return result;
		};
		// mocha "ran": it writes its JSON report where the command says.
		const mochaPasses = (file: string) => async (request: IVoltExecRequest): Promise<Partial<IVoltExecResult>> => {
			const output = /output=(?:'([^']+)'|(\S+))/.exec(request.command);
			const report = output?.[1] ?? output?.[2];
			if (report) {
				await fileService.writeFile(URI.file(report), VSBuffer.fromString(JSON.stringify({ tests: [{ title: 'adds', fullTitle: 'math adds', file, duration: 1, err: {} }] })));
			}
			return {};
		};
		const state = (result: ITestResult, label: string) => [...result.tests].find(item => item.item.label === label)?.ownComputedState;
		return { fileService, write, create, run, stdio, diffs, state, mochaPasses, debugStarts: () => debugStarts, controller: () => controller };
	}

	async function mochaProject(rig: ReturnType<typeof controllerRig>, root: string) {
		await rig.write(`${root}/package.json`, JSON.stringify({ scripts: { test: 'mocha' }, devDependencies: { mocha: '^11.0.0' } }));
		await rig.write(`${root}/test/math.test.js`, 'describe(\'math\', () => {\n\tit(\'adds\', () => {});\n});\n');
	}

	test('DEV-SBX-4: an agent\'s test run executes in the chat\'s sandbox, as the chat; the Testing view\'s run stays the user\'s', async () => {
		const rig = controllerRig();
		await mochaProject(rig, '/ws');
		rig.create();
		await rig.controller()!.syncTests(CancellationToken.None);
		rig.stdio.respond = rig.mochaPasses('/ws/test/math.test.js');

		// The user's Run Test: as the user, unsandboxed, the report in Volt's cache.
		const mine = await rig.run(1);
		assert.strictEqual(rig.stdio.runs.length, 1);
		assert.deepStrictEqual(who(rig.stdio.runs[0]), { principal: 'user', sandboxed: false, level: undefined, network: undefined, roots: undefined });
		assert.match(rig.stdio.runs[0].command, /^npx --no-install mocha .*output=\/cache\/volt-tests\//);
		assert.strictEqual(rig.state(mine, 'adds'), TestResultState.Passed);

		// The chat's: in its sandbox with its rules, the report in its temp folder, read only where its sandbox reads.
		const reads: string[] = [];
		const exec = chatExec('chat-1', WORKSPACE_WRITE, ['/ws'], 'agent-shell');
		const agents = await rig.run(1, { exec, tmpdir: '/chat-tmp', readRefusal: async path => { reads.push(path); return undefined; } });
		assert.strictEqual(rig.stdio.runs.length, 2);
		assert.deepStrictEqual(who(rig.stdio.runs[1]), { principal: 'chat:chat-1', sandboxed: true, level: 'workspace-write', network: false, roots: ['/ws'] });
		assert.strictEqual(rig.stdio.runs[1].cwd, '/ws');
		assert.match(rig.stdio.runs[1].command, /output=\/chat-tmp\/volt-tests\/[\w-]+\.json/);
		assert.deepStrictEqual(reads.map(path => path.replace(/[\w-]+\.json$/, 'X.json')), ['/chat-tmp/volt-tests/X.json'], 'the report was judged before it was read');
		assert.strictEqual(rig.state(agents, 'adds'), TestResultState.Passed);
		assert.strictEqual(refusedTestRuns.get(agents), undefined);

		// A report the chat may not read (a link it left in its place) is not read: the test reads as errored, with why.
		const refusedRead = await rig.run(1, { exec, tmpdir: '/chat-tmp', readRefusal: async () => 'it links outside the workspace' });
		assert.strictEqual(rig.state(refusedRead, 'adds'), TestResultState.Errored);
		const message = [...refusedRead.tests].find(item => item.item.label === 'adds')!.tasks[0].messages[0].message;
		assert.match(typeof message === 'string' ? message : message.value, /The run's report was not read: it links outside the workspace/);
		// Without the gate's rule Volt cannot tell: not read either.
		const noRule = await rig.run(1, { exec, tmpdir: '/chat-tmp' });
		assert.strictEqual(rig.state(noRule, 'adds'), TestResultState.Errored);
	});

	test('DEV-SBX-5: a test command the chat\'s sandbox refused did not run (refused, not failing); a sandboxed debug run starts nothing', async () => {
		const rig = controllerRig();
		await mochaProject(rig, '/ws');
		rig.create();
		await rig.controller()!.syncTests(CancellationToken.None);
		const exec = chatExec('chat-1', WORKSPACE_WRITE, ['/ws'], 'agent-shell');

		rig.stdio.respond = async () => ({ exitCode: null, refused: { kind: 'sandbox', reason: 'the sandbox could not start (sandbox-exec is missing)' } });
		const refused = await rig.run(1, { exec, tmpdir: '/chat-tmp', readRefusal: async () => undefined });
		assert.strictEqual(rig.stdio.runs.length, 1, 'the one command, which its sandbox refused');
		assert.strictEqual(rig.state(refused, 'adds'), TestResultState.Errored);
		assert.match(refusedTestRuns.get(refused) ?? '', /^The test command did not run: the sandbox could not start/);
		assert.ok(!(await rig.fileService.exists(URI.file('/chat-tmp/volt-tests'))) || !(await rig.fileService.resolve(URI.file('/chat-tmp/volt-tests'))).children?.length, 'no report left behind');

		// The Debug profile for a sandboxed chat: js-debug would start outside the sandbox. Nothing starts.
		const debugRun = await rig.run(2, { exec, tmpdir: '/chat-tmp', readRefusal: async () => undefined });
		assert.strictEqual(rig.debugStarts(), 0);
		assert.strictEqual(rig.stdio.runs.length, 1, 'no command either');
		assert.strictEqual(rig.state(debugRun, 'adds'), TestResultState.Errored);
		assert.match(refusedTestRuns.get(debugRun) ?? '', /a debug run starts the debugger outside it/);
	});

	test('DEV-LIVE-1: a chat\'s project outside the window\'s folders gets its tests discovered (the plain mocha repo the live pass missed)', async () => {
		const rig = controllerRig();
		await mochaProject(rig, '/tmp/v4-devrepo');
		rig.create();
		await rig.controller()!.syncTests(CancellationToken.None);
		const fileId = new TestId([VOLT_TEST_CONTROLLER_ID, URI.file('/tmp/v4-devrepo/test/math.test.js').toString()]).toString();
		const published = () => rig.diffs.flat().some(op => op.op === 0 && op.item.item.extId === fileId);
		assert.strictEqual(published(), false, 'the window\'s folders do not hold it');
		await voltTestRoots.ensure(URI.file('/tmp/v4-devrepo'));
		assert.strictEqual(published(), true, 'the tests tool adds the chat\'s folder before it lists or runs');
		rig.stdio.respond = rig.mochaPasses('/tmp/v4-devrepo/test/math.test.js');
		const result = await rig.run(1, { exec: chatExec('chat-1', undefined, [], 'agent-shell') });
		assert.strictEqual(rig.stdio.runs[0].cwd, '/tmp/v4-devrepo');
		assert.deepStrictEqual(who(rig.stdio.runs[0]), { principal: 'chat:chat-1', sandboxed: false, level: undefined, network: undefined, roots: undefined }, 'an unsandboxed chat\'s run is still the chat\'s, not the user\'s');
		assert.strictEqual(rig.state(result, 'adds'), TestResultState.Passed);
	});

	// --- The tests tool -----------------------------------------------------------------------

	function testsRig() {
		const items: InternalTestItem[] = [];
		const add = (controllerId: string, path: string, name: string) => {
			const uri = URI.file(path);
			const fileId = new TestId([controllerId, uri.toString()]).toString();
			const leafId = TestId.joinToString(fileId, name);
			if (!items.some(item => item.item.extId === fileId)) {
				items.push({ controllerId, expand: TestItemExpandState.Expanded, item: { extId: fileId, label: path.split('/').pop()!, uri, range: null, tags: [], busy: false, description: null, error: null, sortText: null }, children: new Set<string>() } as unknown as InternalTestItem);
			}
			(items.find(item => item.item.extId === fileId) as unknown as { children: Set<string> }).children.add(leafId);
			items.push({ controllerId, expand: TestItemExpandState.NotExpandable, item: { extId: leafId, label: name, uri, range: new Range(1, 1, 3, 1), tags: [], busy: false, description: null, error: null, sortText: null }, children: new Set<string>() } as unknown as InternalTestItem);
		};
		add(VOLT_TEST_CONTROLLER_ID, '/ws/test/a.test.js', 'adds');
		add(VOLT_TEST_CONTROLLER_ID, '/secret/test/b.test.js', 'reads the secret');
		add('ext', '/ws/py/test_x.py', 'test_x');
		const requests: ResolvedTestRunRequest[] = [];
		const profile = (controllerId: string): ITestRunProfile => ({ controllerId, profileId: 1, label: 'Run', group: TestRunProfileBitset.Run, isDefault: true, tag: null, hasConfigurationHandler: false, supportsContinuousRun: false });
		const users: ITestResult = { id: 'users-run', completedAt: 1, tests: [], tasks: [], request: { group: TestRunProfileBitset.Run, targets: [] } } as unknown as ITestResult;
		const testService = {
			collection: {
				all: items,
				rootItems: items.filter(item => !TestId.parentId(item.item.extId) || TestId.fromString(item.item.extId).path.length === 2),
				getNodeById: (id: string) => items.find(item => item.item.extId === id),
			},
			getTestController: (id: string) => ({ label: observableValue('label', id === 'ext' ? 'Python' : 'Volt'), syncTests: async () => undefined }),
			syncTests: async () => undefined,
			runResolvedTests: async (request: ResolvedTestRunRequest) => {
				requests.push(request);
				return { id: `run-${requests.length}`, completedAt: 2, tests: [], tasks: [], request } as unknown as ITestResult;
			},
		} as unknown as ITestService;
		const results = { results: [users], getResult: (id: string) => id === users.id ? users : undefined } as unknown as ITestResultService;
		const profiles = {
			getControllerProfiles: (controllerId: string) => [profile(controllerId)],
			getDefaultProfileForTest: (_group: TestRunProfileBitset, test: InternalTestItem) => profile(test.controllerId),
		} as unknown as ITestProfileService;
		const readRefusal = async (path: string) => path.startsWith('/secret/') ? 'it is outside the workspace' : undefined;
		return { tests: new IdeTests(testService, results, profiles), requests, readRefusal };
	}

	test('DEV-SBX-6: the tests tool shows a sandboxed chat only tests it may read, its own results, and runs only Volt\'s runner (in its sandbox)', async () => {
		const { tests, requests, readRefusal } = testsRig();
		const root = URI.file('/ws');
		const exec = chatExec('chat-1', WORKSPACE_WRITE, ['/ws'], 'agent-shell');

		const listed = await tests.list(root, undefined, undefined, { readRefusal });
		assert.match(listed.text, /adds/);
		assert.match(listed.text, /test_x/, 'an extension\'s tests in the workspace are listed (they ran nothing)');
		assert.doesNotMatch(listed.text, /secret|b\.test/, 'a file the chat may not read is not listed');
		assert.doesNotMatch((await tests.list(root, undefined, undefined, {})).text, /adds|test_x/, 'without the gate\'s rule nothing is listed');
		assert.match((await tests.list(root, undefined, undefined)).text, /reads the secret/, 'unsandboxed: as before');

		// Not another's results: the user's last run is theirs.
		assert.strictEqual((await tests.resultsFor('chat-1', root, undefined, { readRefusal })).text, 'This chat has run no tests yet. Run them with op run.');
		assert.notStrictEqual((await tests.resultsFor('chat-1', root, undefined)).text, 'This chat has run no tests yet. Run them with op run.');

		// A test extension runs its tests in its extension host: refused, nothing started.
		const foreign = await tests.run('chat-1', root, { targets: ['py/test_x.py'] }, undefined, CancellationToken.None, { exec, readRefusal });
		assert.strictEqual(foreign.isError, true);
		assert.match(foreign.text, /^The tests did not run: they belong to Python, a test extension that runs them in its extension host, outside this chat's sandbox\. Run them with your own shell tool instead/);
		// A file it may not read is no target.
		assert.match((await tests.run('chat-1', root, { targets: ['/secret/test/b.test.js'] }, undefined, CancellationToken.None, { exec, readRefusal })).text, /No test or file matches/);
		assert.strictEqual(requests.length, 0, 'nothing started');

		// All tests: Volt's runner only, registered for the chat before it starts, the rest named as not run.
		const all = await tests.run('chat-1', root, {}, undefined, CancellationToken.None, { exec, readRefusal });
		assert.strictEqual(requests.length, 1);
		assert.deepStrictEqual(requests[0].targets.map(target => target.controllerId), [VOLT_TEST_CONTROLLER_ID]);
		assert.strictEqual(agentTestRuns.get(requests[0])?.exec, exec, 'Volt\'s controller runs it with the chat\'s sandboxed exec');
		assert.match(all.text, /Not run: the tests of Python, whose extension runs them outside this chat's sandbox/);
		// Unsandboxed: every controller, as before.
		await tests.run('chat-2', root, {}, undefined, CancellationToken.None);
		assert.deepStrictEqual(requests[1].targets.map(target => target.controllerId).sort(), ['ext', VOLT_TEST_CONTROLLER_ID]);
		assert.strictEqual(agentTestRuns.get(requests[1]), undefined, 'no agent registered: the controller would treat it as the user\'s');
	});

	// --- Capability commands and git ----------------------------------------------------------

	test('DEV-SBX-7: capability programs and git run in the chat\'s sandbox, through HostGit\'s guards; never as a bare execFile', async () => {
		const stdio = new FakeStdio();
		const sandboxed = chatExec('chat-1', WORKSPACE_WRITE, ['/proj'], 'agent-shell');
		const cli = new IdeCli(stdio.asService(), '/proj', sandboxed);
		await cli.run('docker', ['ps', '--format', '{{json .}}']);
		await cli.git(['for-each-ref', 'refs/heads']);
		assert.deepStrictEqual(stdio.files, [], 'a program run without a shell cannot carry a sandbox');
		assert.deepStrictEqual(stdio.gits, [], 'not HostGit on the host either');
		assert.strictEqual(stdio.runs.length, 2);
		for (const run of stdio.runs) {
			assert.deepStrictEqual(who(run), { principal: 'chat:chat-1', sandboxed: true, level: 'workspace-write', network: false, roots: ['/proj'] });
			assert.strictEqual(run.cwd, '/proj');
		}
		assert.strictEqual(stdio.runs[0].command, 'docker ps --format \'{{json .}}\'');
		assert.match(stdio.runs[1].command, /^git -c core\.fsmonitor=false -c protocol\.ext\.allow=never -c core\.hooksPath=\/dev\/null --no-pager for-each-ref refs\/heads$/);

		// An unsandboxed chat's git goes through HostGit; its other programs run without a shell.
		const open = new FakeStdio();
		const unconfined = new IdeCli(open.asService(), '/proj', chatExec('chat-2', undefined, [], 'agent-shell'));
		await unconfined.git(['status']);
		await unconfined.run('kubectl', ['get', 'pods']);
		assert.deepStrictEqual(open.gits.map(request => [request.cwd, request.args]), [['/proj', ['--no-pager', 'status']]]);
		assert.deepStrictEqual(open.files.map(request => request.file), ['kubectl']);
		assert.deepStrictEqual(open.runs, []);

		// A sandboxed chat's exec that lost its sandbox runs nothing, and no folder runs nothing.
		const lost: IChatExec = { context: { principal: 'chat:chat-1', reason: 'agent-shell', sandboxed: true } };
		const none = new FakeStdio();
		assert.match((await runChatGit(none.asService(), lost, { id: 'x', cwd: '/proj', args: ['status'], timeoutMs: 1_000 })).refused ?? '', /no sandbox to run git in/);
		assert.match((await new IdeCli(none.asService(), undefined, voltExec('agent-shell')).git(['status'])).refused ?? '', /no project folder/);
		assert.deepStrictEqual([none.runs, none.gits, none.files], [[], [], []]);
	});

	function ideServiceRig() {
		const instantiation = store.add(new TestInstantiationService());
		let provider: IVoltHostToolProvider | undefined;
		instantiation.stub(IVoltHostToolService, {
			registerToolProvider: (registered: IVoltHostToolProvider) => {
				provider = registered;
				return toDisposable(() => provider = undefined);
			},
			onDidInvokeTool: Event.None,
		} as unknown as IVoltHostToolService);
		const recorded = new Map<string, IChatExec>();
		instantiation.stub(IAgentRuntimeService, {
			chatFor: (sessionId: string) => sessionId === 's1' ? 'chat-1' : undefined,
			chatExec: (chatId: string, reason: 'agent-shell') => recorded.get(chatId) ?? chatExec(chatId, undefined, [], reason),
			onDidEmit: Event.None,
		} as unknown as IAgentRuntimeService);
		instantiation.stub(IWorkspaceContextService, { getWorkspace: () => ({ folders: [{ uri: URI.file('/volt-checkout') }] }) } as unknown as IWorkspaceContextService);
		const stdio = new FakeStdio();
		instantiation.stub(IVoltStdioService, stdio.asService());
		instantiation.stub(ICommandService, { executeCommand: async () => undefined } as unknown as ICommandService);
		for (const id of [ITestService, ITestResultService, ITestProfileService, IDebugService, ITaskService, ITerminalService, IFileService, IViewsService, IEditorService, ICodeEditorService, ITextFileService,
			INotebookEditorModelResolverService, INotebookKernelService, INotebookExecutionService, INotebookExecutionStateService, ITextModelService, IContextKeyService, IVoltHttpService, IEnvironmentService,
			IMarkerService, IWorkbenchEnvironmentService, IPathService, IExtensionService]) {
			instantiation.stub(id as ServiceIdentifier<object>, {});
		}
		store.add(instantiation.createInstance(AgentIdeService));
		const invoke = async (args: Record<string, unknown>, call: IVoltHostToolCall) => provider!.invoke('ide', args, call);
		return { invoke, stdio, recorded };
	}

	test('DEV-SBX-8: the ide gateway runs a sandboxed chat\'s programs in its sandbox, refuses a chat without a folder, and the stricter of the call and the chat wins', async () => {
		const { invoke, stdio, recorded } = ideServiceRig();
		const branches = { capability: 'git', op: 'branches' };

		await invoke(branches, { sessionId: 's1', cwd: '/proj', sandbox: WORKSPACE_WRITE, readRefusal: async () => undefined, writeRefusal: async () => undefined });
		assert.strictEqual(stdio.runs.length, 1);
		assert.deepStrictEqual(who(stdio.runs[0]), { principal: 'chat:chat-1', sandboxed: true, level: 'workspace-write', network: false, roots: ['/proj'] });
		assert.match(stdio.runs[0].command, /^git -c core\.fsmonitor=false .* for-each-ref /);
		assert.strictEqual(stdio.gits.length, 0);

		// A chat without a folder: nothing runs (never Volt's own checkout as a stand-in).
		const noFolder = await invoke(branches, { sessionId: 's1' });
		assert.match(noFolder.error ?? '', /^ide was not run: this chat has no project folder, so nothing was run/);
		assert.strictEqual(stdio.runs.length + stdio.gits.length, 1);

		// The chat turned sandboxed after its turn started (the call carries none): its programs run in the chat's sandbox,
		// and what needs the gate's path rules waits for the next turn.
		recorded.set('chat-1', chatExec('chat-1', { level: 'read-only', network: false }, ['/proj'], 'agent-shell'));
		await invoke(branches, { sessionId: 's1', cwd: '/proj' });
		assert.strictEqual(stdio.runs.length, 2);
		assert.deepStrictEqual(who(stdio.runs[1]), { principal: 'chat:chat-1', sandboxed: true, level: 'read-only', network: false, roots: ['/proj'] });
		const reads = await invoke({ capability: 'coverage', op: 'report' }, { sessionId: 's1', cwd: '/proj' });
		assert.match(reads.error ?? '', /sandbox was turned on after this turn started/);
		assert.strictEqual(stdio.gits.length, 0, 'git never ran on the host for this chat');

		// Unsandboxed chat: HostGit, in its folder.
		recorded.clear();
		await invoke(branches, { sessionId: 's1', cwd: '/proj' });
		assert.deepStrictEqual(stdio.gits.map(request => request.cwd), ['/proj']);
	});

	// --- Job waits ----------------------------------------------------------------------------

	test('DEV-SBX-9: watch_job runs the agent\'s check in the chat\'s sandbox (the turn\'s, when Volt\'s record says otherwise); the pid probe runs only a number', async () => {
		const instantiation = store.add(new TestInstantiationService());
		let provider: IVoltHostToolProvider | undefined;
		instantiation.stub(IVoltHostToolService, { registerToolProvider: (registered: IVoltHostToolProvider) => { provider = registered; return toDisposable(() => provider = undefined); } } as unknown as IVoltHostToolService);
		const stdio = new FakeStdio();
		// The check says the job is done, so no watch stays running past the test.
		stdio.respond = async () => ({ exitCode: 0, combined: 'done' });
		instantiation.stub(IVoltStdioService, stdio.asService());
		const recorded = new Map<string, IChatExec>();
		instantiation.stub(IAgentRuntimeService, {
			chatFor: (sessionId: string) => sessionId,
			chatExec: (chatId: string, reason: 'agent-shell') => recorded.get(chatId) ?? chatExec(chatId, undefined, [], reason),
		} as unknown as IAgentRuntimeService);
		instantiation.stub(IAgentOrchestratorService, { onDidChange: Event.None, onDidStop: Event.None, getThread: () => undefined, whenReady: Promise.resolve() } as unknown as IAgentOrchestratorService);
		instantiation.stub(IAgentTerminalsService, { onDidChange: Event.None, list: () => [] } as unknown as IAgentTerminalsService);
		instantiation.stub(IAgentHistoryService, { whenReady: Promise.resolve(), get: () => undefined } as unknown as IAgentHistoryService);
		instantiation.stub(IAgentWorkspaceService, { onDidChange: Event.None, get: () => undefined } as unknown as IAgentWorkspaceService);
		instantiation.stub(IFileService, {});
		instantiation.stub(IStorageService, { onWillSaveState: Event.None, get: () => undefined, store: () => undefined, remove: () => undefined } as unknown as IStorageService);
		store.add(instantiation.createInstance(AgentJobWaitsService));
		const watch = (call: IVoltHostToolCall, args: Record<string, unknown> = {}) => provider!.invoke('watch_job', { title: 'build', check: 'test -f out/done && echo done', every_s: 30, timeout_s: 600, ...args }, call);

		// The record says sandboxed: the check runs there.
		recorded.set('chat-1', chatExec('chat-1', WORKSPACE_WRITE, ['/proj'], 'agent-shell'));
		await watch({ sessionId: 'chat-1', cwd: '/proj' });
		assert.deepStrictEqual(who(stdio.runs[0]), { principal: 'chat:chat-1', sandboxed: true, level: 'workspace-write', network: false, roots: ['/proj'] });
		assert.strictEqual(stdio.runs[0].command, 'test -f out/done && echo done');

		// The user turned the sandbox off mid-turn: the turn that asked still runs sandboxed, so does its check.
		recorded.delete('chat-2');
		await watch({ sessionId: 'chat-2', cwd: '/proj2', sandbox: { level: 'read-only', network: false } });
		assert.deepStrictEqual(who(stdio.runs[1]), { principal: 'chat:chat-2', sandboxed: true, level: 'read-only', network: false, roots: ['/proj2'] });

		// The pid probe is Volt's own command: a number, never the agent's text.
		await watch({ sessionId: 'chat-1', cwd: '/proj' }, { check: undefined, pid: 4242 });
		const probe = stdio.runs.at(-1)!;
		assert.deepStrictEqual(who(probe), { principal: 'volt', sandboxed: false, level: undefined, network: undefined, roots: undefined });
		assert.match(probe.command, /^kill -0 4242 |tasklist \/FI "PID eq 4242"/);
	});

	// --- Debug sessions and tasks ---------------------------------------------------------------

	test('DEV-SBX-10: debug and tasks refuse a sandboxed chat what runs outside the sandbox, and show it only what it started', async () => {
		let debugStarts = 0;
		const users = { getId: () => 'users-session', getLabel: () => 'Launch Program', parentSession: undefined, state: 2 } as unknown as IDebugSession;
		const debugService = {
			startDebugging: async () => { debugStarts++; return true; },
			addBreakpoints: async () => { throw new Error('no breakpoint may be added'); },
			getModel: () => ({ getSessions: () => [users] }),
			getViewModel: () => ({ focusedSession: users }),
		} as unknown as IDebugService;
		const debug = new IdeDebug(debugService, {} as IFileService);
		const root = URI.file('/proj');
		for (const op of ['start', 'attach']) {
			const refused = await debug.invoke('chat-1', root, { op, program: 'a.js', port: 9229 }, undefined, CancellationToken.None, true);
			assert.strictEqual(refused.isError, true);
			assert.match(refused.text, /^The debugger was not started: this chat runs in Volt's sandbox/, op);
		}
		assert.strictEqual(debugStarts, 0);
		for (const op of ['state', 'variables', 'output', 'stop', 'evaluate', 'continue']) {
			const refused = await debug.invoke('chat-1', root, { op, expression: 'process.env' }, undefined, CancellationToken.None, true);
			assert.match(refused.text, /^This chat has no debug session of its own/, `${op}: never the user's session`);
		}
		assert.match((await debug.invoke('chat-1', root, { op: 'breakpoints', path: 'a.js', line: 3, condition: 'fetch(evil)' }, undefined, CancellationToken.None, true)).text, /^No breakpoint was set: .*a condition or logpoint runs code/);
		assert.match((await debug.invoke('chat-1', root, { op: 'breakpoints', path: 'a.js', line: 3, log: '{x}' }, undefined, CancellationToken.None, true)).text, /^No breakpoint was set/);

		const userTask = { _label: 'build', getMapKey: () => 'user-build', getQualifiedLabel: () => 'build', configurationProperties: {} } as unknown as Task;
		let taskRuns = 0;
		const taskService = {
			getActiveTasks: async () => [userTask],
			getBusyTasks: async () => [userTask],
			tasks: async () => [userTask],
			run: async () => { taskRuns++; },
			terminate: async () => { throw new Error('the user\'s task must not be stopped'); },
		} as unknown as ITaskService;
		const tasks = new IdeTasks(taskService, {} as ITerminalService);
		const own = (task: Task) => task.getMapKey() !== 'user-build';
		assert.match((await tasks.invoke(root, 'run', 'build', undefined, undefined, CancellationToken.None, own)).text, /^The task did not run: this chat runs in Volt's sandbox, and a task runs its command in a terminal outside it/);
		assert.strictEqual(taskRuns, 0);
		assert.strictEqual((await tasks.invoke(root, 'status', undefined, undefined, undefined, CancellationToken.None, own)).text, 'No task this chat started is running.');
		assert.match((await tasks.invoke(root, 'output', 'build', undefined, undefined, CancellationToken.None, own)).text, /^No task "build" that this chat started/);
		assert.match((await tasks.invoke(root, 'stop', 'build', undefined, undefined, CancellationToken.None, own)).text, /^No task "build" that this chat started/);
		assert.match((await tasks.invoke(root, 'status', undefined, undefined, undefined, CancellationToken.None)).text, /build: busy/, 'unsandboxed: as before');
	});
});

