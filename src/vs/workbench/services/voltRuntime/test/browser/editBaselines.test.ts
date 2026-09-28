/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { EditBaselineTracker, reverseDiffs } from '../../browser/editBaselines.js';

/** An in-memory disk the agent writes behind the tracker's back. */
class FakeDisk {
	readonly files = new Map<string, string>();

	asService(): IFileService {
		return {
			readFile: async (uri: URI) => {
				const text = this.files.get(uri.path);
				if (text === undefined) {
					throw new Error('ENOENT');
				}
				return { value: VSBuffer.fromString(text) };
			},
		} as unknown as IFileService;
	}
}

suite('Edit baselines', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const resolve = (_session: string, path: string) => URI.file(path);

	test('snapshots a file when the call names it, before the agent writes it', async () => {
		const disk = new FakeDisk();
		disk.files.set('/w/a.ts', 'one\ntwo\n');
		const tracker = new EditBaselineTracker(disk.asService(), resolve);
		tracker.observe('s', { type: 'tool.start', callId: 'c', name: 'Edit', kind: 'edit' });
		tracker.observe('s', { type: 'tool.update', callId: 'c', locations: [{ path: '/w/a.ts' }] });
		await Promise.resolve();
		disk.files.set('/w/a.ts', 'one\nTWO\n');
		const found = await tracker.observe('s', { type: 'tool.end', callId: 'c' });
		assert.deepStrictEqual(found?.map(b => ({ path: b.uri.path, kind: b.kind, before: b.before })), [{ path: '/w/a.ts', kind: 'edit', before: 'one\ntwo\n' }]);
	});

	test('reverses the call\'s own diff when the snapshot came too late', async () => {
		const disk = new FakeDisk();
		disk.files.set('/w/a.ts', 'head\nnew line\ntail\n');
		const tracker = new EditBaselineTracker(disk.asService(), resolve);
		const found = await tracker.observe('s', { type: 'tool.end', callId: 'c', diffs: [{ path: '/w/a.ts', oldText: 'old line', newText: 'new line' }] });
		assert.strictEqual(found?.[0].before, 'head\nold line\ntail\n');
	});

	test('reports a created file with no baseline text', async () => {
		const disk = new FakeDisk();
		const tracker = new EditBaselineTracker(disk.asService(), resolve);
		tracker.observe('s', { type: 'tool.update', callId: 'c', diffs: [{ path: '/w/new.ts', oldText: null, newText: 'hello' }] });
		await Promise.resolve();
		disk.files.set('/w/new.ts', 'hello');
		const found = await tracker.observe('s', { type: 'tool.end', callId: 'c' });
		assert.deepStrictEqual(found?.map(b => ({ kind: b.kind, existed: b.existed, before: b.before })), [{ kind: 'create', existed: false, before: undefined }]);
	});

	test('ignores reads, failed calls, and paths outside the checkout', async () => {
		const disk = new FakeDisk();
		disk.files.set('/w/a.ts', 'x');
		const tracker = new EditBaselineTracker(disk.asService(), (_session, path) => path.startsWith('/w/') ? URI.file(path) : undefined);
		assert.strictEqual(tracker.observe('s', { type: 'tool.start', callId: 'r', name: 'Read', kind: 'read', locations: [{ path: '/w/a.ts' }] }), undefined);
		assert.strictEqual(await tracker.observe('s', { type: 'tool.end', callId: 'r' }), undefined);
		tracker.observe('s', { type: 'tool.update', callId: 'f', kind: 'edit', locations: [{ path: '/w/a.ts' }] });
		assert.strictEqual(await tracker.observe('s', { type: 'tool.end', callId: 'f', error: 'Tool failed' }), undefined);
		tracker.observe('s', { type: 'tool.update', callId: 'o', kind: 'edit', locations: [{ path: '/home/.claude/plan.md' }] });
		assert.deepStrictEqual(await tracker.observe('s', { type: 'tool.end', callId: 'o' }), []);
	});

	test('reverses several edits newest first', () => {
		const current = 'a\nB\nc\nD\n';
		assert.strictEqual(reverseDiffs(current, [
			{ path: 'f', oldText: 'b', newText: 'B' },
			{ path: 'f', oldText: 'd', newText: 'D' },
		]), 'a\nb\nc\nd\n');
		assert.strictEqual(typeof reverseDiffs(current, [{ path: 'f', oldText: 'x', newText: 'missing' }]), 'symbol');
	});
});
