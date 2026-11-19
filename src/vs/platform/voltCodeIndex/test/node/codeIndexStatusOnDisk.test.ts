/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { indexDirFor, normalizeIndexRoot } from '../../node/codeIndexDisk.js';
import { VoltCodeIndexService } from '../../node/voltCodeIndexService.js';

suite('Volt code index: a stopped index answers status from disk, without its process (round 7)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let dataDir: string;

	setup(async () => {
		dataDir = await fs.mkdtemp(join(tmpdir(), 'volt-index-status-'));
	});

	teardown(async () => {
		await fs.rm(dataDir, { recursive: true, force: true });
	});

	test('an indexed folder is ready with its counts, an unknown one is none, and no process is forked', async () => {
		const root = join(tmpdir(), 'some-project');
		const dir = indexDirFor(dataDir, normalizeIndexRoot(root));
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ root, updatedAt: 5, lastUsedAt: 6, stats: { files: 2_345, bytes: 10, symbols: 7, diskBytes: 20 } }));
		const service = store.add(new VoltCodeIndexService(dataDir, new NullLogService()));
		const [indexed, unknown] = await service.status([`${root}/`, join(tmpdir(), 'never-indexed')]);
		assert.deepStrictEqual(indexed, { root, state: 'ready', files: 2_345, bytes: 10, diskBytes: 20, symbols: 7, pending: 0, updatedAt: 5, lastUsedAt: 6 });
		assert.strictEqual(unknown.state, 'none');
		assert.strictEqual(unknown.files, 0);
		// Nothing connected: the service never created its process client.
		assert.strictEqual((service as unknown as { client: unknown }).client, undefined);
	});
});
