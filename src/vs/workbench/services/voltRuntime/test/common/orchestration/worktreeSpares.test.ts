/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IWorktreeSpare, IWorktreeSpareHost, WorktreeSpares } from '../../../common/orchestration/worktreeSpares.js';

const tick = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));

class FakeRepo implements IWorktreeSpareHost {
	headNow = 'c1';
	made = 0;
	readonly log: string[] = [];
	/** Holds every create until released (a worktree still being made). */
	hold: Promise<void> | undefined;
	moveOk = true;

	async create(repoRoot: string): Promise<IWorktreeSpare> {
		await this.hold;
		const n = ++this.made;
		this.log.push(`create ${n}`);
		return { path: `${repoRoot}-wt${n}`, branch: `volt/${n}`, commit: this.headNow };
	}
	async head(): Promise<string | undefined> {
		return this.headNow;
	}
	async moveTo(spare: IWorktreeSpare, commit: string): Promise<boolean> {
		this.log.push(`move ${spare.branch} ${commit}`);
		return this.moveOk;
	}
	async remove(_repoRoot: string, spare: IWorktreeSpare): Promise<void> {
		this.log.push(`remove ${spare.branch}`);
	}
}

function warmer(log: string[]) {
	return (spare: IWorktreeSpare) => {
		log.push(`warm ${spare.branch}`);
		return () => log.push(`stop ${spare.branch}`);
	};
}

suite('Volt worktree spares', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a worktree task takes a worktree made ahead, with its agent warmed there', async () => {
		const repo = new FakeRepo();
		const spares = new WorktreeSpares(repo, 60_000);
		spares.fill('/repo', 2, warmer(repo.log));
		await tick();
		assert.deepStrictEqual([...repo.log].sort(), ['create 1', 'create 2', 'warm volt/1', 'warm volt/2']);
		assert.deepStrictEqual(await spares.take('/repo'), { path: '/repo-wt1', branch: 'volt/1', commit: 'c1' });
		assert.strictEqual(spares.count('/repo'), 1);
		assert.strictEqual(await spares.take('/other'), undefined);
		spares.clear();
		await tick();
		assert.deepStrictEqual(repo.log.slice(4), ['stop volt/2', 'remove volt/2']);
	});

	test('filling again makes none extra and warms the agents again', async () => {
		const repo = new FakeRepo();
		const spares = new WorktreeSpares(repo, 60_000);
		spares.fill('/repo', 2, warmer(repo.log));
		await tick();
		spares.fill('/repo', 2, warmer(repo.log));
		assert.strictEqual(repo.made, 2);
		assert.deepStrictEqual(repo.log.slice(4), ['warm volt/1', 'warm volt/2']);
		spares.clear();
	});

	test('one still being made is awaited and keeps its warm agent', async () => {
		const repo = new FakeRepo();
		let release!: () => void;
		repo.hold = new Promise(resolve => release = resolve);
		const spares = new WorktreeSpares(repo, 60_000);
		spares.fill('/repo', 1, warmer(repo.log));
		const taken = spares.take('/repo');
		assert.strictEqual(spares.count('/repo'), 0);
		release();
		assert.deepStrictEqual(await taken, { path: '/repo-wt1', branch: 'volt/1', commit: 'c1' });
		assert.deepStrictEqual(repo.log, ['create 1', 'warm volt/1']);
	});

	test('HEAD moved since: the spare follows it and its agent (which saw the old commit) stops', async () => {
		const repo = new FakeRepo();
		const spares = new WorktreeSpares(repo, 60_000);
		spares.fill('/repo', 2, warmer(repo.log));
		await tick();
		repo.headNow = 'c2';
		assert.deepStrictEqual(await spares.take('/repo'), { path: '/repo-wt1', branch: 'volt/1', commit: 'c2' });
		assert.deepStrictEqual(repo.log.slice(4), ['stop volt/1', 'move volt/1 c2']);
		repo.moveOk = false;
		assert.strictEqual(await spares.take('/repo'), undefined);
		assert.deepStrictEqual(repo.log.slice(6), ['stop volt/2', 'move volt/2 c2', 'remove volt/2']);
	});

	test('a spare nobody takes is removed with its agent, also one still being made', async () => {
		const repo = new FakeRepo();
		const spares = new WorktreeSpares(repo, 5);
		spares.fill('/repo', 1, warmer(repo.log));
		await tick(30);
		assert.deepStrictEqual(repo.log, ['create 1', 'warm volt/1', 'stop volt/1', 'remove volt/1']);
		assert.strictEqual(await spares.take('/repo'), undefined);

		let release!: () => void;
		repo.hold = new Promise(resolve => release = resolve);
		spares.fill('/repo', 1, warmer(repo.log));
		spares.clear();
		release();
		await tick();
		assert.deepStrictEqual(repo.log.slice(4), ['create 2', 'remove volt/2']);
	});
});
