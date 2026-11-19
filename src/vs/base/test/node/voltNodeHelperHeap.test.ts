/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFile } from 'child_process';
import { NODE_HELPER_MAX_SEMI_SPACE_MB, nodeHelperHeapFlags } from '../../node/voltNodeHelperHeap.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

/** A burst of short-lived JSON, as a relay parses it; prints the young generation's size in MB afterwards. */
const BURST = `
const v8 = require('v8');
const line = JSON.stringify({ text: 'x'.repeat(200), items: Array.from({ length: 50 }, (_, i) => ({ i, t: 'tok' + i })) });
let kept = [];
for (let i = 0; i < 150000; i++) { const o = JSON.parse(line); if (i % 50 === 0) { kept.push(o); } if (kept.length > 2000) { kept = kept.slice(1000); } }
const young = v8.getHeapSpaceStatistics().find(s => s.space_name === 'new_space');
process.stdout.write(String(Math.round(young.space_size / 1048576)));
`;

function youngGenerationAfterBurst(flags: string[]): Promise<number> {
	return new Promise((resolve, reject) => {
		// process.execPath is Electron's binary under the Electron test runner: run as Node, as the agent server is.
		execFile(process.execPath, [...flags, '-e', BURST], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 60_000 }, (err, stdout) => err ? reject(err) : resolve(Number(stdout)));
	});
}

suite('Agent server heap: a small young generation under a burst (round 9)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the flags cap the young generation at two semi-spaces of the cap', async function () {
		this.timeout(120_000);
		const capped = await youngGenerationAfterBurst(nodeHelperHeapFlags());
		const uncapped = await youngGenerationAfterBurst([]);
		assert.ok(capped <= 2 * NODE_HELPER_MAX_SEMI_SPACE_MB, `capped young generation ${capped} MB`);
		assert.ok(uncapped > capped, `without the flags the burst grows it further (${uncapped} MB)`);
	});
});
