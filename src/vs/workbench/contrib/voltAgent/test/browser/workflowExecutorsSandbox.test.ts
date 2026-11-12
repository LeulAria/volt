/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { IVoltExecRequest, IVoltExecResult } from '../../../../../platform/voltStdio/common/voltStdio.js';
import { IWorkflowDefinition, IWorkflowNodeContext, WorkflowNodeError, WorkflowRecord } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { WorkflowExecutors } from '../../browser/workflows/workflowExecutors.js';

const REPO = '/work/repo';

/**
 * Workflow steps of a sandboxed chat (spec B-06, LIFE-PATH-3, N.1 #10): a workflow's commands run
 * for the chat its agent steps used, inside that chat's sandbox with the chat's rules, or not at all.
 * The real sandbox's denial of the canary write is voltStdioSandbox.test.ts's (LIFE-PATH (workflow)).
 */
suite('Workflow commands of sandboxed chats (LIFE-PATH-3)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(chats: Record<string, IVoltSandboxSettings>, defaults: IVoltSandboxSettings = { level: 'off', network: true }) {
		const execs: IVoltExecRequest[] = [];
		let refuse = false;
		const stub = <T>(value: object) => value as unknown as T;
		const stdio = {
			exec: async (request: IVoltExecRequest): Promise<IVoltExecResult> => {
				execs.push(request);
				const base = { id: request.id, truncated: false, durationMs: 1, timedOut: false, cancelled: false, running: false };
				return refuse
					? { ...base, exitCode: null, stdout: '', stderr: '', combined: '', refused: { kind: 'sandbox', reason: 'No OS sandbox available' } }
					: { ...base, exitCode: 0, stdout: 'ok', stderr: '', combined: 'ok' };
			},
			execFile: async () => { throw new Error('a sandboxed chat\'s program runs as a command in its sandbox, never through execFile'); },
			cancelExec: async () => { },
		};
		const runtime = {
			getSandboxSettings: (chat: string) => chats[chat] ?? defaults,
			getDefaultSandboxSettings: () => defaults,
		};
		const workflow = stub<IWorkflowDefinition>({ id: 'wf', name: 'Wf', nodes: [], edges: [], settings: { repository: REPO } });
		const executors = store.add(new WorkflowExecutors(
			{ runId: 'run-1', workflow },
			stub({}), stub(runtime), stub({}), stub({ activeProject: undefined, projects: [] }), stub({}), stub(stdio), stub({}), stub({}), stub({}), stub({}), stub({}), stub({}),
			stub({ createInstance: () => ({}) }),
		));
		const run = async (type: string, config: WorkflowRecord, chat?: string) => {
			// The chat the run's last agent step used.
			(executors as unknown as { lastThread: string | undefined }).lastThread = chat;
			const ctx = stub<IWorkflowNodeContext>({
				runId: 'run-1', mode: 'run', workflow, node: { id: 'n', type, position: { x: 0, y: 0 }, config }, type: { type, outputs: () => [{ id: 'success', kind: 'success' }] }, config, input: null, attempt: 1, stepId: 's', token: CancellationToken.None,
				log: () => { }, setVariable: () => { }, reportTokens: () => { }, reportThread: () => { }, waiting: () => Disposable.None,
			});
			return executors.executor(type)!.execute(ctx);
		};
		return { execs, run, refuse: () => { refuse = true; } };
	}

	test('LIFE-PATH-3: a shell step after a sandboxed chat\'s agent step runs in that chat\'s sandbox, with its rules', async () => {
		const { execs, run } = setup({ c1: { level: 'workspace-write', network: true, allowedDomains: ['registry.example'] } });
		await run('shell', { command: 'touch $HOME/pwned' }, 'c1');
		assert.strictEqual(execs.length, 1);
		assert.deepStrictEqual(execs[0].context, { principal: 'chat:c1', reason: 'workflow', sandboxed: true });
		assert.deepStrictEqual(execs[0].sandbox, { level: 'workspace-write', network: true, providerId: '', workspaceRoots: [REPO], allowedDomains: ['registry.example'] }, 'the chat\'s own rules, not forced network-off');
	});

	test('LIFE-PATH-3: before any agent step, a run whose new chats are sandboxed runs its commands in that sandbox', async () => {
		const { execs, run } = setup({}, { level: 'read-only', network: false });
		await run('shell', { command: 'make' });
		assert.deepStrictEqual(execs[0].context, { principal: 'volt', reason: 'workflow', sandboxed: true });
		assert.deepStrictEqual(execs[0].sandbox, { level: 'read-only', network: false, providerId: '', workspaceRoots: [REPO] });
	});

	test('LIFE-PATH-3: a step whose sandbox cannot be set up fails with the reason; nothing ran unconfined', async () => {
		const { execs, run, refuse } = setup({ c1: { level: 'workspace-write', network: false } });
		refuse();
		await assert.rejects(run('shell', { command: 'touch $HOME/pwned' }, 'c1'), (err: Error) => err instanceof WorkflowNodeError && /No OS sandbox/.test(err.message));
		assert.strictEqual(execs.length, 1, 'one attempt, no unsandboxed retry');
		assert.ok(execs[0].sandbox);
	});

	test('an unsandboxed chat\'s step runs as before, labelled with the chat', async () => {
		const { execs, run } = setup({ c2: { level: 'off', network: true } });
		await run('shell', { command: 'npm test' }, 'c2');
		assert.deepStrictEqual(execs[0].context, { principal: 'chat:c2', reason: 'workflow', sandboxed: false });
		assert.strictEqual(execs[0].sandbox, undefined);
	});
});
