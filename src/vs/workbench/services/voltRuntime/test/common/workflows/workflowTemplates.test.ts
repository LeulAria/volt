/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { parseWorkflowYaml } from '../../../common/workflows/workflowSchema.js';
import {
	BUILT_IN_WORKFLOW_TEMPLATES, describeTemplate, isSafeTemplatePath, OFFICIAL_TEMPLATE_SOURCE, parseTemplateIndex, resolveTemplateFileUrl, resolveTemplateSource,
	validateTemplateYaml, WORKFLOW_TEMPLATE_INDEX_JSON_SCHEMA,
} from '../../../common/workflows/workflowTemplates.js';
import { IWorkflowIssue } from '../../../common/workflows/workflowTypes.js';

function lines(...text: string[]): string {
	return text.join('\n') + '\n';
}

function codes(issues: readonly IWorkflowIssue[], severity: IWorkflowIssue['severity']): string[] {
	return issues.filter(issue => issue.severity === severity).map(issue => issue.code);
}

/** Node's fs when the suite runs under Node or Bun (the repository checks); undefined in a browser. */
function nodeFs(): { readFileSync(path: string, encoding: 'utf8'): string; existsSync(path: string): boolean } | undefined {
	const host = globalThis as { process?: { getBuiltinModule?(id: string): unknown } };
	return host.process?.getBuiltinModule?.('fs') as ReturnType<typeof nodeFs>;
}

const ENTRY = { id: 'my-flow', name: 'My flow', description: 'Does things.', path: 'templates/my-flow.yaml' };

suite('Volt workflow templates', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('built-in templates', () => {

		test('there are 8 to 10 with unique ids, and each one is publishable', () => {
			assert.ok(BUILT_IN_WORKFLOW_TEMPLATES.length >= 8 && BUILT_IN_WORKFLOW_TEMPLATES.length <= 10);
			assert.strictEqual(new Set(BUILT_IN_WORKFLOW_TEMPLATES.map(template => template.id)).size, BUILT_IN_WORKFLOW_TEMPLATES.length);
			for (const template of BUILT_IN_WORKFLOW_TEMPLATES) {
				const issues = validateTemplateYaml(template.yaml);
				assert.deepStrictEqual(codes(issues, 'error'), [], `${template.id}: ${JSON.stringify(issues.filter(issue => issue.severity === 'error'))}`);
				assert.deepStrictEqual(codes(issues, 'warning'), [], `${template.id}: ${JSON.stringify(issues.filter(issue => issue.severity === 'warning'))}`);
			}
		});

		test('entries match their YAML: id, name, path, node types and permissions', () => {
			for (const template of BUILT_IN_WORKFLOW_TEMPLATES) {
				const definition = parseWorkflowYaml(template.yaml).definition!;
				assert.strictEqual(definition.id, template.id);
				assert.strictEqual(definition.name, template.name);
				assert.strictEqual(template.path, `templates/${template.id}.yaml`);
				assert.ok(template.description.trim() && definition.description?.trim(), template.id);
				const facts = describeTemplate(definition);
				assert.deepStrictEqual(template.nodeTypes, facts.nodeTypes, template.id);
				assert.deepStrictEqual(template.permissions, facts.permissions, template.id);
				assert.deepStrictEqual(template.tags, definition.tags, template.id);
			}
		});

		// Positions come from the canvas's auto-layout with its real node sizes (columns 96px apart,
		// nodes in a column at least 48px apart); the smallest node is 80px tall.
		test('laid out left to right in columns without overlaps, every node reachable from start', () => {
			for (const template of BUILT_IN_WORKFLOW_TEMPLATES) {
				const definition = parseWorkflowYaml(template.yaml).definition!;
				for (const node of definition.nodes) {
					assert.ok(node.position.x % 16 === 0 && Number.isInteger(node.position.y), `${template.id}/${node.id} at ${node.position.x},${node.position.y}`);
					for (const other of definition.nodes) {
						if (other !== node && other.position.x === node.position.x) {
							assert.ok(Math.abs(other.position.y - node.position.y) >= 80, `${template.id}/${node.id} overlaps ${other.id}`);
						}
					}
				}
				const start = definition.nodes.find(node => node.type === 'start')!;
				assert.deepStrictEqual(start.position, { x: 0, y: 0 }, template.id);
				const reaches = (from: string, to: string) => {
					const seen = new Set([from]);
					const queue = [from];
					while (queue.length) {
						const id = queue.shift()!;
						if (id === to) {
							return true;
						}
						for (const edge of definition.edges) {
							if (edge.from === id && !seen.has(edge.to)) {
								seen.add(edge.to);
								queue.push(edge.to);
							}
						}
					}
					return false;
				};
				for (const edge of definition.edges) {
					const from = definition.nodes.find(node => node.id === edge.from)!;
					const to = definition.nodes.find(node => node.id === edge.to)!;
					// Only an edge closing a cycle through a loop node may point back to the left.
					if (to.position.x < from.position.x) {
						assert.ok(definition.nodes.some(loop => loop.type === 'loop' && reaches(edge.to, loop.id) && reaches(loop.id, edge.from)), `${template.id}: ${edge.id} points left`);
					}
				}
			}
		});

		test('the brief\'s shapes: the review loop, the schedules and the event triggers', () => {
			const byId = new Map(BUILT_IN_WORKFLOW_TEMPLATES.map(template => [template.id, parseWorkflowYaml(template.yaml).definition!]));
			const loop = byId.get('implement-test-review')!;
			assert.strictEqual(loop.nodes.find(node => node.type === 'loop')?.config.max, 3);
			assert.deepStrictEqual(loop.nodes.find(node => node.id === 'review')?.config.verdicts, ['approve', 'changes']);
			assert.ok(loop.edges.some(edge => edge.from === 'test' && edge.port === 'failed' && edge.to === 'retry'));
			assert.ok(loop.nodes.some(node => node.type === 'github_pr'));
			assert.deepStrictEqual(byId.get('uptime-check')!.trigger, { type: 'schedule', everyMinutes: 5 });
			assert.deepStrictEqual(byId.get('uptime-check')!.nodes.map(node => node.type).filter(type => ['http', 'if', 'slack_message'].includes(type)), ['http', 'if', 'slack_message', 'slack_message']);
			assert.strictEqual(byId.get('nightly-dependency-update')!.trigger.cron, '0 3 * * *');
			assert.deepStrictEqual([byId.get('review-pull-request')!.trigger.provider, byId.get('review-pull-request')!.trigger.event], ['github', 'pr.opened']);
			assert.ok(byId.get('parallel-research')!.nodes.some(node => node.type === 'fork') && byId.get('parallel-research')!.nodes.some(node => node.type === 'join'));
		});

		test('each is published as workflow-templates/templates/<id>.yaml and listed in the official index', () => {
			const fs = nodeFs();
			if (!fs) {
				return; // a browser run: the validator checks the repository in CI
			}
			const index = parseTemplateIndex(fs.readFileSync('workflow-templates/index.json', 'utf8'));
			assert.deepStrictEqual(index.errors, []);
			for (const template of BUILT_IN_WORKFLOW_TEMPLATES) {
				assert.strictEqual(fs.readFileSync(`workflow-templates/${template.path}`, 'utf8'), template.yaml, `${template.id} differs: run bun build/volt/workflows/validateTemplates.ts --write`);
				const entry = index.index!.templates.find(candidate => candidate.id === template.id);
				assert.ok(entry, `${template.id} is not in index.json`);
				assert.deepStrictEqual([entry!.name, entry!.path, entry!.nodeTypes, entry!.permissions], [template.name, template.path, template.nodeTypes, template.permissions]);
			}
			for (const entry of index.index!.templates) {
				const issues = validateTemplateYaml(fs.readFileSync(`workflow-templates/${entry.path}`, 'utf8'));
				assert.deepStrictEqual(codes(issues, 'error'), [], entry.id);
			}
			const schema = fs.readFileSync('workflow-templates/schema/index.schema.json', 'utf8');
			assert.strictEqual(schema, `${JSON.stringify(WORKFLOW_TEMPLATE_INDEX_JSON_SCHEMA, null, '\t')}\n`);
		});
	});

	suite('validateTemplateYaml', () => {

		test('refuses what a shared template must not carry', () => {
			const issues = validateTemplateYaml(lines(
				'name: Risky',
				'revision: 3',
				'settings:',
				'  repository: file:///Users/me/code',
				'source:',
				'  kind: community',
				'nodes:',
				'  - id: start',
				'    type: start',
				'  - id: odd',
				'    type: teleport',
				'    position: [280, 0]',
				'edges:',
				'  - { from: start.next, to: odd }',
			));
			assert.deepStrictEqual(codes(issues, 'error').sort(), ['missing-version', 'template-missing-id', 'template-repository', 'template-source', 'unknown-node-type'].sort());
			assert.deepStrictEqual(codes(issues, 'warning').sort(), ['template-layout', 'template-missing-description', 'template-revision'].sort());
			const layout = issues.find(issue => issue.code === 'template-layout')!;
			assert.deepStrictEqual([layout.nodeId, layout.line], ['start', 8]);
			assert.strictEqual(issues.find(issue => issue.code === 'template-repository')?.line, 4);
		});

		test('passes YAML errors through', () => {
			assert.deepStrictEqual(validateTemplateYaml('name: [unclosed\n').map(issue => issue.code), ['yaml-syntax']);
		});
	});

	suite('parseTemplateIndex', () => {

		test('reads a valid index, from an object or from JSON text', () => {
			const raw = { $schema: './schema/index.schema.json', version: 1, templates: [{ ...ENTRY, author: 'Me', tags: ['a'], icon: 'robot', nodeTypes: ['start'], permissions: ['agent', 'git'] }] };
			const parsed = parseTemplateIndex(raw);
			assert.deepStrictEqual(parsed, { index: { version: 1, templates: raw.templates }, errors: [] });
			assert.deepStrictEqual(parseTemplateIndex(JSON.stringify(raw)), parsed);
		});

		test('reports bad entries and keeps the good ones', () => {
			const parsed = parseTemplateIndex({
				version: 1,
				templates: [
					ENTRY,
					ENTRY,
					{ ...ENTRY, id: 'Bad Id', path: 'templates/bad.yaml' },
					{ ...ENTRY, id: 'escape', path: '../outside.yaml' },
					{ ...ENTRY, id: 'absolute', path: '/etc/flow.yaml' },
					{ ...ENTRY, id: 'yml', path: 'templates/yml.yml' },
					{ ...ENTRY, id: 'nameless', name: ' ', path: 'templates/nameless.yaml' },
					{ ...ENTRY, id: 'perms', path: 'templates/perms.yaml', permissions: ['root'] },
					{ ...ENTRY, id: 'tags', path: 'templates/tags.yaml', tags: 'one' },
					'not an object',
					{ ...ENTRY, id: 'second', path: 'templates/second.yaml' },
				],
			});
			assert.deepStrictEqual(parsed.index?.templates.map(entry => entry.id), ['my-flow', 'second']);
			assert.deepStrictEqual(parsed.errors.map(error => error.split(':')[0]), [
				'templates[1] (my-flow)', 'templates[1] (my-flow)', 'templates[2] (Bad Id)', 'templates[3] (escape)', 'templates[4] (absolute)', 'templates[5] (yml)',
				'templates[6] (nameless)', 'templates[7] (perms)', 'templates[8] (tags)', 'templates[9]',
			]);
		});

		test('refuses broken files and newer index versions', () => {
			assert.ok(parseTemplateIndex('{ not json').errors[0].startsWith('index.json is not valid JSON'));
			assert.ok(parseTemplateIndex([]).errors[0].includes('must be an object'));
			assert.ok(parseTemplateIndex({ version: 2, templates: [] }).errors[0].includes('newer Volt'));
			assert.deepStrictEqual(parseTemplateIndex({ version: 1 }).errors, ['"templates" must be a list of { id, name, description, path }']);
		});

		test('safe paths stay inside the repository', () => {
			for (const path of ['templates/a.yaml', 'a.yaml', 'deep/er/a-b_c.yaml']) {
				assert.ok(isSafeTemplatePath(path), path);
			}
			for (const path of ['../a.yaml', 'templates/../../a.yaml', './a.yaml', '/a.yaml', 'a.yml', 'a\\b.yaml', 'https://x/a.yaml', 'C:/a.yaml', 'a//b.yaml', 'templates/']) {
				assert.ok(!isSafeTemplatePath(path), path);
			}
		});
	});

	suite('resolveTemplateSource', () => {

		test('GitHub repositories, folders and files become raw URLs', () => {
			assert.deepStrictEqual(resolveTemplateSource('https://github.com/acme/flows'), {
				indexUrl: 'https://raw.githubusercontent.com/acme/flows/HEAD/index.json',
				rawBase: 'https://raw.githubusercontent.com/acme/flows/HEAD/',
			});
			assert.deepStrictEqual(resolveTemplateSource('https://github.com/acme/flows.git/'), resolveTemplateSource('https://github.com/acme/flows'));
			assert.deepStrictEqual(resolveTemplateSource(OFFICIAL_TEMPLATE_SOURCE.url), {
				indexUrl: 'https://raw.githubusercontent.com/LeulAria/volt/main/workflow-templates/index.json',
				rawBase: 'https://raw.githubusercontent.com/LeulAria/volt/main/workflow-templates/',
			});
			assert.deepStrictEqual(resolveTemplateSource('https://github.com/acme/flows/blob/dev/templates/ship.yaml#L3'), {
				singleYamlUrl: 'https://raw.githubusercontent.com/acme/flows/dev/templates/ship.yaml',
				rawBase: 'https://raw.githubusercontent.com/acme/flows/dev/templates/',
			});
			assert.deepStrictEqual(resolveTemplateSource('https://github.com/acme/flows/blob/main/index.json'), {
				indexUrl: 'https://raw.githubusercontent.com/acme/flows/main/index.json',
				rawBase: 'https://raw.githubusercontent.com/acme/flows/main/',
			});
		});

		test('raw and direct URLs are used as they are', () => {
			assert.deepStrictEqual(resolveTemplateSource('https://raw.githubusercontent.com/acme/flows/main/templates/ship.yaml'), {
				singleYamlUrl: 'https://raw.githubusercontent.com/acme/flows/main/templates/ship.yaml',
				rawBase: 'https://raw.githubusercontent.com/acme/flows/main/templates/',
			});
			assert.deepStrictEqual(resolveTemplateSource('https://raw.githubusercontent.com/acme/flows/main/wf'), {
				indexUrl: 'https://raw.githubusercontent.com/acme/flows/main/wf/index.json',
				rawBase: 'https://raw.githubusercontent.com/acme/flows/main/wf/',
			});
			assert.deepStrictEqual(resolveTemplateSource('https://example.com/volt/index.json?v=2'), {
				indexUrl: 'https://example.com/volt/index.json?v=2',
				rawBase: 'https://example.com/volt/',
			});
			assert.deepStrictEqual(resolveTemplateSource('  https://example.com/one.yml  '), { singleYamlUrl: 'https://example.com/one.yml', rawBase: 'https://example.com/' });
		});

		test('refuses what it cannot fetch safely', () => {
			const error = (url: string) => resolveTemplateSource(url).error ?? '';
			assert.ok(error('http://github.com/acme/flows').includes('https'));
			assert.ok(error('file:///etc/index.json').includes('https'));
			assert.ok(error('github.com/acme/flows').includes('Not a URL'));
			assert.ok(error('https://user:token@github.com/acme/flows').includes('user name or password'));
			assert.ok(error('https://github.com/acme').includes('owner and the repository'));
			assert.ok(error('https://github.com/acme/flows/pulls').includes('Unsupported GitHub URL'));
			assert.ok(error('https://github.com/acme/flows/blob/main/README.md').includes('index.json or a .yaml'));
			assert.ok(error('https://example.com/volt/').includes('direct https URL'));
		});

		test('entry files resolve under the source and never above it', () => {
			const base = 'https://raw.githubusercontent.com/acme/flows/main/';
			assert.strictEqual(resolveTemplateFileUrl(base, 'templates/ship it.yaml'), `${base}templates/ship%20it.yaml`);
			assert.strictEqual(resolveTemplateFileUrl(base, '../secrets.yaml'), undefined);
			assert.strictEqual(resolveTemplateFileUrl(base, '/abs.yaml'), undefined);
		});
	});
});
