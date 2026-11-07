/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { WorkflowExpressionError, checkTemplate, evaluateExpression, expressionReferences, isTruthy, parseExpression, renderTemplate, resolveTemplates, scopeSuggestions, templateReferences } from '../../../common/workflows/workflowExpressions.js';
import { IWorkflowDefinition, IWorkflowScope, WorkflowValue } from '../../../common/workflows/workflowTypes.js';

const scope: IWorkflowScope = {
	inputs: { task: 'Fix the login bug', count: 3, flag: false },
	trigger: { kind: 'event', payload: { a: { b: 'deep' }, list: [1, 2, 3] } },
	nodes: {
		'run-tests': { exitCode: 0, stdout: 'ok' },
		check: { exitCode: 1, failed: ['a', 'b'] },
		agent: { summary: 'Done', count: 3, list: ['x', 'y'] },
	},
	vars: { n: 2, name: 'volt', empty: '', nothing: null, big: Array.from({ length: 30_000 }, (_, i) => i), s: 'x'.repeat(600 * 1024) },
	item: { title: 'Item one', tags: ['p1'] },
	loop: { index: 1, iteration: 2, max: 3 },
	run: { id: 'r1', mode: 'simulate', workflowId: 'wf' },
	input: { summary: 'from upstream' },
};

function ev(source: string): WorkflowValue {
	return evaluateExpression(source, scope, { now: () => Date.UTC(2026, 10, 2, 9, 30, 5) });
}

function throwsAt(source: string, pattern: RegExp, offset?: number): void {
	assert.throws(() => ev(source), (error: unknown) => {
		if (!(error instanceof WorkflowExpressionError)) {
			throw new Error(`expected a WorkflowExpressionError for ${source}, got ${error}`);
		}
		assert.match(error.message, pattern);
		if (offset !== undefined) {
			assert.strictEqual(error.offset, offset, `offset of "${source}"`);
		}
		return true;
	});
}

suite('Volt workflow expressions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('literals and precedence', () => {
		assert.strictEqual(ev('1 + 2 * 3'), 7);
		assert.strictEqual(ev('(1 + 2) * 3'), 9);
		assert.strictEqual(ev('-2 * 3'), -6);
		assert.strictEqual(ev('10 - 4 - 3'), 3);
		assert.strictEqual(ev('7 % 4 + 8 / 2'), 7);
		assert.strictEqual(ev('1 + 2 * 3 == 7 && !false || false'), true);
		assert.strictEqual(ev('!inputs.flag == true'), true);
		assert.strictEqual(ev('1 < 2 == true'), true);
		assert.strictEqual(ev('true ? 1 : false ? 2 : 3'), 1);
		assert.strictEqual(ev('false ? 1 : false ? 2 : 3'), 3);
		assert.strictEqual(ev('vars.n > 1 ? \'many\' : \'one\''), 'many');
		assert.deepStrictEqual(ev('[1, \'two\', [3], {a: 1, \'b c\': null}]'), [1, 'two', [3], { a: 1, 'b c': null }]);
		assert.strictEqual(ev('"esc\\"aped\\n"'), 'esc"aped\n');
		assert.strictEqual(ev('0x10 + 1.5e1'), 31);
		assert.strictEqual(ev('null'), null);
		assert.strictEqual(ev('1 === 1 && 1 !== 2'), true);
	});

	test('operators: short-circuit operands, equality, comparison, in, concatenation', () => {
		assert.strictEqual(ev('vars.empty || \'fallback\''), 'fallback');
		assert.strictEqual(ev('vars.name && 5'), 5);
		assert.strictEqual(ev('vars.nothing ?? 5'), 5);
		assert.strictEqual(ev('vars.empty ?? 5'), '');
		assert.strictEqual(ev('[1, {a: [2]}] == [1, {a: [2]}]'), true);
		assert.strictEqual(ev('nodes.missing == null'), true);
		assert.strictEqual(ev('1 == \'1\''), false);
		assert.strictEqual(ev('\'b\' > \'a\''), true);
		assert.strictEqual(ev('null < 1'), false, 'mismatched types compare false');
		assert.strictEqual(ev('\'b\' in [\'a\', \'b\']'), true);
		assert.strictEqual(ev('\'ell\' in \'hello\''), true);
		assert.strictEqual(ev('\'exitCode\' in nodes.check'), true);
		assert.strictEqual(ev('\'x\' in nodes.missing'), false);
		assert.strictEqual(ev('\'n=\' + vars.n'), 'n=2');
		assert.deepStrictEqual(ev('[1] + [2]'), [1, 2]);
		throwsAt('1 / 0', /Division by zero/, 2);
		throwsAt('{} - 1', /needs numbers/);
		throwsAt('-\'a\'', /needs a number/);
		throwsAt('1 in 2', /'in' needs/);
	});

	test('paths over the scope', () => {
		assert.strictEqual(ev('inputs.task'), 'Fix the login bug');
		assert.strictEqual(ev('input.summary'), 'from upstream');
		assert.strictEqual(ev('nodes.run-tests.exitCode'), 0, 'node ids with dashes');
		assert.strictEqual(ev('nodes[\'run-tests\'].stdout'), 'ok');
		assert.strictEqual(ev('vars.n - 1'), 1);
		assert.strictEqual(ev('trigger.payload.a.b'), 'deep');
		assert.strictEqual(ev('trigger.kind'), 'event');
		assert.strictEqual(ev('item.title'), 'Item one');
		assert.strictEqual(ev('loop.index'), 1);
		assert.strictEqual(ev('run.mode'), 'simulate');
		assert.strictEqual(ev('nodes.check.failed[0]'), 'a');
		assert.strictEqual(ev('nodes.check.failed[-1]'), 'b');
		assert.strictEqual(ev('nodes.check.failed.1'), 'b');
		assert.strictEqual(ev('nodes.check.failed.length'), 2);
		assert.strictEqual(ev('nodes.check.failed[5]'), null);
		assert.strictEqual(ev('nodes.nope.deeper.still'), null);
		assert.strictEqual(ev('inputs.task[0]'), 'F');
	});

	test('safety: prototypes, globals and host objects are unreachable', () => {
		assert.strictEqual(ev('inputs.constructor'), null);
		assert.strictEqual(ev('inputs.__proto__'), null);
		assert.strictEqual(ev('inputs[\'constructor\']'), null);
		assert.strictEqual(ev('inputs.toString'), null, 'inherited members are not own keys');
		assert.strictEqual(ev('nodes.check.failed.constructor'), null);
		assert.strictEqual(ev('inputs.task.constructor'), null);
		assert.strictEqual(ev('trigger.payload.__proto__.polluted'), null);
		const hostile = JSON.parse('{"__proto__": {"x": 1}, "prototype": 2, "ok": 3}');
		assert.strictEqual(evaluateExpression('vars.h.__proto__', { ...scope, vars: { h: hostile } }), null);
		assert.strictEqual(evaluateExpression('vars.h.prototype', { ...scope, vars: { h: hostile } }), null);
		assert.strictEqual(evaluateExpression('vars.h.ok', { ...scope, vars: { h: hostile } }), 3);
		throwsAt('globalThis', /Unknown name 'globalThis'/, 0);
		throwsAt('process.env', /Unknown name 'process'/);
		throwsAt('constructor', /Unknown name/);
		throwsAt('inputs.task.toUpperCase()', /Only functions can be called/);
		throwsAt('eval(\'1\')', /Unknown function 'eval'/, 0);
		assert.strictEqual(parseExpression('{__proto__: 1}').error, 'Key \'__proto__\' is not allowed');
	});

	test('functions', () => {
		assert.strictEqual(ev('len(inputs.task)'), 17);
		assert.strictEqual(ev('len(nodes.check.failed) + len(nodes.check) + len(null)'), 4);
		assert.strictEqual(ev('lower(\'AbC\') + upper(\'x\') + trim(\'  y \')'), 'abcXy');
		assert.strictEqual(ev('contains(inputs.task, \'login\') && contains(nodes.check.failed, \'b\') && contains(nodes.check, \'exitCode\')'), true);
		assert.strictEqual(ev('startsWith(inputs.task, \'Fix\') && endsWith(inputs.task, \'bug\')'), true);
		assert.strictEqual(ev('matches(inputs.task, \'^fix\\\\s\', \'i\')'), true);
		assert.strictEqual(ev('replace(\'a-b-c\', \'-\', \'+\')'), 'a+b+c');
		assert.deepStrictEqual(ev('split(\'a,b,c\')'), ['a', 'b', 'c']);
		assert.deepStrictEqual(ev('split(\'a b\', \' \')'), ['a', 'b']);
		assert.strictEqual(ev('join(nodes.check.failed, \' | \')'), 'a | b');
		assert.strictEqual(ev('json({a: [1, true]})'), '{"a":[1,true]}');
		assert.deepStrictEqual(ev('parseJson(\'{"x": [1]}\').x'), [1]);
		throwsAt('parseJson(\'{bad\')', /Invalid JSON/);
		assert.strictEqual(ev('number(\'42\') + number(true)'), 43);
		assert.strictEqual(ev('number(\'nope\')'), null);
		assert.strictEqual(ev('string(nodes.check.failed)'), '["a","b"]');
		assert.strictEqual(ev('bool(\'false\') || bool(\'0\') || bool(\'\')'), false);
		assert.strictEqual(ev('bool(\'yes\') && bool([1])'), true);
		assert.strictEqual(ev('default(vars.empty, vars.nothing, \'third\')'), 'third');
		assert.strictEqual(ev('coalesce(vars.nothing, vars.empty, 1)'), '');
		assert.deepStrictEqual(ev('keys(nodes.check)'), ['exitCode', 'failed']);
		assert.deepStrictEqual(ev('values({a: 1, b: 2})'), [1, 2]);
		assert.strictEqual(ev('first(nodes.check.failed) + last(nodes.check.failed)'), 'ab');
		assert.strictEqual(ev('first([])'), null);
		assert.deepStrictEqual(ev('slice([1, 2, 3, 4], 1, -1)'), [2, 3]);
		assert.strictEqual(ev('slice(\'volt\', -2)'), 'lt');
		assert.strictEqual(ev('round(3.14159, 2)'), 3.14);
		assert.strictEqual(ev('floor(1.9) + ceil(0.1) + abs(-1)'), 3);
		assert.strictEqual(ev('min(3, 1, 2) + max([4, 9, 2])'), 10);
		assert.strictEqual(ev('min([])'), null);
		assert.strictEqual(ev('now()'), Date.UTC(2026, 10, 2, 9, 30, 5));
		assert.strictEqual(ev('date()'), '2026-11-02T09:30:05.000Z');
		assert.strictEqual(ev('date(0, \'YYYY-MM-DD HH:mm:ss\')'), '1970-01-01 00:00:00');
		assert.strictEqual(ev('date(\'2024-02-29T12:00:00Z\', \'DD/MM/YYYY\')'), '29/02/2024');
		throwsAt('date(\'not a date\')', /Not a date/);
		throwsAt('len(1, 2)', /len\(\) takes 1 argument/, 0);
		throwsAt('round(\'x\')', /needs a number/);
	});

	test('matches() rejects patterns that could hang', () => {
		throwsAt('matches(\'aaaa\', \'(a+)+$\')', /Nested repetition/);
		throwsAt('matches(\'aaaa\', \'(\\\\w+\\\\s?)*\')', /Nested repetition/);
		throwsAt('matches(\'aaaa\', \'((a|b)*c)*\')', /Nested repetition/);
		throwsAt('matches(\'abab\', \'(a)\\\\1\')', /Back-references/);
		throwsAt(`matches('a', '${'a'.repeat(201)}')`, /longer than 200/);
		throwsAt('matches(\'a\', \'a\', \'g\')', /flags/);
		throwsAt('matches(\'a\', \'(\')', /Invalid pattern/);
		assert.strictEqual(ev('matches(\'a1b2\', \'[a-z]\\\\d\')'), true);
		assert.strictEqual(ev('matches(\'x(y)\', \'\\\\(y\\\\)+\')'), true, 'an escaped paren with a quantifier is fine');
		assert.strictEqual(ev('matches(\'aaa\', \'(ab)+|a{2,}\')'), true);
	});

	test('limits: source length, steps, result size, nesting', () => {
		assert.match(parseExpression('1+'.repeat(2100) + '1').error!, /longer than 4000/);
		throwsAt('1 in vars.big', /too many steps/);
		throwsAt('vars.s + vars.s', /larger than 1 MB/);
		assert.match(parseExpression('('.repeat(80) + '1' + ')'.repeat(80)).error!, /nested too deeply/);
		assert.match(parseExpression('!'.repeat(80) + 'true').error!, /nested too deeply/);
	});

	test('parse errors carry an offset', () => {
		assert.deepStrictEqual(parseExpression('nodes.a ==').error, 'Expected a value');
		assert.strictEqual(parseExpression('nodes.a ==').offset, 10);
		assert.strictEqual(parseExpression('\'open').offset, 0);
		assert.match(parseExpression('\'open').error!, /Unterminated string/);
		assert.strictEqual(parseExpression('1 2').offset, 2);
		assert.strictEqual(parseExpression('a.').error, 'Expected a name after \'.\'');
		assert.strictEqual(parseExpression('  ').error, 'Empty expression');
		assert.strictEqual(parseExpression('a # b').offset, 2);
		assert.strictEqual(parseExpression('nodes.check.exitCode == 0 && vars.n < 3').error, undefined);
	});

	test('templates: typed single templates, rendering, deep resolution', () => {
		assert.strictEqual(resolveTemplates('{{ nodes.agent.count }}', scope), 3);
		assert.deepStrictEqual(resolveTemplates(' {{ nodes.agent.list }} ', scope), ['x', 'y'], 'surrounding whitespace keeps the type');
		assert.strictEqual(resolveTemplates('n={{ nodes.agent.count }}', scope), 'n=3');
		assert.strictEqual(resolveTemplates('{{ vars.nothing }}', scope), null);
		assert.strictEqual(resolveTemplates('plain', scope), 'plain');
		assert.deepStrictEqual(resolveTemplates({ title: '{{ upper(vars.name) }}', list: ['{{ vars.n }}', 'x {{ vars.n }}'], keep: 4 }, scope), { title: 'VOLT', list: [2, 'x 2'], keep: 4 });
		assert.strictEqual(renderTemplate('{{ nodes.check.failed }} / {{ vars.nothing }} / {{ inputs.flag }}', scope), '["a","b"] /  / false');
		assert.strictEqual(renderTemplate('{{ json({a: {b: 1}}) }}!', scope), '{"a":{"b":1}}!', 'the closing braces are found outside maps');
		assert.strictEqual(renderTemplate('{{ \'}}\' }}', scope), '}}', 'and outside strings');
		assert.strictEqual(renderTemplate('{{ vars.n }}{{ vars.n }}', scope), '22');
		assert.throws(() => renderTemplate('{{ nope }}', scope), /Unknown name 'nope'/);
		assert.match(checkTemplate('a {{ inputs.x')!.message, /Unclosed/);
		assert.strictEqual(checkTemplate('a {{ inputs.x')!.offset, 2);
		assert.match(checkTemplate('{{  }}')!.message, /Empty/);
		assert.strictEqual(checkTemplate('x {{ 1 + }}')!.offset, 9, 'offsets point into the whole string (here: the closing braces)');
		assert.strictEqual(checkTemplate('fine {{ inputs.task }}'), undefined);
	});

	test('references for validation and autocomplete', () => {
		assert.deepStrictEqual(templateReferences('Hi {{ inputs.name }}, {{ nodes.a.b + len(vars.c) }} {{ trigger.payload[\'x\'][0].y }} {{ nodes[vars.k].z }}'), ['inputs.name', 'nodes.a.b', 'vars.c', 'trigger.payload.x.0.y', 'nodes', 'vars.k']);
		assert.deepStrictEqual(templateReferences('no templates'), []);
		assert.deepStrictEqual(templateReferences('{{ broken'), []);
		assert.deepStrictEqual(expressionReferences('nodes.check.exitCode != 0 && loop.index < 2'), ['nodes.check.exitCode', 'loop.index']);
	});

	test('truthiness', () => {
		for (const falsy of [null, false, 0, '', []] as WorkflowValue[]) {
			assert.strictEqual(isTruthy(falsy), false, JSON.stringify(falsy));
		}
		for (const truthy of [true, 1, 'x', [0], {}] as WorkflowValue[]) {
			assert.strictEqual(isTruthy(truthy), true, JSON.stringify(truthy));
		}
		assert.strictEqual(isTruthy(undefined), false);
	});

	test('scopeSuggestions: inputs, upstream outputs nearest first, variables, loop, payload', () => {
		const definition: IWorkflowDefinition = {
			version: 1, id: 'wf', name: 'WF',
			trigger: { type: 'event', samplePayload: { pull_request: { title: 'Fix', number: 7 } } },
			inputs: [{ name: 'task', type: 'string', description: 'What to do' }],
			variables: { tries: 0 },
			nodes: [
				{ id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
				{ id: 'work', type: 'agent', position: { x: 0, y: 0 }, config: {} },
				{ id: 'vars', type: 'set_variables', position: { x: 0, y: 0 }, config: { variables: { note: 'x' } } },
				{ id: 'each', type: 'for_each', position: { x: 0, y: 0 }, config: { items: '{{ nodes.work.list }}' } },
				{ id: 'shape', type: 'transform', position: { x: 0, y: 0 }, config: { fields: { title: '{{ item }}' } } },
				{ id: 'last', type: 'log', position: { x: 0, y: 0 }, config: { message: 'x' } },
				{ id: 'other', type: 'shell', position: { x: 0, y: 0 }, config: { command: 'ls' } },
			],
			edges: [
				{ id: 'e1', from: 'start', port: 'next', to: 'work' },
				{ id: 'e2', from: 'work', port: 'done', to: 'vars' },
				{ id: 'e3', from: 'vars', port: 'next', to: 'each' },
				{ id: 'e4', from: 'each', port: 'item', to: 'shape' },
				{ id: 'e5', from: 'shape', port: 'next', to: 'last' },
			],
		};
		const paths = scopeSuggestions(definition, 'last').map(suggestion => suggestion.path);
		assert.ok(paths.includes('inputs.task'));
		assert.ok(paths.includes('nodes.work.summary'));
		assert.ok(paths.includes('nodes.shape.title'), 'transform fields are suggested');
		assert.ok(paths.indexOf('nodes.shape') < paths.indexOf('nodes.work'), 'nearest upstream first');
		assert.ok(!paths.includes('nodes.other'), 'not upstream');
		assert.ok(!paths.includes('nodes.last'), 'not itself');
		assert.ok(!paths.some(path => path.startsWith('nodes.start')));
		assert.ok(paths.includes('vars.tries') && paths.includes('vars.note'));
		assert.ok(paths.includes('item') && paths.includes('loop.index'));
		assert.ok(paths.includes('trigger.payload.pull_request.title'));
		assert.ok(paths.includes('run.mode') && paths.includes('input'));
		assert.ok(!scopeSuggestions(definition, 'work').some(suggestion => suggestion.path === 'item'), 'no loop outside a body');
	});
});
