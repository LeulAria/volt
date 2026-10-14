/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { browserToolVerdict, BROWSER_AUDIT_TOOL_NAME, BROWSER_MOCK_TOOL_NAME, BROWSER_RUN_TOOL_NAME, isBrowserAutomationTool, isVoltHostTool, VOLT_HOST_TOOLS } from '../../common/hostTools.js';
import { PLAYGROUND_TOOLS } from '../../common/playgroundTools.js';
import { describeLocator, describeStep, diffSnapshots, formatRunLog, parseLocator, parseRunSteps } from '../../common/tools/browserRun.js';

suite('Volt browser_run', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('locators: objects, string shorthands and refs', () => {
		assert.deepStrictEqual(parseLocator({ role: 'Button', name: 'Add' }), { role: 'button', name: 'Add' });
		assert.deepStrictEqual(parseLocator('e12'), { ref: 'e12' });
		assert.deepStrictEqual(parseLocator('@e7'), { ref: 'e7' });
		assert.deepStrictEqual(parseLocator('ref=e3'), { ref: 'e3' });
		assert.deepStrictEqual(parseLocator('role=button[name="Sign up"]'), { role: 'button', name: 'Sign up' });
		assert.deepStrictEqual(parseLocator('role=link'), { role: 'link' });
		assert.deepStrictEqual(parseLocator('label=Email'), { label: 'Email' });
		assert.deepStrictEqual(parseLocator('text=Saved'), { text: 'Saved' });
		assert.deepStrictEqual(parseLocator('#new-todo'), { selector: '#new-todo' });
		assert.deepStrictEqual(parseLocator({ testid: 'save', nth: 1.7, exact: true }), { testId: 'save', nth: 1, exact: true });
		// A bare name means visible text.
		assert.deepStrictEqual(parseLocator({ name: 'Add' }), { text: 'Add' });
		assert.strictEqual(parseLocator({ exact: true }), undefined);
		assert.strictEqual(parseLocator(''), undefined);
		assert.strictEqual(describeLocator({ role: 'button', name: 'Add', exact: true }), 'button "Add", exact');
	});

	test('steps: canonical, flattened and shorthand forms', () => {
		const { steps, errors } = parseRunSteps([
			{ action: 'goto', url: 'http://localhost:4400' },
			{ action: 'fill', target: { label: 'Email' }, text: 'a@b.co' },
			{ action: 'click', role: 'button', name: 'Sign up' },
			{ click: 'text=Log in' },
			{ navigate: 'http://localhost:4400/x' },
			{ action: 'press', key: 'Enter' },
			{ action: 'assert', target: { role: 'status' }, expect: 'text', value: 'Account created' },
			{ action: 'assert', expect: 'url', value: '/x' },
			{ action: 'assert', text: 'Welcome' },
			{ action: 'wait', seconds: 0.5 },
			{ action: 'resize', width: 375 },
			{ action: 'check', target: 'label=Remember me' },
			{ action: 'fill', target: { placeholder: 'Email' }, nth: 1, text: 'x' },
		]);
		assert.deepStrictEqual(errors, []);
		assert.deepStrictEqual(steps.map(step => step.action), ['navigate', 'fill', 'click', 'click', 'navigate', 'press', 'assert', 'assert', 'assert', 'wait', 'resize', 'check', 'fill']);
		assert.deepStrictEqual(steps[12].target, { placeholder: 'Email', nth: 1 });
		assert.strictEqual(steps[1].clear, true);
		assert.deepStrictEqual(steps[2].target, { role: 'button', name: 'Sign up' });
		assert.deepStrictEqual(steps[3].target, { text: 'Log in' });
		assert.strictEqual(steps[4].url, 'http://localhost:4400/x');
		assert.deepStrictEqual(steps[6].assertion, { expect: 'text', target: { role: 'status' }, value: 'Account created', match: undefined, name: undefined });
		assert.strictEqual(steps[7].assertion!.expect, 'url');
		// "assert text Welcome" reads as "an element with that text is visible".
		assert.deepStrictEqual([steps[8].assertion!.expect, steps[8].assertion!.target], ['visible', { text: 'Welcome' }]);
		assert.strictEqual(steps[9].ms, 500);
		assert.deepStrictEqual([steps[10].width, steps[10].height], [375, 844]);
	});

	test('steps: every problem is reported, by step number', () => {
		const { errors } = parseRunSteps([
			{ action: 'click' },
			{ action: 'fly' },
			{ action: 'type', target: 'e1' },
			{ action: 'assert', expect: 'checked' },
			'click',
		]);
		assert.strictEqual(errors.length, 5);
		assert.match(errors[0], /^step 1: click needs a `target`/);
		assert.match(errors[1], /^step 2: unknown action "fly"/);
		assert.match(errors[2], /^step 3: type needs a `target` and `text`/);
		assert.match(errors[3], /^step 4: assert checked needs a `target`/);
		assert.match(errors[4], /^step 5: must be an object/);
		assert.match(parseRunSteps([]).errors[0], /non-empty array/);
	});

	test('assertions infer their expectation and accept aliases', () => {
		const { steps, errors } = parseRunSteps([
			{ action: 'expect', target: { text: 'Loading' }, state: 'gone', timeout: 2 },
			{ action: 'assert', target: { role: 'listitem' }, count: 2 },
			{ action: 'assert', expect: 'no errors' },
			{ action: 'assert', target: { role: 'heading' } },
			{ action: 'verify', target: { label: 'Email' }, expect: 'value', equals: 'a@b.co' },
		]);
		assert.deepStrictEqual(errors, []);
		assert.deepStrictEqual(steps.map(step => step.assertion!.expect), ['hidden', 'count', 'no_console_errors', 'visible', 'value']);
		assert.strictEqual(steps[0].timeoutMs, 2000);
		assert.strictEqual(steps[1].assertion!.value, 2);
		assert.strictEqual(steps[4].assertion!.match, 'equals');
		assert.strictEqual(describeStep(steps[4]), 'assert label "Email" value = "a@b.co"');
	});

	test('run log counts passed, failed and not-run steps', () => {
		const lines = formatRunLog([{ ok: true, line: 'navigate x', ms: 420 }, { ok: false, line: 'assert … — actual: 0', ms: 5000 }], 4, 5600);
		assert.strictEqual(lines[0], '### Run: 4 steps, 1 passed, 1 failed, 2 not run (5.6s)');
		assert.strictEqual(lines[1], '1. ✓ navigate x (0.4s)');
		assert.strictEqual(lines[2], '2. ✗ assert … — actual: 0 (5.0s)');
	});

	test('snapshot diff shows changed lines under their enclosing node', () => {
		const before = [
			'- role: document',
			'  name: Taskboard',
			'  ref: root',
			'  children:',
			'    - role: heading',
			'      name: Todos 0 remaining',
			'      ref: e4',
			'    - role: list',
			'      ref: e9',
			...Array.from({ length: 40 }, (_, i) => `    - role: text\n      name: filler ${i}`).join('\n').split('\n'),
		].join('\n');
		const after = before.replace('Todos 0 remaining', 'Todos 1 remaining').replace('      ref: e9', '      ref: e9\n      children:\n        - role: listitem\n          name: Buy milk\n          ref: e31');
		const diff = diffSnapshots(before, after);
		assert.ok(diff);
		assert.strictEqual(diff.removed, 1);
		assert.strictEqual(diff.added, 5);
		assert.match(diff.text, /^@@ in heading "Todos 1 remaining" \(e4\)$/m);
		assert.match(diff.text, /^@@ in list \(e9\)$/m);
		assert.match(diff.text, /\+ {10}name: Buy milk/);
		assert.deepStrictEqual(diffSnapshots(after, after), { text: '(no change)', added: 0, removed: 0 });
		// Mostly different: the caller sends the whole snapshot instead.
		assert.strictEqual(diffSnapshots('- role: document\n  name: A', '- role: document\n  name: B\n  ref: x'), undefined);
	});

	test('new tools are host tools that route to the browser, with read-only gates', () => {
		for (const name of ['browser_run', 'browser_status', 'browser_mock', 'browser_emulate', 'browser_audit']) {
			assert.ok(VOLT_HOST_TOOLS.some(tool => tool.name === name), name);
			assert.ok(isBrowserAutomationTool(name), name);
			assert.ok(isVoltHostTool(`mcp__volt__${name}`), name);
		}
		for (const tool of PLAYGROUND_TOOLS) {
			assert.ok(isVoltHostTool(`volt-${tool.name}: ${tool.name}`), tool.name);
			assert.ok(!isBrowserAutomationTool(tool.name), tool.name);
		}
		const local = 'http://localhost:4400/';
		assert.deepStrictEqual(browserToolVerdict(BROWSER_RUN_TOOL_NAME, { steps: [{ action: 'click', target: 'e1' }] }, 'ask', local), { kind: 'allow' });
		assert.strictEqual(browserToolVerdict(BROWSER_RUN_TOOL_NAME, { steps: [{ action: 'click', target: 'e1' }] }, 'ask', 'https://bank.example/').kind, 'ask');
		assert.strictEqual(browserToolVerdict(BROWSER_RUN_TOOL_NAME, { steps: [{ action: 'assert', expect: 'title', value: 'x' }] }, 'plan', 'https://bank.example/').kind, 'allow');
		assert.strictEqual(browserToolVerdict(BROWSER_RUN_TOOL_NAME, { url: 'https://example.com', steps: [{ action: 'snapshot' }] }, 'ask', local).kind, 'ask');
		assert.strictEqual(browserToolVerdict(BROWSER_RUN_TOOL_NAME, { steps: [{ action: 'evaluate', expression: '1' }] }, 'ask', local).kind, 'ask');
		assert.strictEqual(browserToolVerdict(BROWSER_RUN_TOOL_NAME, { steps: [{ action: 'evaluate', expression: '1' }] }, 'agent', 'https://bank.example/').kind, 'allow');
		assert.strictEqual(browserToolVerdict(BROWSER_MOCK_TOOL_NAME, { routes: [] }, 'ask', 'https://bank.example/').kind, 'ask');
		assert.strictEqual(browserToolVerdict(BROWSER_AUDIT_TOOL_NAME, {}, 'ask', 'https://bank.example/').kind, 'allow');
	});
});
