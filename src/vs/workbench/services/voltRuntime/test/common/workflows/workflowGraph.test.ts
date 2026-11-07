/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { WORKFLOW_DEFAULT_NODE_SIZE, autoLayout, downstreamNodes, hasErrors, incomingEdges, loopBody, outgoingEdges, topologicalOrder, upstreamNodes, validateWorkflow, workflowBackEdges } from '../../../common/workflows/workflowGraph.js';
import { IWorkflowDefinition, IWorkflowEdge, IWorkflowIssue, IWorkflowNode, IWorkflowPosition, WorkflowRecord } from '../../../common/workflows/workflowTypes.js';

type NodeSpec = [id: string, type: string, config?: WorkflowRecord, extra?: Partial<IWorkflowNode>];

/** Edges as `from.port->to`. */
function workflow(nodes: readonly NodeSpec[], edges: readonly string[], extra: Partial<IWorkflowDefinition> = {}): IWorkflowDefinition {
	return {
		version: 1, id: 'wf', name: 'WF', trigger: { type: 'manual' },
		inputs: [{ name: 'task', type: 'string' }],
		nodes: nodes.map(([id, type, config, more]) => ({ id, type, position: { x: 0, y: 0 }, config: config ?? {}, ...more })),
		edges: edges.map((spec): IWorkflowEdge => {
			const match = /^([^.]+)\.(.+)->(.+)$/.exec(spec)!;
			return { id: spec, from: match[1], port: match[2], to: match[3] };
		}),
		...extra,
	};
}

function codes(issues: readonly IWorkflowIssue[], severity?: string): string[] {
	return issues.filter(issue => !severity || issue.severity === severity).map(issue => issue.code);
}

const linear = workflow(
	[['start', 'start'], ['work', 'agent', { prompt: 'Do {{ inputs.task }}' }], ['check', 'shell', { command: 'npm test' }], ['done', 'end', { output: '{{ nodes.work.summary }}' }]],
	['start.next->work', 'work.done->check', 'check.passed->done'],
);

suite('Volt workflow graph', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a valid workflow has no errors; unwired ports are info', () => {
		const issues = validateWorkflow(linear);
		assert.deepStrictEqual(codes(issues, 'error'), []);
		assert.deepStrictEqual(codes(issues, 'warning'), []);
		assert.deepStrictEqual(issues.filter(issue => issue.code === 'unwired-port').map(issue => `${issue.nodeId}:${issue.path}`), ['work:nodes[1].outputs.failed', 'check:nodes[2].outputs.failed']);
		assert.match(issues.find(issue => issue.nodeId === 'check')!.message, /the run fails/);
		assert.ok(!hasErrors(issues));
	});

	test('structure: start, ids, types, singletons', () => {
		assert.deepStrictEqual(codes(validateWorkflow(workflow([['a', 'log', { message: 'x' }]], [])), 'error'), ['no-start']);
		assert.ok(codes(validateWorkflow(workflow([['s1', 'start'], ['s2', 'start']], []))).includes('multiple-start'));
		const ids = validateWorkflow(workflow([['start', 'start'], ['Bad Id', 'log', { message: 'x' }], ['dup', 'log', { message: 'x' }], ['dup', 'log', { message: 'y' }], ['odd', 'teleport']], ['start.next->dup']));
		assert.deepStrictEqual(codes(ids, 'error').sort(), ['duplicate-id', 'invalid-id', 'unknown-node-type']);
		assert.ok(hasErrors(ids));
	});

	test('edges must join real nodes and ports', () => {
		const issues = validateWorkflow(workflow(
			[['start', 'start'], ['a', 'log', { message: 'x' }], ['b', 'if', { condition: 'true' }]],
			['start.next->a', 'a.nope->b', 'a.next->ghost', 'b.true->start', 'start.next->a'],
		));
		assert.deepStrictEqual(codes(issues, 'error').sort(), ['duplicate-edge-id', 'edge-unknown-input', 'edge-unknown-node', 'edge-unknown-port']);
		const twice = validateWorkflow({ ...linear, edges: [...linear.edges, { id: 'again', from: 'start', port: 'next', to: 'work' }] });
		assert.deepStrictEqual(codes(twice, 'warning'), ['duplicate-edge']);
	});

	test('fields: required, kinds, ranges, options, expressions; disabled nodes only warn', () => {
		const issues = validateWorkflow(workflow([
			['start', 'start'],
			['a', 'agent', { prompt: '' }],
			['b', 'shell', {}],
			['c', 'loop', { max: 'three', while: 'nodes.a.summary ==' }],
			['d', 'fork', { branches: 9 }],
			['e', 'http', { url: 'https://x.dev', method: 'FETCH', timeout: 'a while' }],
			['f', 'agent', { prompt: '' }, { disabled: true }],
			['g', 'loop', { max: '{{ inputs.n }}' }],
		], ['start.next->a', 'a.done->b', 'b.passed->c', 'c.repeat->d', 'd.branch1->e', 'e.success->f', 'f.done->g']));
		const byNode = (nodeId: string) => issues.filter(issue => issue.nodeId === nodeId && issue.severity !== 'info').map(issue => `${issue.severity}:${issue.code}:${issue.field}`);
		assert.deepStrictEqual(byNode('a'), ['error:required-field:prompt']);
		assert.deepStrictEqual(byNode('b'), ['error:required-field:command']);
		assert.deepStrictEqual(byNode('c'), ['error:field-type:max', 'error:expression-syntax:while']);
		assert.deepStrictEqual(byNode('d'), ['error:field-range:branches']);
		assert.deepStrictEqual(byNode('e'), ['error:field-type:method', 'error:field-type:timeout']);
		assert.deepStrictEqual(byNode('f'), ['warning:required-field:prompt']);
		assert.deepStrictEqual(byNode('g').filter(entry => entry.startsWith('error')), [], 'templates fit any kind');
		assert.match(issues.find(issue => issue.code === 'expression-syntax')!.message, /Expected a value \(at 19\)/);
	});

	test('template references: unknown nodes, nodes that run later, names, inputs, loop outside a loop', () => {
		const issues = validateWorkflow(workflow([
			['start', 'start'],
			['a', 'agent', { prompt: '{{ nodes.ghost.summary }} {{ nodes.b.summary }} {{ nodes.start.payload }} {{ inputs.missing }} {{ secrets.x }} {{ item }}' }],
			['b', 'agent', { prompt: '{{ nodes.a.summary }} {{ {{ }}' }],
			['c', 'if', { condition: 'nodes.b.verdict == \'ok\' && nodes.zzz.x' }],
		], ['start.next->a', 'a.done->b', 'b.done->c']));
		const seen = issues.filter(issue => issue.code.startsWith('template') || issue.code === 'expression-syntax').map(issue => `${issue.nodeId}:${issue.severity}:${issue.code}`);
		assert.deepStrictEqual(seen, [
			'a:warning:template-unknown-node',
			'a:warning:template-not-upstream',
			'a:info:template-unknown-input',
			'a:warning:template-unknown-name',
			'a:info:template-outside-loop',
			'b:error:template-syntax',
			'c:warning:template-unknown-node',
		]);
	});

	test('cycles must pass through a loop node', () => {
		const bad = validateWorkflow(workflow(
			[['start', 'start'], ['a', 'log', { message: 'x' }], ['b', 'log', { message: 'y' }]],
			['start.next->a', 'a.next->b', 'b.next->a'],
		));
		assert.deepStrictEqual(codes(bad, 'error'), ['cycle']);
		const good = workflow(
			[['start', 'start'], ['loop', 'loop', { max: 3 }], ['fix', 'agent', { prompt: 'fix' }], ['check', 'shell', { command: 'npm test' }], ['ok', 'end'], ['ko', 'end', { status: 'failure' }]],
			['start.next->loop', 'loop.repeat->fix', 'fix.done->check', 'check.failed->loop', 'check.passed->ok', 'loop.exhausted->ko'],
		);
		assert.deepStrictEqual(codes(validateWorkflow(good), 'error'), []);
		assert.deepStrictEqual([...workflowBackEdges(good)], ['check.failed->loop']);
		assert.deepStrictEqual([...loopBody(good, 'loop', 'repeat')].sort(), ['check', 'fix', 'ok']);
		assert.deepStrictEqual(topologicalOrder(good), ['start', 'loop', 'fix', 'check', 'ok', 'ko']);
	});

	test('reachability, joins, loops and for-each bodies', () => {
		const issues = validateWorkflow(workflow([
			['start', 'start'],
			['each', 'for_each', { items: '{{ inputs.list }}' }],
			['work', 'agent', { prompt: 'x {{ item }}' }],
			['stop', 'end'],
			['after', 'log', { message: 'done' }],
			['join', 'join'],
			['empty', 'for_each', { items: [] }],
			['spin', 'loop', { max: 2 }],
			['island', 'log', { message: 'alone' }],
		], ['start.next->each', 'each.item->work', 'work.done->stop', 'work.failed->after', 'each.done->after', 'after.next->join', 'join.next->empty', 'empty.done->spin']));
		assert.deepStrictEqual(codes(issues, 'warning').sort(), ['for-each-empty-body', 'for-each-end-in-body', 'for-each-shared-body', 'loop-no-body', 'unreachable']);
		assert.ok(codes(issues, 'info').includes('join-single-input'));
		assert.ok(!codes(issues).includes('template-outside-loop'), 'item is set inside the body');
	});

	test('settings and inputs', () => {
		const issues = validateWorkflow({ ...linear, inputs: [{ name: 'task', type: 'string' }, { name: 'task', type: 'string' }, { name: '1bad', type: 'string' }], settings: { concurrency: 0, maxSteps: 5000, timeoutMs: -1 } });
		assert.deepStrictEqual(issues.filter(issue => issue.path?.startsWith('settings') || issue.path?.startsWith('inputs')).map(issue => `${issue.severity}:${issue.code}`), [
			'error:duplicate-input', 'error:invalid-input', 'error:settings-range', 'warning:settings-range', 'error:settings-range',
		]);
	});

	test('traversal helpers', () => {
		assert.deepStrictEqual(outgoingEdges(linear, 'work').map(edge => edge.id), ['work.done->check']);
		assert.deepStrictEqual(outgoingEdges(linear, 'work', 'failed'), []);
		assert.deepStrictEqual(incomingEdges(linear, 'done').map(edge => edge.from), ['check']);
		assert.deepStrictEqual(upstreamNodes(linear, 'done'), ['check', 'work', 'start']);
		assert.deepStrictEqual(downstreamNodes(linear, 'work'), ['check', 'done']);
		assert.deepStrictEqual(topologicalOrder(linear), ['start', 'work', 'check', 'done']);
	});

	test('autoLayout: left to right, no overlaps, port order, deterministic, anchored', () => {
		const branching = workflow([
			['start', 'start', {}, { position: { x: 40, y: 80 } }],
			['gate', 'if', { condition: 'true' }],
			['yes', 'agent', { prompt: 'a' }],
			['no', 'agent', { prompt: 'b' }],
			['fork', 'fork', { branches: 3 }],
			['p1', 'shell', { command: '1' }],
			['p2', 'shell', { command: '2' }],
			['p3', 'shell', { command: '3' }],
			['join', 'join'],
			['loop', 'loop', { max: 2 }],
			['body', 'agent', { prompt: 'c' }],
			['end', 'end'],
			['loose', 'log', { message: 'not connected' }],
		], [
			'start.next->gate', 'gate.true->yes', 'gate.false->no', 'yes.done->fork', 'no.done->join',
			'fork.branch1->p1', 'fork.branch2->p2', 'fork.branch3->p3', 'p1.passed->join', 'p2.passed->join', 'p3.passed->join',
			'join.next->loop', 'loop.repeat->body', 'body.done->loop', 'loop.exhausted->end', 'start.next->end',
		]);
		const sizes = new Map([['yes', { width: 320, height: 140 }]]);
		const positions = autoLayout(branching, { sizes, layerGap: 80, nodeGap: 30 });
		const size = (id: string) => sizes.get(id) ?? (id === 'end' ? { width: 160, height: 56 } : WORKFLOW_DEFAULT_NODE_SIZE);
		const rect = (id: string) => ({ ...positions.get(id)!, ...size(id) });
		const ids = branching.nodes.map(node => node.id);
		for (let i = 0; i < ids.length; i++) {
			for (let j = i + 1; j < ids.length; j++) {
				const a = rect(ids[i]);
				const b = rect(ids[j]);
				const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
				assert.ok(!overlap, `${ids[i]} and ${ids[j]} overlap: ${JSON.stringify(a)} ${JSON.stringify(b)}`);
			}
		}
		const back = workflowBackEdges(branching);
		for (const edge of branching.edges) {
			if (!back.has(edge.id)) {
				assert.ok(positions.get(edge.from)!.x < positions.get(edge.to)!.x, `${edge.id} runs left to right`);
			}
		}
		assert.ok(positions.get('body')!.x > positions.get('loop')!.x, 'a loop body sits right of its loop');
		assert.ok(positions.get('yes')!.y < positions.get('no')!.y, 'the first port\'s branch is on top');
		assert.ok(positions.get('p1')!.y < positions.get('p2')!.y && positions.get('p2')!.y < positions.get('p3')!.y, 'fork branches in port order');
		assert.deepStrictEqual(positions.get('start'), { x: 40, y: 80 }, 'the start node stays put');
		assert.deepStrictEqual([...autoLayout(branching, { sizes, layerGap: 80, nodeGap: 30 })], [...positions], 'deterministic');

		const snapped = autoLayout(branching, { snap: 16 });
		for (const position of snapped.values()) {
			assert.strictEqual(position.x % 16, 0);
			assert.strictEqual(Math.abs(position.y % 16), 0);
		}
	});

	test('autoLayout of a selection keeps the rest in place', () => {
		const definition = workflow([
			['start', 'start', {}, { position: { x: 0, y: 0 } }],
			['a', 'log', { message: 'a' }, { position: { x: 500, y: 500 } }],
			['b', 'log', { message: 'b' }, { position: { x: 500, y: 520 } }],
			['c', 'log', { message: 'c' }, { position: { x: 900, y: 900 } }],
		], ['start.next->a', 'a.next->b', 'b.next->c']);
		const positions = autoLayout(definition, { only: new Set(['a', 'b']) });
		assert.deepStrictEqual(positions.get('start'), { x: 0, y: 0 });
		assert.deepStrictEqual(positions.get('c'), { x: 900, y: 900 });
		assert.deepStrictEqual(positions.get('a'), { x: 500, y: 500 }, 'the selection keeps its top-left corner');
		const b: IWorkflowPosition = positions.get('b')!;
		assert.ok(b.x >= 500 + WORKFLOW_DEFAULT_NODE_SIZE.width, 'b is laid out after a');
		assert.strictEqual(autoLayout(workflow([], [])).size, 0);
	});
});
