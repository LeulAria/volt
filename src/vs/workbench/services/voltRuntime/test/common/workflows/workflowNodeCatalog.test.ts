/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { WORKFLOW_NODE_TYPES, formatWorkflowDuration, keyValueRecord, parseWorkflowDuration, workflowItemsList } from '../../../common/workflows/workflowNodeCatalog.js';
import { defaultNodeConfig, getWorkflowNodeType } from '../../../common/workflows/workflowNodes.js';
import { IWorkflowDefinition, IWorkflowNode, IWorkflowNodeContext, IWorkflowNodeResult, IWorkflowNodeType, WORKFLOW_NODE_CATEGORIES, WorkflowLogLevel, WorkflowRecord } from '../../../common/workflows/workflowTypes.js';

/** Every type id with its output ports for the default config (the names other workstreams code against). */
const PORTS: { readonly [type: string]: readonly string[] } = {
	start: ['next'],
	agent: ['done', 'failed'],
	ask_user: ['answered', 'timeout'],
	subtask: ['done', 'failed'],
	classify: ['other'],
	summarize: ['done', 'failed'],
	end: [],
	if: ['true', 'false'],
	switch: ['default'],
	loop: ['exhausted', 'repeat'],
	for_each: ['item', 'done'],
	fork: ['branch1', 'branch2'],
	join: ['next'],
	wait: ['next'],
	approval: ['approved', 'rejected'],
	subworkflow: ['done', 'failed'],
	set_variables: ['next'],
	shell: ['passed', 'failed'],
	http: ['success', 'fail'],
	webhook: ['sent', 'failed'],
	git_commit: ['committed', 'nothing', 'failed'],
	git_push: ['pushed', 'failed'],
	git_sync: ['synced', 'conflict'],
	git_branch: ['created', 'failed'],
	github_pr: ['opened', 'failed'],
	github_wait_ci: ['passed', 'failed', 'timeout'],
	github_pr_comment: ['done', 'failed'],
	github_update_pr: ['done', 'failed'],
	github_issue_comment: ['done', 'failed'],
	mcp_tool: ['done', 'failed'],
	skill: ['done', 'failed'],
	slack_message: ['sent', 'failed'],
	teams_message: ['sent', 'failed'],
	transform: ['next'],
	filter: ['next', 'empty'],
	parse_json: ['parsed', 'invalid'],
	template: ['next'],
	notify: ['next'],
	log: ['next'],
	write_file: ['written', 'failed'],
	package_script: ['passed', 'failed'],
};

const CATEGORY: { readonly [type: string]: string } = {
	start: 'trigger', agent: 'ai', ask_user: 'ai', subtask: 'ai', classify: 'ai', summarize: 'ai',
	end: 'flow', if: 'flow', switch: 'flow', loop: 'flow', for_each: 'flow', fork: 'flow', join: 'flow', wait: 'flow', approval: 'flow', subworkflow: 'flow', set_variables: 'flow',
	shell: 'scripts', http: 'scripts', webhook: 'scripts', mcp_tool: 'mcp', skill: 'skills', slack_message: 'integrations', teams_message: 'integrations',
	transform: 'data', filter: 'data', parse_json: 'data', template: 'data', notify: 'outputs', log: 'outputs', write_file: 'outputs', package_script: 'custom',
};

function context(type: IWorkflowNodeType, config: WorkflowRecord, logs: [WorkflowLogLevel, string][] = []): IWorkflowNodeContext {
	const node: IWorkflowNode = { id: 'n', type: type.type, position: { x: 0, y: 0 }, config };
	const workflow: IWorkflowDefinition = { version: 1, id: 'wf', name: 'WF', trigger: { type: 'manual' }, nodes: [node], edges: [] };
	return {
		runId: 'r', mode: 'simulate', workflow, node, type, config: { ...defaultNodeConfig(type), ...config }, input: null,
		scope: { inputs: {}, trigger: null, nodes: {}, vars: { min: 2 }, run: { id: 'r', mode: 'simulate', workflowId: 'wf' } },
		attempt: 1, stepId: 'n#1', token: CancellationToken.None,
		log: (level, message) => logs.push([level, message]), setVariable: () => { }, reportTokens: () => { }, reportThread: () => { },
		waiting: () => ({ dispose: () => { } }),
	};
}

async function simulate(typeId: string, config: WorkflowRecord, logs?: [WorkflowLogLevel, string][]): Promise<IWorkflowNodeResult> {
	const type = getWorkflowNodeType(typeId)!;
	return type.simulate!(context(type, config, logs));
}

function validate(typeId: string, config: WorkflowRecord) {
	const type = getWorkflowNodeType(typeId)!;
	const node: IWorkflowNode = { id: 'n', type: typeId, position: { x: 0, y: 0 }, config };
	return type.validate?.(node, { version: 1, id: 'wf', name: 'WF', trigger: { type: 'manual' }, nodes: [node], edges: [] }) ?? [];
}

suite('Volt workflow node catalog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('every node type with the agreed ids, categories and ports', () => {
		assert.deepStrictEqual(WORKFLOW_NODE_TYPES.map(type => type.type).sort(), Object.keys(PORTS).sort());
		for (const type of WORKFLOW_NODE_TYPES) {
			assert.deepStrictEqual(type.outputs(defaultNodeConfig(type)).map(port => port.id), PORTS[type.type], `ports of ${type.type}`);
			assert.strictEqual(type.category, CATEGORY[type.type] ?? 'git', `category of ${type.type}`);
		}
		assert.deepStrictEqual(getWorkflowNodeType('agent')!.outputs({ verdicts: ['approve', 'changes'] }).map(port => port.id), ['approve', 'changes', 'done', 'failed']);
		assert.deepStrictEqual(getWorkflowNodeType('classify')!.outputs({ categories: ['bug', 'feature'] }).map(port => port.id), ['bug', 'feature', 'other']);
		assert.deepStrictEqual(getWorkflowNodeType('switch')!.outputs({ cases: ['a', ' b '] }).map(port => port.id), ['a', 'b', 'default']);
		assert.deepStrictEqual(getWorkflowNodeType('fork')!.outputs({ branches: 4 }).map(port => port.id), ['branch1', 'branch2', 'branch3', 'branch4']);
		assert.deepStrictEqual(getWorkflowNodeType('fork')!.outputs({ branches: 9 }).length, 4);
	});

	test('descriptors are complete: labels, sentences, icons, fields, groups, permissions, pure flags', () => {
		const categories = new Set(WORKFLOW_NODE_CATEGORIES.map(category => category.id));
		for (const type of WORKFLOW_NODE_TYPES) {
			assert.ok(categories.has(type.category), type.type);
			assert.ok(type.label && type.icon && /^[a-z-]+$/.test(type.icon), `${type.type} label/icon`);
			assert.match(type.description, /^[A-Z].*\.$/, `${type.type} description is one sentence`);
			assert.ok(type.keywords, `${type.type} keywords`);
			const keys = type.fields.map(field => field.key);
			assert.strictEqual(new Set(keys).size, keys.length, `${type.type} field keys are unique`);
			for (const field of type.fields) {
				if (field.kind === 'select') {
					assert.ok(field.options?.length, `${type.type}.${field.key} has options`);
					assert.ok(field.default === undefined || field.options!.some(option => option.value === field.default), `${type.type}.${field.key} default is an option`);
				}
				if (field.visibleWhen) {
					assert.ok(keys.includes(field.visibleWhen.key), `${type.type}.${field.key} visibleWhen refers to a field`);
				}
			}
			const ports = type.outputs(defaultNodeConfig(type)).map(port => port.id);
			assert.strictEqual(new Set(ports).size, ports.length, `${type.type} port ids are unique`);
			if (type.control === 'task') {
				assert.ok(type.simulate, `${type.type} simulates`);
			}
			assert.strictEqual(!!type.pure, ['transform', 'filter', 'parse_json', 'template', 'log'].includes(type.type), `${type.type} pure`);
		}
		const groups = Object.fromEntries(WORKFLOW_NODE_TYPES.filter(type => type.group).map(type => [type.type, type.group]));
		assert.strictEqual(groups.git_commit, 'Git');
		assert.strictEqual(groups.github_pr, 'GitHub');
		assert.strictEqual(groups.slack_message, 'Slack');
		assert.strictEqual(groups.teams_message, 'Microsoft Teams');
		const permissions = (id: string) => [...getWorkflowNodeType(id)!.permissions].sort();
		assert.deepStrictEqual(permissions('agent'), ['agent']);
		assert.deepStrictEqual(permissions('shell'), ['shell']);
		assert.deepStrictEqual(permissions('package_script'), ['shell']);
		assert.deepStrictEqual(permissions('http'), ['network']);
		assert.deepStrictEqual(permissions('webhook'), ['network']);
		assert.deepStrictEqual(permissions('git_commit'), ['git']);
		assert.deepStrictEqual(permissions('github_pr'), ['git', 'network']);
		assert.deepStrictEqual(permissions('slack_message'), ['messaging', 'network']);
		assert.deepStrictEqual(permissions('write_file'), ['filesystem']);
		assert.deepStrictEqual(permissions('if'), []);
		assert.ok(getWorkflowNodeType('start')!.singleton);
	});

	test('summaries', () => {
		const summary = (id: string, config: WorkflowRecord) => getWorkflowNodeType(id)!.summary?.(config);
		assert.strictEqual(summary('agent', { model: 'claude', skill: 'review' }), 'claude · /review');
		assert.strictEqual(summary('agent', { model: 'agent:seed-grok:grok-4.7' }), 'grok-4.7');
		assert.strictEqual(summary('http', { method: 'GET', url: 'https://api.example.com/items?x=1' }), 'GET api.example.com');
		assert.strictEqual(summary('shell', { command: 'npm test\nnpm run lint' }), 'npm test');
		assert.strictEqual(summary('loop', { max: 5, while: 'nodes.check.exitCode != 0' }), 'up to 5× · nodes.check.exitCode != 0');
		assert.strictEqual(summary('for_each', { items: '{{ nodes.find.files }}', maxItems: 50 }), 'nodes.find.files');
		assert.strictEqual(summary('wait', { duration: '90s' }), '1m 30s');
		assert.strictEqual(summary('github_issue_comment', { issue: '42' }), '#42');
		assert.strictEqual(summary('join', { mode: 'any' }), 'first branch');
		assert.strictEqual(summary('end', { status: 'failure' }), 'fails');
		assert.strictEqual(summary('mcp_tool', { server: 'linear', tool: 'create_issue' }), 'linear · create_issue');
		assert.strictEqual(summary('set_variables', { variables: { a: 1, b: 2 } }), 'a, b');
		assert.ok(summary('shell', { command: 'x'.repeat(100) })!.endsWith('…'));
	});

	test('durations, key-value fields and item lists', () => {
		assert.strictEqual(parseWorkflowDuration('5m'), 300_000);
		assert.strictEqual(parseWorkflowDuration('30s'), 30_000);
		assert.strictEqual(parseWorkflowDuration('1h30m'), 5_400_000);
		assert.strictEqual(parseWorkflowDuration('1h 30m'), 5_400_000);
		assert.strictEqual(parseWorkflowDuration('500ms'), 500);
		assert.strictEqual(parseWorkflowDuration('2d'), 172_800_000);
		assert.strictEqual(parseWorkflowDuration(90), 90_000, 'a bare number is seconds');
		assert.strictEqual(parseWorkflowDuration('1.5s'), 1500);
		assert.strictEqual(parseWorkflowDuration('soon'), undefined);
		assert.strictEqual(parseWorkflowDuration('5 minutes'), undefined);
		assert.strictEqual(parseWorkflowDuration(-1), undefined);
		assert.strictEqual(formatWorkflowDuration(500), '500ms');
		assert.strictEqual(formatWorkflowDuration(3_723_000), '1h 2m');
		assert.deepStrictEqual(keyValueRecord({ a: 1 }), { a: 1 });
		assert.deepStrictEqual(keyValueRecord([{ key: 'a', value: 'x' }, 'b=2', 'c: three', 'junk']), { a: 'x', b: '2', c: 'three' });
		assert.deepStrictEqual(keyValueRecord(null), {});
		assert.deepStrictEqual(workflowItemsList([1, 2]), [1, 2]);
		assert.deepStrictEqual(workflowItemsList('["a", "b"]'), ['a', 'b']);
		assert.deepStrictEqual(workflowItemsList('src/a.ts\n\n  src/b.ts  \n'), ['src/a.ts', 'src/b.ts']);
		assert.deepStrictEqual(workflowItemsList(null), []);
		assert.strictEqual(workflowItemsList({ a: 1 }), undefined);
		assert.strictEqual(workflowItemsList(3), undefined);
	});

	test('pure nodes behave the same in simulations and real runs', async () => {
		assert.deepStrictEqual(await simulate('transform', { fields: { title: 'T', n: 3 } }), { output: { title: 'T', n: 3 } });
		assert.deepStrictEqual(await simulate('transform', { fields: ['a=1'] }), { output: { a: '1' } });
		assert.deepStrictEqual(await simulate('filter', { items: [1, 2, 3, 4], condition: 'item >= vars.min && loop.index < 3' }), { output: { items: [2, 3], count: 2, removed: 2 }, port: 'next' });
		assert.deepStrictEqual(await simulate('filter', { items: [{ state: 'closed' }], condition: 'item.state == \'open\'' }), { output: { items: [], count: 0, removed: 1 }, port: 'empty' });
		await assert.rejects(Promise.resolve().then(() => simulate('filter', { items: { a: 1 }, condition: 'true' })), /Items must be a list/);
		assert.deepStrictEqual(await simulate('parse_json', { text: '```json\n{"ok": true}\n```' }), { output: { value: { ok: true } }, port: 'parsed' });
		assert.deepStrictEqual(await simulate('parse_json', { text: { already: 'parsed' } }), { output: { value: { already: 'parsed' } }, port: 'parsed' });
		const invalid = await simulate('parse_json', { text: 'not json' });
		assert.strictEqual(invalid.port, 'invalid');
		assert.ok((invalid.output as WorkflowRecord).error);
		assert.deepStrictEqual(await simulate('template', { text: 'Hello' }), { output: { text: 'Hello' } });
		assert.deepStrictEqual(await simulate('template', { text: { a: 1 } }), { output: { text: '{"a":1}' } });
		const logs: [WorkflowLogLevel, string][] = [];
		assert.deepStrictEqual(await simulate('log', { message: 'hi', level: 'warn' }, logs), { output: { message: 'hi', level: 'warn' } });
		assert.deepStrictEqual(logs, [['warn', 'hi']]);
	});

	test('simulated task nodes give realistic results through a real port, with no side effects', async () => {
		for (const type of WORKFLOW_NODE_TYPES.filter(candidate => candidate.control === 'task')) {
			const config = { ...defaultNodeConfig(type), prompt: 'Fix the bug', command: 'npm test', url: 'https://example.com/x', text: '{"a":1}', message: 'm', title: 't', categories: ['bug'], items: [1], condition: 'true', fields: { a: 1 }, path: 'out.md', content: 'c', script: 'test', skill: 'review', server: 's', tool: 't', webhookUrl: 'https://hooks.slack.com/x', body: 'b', issue: '1', name: 'b' };
			const result = await type.simulate!(context(type, config));
			const ports = type.outputs(config).map(port => port.id);
			assert.ok(result.port === undefined || ports.includes(result.port), `${type.type} leaves through one of its ports (${result.port})`);
			assert.ok(result.output !== undefined, `${type.type} has an output`);
		}
		const agent = await simulate('agent', { prompt: 'Review the PR', verdicts: ['approve', 'changes'] });
		assert.strictEqual(agent.port, 'approve');
		assert.strictEqual((agent.output as WorkflowRecord).verdict, 'approve');
		assert.ok(agent.tokens && agent.tokens.input > 0);
		assert.deepStrictEqual(await simulate('agent', { prompt: 'same' }), await simulate('agent', { prompt: 'same' }), 'deterministic');
		assert.strictEqual((await simulate('classify', { text: 'x', categories: ['bug', 'feature'] })).port, 'bug');
		assert.strictEqual(((await simulate('http', { method: 'GET', url: 'https://x.dev', expectStatus: '204' })).output as WorkflowRecord).status, 204);
	});

	test('type-specific validation', () => {
		assert.deepStrictEqual(validate('agent', { verdicts: ['approve', 'done', 'approve', 'needs.work'] }).map(issue => [issue.code, issue.severity]), [['reserved-port', 'error'], ['duplicate-port', 'error'], ['port-name', 'warning']]);
		assert.deepStrictEqual(validate('classify', { categories: ['other'] }).map(issue => issue.code), ['reserved-port']);
		assert.deepStrictEqual(validate('switch', { cases: ['default'] }).map(issue => issue.code), ['reserved-port']);
		assert.deepStrictEqual(validate('http', { url: 'ftp://nope' }).map(issue => issue.code), ['invalid-url']);
		assert.deepStrictEqual(validate('http', { url: '{{ inputs.url }}' }), []);
		assert.deepStrictEqual(validate('slack_message', { webhookUrl: 'http://insecure' }).map(issue => issue.code), ['invalid-url']);
		assert.deepStrictEqual(validate('wait', { duration: 'later' }).map(issue => issue.code), ['invalid-duration']);
		assert.deepStrictEqual(validate('write_file', { path: '../outside.md' }).map(issue => issue.code), ['path-outside']);
		assert.deepStrictEqual(validate('write_file', { path: '/etc/passwd' }).map(issue => issue.code), ['path-outside']);
		assert.deepStrictEqual(validate('write_file', { path: 'reports/x..y.md' }), []);
		assert.deepStrictEqual(validate('subworkflow', { workflow: 'wf' }).map(issue => [issue.code, issue.severity]), [['subworkflow-self', 'warning']]);
	});
});
