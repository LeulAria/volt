/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { fillVars, formatActScript, parseActScript } from '../../../common/tools/actScript.js';
import { IActStep } from '../../../common/tools/pageModel.js';

function steps(script: string, vars?: Record<string, string>): readonly IActStep[] {
	const parsed = parseActScript(script, vars);
	if ('error' in parsed) {
		throw new Error(parsed.error);
	}
	return parsed.steps;
}

function error(script: string): string {
	const parsed = parseActScript(script);
	return 'error' in parsed ? parsed.error : '';
}

suite('Act script', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads a sign-in flow', () => {
		assert.deepStrictEqual(steps(`
			goto http://localhost:3000/login
			type "Email" ada@example.com
			type "Password" \${pw}
			check "Remember me"
			click button "Sign in" => "Welcome back, Ada" and url /dashboard
		`, { pw: 'correct horse' }), [
			{ action: 'navigate', url: 'http://localhost:3000/login' },
			{ action: 'type', target: { label: 'Email' }, text: 'ada@example.com' },
			{ action: 'type', target: { label: 'Password' }, text: 'correct horse' },
			{ action: 'check', target: { label: 'Remember me' } },
			{ action: 'click', target: { role: 'button', name: 'Sign in' }, expect: { text: 'Welcome back, Ada', url: '/dashboard' } },
		]);
	});

	test('targets: refs, roles, within, nth, exact, css, bare roles', () => {
		assert.deepStrictEqual(steps('click e12')[0].target, { ref: 'e12' });
		assert.deepStrictEqual(steps('tap d4')[0].target, { ref: 'd4' });
		assert.deepStrictEqual(steps('click button "Delete" in "Project A"')[0].target, { role: 'button', name: 'Delete', within: { text: 'Project A' } });
		assert.deepStrictEqual(steps('click "Delete" in row "Project A" #1 exact')[0].target, { text: 'Delete', within: { role: 'row', name: 'Project A' }, nth: 1, exact: true });
		assert.deepStrictEqual(steps('click css ".save-btn"')[0].target, { selector: '.save-btn' });
		assert.deepStrictEqual(steps('click css=#go')[0].target, { selector: '#go' });
		assert.deepStrictEqual(steps('check checkbox in "Walk dog"')[0].target, { role: 'checkbox', within: { text: 'Walk dog' } });
		assert.deepStrictEqual(steps("click 'Sign in'")[0].target, { text: 'Sign in' });
	});

	test('text after the target is typed as is; "in" that is not a target stays text', () => {
		assert.deepStrictEqual(steps('type "Notes" in progress, see doc')[0], { action: 'type', target: { label: 'Notes' }, text: 'in progress, see doc' });
		assert.deepStrictEqual(steps('submit "Search" lamp')[0], { action: 'type', target: { label: 'Search' }, text: 'lamp', submit: true });
		assert.deepStrictEqual(steps('type "Bio" "  padded  "')[0].text, '  padded  ');
		assert.deepStrictEqual(steps('type textbox "Search settings" dark theme')[0].target, { role: 'textbox', name: 'Search settings' });
	});

	test('waits, expectations, scrolls, keys, selects, optional steps and flows', () => {
		assert.deepStrictEqual(steps('wait 500ms')[0], { action: 'wait', ms: 500 });
		assert.deepStrictEqual(steps('wait gone "Loading"')[0], { action: 'wait', expect: { textGone: 'Loading' }, timeoutMs: 10_000 });
		assert.deepStrictEqual(steps('expect count listitem in "Todos" 2')[0], { action: 'expect', expect: { target: { role: 'listitem', within: { text: 'Todos' } }, count: 2 } });
		assert.deepStrictEqual(steps('expect "Remember me" checked')[0].expect, { target: { text: 'Remember me' }, state: 'checked' });
		assert.deepStrictEqual(steps('expect textbox "Email" = "a@b.co"')[0].expect, { target: { role: 'textbox', name: 'Email' }, value: 'a@b.co' });
		assert.deepStrictEqual(steps('scroll down until "Display"')[0], { action: 'scroll', deltaY: 600, until: { text: 'Display' } });
		assert.deepStrictEqual(steps('scroll up 300')[0], { action: 'scroll', deltaY: -300 });
		assert.deepStrictEqual(steps('press Meta+a in "Search"')[0], { action: 'press', key: 'Meta+a', target: { label: 'Search' } });
		assert.deepStrictEqual(steps('select "Country" Germany')[0], { action: 'select', target: { label: 'Country' }, values: ['Germany'] });
		assert.deepStrictEqual(steps('select "Toppings" "Ham" "Olives"')[0].values, ['Ham', 'Olives']);
		assert.deepStrictEqual(steps('? click "Accept cookies"')[0], { action: 'click', target: { text: 'Accept cookies' }, optional: true });
		assert.deepStrictEqual(steps('run sign-in email=ada@example.com')[0], { action: 'flow', flow: 'sign-in', vars: { email: 'ada@example.com' } });
	});

	test('desktop menus and chords', () => {
		assert.deepStrictEqual(steps('menu File > Export > "PDF…"')[0], { action: 'menu', values: ['File', 'Export', 'PDF…'] });
		assert.deepStrictEqual(steps('press cmd+shift+s')[0], { action: 'press', key: 'cmd+shift+s' });
		assert.deepStrictEqual(steps('open Notes')[0], { action: 'navigate', url: 'Notes' });
		assert.match(error('menu'), /menu needs a path/);
		assert.deepStrictEqual(steps(formatActScript(steps('menu Edit > Find > Find…'))), steps('menu Edit > Find > Find…'));
	});

	test('several steps on one line, comments and blank lines', () => {
		assert.deepStrictEqual(steps('# sign up\ntype "Name" Ada; type "Email" a@b.co ; click "Next"\n\n// done').map(step => step.action), ['type', 'type', 'click']);
		assert.deepStrictEqual(steps('type "Note" a; b').map(step => step.text), ['a; b'], 'a ; not followed by a step word is text');
		assert.deepStrictEqual(steps('type "Note" "x; click y"').length, 1, 'a ; inside quotes is text');
	});

	test('errors name the line', () => {
		assert.match(error('teleport "home"'), /unknown step "teleport"/);
		assert.match(error('click'), /expected a target/);
		assert.match(error('click "Save'), /unclosed quote/);
		assert.match(error('click "Save" now'), /unexpected "now"/);
		assert.match(error('select "Country"'), /select needs a value/);
		assert.match(error('expect "a" and "b"'), /two text conditions/);
		assert.match(error(''), /no steps/);
		assert.deepStrictEqual(fillVars('type "P" ${pw}', {}), { error: 'missing value for ${pw}: pass vars' });
	});

	test('round-trips JSON steps through the script form', () => {
		const original = steps(`goto http://localhost:5173
type "Email" ada@example.com
submit "Search" lamp
check checkbox in "Walk dog"
click button "Delete" in "Buy milk" => gone "Buy milk"
select "Country" "Germany"
scroll down until "Footer"
wait 200ms
expect count listitem 2
? click "Dismiss"
run sign-in`);
		assert.deepStrictEqual(steps(formatActScript(original)), original);
	});
});
