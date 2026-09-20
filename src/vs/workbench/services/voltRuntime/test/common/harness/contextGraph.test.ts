/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IContextItem } from '../../../common/harness/contextEngine.js';
import { buildContextGraph, prioritizeGraph } from '../../../common/harness/contextGraph.js';

suite('Volt context graph', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('links retrieved files to the goal and keeps pinned items first', () => {
		const items: IContextItem[] = [
			{ id: 'goal', channel: 'goal', text: 'add a logout button', priority: 1, pinned: true },
			{ id: 'file', channel: 'files', text: 'src/Header.tsx exports Header', priority: 0.4 },
			{ id: 'noise', channel: 'files', text: 'changelog from 2019', priority: 0.9 },
			{ id: 'rules', channel: 'rules', text: 'use pnpm', priority: 0.5 },
		];
		const graph = buildContextGraph(items, 'logout button Header');
		assert.ok(graph.edges.some(edge => edge.kind === 'retrieved-for' && edge.to === 'goal'));
		assert.ok(graph.edges.some(edge => edge.kind === 'supports' && edge.from === 'rules'));
		const ranked = prioritizeGraph(graph);
		assert.strictEqual(ranked[0].id, 'goal');
	});
});
