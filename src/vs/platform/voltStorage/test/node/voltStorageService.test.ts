/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IVoltStorageContext } from '../../common/voltStorage.js';
import { worktreeRepoKey } from '../../common/voltStorageRules.js';
import { measurePath, VoltStorageService } from '../../node/voltStorageService.js';

const EMPTY: IVoltStorageContext = { openWorkspaceIds: [], worktrees: [], sessionIds: [], runningSessionIds: [] };

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

suite('VoltStorageService on real folders', function () {

	this.timeout(60_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let service: VoltStorageService;
	let data: string;
	let worktrees: string;
	const cleared: string[] = [];

	setup(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), 'volt-storage-')));
		data = join(root, 'data');
		worktrees = join(root, 'home', '.volt', 'worktrees');
		await mkdir(join(data, 'User'), { recursive: true });
		cleared.length = 0;
		service = new VoltStorageService({
			userDataPath: data,
			userRoamingPath: join(data, 'User'),
			logsSessionPath: join(data, 'logs', 'current'),
			worktreesRoot: worktrees,
			commit: undefined,
		}, async () => process.env, new NullLogService(), {
			codeCache: async () => { cleared.push('codeCache'); },
		});
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('measures like du -sk', async () => {
		const dir = join(root, 'm');
		await mkdir(join(dir, 'sub'), { recursive: true });
		await writeFile(join(dir, 'a.bin'), Buffer.alloc(100_000));
		await writeFile(join(dir, 'sub', 'b.bin'), Buffer.alloc(5_000));
		const measured = await measurePath(dir);
		const du = Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0]) * 1024;
		assert.strictEqual(measured.bytes, du);
		assert.strictEqual(measured.files, 2);
		assert.deepStrictEqual(await measurePath(join(root, 'missing')), { bytes: 0, files: 0 });
	});

	test('cleans old logs but keeps this session\'s', async () => {
		await mkdir(join(data, 'logs', 'current'), { recursive: true });
		await mkdir(join(data, 'logs', 'old'), { recursive: true });
		await writeFile(join(data, 'logs', 'current', 'main.log'), 'x'.repeat(10_000));
		await writeFile(join(data, 'logs', 'old', 'main.log'), 'x'.repeat(10_000));
		const report = await service.machineReport(EMPTY);
		const logs = report.items.find(item => item.id === 'logs')!;
		assert.ok(logs.cleanableBytes > 0 && logs.cleanableBytes < logs.bytes);
		const result = await service.clean('logs', EMPTY);
		assert.strictEqual(result.removed, 1);
		assert.deepStrictEqual(result.skipped.map(skip => skip.keep), ['current']);
		assert.ok(existsSync(join(data, 'logs', 'current', 'main.log')));
		assert.ok(!existsSync(join(data, 'logs', 'old')));
	});

	test('whole rows go through their cleaner; info rows are never cleaned', async () => {
		await mkdir(join(data, 'Code Cache'), { recursive: true });
		await writeFile(join(data, 'Code Cache', 'x'), 'y');
		await service.clean('codeCache', EMPTY);
		assert.deepStrictEqual(cleared, ['codeCache']);
		await mkdir(join(data, 'GPUCache'), { recursive: true });
		await writeFile(join(data, 'GPUCache', 'data_0'), 'y');
		const result = await service.clean('gpuCache', EMPTY);
		assert.strictEqual(result.removed, 0);
		assert.ok(existsSync(join(data, 'GPUCache', 'data_0')));
	});

	test('native transcripts only of deleted chats go; workspace state only of gone folders', async () => {
		const native = join(data, 'User', 'voltNative');
		await mkdir(native, { recursive: true });
		await writeFile(join(native, 'agent-11111111-aaaa.json'), '{}');
		await writeFile(join(native, 'agent-22222222-bbbb.json'), '{}');
		const ws = join(data, 'User', 'workspaceStorage');
		await mkdir(join(ws, 'live'), { recursive: true });
		await mkdir(join(ws, 'gone'), { recursive: true });
		await mkdir(join(ws, 'open'), { recursive: true });
		await writeFile(join(ws, 'live', 'workspace.json'), JSON.stringify({ folder: `file://${root}` }));
		await writeFile(join(ws, 'gone', 'workspace.json'), JSON.stringify({ folder: `file://${join(root, 'nope')}` }));
		await writeFile(join(ws, 'open', 'workspace.json'), JSON.stringify({ folder: `file://${join(root, 'nope')}` }));
		const context = { ...EMPTY, sessionIds: ['agent-11111111-aaaa'], openWorkspaceIds: ['open'] };
		await service.clean('nativeTranscripts', context);
		assert.ok(existsSync(join(native, 'agent-11111111-aaaa.json')));
		assert.ok(!existsSync(join(native, 'agent-22222222-bbbb.json')));
		await service.clean('workspaceStorage', context);
		assert.ok(existsSync(join(ws, 'live')));
		assert.ok(existsSync(join(ws, 'open')));
		assert.ok(!existsSync(join(ws, 'gone')));
		// From the project, its own entry may go.
		const project = { ...context, root, projectSessionIds: [] };
		const report = await service.projectReport(project);
		assert.deepStrictEqual(report.items.find(item => item.id === 'project.workspaceStorage')!.entries.map(entry => entry.keep), [undefined]);
		await service.clean('project.workspaceStorage', context, project);
		assert.ok(!existsSync(join(ws, 'live')));
	});

	test('worktrees: removes clean unused ones, keeps dirty and in-use ones', async () => {
		const repo = join(root, 'repo');
		await mkdir(repo);
		git(repo, 'init', '-q', '-b', 'main');
		await writeFile(join(repo, 'a.txt'), 'a');
		git(repo, 'add', '.');
		git(repo, 'commit', '-q', '-m', 'init');
		const key = worktreeRepoKey(join(repo, '.git'));
		const parent = join(worktrees, key);
		await mkdir(parent, { recursive: true });
		const [clean, dirty, used] = ['volt-aaaaaaaa', 'volt-bbbbbbbb', 'volt-cccccccc'].map(name => join(parent, name));
		git(repo, 'worktree', 'add', '-q', '-b', 'volt/aaaaaaaa', clean);
		git(repo, 'worktree', 'add', '-q', '-b', 'volt/bbbbbbbb', dirty);
		git(repo, 'worktree', 'add', '-q', '-b', 'volt/cccccccc', used);
		await writeFile(join(dirty, 'wip.txt'), 'uncommitted');
		const context: IVoltStorageContext = { ...EMPTY, worktrees: [{ path: used, sessionId: 's1', archived: false }, { path: clean, sessionId: 's2', archived: true }, { path: dirty, sessionId: 's3', archived: true }] };
		const project = { ...context, root: repo, projectSessionIds: ['s1', 's2', 's3'] };
		const report = await service.projectReport(project);
		const row = report.items.find(item => item.id === 'project.worktrees')!;
		assert.deepStrictEqual(Object.fromEntries(row.entries.map(entry => [entry.path, entry.keep])), { [clean]: undefined, [dirty]: 'dirty', [used]: 'inUse' });
		const result = await service.clean('project.worktrees', context, project);
		assert.strictEqual(result.removed, 1);
		assert.ok(!existsSync(clean));
		assert.ok(existsSync(join(dirty, 'wip.txt')));
		assert.ok(existsSync(used));
		// git forgot the removed one; its branch stays.
		assert.ok(!git(repo, 'worktree', 'list').includes('volt-aaaaaaaa'));
		assert.ok(git(repo, 'branch', '--list', 'volt/aaaaaaaa').includes('volt/aaaaaaaa'));
	});
});
