/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { workflowNodeTypes } from '../../../common/workflows/workflowNodes.js';
import {
	blankWorkflow, defaultEdgeId, formatWorkflowPath, migrateWorkflowDocument, parseWorkflowYaml, readWorkflowDocument, serializeWorkflow, slugifyWorkflowId,
	WORKFLOW_FILE_HEADER, WORKFLOW_JSON_SCHEMA, WORKFLOW_SCHEMA_NODE_TYPES, workflowToDocument,
} from '../../../common/workflows/workflowSchema.js';
import { BUILT_IN_WORKFLOW_TEMPLATES } from '../../../common/workflows/workflowTemplates.js';
import { IWorkflowDefinition, IWorkflowIssue, WORKFLOW_SCHEMA_VERSION } from '../../../common/workflows/workflowTypes.js';
import { parseYaml } from '../../../common/workflows/workflowYaml.js';

function lines(...text: string[]): string {
	return text.join('\n') + '\n';
}

function parse(text: string): { definition: IWorkflowDefinition; issues: readonly IWorkflowIssue[] } {
	const result = parseWorkflowYaml(text);
	assert.ok(result.definition, `no definition: ${JSON.stringify(result.issues)}`);
	return { definition: result.definition!, issues: result.issues };
}

function issue(issues: readonly IWorkflowIssue[], code: string): IWorkflowIssue {
	const found = issues.find(candidate => candidate.code === code);
	assert.ok(found, `no "${code}" issue in ${JSON.stringify(issues.map(candidate => candidate.code))}`);
	return found!;
}

function errors(issues: readonly IWorkflowIssue[]): IWorkflowIssue[] {
	return issues.filter(candidate => candidate.severity === 'error');
}

/** Node's fs when the suite runs under Node or Bun (the file checks); undefined in a browser. */
function nodeFs(): { readFileSync(path: string, encoding: 'utf8'): string; existsSync(path: string): boolean } | undefined {
	const host = globalThis as { process?: { getBuiltinModule?(id: string): unknown; cwd?(): string } };
	return host.process?.getBuiltinModule?.('fs') as ReturnType<typeof nodeFs>;
}

const MINIMAL = lines(
	'version: 1',
	'name: Implement and check',
	'nodes:',
	'  - id: start',
	'    type: start',
	'    position: [0, 0]',
	'  - id: work',
	'    type: agent',
	'    position: { x: 280, y: 0 }',
	'    config:',
	'      prompt: Do it',
	'  - id: done',
	'    type: end',
	'    position: [560, 0]',
	'edges:',
	'  - from: start',
	'    to: work',
	'  - { from: work.done, to: done }',
);

/** Every field the format has, for the round trip. */
const EVERYTHING: IWorkflowDefinition = {
	version: WORKFLOW_SCHEMA_VERSION,
	id: 'everything',
	name: 'Everything: all of it',
	description: 'Line one\nline two\n',
	revision: 7,
	tags: ['a', 'b c', 'true'],
	trigger: { type: 'event', provider: 'github', event: 'pr.opened', option: 'main', filters: ['payload.action in opened,reopened'], samplePayload: { pull_request: { number: 4, title: 'Fix: it' } } },
	inputs: [
		{ name: 'task', type: 'string', description: 'What to do', default: '', required: true },
		{ name: 'count', type: 'number', default: 3 },
		{ name: 'data', type: 'json', default: { a: [1, null] } },
	],
	variables: { webhook: 'https://hooks.slack.com/x', retries: 2, flags: [true, false], nested: { empty: {} } },
	settings: { concurrency: 2, maxSteps: 50, timeoutMs: 600000, repository: 'file:///repo', modelRef: 'agent:claude:opus' },
	nodes: [
		{ id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
		{
			id: 'work', type: 'agent', name: 'Work', position: { x: 280.5, y: -140 }, color: 'purple', disabled: false, notes: '# not a comment\nsecond: line',
			config: { mode: 'Ask', prompt: '{{ inputs.task }}\n\n  indented\n', verdicts: ['approve', 'changes'], custom: { ['__proto__']: { own: true }, other: 'x' } },
			retry: { attempts: 2, delayMs: 1000, maxDelayMs: 8000 }, timeoutMs: 120000, onError: 'route', pinnedOutput: { summary: 'pinned', n: -0 },
		},
		{ id: 'gate', type: 'approval', position: { x: 560, y: 0 }, config: { title: 'OK?' }, pinnedOutput: null },
		{ id: 'later', type: 'third-party.thing', position: { x: 840, y: 0 }, config: { anything: [1, '2'] } },
		{ id: 'done', type: 'end', position: { x: 1120, y: 0 }, config: { status: 'success' } },
	],
	edges: [
		{ id: 'start.next->work', from: 'start', port: 'next', to: 'work' },
		{ id: 'custom-id', from: 'work', port: 'approve', to: 'gate', label: 'approved: yes' },
		{ id: 'work.changes->work', from: 'work', port: 'changes', to: 'work' },
		{ id: 'gate.approved->later.special', from: 'gate', port: 'approved', to: 'later', toPort: 'special' },
		{ id: 'later.out.with.dots->done', from: 'later', port: 'out.with.dots', to: 'done' },
	],
	groups: [{ id: 'review', title: 'Review', color: 'teal', nodes: ['work', 'gate'] }],
	source: { kind: 'community', url: 'https://raw.githubusercontent.com/o/r/main/x.yaml', sha: 'abc123', templateId: 'x' },
};

suite('Volt workflow schema', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseWorkflowYaml', () => {

		test('reads a minimal file with defaults: manual trigger, derived id, first output port, in port', () => {
			const { definition, issues } = parse(MINIMAL);
			assert.deepStrictEqual(definition, {
				version: 1,
				id: 'implement-and-check',
				name: 'Implement and check',
				trigger: { type: 'manual' },
				nodes: [
					{ id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
					{ id: 'work', type: 'agent', position: { x: 280, y: 0 }, config: { prompt: 'Do it' } },
					{ id: 'done', type: 'end', position: { x: 560, y: 0 }, config: {} },
				],
				edges: [
					{ id: 'start.next->work', from: 'start', port: 'next', to: 'work' },
					{ id: 'work.done->done', from: 'work', port: 'done', to: 'done' },
				],
			});
			assert.deepStrictEqual(errors(issues), []);
		});

		test('missing version reads as version 1 with an info; a newer version is refused', () => {
			const missing = parse(MINIMAL.replace('version: 1\n', ''));
			assert.strictEqual(missing.definition.version, 1);
			assert.strictEqual(issue(missing.issues, 'missing-version').severity, 'info');

			const newer = parseWorkflowYaml(MINIMAL.replace('version: 1', `version: ${WORKFLOW_SCHEMA_VERSION + 1}`));
			assert.strictEqual(newer.definition, undefined);
			const refused = issue(newer.issues, 'newer-version');
			assert.ok(refused.message.includes('made by a newer Volt'));
			assert.deepStrictEqual([refused.severity, refused.line, refused.path], ['error', 1, 'version']);

			assert.strictEqual(issue(parse(MINIMAL.replace('version: 1', 'version: one')).issues, 'invalid-version').line, 1);
		});

		test('YAML syntax errors become yaml-syntax issues with their position and no definition', () => {
			const result = parseWorkflowYaml('name: x\nnodes:\n\t- id: start\n');
			assert.strictEqual(result.definition, undefined);
			assert.deepStrictEqual(result.issues.map(({ code, line, column }) => ({ code, line, column })), [{ code: 'yaml-syntax', line: 3, column: 1 }]);
		});

		test('duplicate keys are syntax errors, the rest of the file still reads', () => {
			const result = parseWorkflowYaml(MINIMAL.replace('name: Implement and check', 'name: A\nname: B'));
			assert.strictEqual(result.definition?.name, 'A');
			assert.deepStrictEqual(errors(result.issues).map(({ code, line }) => ({ code, line })), [{ code: 'yaml-syntax', line: 3 }]);
		});

		test('shape problems point at their line and path', () => {
			const { definition, issues } = parse(lines(
				'version: 1',
				'id: Not A Slug',
				'colour: blue',
				'trigger:',
				'  type: schedule',
				'  cron: \'99 * * * *\'',
				'  timezone: Mars/Olympus',
				'nodes:',
				'  - id: start',
				'    type: start',
				'  - id: start',
				'    type: agent',
				'  - id: odd',
				'    type: mystery',
				'    color: magenta',
				'    position: [1, 2, 3]',
				'    retry: 99',
				'    onError: shrug',
				'    disabled: maybe',
				'  - type: agent',
				'edges:',
				'  - from: start.next',
				'  - from: ghost',
				'    to: odd',
			));
			const at = (code: string) => {
				const found = issue(issues, code);
				return [found.severity, found.line, found.path];
			};
			assert.deepStrictEqual(at('missing-name'), ['error', 1, undefined]);
			assert.deepStrictEqual(at('invalid-id'), ['error', 2, 'id']);
			assert.strictEqual(definition.id, 'not-a-slug');
			assert.deepStrictEqual(at('unknown-key'), ['warning', 3, 'colour']);
			assert.deepStrictEqual(at('invalid-cron'), ['error', 6, 'trigger.cron']);
			assert.deepStrictEqual(at('invalid-timezone'), ['error', 7, 'trigger.timezone']);
			assert.deepStrictEqual(at('duplicate-node-id'), ['error', 11, 'nodes[1].id']);
			assert.deepStrictEqual(at('unknown-node-type'), ['warning', 14, 'nodes[2].type']);
			assert.deepStrictEqual(at('invalid-color'), ['warning', 15, 'nodes[2].color']);
			assert.deepStrictEqual(at('invalid-position'), ['error', 16, 'nodes[2].position']);
			assert.deepStrictEqual(at('invalid-retry'), ['error', 17, 'nodes[2].retry']);
			assert.deepStrictEqual(at('invalid-on-error'), ['error', 18, 'nodes[2].onError']);
			assert.deepStrictEqual(at('invalid-value'), ['error', 19, 'nodes[2].disabled']);
			assert.deepStrictEqual(at('missing-node-id'), ['error', 20, 'nodes[3]']);
			assert.deepStrictEqual(at('missing-edge-to'), ['error', 22, 'edges[0]']);
			assert.deepStrictEqual(at('missing-edge-port'), ['error', 23, 'edges[1].from']);
			assert.deepStrictEqual(definition.nodes.map(node => node.id), ['start', 'odd', 'agent']);
			assert.strictEqual(issue(issues, 'unknown-node-type').nodeId, 'odd');
		});

		test('edges: dotted ports, a separate port key, target ports, labels, ids and duplicates', () => {
			const { definition, issues } = parse(lines(
				'name: Edges',
				'nodes:',
				'  - { id: start, type: start, position: [0, 0] }',
				'  - { id: check, type: shell, position: [280, 0], config: { command: npm test } }',
				'  - { id: gate, type: if, position: [560, 0], config: { condition: nodes.check.exitCode == 0 } }',
				'  - { id: done, type: end, position: [840, 0] }',
				'edges:',
				'  - { from: start, to: check }',
				'  - { from: check, port: failed, to: gate.in, label: "failed: retry" }',
				'  - { from: check.passed, to: gate, id: passed-edge }',
				'  - { from: gate.true, to: done }',
				'  - { from: gate.true, to: done }',
				'  - { from: gate.false, port: true, to: done }',
			));
			assert.deepStrictEqual(definition.edges, [
				{ id: 'start.next->check', from: 'start', port: 'next', to: 'check' },
				{ id: 'check.failed->gate', from: 'check', port: 'failed', to: 'gate', label: 'failed: retry' },
				{ id: 'passed-edge', from: 'check', port: 'passed', to: 'gate' },
				{ id: 'gate.true->done', from: 'gate', port: 'true', to: 'done' },
				{ id: 'gate.false->done', from: 'gate', port: 'false', to: 'done' },
			]);
			const duplicate = issue(issues, 'duplicate-edge');
			assert.deepStrictEqual([duplicate.severity, duplicate.line, duplicate.edgeId], ['error', 12, 'gate.true->done']);
			assert.strictEqual(issue(issues, 'edge-port-conflict').line, 13);
		});

		test('graph issues from validateWorkflow get the line of their node or edge', () => {
			const { issues } = parse(lines(
				'name: Graph',
				'nodes:',
				'  - id: start',
				'    type: start',
				'    position: [0, 0]',
				'  - id: work',
				'    type: agent',
				'    position: [280, 0]',
				'    config:',
				'      prompt: \'\'',
				'edges:',
				'  - from: start.next',
				'    to: work',
				'  - from: work.done',
				'    to: nowhere',
			));
			const missing = issue(issues, 'edge-unknown-node');
			assert.deepStrictEqual([missing.edgeId, missing.line], ['work.done->nowhere', 14]);
			const required = issue(issues, 'required-field');
			assert.deepStrictEqual([required.nodeId, required.field, required.line], ['work', 'prompt', 10]);
		});

		test('triggers: shorthand, schedules, events, filters and misplaced fields', () => {
			const base = (trigger: string[]) => lines('name: T', ...trigger, 'nodes:', '  - { id: start, type: start, position: [0, 0] }');
			assert.deepStrictEqual(parse(base(['trigger: manual'])).definition.trigger, { type: 'manual' });
			assert.deepStrictEqual(parse(base(['trigger:', '  everyMinutes: 5'])).definition.trigger, { type: 'schedule', everyMinutes: 5 });
			assert.ok(issue(parse(base(['trigger: schedule'])).issues, 'invalid-trigger').message.includes('cron'));
			assert.strictEqual(issue(parse(base(['trigger:', '  type: schedule'])).issues, 'missing-schedule').severity, 'error');
			assert.strictEqual(issue(parse(base(['trigger:', '  type: schedule', '  cron: \'@daily\'', '  everyMinutes: 5'])).issues, 'schedule-conflict').severity, 'warning');
			assert.strictEqual(issue(parse(base(['trigger:', '  type: sometimes'])).issues, 'invalid-trigger-type').line, 3);

			const event = parse(base(['trigger:', '  type: event', '  provider: github', '  event: pr.opened', '  filters: [\'payload.ref matches ^refs/tags/\', \'nonsense\']', '  cron: \'0 9 * * *\'']));
			assert.deepStrictEqual(event.definition.trigger, { type: 'event', cron: '0 9 * * *', provider: 'github', event: 'pr.opened', filters: ['payload.ref matches ^refs/tags/', 'nonsense'] });
			assert.deepStrictEqual([issue(event.issues, 'invalid-filter').path, issue(event.issues, 'invalid-filter').line], ['trigger.filters[1]', 6]);
			assert.strictEqual(issue(event.issues, 'unused-trigger-field').path, 'trigger.cron');
			assert.strictEqual(issue(parse(base(['trigger:', '  type: event', '  provider: myspace'])).issues, 'invalid-provider').severity, 'error');
			assert.strictEqual(issue(parse(base(['trigger:', '  type: event', '  provider: github', '  event: pr.exploded'])).issues, 'unknown-event').severity, 'warning');
			assert.strictEqual(issue(parse(base(['trigger:', '  type: event', '  provider: github'])).issues, 'missing-event').severity, 'error');
			assert.deepStrictEqual(errors(parse(base(['trigger:', '  type: event', '  provider: webhook'])).issues), []);
			assert.deepStrictEqual(errors(parse(base(['trigger:', '  type: schedule', '  cron: \'*/15 9-17 * * 1-5\'', '  timezone: Europe/Berlin'])).issues), []);
		});

		test('inputs: list and map forms, names, types and defaults', () => {
			const base = (inputs: string[]) => lines('name: I', ...inputs, 'nodes:', '  - { id: start, type: start, position: [0, 0] }');
			assert.deepStrictEqual(parse(base(['inputs: [task]'])).definition.inputs, [{ name: 'task', type: 'string' }]);
			assert.deepStrictEqual(parse(base(['inputs:', '  task: string', '  retries: { type: number, default: 2 }', '  notes:'])).definition.inputs, [
				{ name: 'task', type: 'string' },
				{ name: 'retries', type: 'number', default: 2 },
				{ name: 'notes', type: 'string' },
			]);
			const bad = parse(base(['inputs:', '  - name: 2bad', '  - name: ok', '    type: number', '    default: lots', '  - name: ok', '  - name: kind', '    type: date']));
			assert.strictEqual(issue(bad.issues, 'invalid-input-name').line, 3);
			assert.strictEqual(issue(bad.issues, 'input-default-type').line, 6);
			assert.strictEqual(issue(bad.issues, 'duplicate-input').line, 7);
			assert.strictEqual(issue(bad.issues, 'invalid-input-type').line, 9);
		});

		test('nodes without a position are laid out', () => {
			const { definition } = parse(lines(
				'name: Layout',
				'nodes:',
				'  - { id: start, type: start }',
				'  - { id: work, type: agent, config: { prompt: x } }',
				'edges:',
				'  - { from: start.next, to: work }',
			));
			const [start, work] = definition.nodes.map(node => node.position);
			assert.ok(Number.isFinite(start.x) && Number.isFinite(start.y) && Number.isFinite(work.x) && Number.isFinite(work.y));
			assert.ok(work.x > start.x, `work (${work.x}) should be laid out right of start (${start.x})`);
		});

		test('readWorkflowDocument checks an already parsed value without lines', () => {
			const result = readWorkflowDocument({ name: 'Plain', nodes: [{ id: 'start', type: 'start', position: [0, 0] }] });
			assert.strictEqual(result.definition?.id, 'plain');
			assert.ok(result.issues.every(candidate => candidate.line === undefined));
			assert.strictEqual(readWorkflowDocument(['not', 'a', 'map']).definition, undefined);
			assert.strictEqual(issue(readWorkflowDocument(null).issues, 'invalid-workflow').severity, 'error');
		});
	});

	suite('serializeWorkflow', () => {

		test('canonical text: header, key order, edges as node.port, inline positions, config in field order', () => {
			const definition: IWorkflowDefinition = {
				edges: [{ id: 'start.next->work', from: 'start', port: 'next', to: 'work' }, { id: 'e2', from: 'work', port: 'done', to: 'join', toPort: 'b', label: 'ok' }],
				nodes: [
					{ config: {}, position: { x: 0, y: 0 }, type: 'start', id: 'start' },
					{ config: { verdicts: ['approve'], mode: 'Ask', prompt: 'Line 1\nLine 2\n', extra: true }, position: { x: 280, y: 40 }, name: 'Work', type: 'agent', id: 'work' },
				],
				trigger: { type: 'manual' },
				name: 'Canonical',
				id: 'canonical',
				version: 1,
			};
			assert.strictEqual(serializeWorkflow(definition), lines(
				`# ${WORKFLOW_FILE_HEADER}`,
				'version: 1',
				'id: canonical',
				'name: Canonical',
				'trigger:',
				'  type: manual',
				'nodes:',
				'  - id: start',
				'    type: start',
				'    position: [0, 0]',
				'  - id: work',
				'    type: agent',
				'    name: Work',
				'    position: [280, 40]',
				'    config:',
				'      prompt: |',
				'        Line 1',
				'        Line 2',
				'      mode: Ask',
				'      verdicts: [approve]',
				'      extra: true',
				'edges:',
				'  - from: start.next',
				'    to: work',
				'  - from: work.done',
				'    to: join.b',
				'    label: ok',
				'    id: e2',
			));
			assert.strictEqual(serializeWorkflow(definition), serializeWorkflow(JSON.parse(JSON.stringify(definition))));
		});

		test('round trip: every field, the blank workflow and every built-in template', () => {
			const roundTrip = (definition: IWorkflowDefinition) => {
				const text = serializeWorkflow(definition);
				const again = parseWorkflowYaml(text);
				assert.deepStrictEqual(errors(again.issues).filter(candidate => candidate.code === 'yaml-syntax'), [], text);
				assert.deepStrictEqual(again.definition, definition, text);
				assert.strictEqual(serializeWorkflow(again.definition!), text);
			};
			roundTrip(EVERYTHING);
			roundTrip(blankWorkflow('fresh', 'Fresh workflow'));
			for (const template of BUILT_IN_WORKFLOW_TEMPLATES) {
				roundTrip(parse(template.yaml).definition);
			}
		});

		test('the document shape: absent fields left out, toPort "in" dropped, ids only when not derived', () => {
			const doc = workflowToDocument({ ...blankWorkflow('x', 'X'), edges: [{ id: 'start.next->a', from: 'start', port: 'next', to: 'a', toPort: 'in' }] }) as Record<string, unknown>;
			assert.deepStrictEqual(Object.keys(doc), ['version', 'id', 'name', 'trigger', 'inputs', 'nodes', 'edges']);
			assert.deepStrictEqual(doc.edges, [{ from: 'start.next', to: 'a' }]);
			assert.deepStrictEqual(doc.nodes, [{ id: 'start', type: 'start', position: [0, 0] }]);
		});
	});

	suite('helpers', () => {

		test('ids, paths and edge ids', () => {
			assert.strictEqual(slugifyWorkflowId('Fix failing CI!'), 'fix-failing-ci');
			assert.strictEqual(slugifyWorkflowId(`Cr${String.fromCharCode(0xe8)}me br${String.fromCharCode(0xfb)}l${String.fromCharCode(0xe9)}e`), 'creme-brulee');
			assert.strictEqual(slugifyWorkflowId('2026 plan'), 'w-2026-plan');
			assert.strictEqual(slugifyWorkflowId('***'), 'workflow');
			assert.strictEqual(formatWorkflowPath(['nodes', 2, 'config', 'prompt']), 'nodes[2].config.prompt');
			assert.strictEqual(formatWorkflowPath(['variables', 'a b']), 'variables["a b"]');
			assert.strictEqual(defaultEdgeId({ from: 'a', port: 'done', to: 'b' }), 'a.done->b');
			assert.strictEqual(defaultEdgeId({ from: 'a', port: 'done', to: 'b', toPort: 'in' }), 'a.done->b');
			assert.strictEqual(defaultEdgeId({ from: 'a', port: 'done', to: 'b', toPort: 'x' }), 'a.done->b.x');
		});

		test('migrations run one version at a time', () => {
			const migrations = {
				1: (doc: Record<string, unknown>) => ({ ...doc, steps: doc.nodes }),
				2: (doc: Record<string, unknown>) => ({ ...doc, renamed: true }),
			} as unknown as Parameters<typeof migrateWorkflowDocument>[2];
			assert.deepStrictEqual(migrateWorkflowDocument({ version: 1, nodes: [] }, 1, migrations, 3).document, { version: 3, nodes: [], steps: [], renamed: true });
			assert.ok(migrateWorkflowDocument({ version: 1 }, 1, {}, 2).error?.includes('No migration from workflow version 1'));
			assert.deepStrictEqual(migrateWorkflowDocument({ version: 1, a: 1 }, 1).document, { version: 1, a: 1 });
		});
	});

	suite('JSON Schema', () => {

		test('is draft 2020-12 and offers every node type the catalog has', () => {
			assert.strictEqual(WORKFLOW_JSON_SCHEMA.$schema, 'https://json-schema.org/draft/2020-12/schema');
			const offered = new Set(WORKFLOW_SCHEMA_NODE_TYPES);
			const missing = workflowNodeTypes().filter(type => !type.hidden && !offered.has(type.type)).map(type => type.type);
			assert.deepStrictEqual(missing, [], 'add these to WORKFLOW_SCHEMA_NODE_TYPES and run bun build/volt/workflows/validateTemplates.ts --write');
		});

		test('workflow-templates/schema/workflow.schema.json is the exported schema', () => {
			const fs = nodeFs();
			if (!fs) {
				return; // a browser run: the validator checks the file in CI
			}
			const file = fs.readFileSync('workflow-templates/schema/workflow.schema.json', 'utf8');
			assert.deepStrictEqual(JSON.parse(file), WORKFLOW_JSON_SCHEMA, 'out of date: run bun build/volt/workflows/validateTemplates.ts --write');
			assert.strictEqual(file, `${JSON.stringify(WORKFLOW_JSON_SCHEMA, null, '\t')}\n`);
		});

		test('a parsed template is valid against the schema\'s structure (required keys, closed objects)', () => {
			const doc = parseYaml(BUILT_IN_WORKFLOW_TEMPLATES[0].yaml).value as Record<string, unknown>;
			const properties = WORKFLOW_JSON_SCHEMA.properties as Record<string, unknown>;
			for (const key of Object.keys(doc)) {
				assert.ok(key in properties, `"${key}" is not in the schema`);
			}
			for (const key of WORKFLOW_JSON_SCHEMA.required as string[]) {
				assert.ok(key in doc, `required "${key}" missing`);
			}
		});
	});
});
