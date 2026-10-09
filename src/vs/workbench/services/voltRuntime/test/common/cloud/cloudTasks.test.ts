/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { cloudAgentForFamily, cloudMachineStorageKey, cloudTaskHasResult, cloudTaskStatusText, cloudTaskTone, ICloudTask, normalizeCloudMachine, ownCloudTasks, sortCloudTasks, upsertCloudTask } from '../../../common/cloud/cloudTasks.js';

function task(patch: Partial<ICloudTask> = {}): ICloudTask {
	return {
		id: 'task_1',
		title: 'Fix it',
		prompt: 'Fix it',
		agent: 'codex',
		status: 'queued',
		createdAt: 1,
		target: {},
		origin: { deviceId: 'cli_me' },
		source: {},
		...patch,
	};
}

suite('cloud tasks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('status text says where the task is, in the words the runner used', () => {
		assert.strictEqual(cloudTaskStatusText(task()), 'Waiting for a runner');
		assert.strictEqual(cloudTaskStatusText(task({ target: { autoPicked: true } })), 'Waiting for the least loaded runner');
		assert.strictEqual(cloudTaskStatusText(task({ target: { machineId: 'run_b' } })), 'Waiting for its runner');
		assert.strictEqual(cloudTaskStatusText(task({ status: 'running', progress: 'Running Codex', assignedName: 'vhx-runner-b' })), 'Running Codex on vhx-runner-b');
		assert.strictEqual(cloudTaskStatusText(task({ status: 'succeeded', result: { stats: { files: 1, insertions: 1, deletions: 0 } } })), '1 file changed');
		assert.strictEqual(cloudTaskStatusText(task({ status: 'succeeded', result: { noChanges: true } })), 'Finished with no changes');
		assert.strictEqual(cloudTaskStatusText(task({ status: 'failed', error: 'codex exited 1' })), 'Failed: codex exited 1');
	});

	test('tone and result follow the status', () => {
		assert.strictEqual(cloudTaskTone(task({ status: 'finishing' })), 'active');
		assert.strictEqual(cloudTaskTone(task({ status: 'cancelled' })), 'muted');
		assert.strictEqual(cloudTaskTone(task({ status: 'failed' })), 'failed');
		const done = task({ status: 'succeeded', result: { branch: 'volt/cloud-x', bundleBlob: 'blob_1' } });
		assert.ok(cloudTaskHasResult(done));
		assert.ok(!cloudTaskHasResult({ ...done, result: { ...done.result, noChanges: true } }));
		assert.ok(!cloudTaskHasResult(task({ status: 'running', result: { branch: 'b', bundleBlob: 'x' } })));
	});

	test('lists are newest first, keep only this Volt\'s tasks, and upsert by id', () => {
		const older = task({ id: 'a', createdAt: 1 });
		const newer = task({ id: 'b', createdAt: 2, origin: { deviceId: 'cli_other' } });
		const archived = task({ id: 'c', createdAt: 3, archived: true });
		assert.deepStrictEqual(sortCloudTasks([older, newer, archived]).map(item => item.id), ['b', 'a']);
		assert.deepStrictEqual(ownCloudTasks([older, newer], 'cli_me').map(item => item.id), ['a']);
		assert.deepStrictEqual(ownCloudTasks([older], undefined), []);
		const updated = upsertCloudTask([older], { ...older, status: 'running' });
		assert.strictEqual(updated.length, 1);
		assert.strictEqual(updated[0].status, 'running');
		assert.strictEqual(upsertCloudTask([older], newer).length, 2);
	});

	test('the Cloud location remembers a machine per project; Claude and Codex are the only cloud agents', () => {
		assert.strictEqual(normalizeCloudMachine(undefined), 'auto');
		assert.strictEqual(normalizeCloudMachine('run_b8Fq2x'), 'run_b8Fq2x');
		assert.strictEqual(normalizeCloudMachine('bad id!'), 'auto');
		assert.strictEqual(cloudMachineStorageKey('p1'), 'volt.agent.cloudMachine.p1');
		assert.strictEqual(cloudAgentForFamily('codex'), 'codex');
		assert.strictEqual(cloudAgentForFamily('claude'), 'claude');
		assert.strictEqual(cloudAgentForFamily('grok'), undefined);
	});
});
