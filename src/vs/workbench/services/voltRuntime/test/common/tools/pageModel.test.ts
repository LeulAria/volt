/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { browserToolVerdict } from '../../../common/hostTools.js';
import { actionEffect, describeEffect, describeStep, diffPage, formatPageNode, hadNoEffect, IPageNode, IPageView, observePage, parseActSteps, parseLocator, renderPage } from '../../../common/tools/pageModel.js';

function page(nodes: IPageNode[], doc = 'd1'): IPageView {
	return { doc, url: 'http://localhost:3000/', title: 'App', nodes };
}

const FORM: IPageNode[] = [
	{ role: 'heading', name: 'Sign in', level: 1, ref: 'e1', depth: 0, parent: 'root' },
	{ role: 'form', ref: 'e2', depth: 0, parent: 'root' },
	{ role: 'textbox', name: 'Email', ref: 'e3', depth: 1, parent: 'e2' },
	{ role: 'checkbox', name: 'Remember me', ref: 'e4', depth: 1, parent: 'e2', states: ['unchecked'] },
	{ role: 'button', name: 'Sign in', ref: 'e5', depth: 1, parent: 'e2' },
	{ role: 'text', name: 'Forgot password?', depth: 1, parent: 'e2' },
];

suite('Page model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('renders one compact line per node, indented by depth', () => {
		assert.deepStrictEqual(renderPage(page(FORM)), [
			'- heading "Sign in" [level=1] [ref=e1]',
			'- form [ref=e2]:',
			'  - textbox "Email" [ref=e3]',
			'  - checkbox "Remember me" [unchecked] [ref=e4]',
			'  - button "Sign in" [ref=e5]',
			'  - text: Forgot password?',
		]);
		assert.strictEqual(formatPageNode({ role: 'textbox', name: 'Email', ref: 'e3', depth: 0, value: 'a@b.co' }), 'textbox "Email" [ref=e3]: "a@b.co"');
		assert.strictEqual(formatPageNode({ role: 'link', name: 'Docs', ref: 'e9', depth: 0, url: '/docs' }), 'link "Docs" [ref=e9] -> /docs');
	});

	test('diffs by ref: values and states change in place, new nodes keep their container', () => {
		const after = page([
			...FORM.slice(0, 2),
			{ ...FORM[2], value: 'a@b.co' },
			{ ...FORM[3], states: ['checked'] },
			FORM[4],
			{ role: 'alert', ref: 'e9', depth: 1, parent: 'e2' },
			{ role: 'text', name: 'Wrong password', depth: 2, parent: 'e9' },
		]);
		const diff = diffPage(page(FORM), after);
		assert.strictEqual(diff.changed.length, 2);
		assert.deepStrictEqual(diff.added.map(node => node.role), ['alert', 'text']);
		assert.deepStrictEqual(diff.removed.map(node => node.name), ['Forgot password?']);
		const observed = observePage(page(FORM), after);
		assert.strictEqual(observed.kind, 'diff');
		const text = observed.lines.join('\n');
		assert.ok(text.includes('~ textbox "Email" [ref=e3]: "a@b.co" (was empty)'), text);
		assert.ok(text.includes('~ checkbox "Remember me" [checked] [ref=e4] (was unchecked)'), text);
		assert.ok(text.includes('+ in form [ref=e2]:'), text);
		assert.ok(text.includes('+   - alert [ref=e9]'), text);
		assert.ok(text.includes('+     - text: Wrong password'), text);
		assert.ok(text.includes('- removed: text: Forgot password?'), text);
	});

	test('a removed container hides its descendants from the removed list', () => {
		const before = page([...FORM, { role: 'dialog', name: 'Cookies', ref: 'e7', depth: 0, parent: 'root' }, { role: 'button', name: 'Accept', ref: 'e8', depth: 1, parent: 'e7' }]);
		const diff = diffPage(before, page(FORM));
		assert.deepStrictEqual(diff.removed.map(node => node.ref), ['e7']);
	});

	test('reads the whole page on a new document, nothing when unchanged', () => {
		assert.strictEqual(observePage(undefined, page(FORM)).kind, 'full');
		assert.strictEqual(observePage(page(FORM), page(FORM, 'd2')).kind, 'full');
		assert.strictEqual(observePage(page(FORM), page(FORM)).kind, 'same');
		assert.strictEqual(observePage(page(FORM), page(FORM), 'full').kind, 'full');
	});

	test('falls back to the full page when most of it changed', () => {
		const big = (prefix: string) => page(Array.from({ length: 80 }, (_, i) => ({ role: 'button', name: `${prefix} ${i}`, ref: `${prefix}${i}`, depth: 0, parent: 'root' })));
		assert.strictEqual(observePage(big('a'), big('b')).kind, 'full');
	});

	test('folds long runs of look-alike siblings to their head and tail', () => {
		const rows: IPageNode[] = [{ role: 'table', name: 'Products', ref: 't', depth: 0, parent: 'root' }];
		for (let i = 0; i < 30; i++) {
			rows.push({ role: 'row', name: `Item ${i}`, ref: `r${i}`, depth: 1, parent: 't' });
			rows.push({ role: 'cell', name: `Item ${i}`, ref: `c${i}`, depth: 2, parent: `r${i}` });
		}
		const lines = renderPage(page(rows));
		assert.strictEqual(lines.length, 1 + 10 * 2 + 1);
		assert.strictEqual(lines[0], '- table "Products" [ref=t]:');
		assert.strictEqual(lines[17], '  - …20 more rows like these (folded: act on them by their text, or browser_snapshot with a selector or unfold: true)');
		assert.strictEqual(lines[18], '  - row "Item 28" [ref=r28]:');
		assert.strictEqual(renderPage(page(rows), { unfold: true }).length, 61);
		// The rows are all still there to diff against: a change in a folded row is reported.
		const changed = rows.map(node => node.ref === 'c15' ? { ...node, name: 'Sold out' } : node);
		assert.deepStrictEqual(observePage(page(rows), page(changed)).lines.filter(line => line.startsWith('~')), ['~ cell "Sold out" [ref=c15] (name was "Item 15")']);
	});

	test('parses locators from strings and objects', () => {
		assert.deepStrictEqual(parseLocator('e12'), { ref: 'e12' });
		assert.deepStrictEqual(parseLocator('Sign in'), { text: 'Sign in' });
		assert.deepStrictEqual(parseLocator({ role: 'Button', name: 'Save' }), { role: 'button', name: 'Save' });
		assert.deepStrictEqual(parseLocator({ name: 'Save' }), { text: 'Save' });
		assert.deepStrictEqual(parseLocator({ role: 'button', name: 'Delete', within: { text: 'Project A' } }), { role: 'button', name: 'Delete', within: { text: 'Project A' } });
		assert.strictEqual(parseLocator({}), undefined);
		assert.strictEqual(parseLocator(42), undefined);
	});

	test('validates steps before running any of them', () => {
		const ok = parseActSteps([
			{ action: 'fill', target: { label: 'Email' }, text: 'a@b.co' },
			{ action: 'click', target: 'Sign in', expect: { url: '/dashboard' } },
			{ action: 'wait', text: 'Welcome' },
			{ action: 'expect', target: { role: 'listitem' }, count: 3 },
			{ action: 'dblclick', target: 'e4' },
		]);
		assert.ok('steps' in ok);
		assert.deepStrictEqual(ok.steps.map(step => step.action), ['type', 'click', 'wait', 'expect', 'click']);
		assert.deepStrictEqual(ok.steps[1].expect, { url: '/dashboard' });
		assert.deepStrictEqual(ok.steps[2].expect, { text: 'Welcome' });
		assert.deepStrictEqual(ok.steps[3].expect, { target: { role: 'listitem' }, count: 3 });
		assert.strictEqual(ok.steps[4].double, true);
		assert.strictEqual(describeStep(ok.steps[0]), 'type into label "Email"');

		const bad = (steps: unknown) => { const r = parseActSteps(steps); return 'error' in r ? r.error : ''; };
		assert.match(bad([]), /non-empty array/);
		assert.match(bad([{ action: 'click' }]), /^Step 1: click needs `target`/);
		assert.match(bad([{ action: 'type', target: 'e1' }]), /needs `text`/);
		assert.match(bad([{ action: 'teleport' }]), /unknown action/);
		assert.match(bad([{ action: 'expect', state: 'checked' }]), /need expect.target|needs a condition/);
		assert.match(bad(Array.from({ length: 31 }, () => ({ action: 'reload' }))), /at most 30/);
	});

	test('tells what an action did from the page counters', () => {
		const before = { doc: 'a', url: 'http://x/', mut: 10, req: 1, focus: '' };
		assert.strictEqual(describeEffect(actionEffect(before, { ...before, mut: 14, req: 2, inflight: 0, quiet: true })), '4 DOM changes, 1 request');
		assert.strictEqual(describeEffect(actionEffect(before, { ...before, doc: 'b', url: 'http://x/home', mut: 0, req: 0 })), 'loaded /home');
		const none = actionEffect(before, { ...before, quiet: true })!;
		assert.ok(hadNoEffect(none));
		assert.strictEqual(describeEffect(none), 'no visible effect');
		assert.strictEqual(describeEffect(actionEffect(before, { ...before, req: 2, inflight: 1, quiet: false })), '1 request, 1 still pending');
		assert.strictEqual(describeEffect(actionEffect({ ...before, dialogs: [{ n: 1, text: 'alert: old' }] }, { ...before, dialogs: [{ n: 1, text: 'alert: old' }, { n: 2, text: 'confirm: Delete?' }] })), 'page dialog: "confirm: Delete?"');
		assert.strictEqual(describeEffect(undefined), 'effect unknown (the page did not answer)');
	});

	test('browser_act needs approval in read-only modes where its parts would', () => {
		const kind = (steps: unknown[], page?: string) => browserToolVerdict('browser_act', { steps }, 'ask', page).kind;
		const click = { action: 'click', target: 'Save' };
		assert.strictEqual(kind([click], 'http://localhost:3000/'), 'allow');
		assert.strictEqual(kind([click], 'https://github.com/'), 'ask');
		assert.strictEqual(kind([{ action: 'navigate', url: 'https://example.com' }]), 'ask');
		assert.strictEqual(kind([{ action: 'navigate', url: 'http://localhost:5173' }, click], 'https://github.com/'), 'allow');
		assert.strictEqual(kind([{ action: 'expect', text: 'Hi' }], 'https://github.com/'), 'allow');
		assert.strictEqual(browserToolVerdict('browser_act', { steps: [click] }, 'agent', 'https://github.com/').kind, 'allow');
	});
});
