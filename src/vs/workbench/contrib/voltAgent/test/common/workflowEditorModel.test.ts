/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IWorkflowDefinition } from '../../../../services/voltRuntime/common/workflows/workflowTypes.js';
import { edgeId, uniqueNodeId, WorkflowEditorModel } from '../../common/workflows/workflowEditorModel.js';

function blank(): IWorkflowDefinition {
	return {
		version: 1,
		id: 'wf',
		name: 'Test',
		trigger: { type: 'manual' },
		nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} }],
		edges: [],
	};
}

suite('Volt workflow editor model', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function model(definition = blank(), clock?: () => number): WorkflowEditorModel {
		return store.add(new WorkflowEditorModel(definition, clock));
	}

	test('adds a node connected from a port, selects it, and undo/redo restore both states', () => {
		const m = model();
		const id = m.addNode('agent', { x: 280.4, y: 0 }, { connectFrom: { nodeId: 'start', port: 'next' } });
		assert.strictEqual(id, 'agent');
		assert.deepStrictEqual(m.selection, ['agent']);
		assert.deepStrictEqual(m.node('agent')?.position, { x: 280, y: 0 });
		assert.strictEqual(m.node('agent')?.config.prompt, '{{ inputs.task }}', 'field defaults fill the config');
		assert.deepStrictEqual(m.definition.edges.map(edge => edge.id), [edgeId('start', 'next', 'agent')]);
		assert.ok(m.dirty);
		m.undo();
		assert.strictEqual(m.definition.nodes.length, 1);
		assert.deepStrictEqual(m.selection, [], 'selection drops nodes that are gone');
		assert.ok(!m.dirty);
		m.redo();
		assert.strictEqual(m.definition.nodes.length, 2);
		assert.strictEqual(m.definition.edges.length, 1);
	});

	test('a drag with one coalesce key is one undo step; a pause starts a new one', () => {
		let now = 0;
		const m = model(blank(), () => now);
		m.addNode('agent', { x: 100, y: 0 });
		for (let x = 110; x <= 200; x += 10) {
			now += 16;
			m.moveNodes([{ id: 'agent', position: { x, y: 0 } }], 'drag-1');
		}
		assert.deepStrictEqual(m.node('agent')?.position, { x: 200, y: 0 });
		m.undo();
		assert.deepStrictEqual(m.node('agent')?.position, { x: 100, y: 0 }, 'the whole drag undoes at once');
		m.redo();
		now += 5000;
		m.moveNodes([{ id: 'agent', position: { x: 300, y: 0 } }], 'drag-1');
		m.undo();
		assert.deepStrictEqual(m.node('agent')?.position, { x: 200, y: 0 }, 'a late move with the same key is its own step');
	});

	test('connect refuses self-loops and dedupes; disconnect removes', () => {
		const m = model();
		m.addNode('agent', { x: 280, y: 0 });
		assert.strictEqual(m.connect('agent', 'done', 'agent'), undefined);
		const first = m.connect('start', 'next', 'agent');
		const again = m.connect('start', 'next', 'agent');
		assert.strictEqual(first, again);
		assert.strictEqual(m.definition.edges.length, 1);
		m.disconnect([first!]);
		assert.strictEqual(m.definition.edges.length, 0);
	});

	test('inserting into an edge rewires from → new → to', () => {
		const m = model();
		m.addNode('end', { x: 560, y: 0 });
		const edge = m.connect('start', 'next', 'end')!;
		const id = m.addNode('agent', { x: 280, y: 0 }, { splitEdgeId: edge });
		assert.deepStrictEqual(m.definition.edges.map(entry => entry.id).sort(), [edgeId(id, 'done', 'end'), edgeId('start', 'next', id)].sort(), 'the new node leaves through its first port');
	});

	test('paste remaps taken ids, keeps inner edges only, and skips a second start', () => {
		const m = model();
		m.addNode('agent', { x: 280, y: 0 }, { connectFrom: { nodeId: 'start', port: 'next' } });
		const copied = m.definition.nodes;
		const ids = m.insertNodes(copied, m.definition.edges, { x: 40, y: 40 });
		assert.deepStrictEqual(ids, ['agent_2']);
		assert.deepStrictEqual(m.node('agent_2')?.position, { x: 320, y: 40 });
		assert.strictEqual(m.definition.edges.length, 1, 'the start → agent edge needs the skipped start, so it is not pasted');
		assert.deepStrictEqual(m.selection, ['agent_2']);
	});

	test('removing a verdict prunes the edges that left through it', () => {
		const m = model();
		m.addNode('agent', { x: 280, y: 0 }, { config: { verdicts: ['approve', 'changes'] } });
		m.addNode('end', { x: 560, y: 0 });
		m.connect('agent', 'approve', 'end');
		m.connect('agent', 'done', 'end');
		m.setNodeConfig('agent', 'verdicts', ['changes']);
		assert.deepStrictEqual(m.definition.edges.map(edge => edge.port), ['done']);
	});

	test('renaming an id rewires edges, groups and the selection; taken or invalid ids are refused', () => {
		const m = model();
		m.addNode('agent', { x: 280, y: 0 }, { connectFrom: { nodeId: 'start', port: 'next' } });
		m.groupNodes(['agent'], 'Work');
		assert.ok(!m.renameNodeId('agent', 'start'));
		assert.ok(!m.renameNodeId('agent', 'Bad Id'));
		assert.ok(m.renameNodeId('agent', 'reviewer'));
		assert.deepStrictEqual(m.definition.edges.map(edge => edge.id), [edgeId('start', 'next', 'reviewer')]);
		assert.deepStrictEqual(m.definition.groups?.[0].nodes, ['reviewer']);
		assert.deepStrictEqual(m.selection, ['reviewer']);
	});

	test('the only start node cannot be deleted; deleting nodes drops their edges and empty groups', () => {
		const m = model();
		m.addNode('agent', { x: 280, y: 0 }, { connectFrom: { nodeId: 'start', port: 'next' } });
		m.groupNodes(['agent']);
		m.removeNodes(['start', 'agent']);
		assert.deepStrictEqual(m.definition.nodes.map(node => node.id), ['start']);
		assert.deepStrictEqual(m.definition.edges, []);
		assert.deepStrictEqual(m.definition.groups, []);
	});

	test('markSaved makes the current state clean without an undo step; unique ids skip taken ones', () => {
		const m = model();
		m.addNode('agent', { x: 280, y: 0 });
		const saved = { ...m.definition, revision: 2 };
		m.markSaved(saved);
		assert.ok(!m.dirty);
		assert.strictEqual(m.definition.revision, 2);
		assert.ok(m.canUndo, 'history is kept across saves');
		assert.strictEqual(uniqueNodeId(m.definition, 'agent'), 'agent_2');
		assert.strictEqual(uniqueNodeId(m.definition, '9 Lives!'), 'lives_');
	});
});
