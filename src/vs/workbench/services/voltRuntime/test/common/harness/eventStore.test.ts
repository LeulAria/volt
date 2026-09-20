/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { EventStore } from '../../../common/harness/eventStore.js';

suite('Volt event store', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('drops live deltas and reduces a durable log', () => {
		const store = new EventStore();
		const base = { runId: 'r1', sessionId: 's1', timestamp: 1 };
		assert.strictEqual(store.append({ ...base, event: { type: 'text.delta', id: 't', delta: 'hi' } }), undefined);
		store.append({ ...base, timestamp: 2, event: { type: 'run.start', runId: 'r1', mode: 'agent' } });
		store.append({ ...base, timestamp: 3, event: { type: 'lane', lane: 'agent', signals: ['coding-verb'], wantsPreview: false, wantsWeb: false } });
		store.append({ ...base, timestamp: 4, event: { type: 'lifecycle', phase: 'running' } });
		store.append({ ...base, timestamp: 5, event: { type: 'tool.start', callId: 'c1', name: 'read_file' } });
		store.append({ ...base, timestamp: 6, event: { type: 'tool.end', callId: 'c1', result: 'ok' } });
		store.append({ ...base, timestamp: 7, event: { type: 'file.change', uri: URI.file('/tmp/a.ts'), kind: 'edit' } });
		store.append({ ...base, timestamp: 8, event: { type: 'run.end', runId: 'r1', reason: 'done' } });

		const projection = store.project('r1');
		assert.ok(projection);
		assert.strictEqual(projection.lane, 'agent');
		assert.strictEqual(projection.phase, 'completed');
		assert.strictEqual(projection.tools[0]?.done, true);
		assert.ok(projection.files.some(file => file.kind === 'edit'));
		assert.strictEqual(projection.reason, 'done');
		assert.ok(store.all('r1').every(item => item.event.type !== 'text.delta'));
	});
});
