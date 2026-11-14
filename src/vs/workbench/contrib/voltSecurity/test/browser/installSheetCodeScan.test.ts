/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// UX-SHEET-LAB: the install sheet for the Agent Lab example (docs/volt/examples/volt-agent-lab):
// its 9 declared capabilities by class with the extension's reasons, Allow granting the medium ones;
// and the code scan's findings on the sheet, with "Run in a Sandbox" while it runs with the user's
// access.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IExtensionDescription } from '../../../../../platform/extensions/common/extensions.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { GestureTokenRegistry } from '../../../../../platform/voltSandbox/common/trust.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { installSheetDrafts, installSheetGroups, showInstallSheet } from '../../browser/installSheet.js';

/** `contributes.voltCapabilities` of docs/volt/examples/volt-agent-lab/package.json (the node test checks the file itself). */
const AGENT_LAB: Record<string, unknown> = {
	voltCapabilities: {
		required: [
			{ id: 'tools.register', class: 'low', reason: 'Serves agent_lab_dependencies, so agents can read the dependency report.' },
			{ id: 'files.read:workspace', class: 'low', reason: 'Reads package.json in the open project to know its dependencies.' },
			{ id: 'net.connect', class: 'low', targets: ['registry.npmjs.org'], reason: 'Asks the npm registry for each dependency\'s latest version.' },
			{ id: 'agents.read:current', class: 'low', reason: 'Offers the chat you have in front first when you hand off the plan.' },
		],
		optional: [
			{ id: 'agents.read:any', class: 'medium', reason: 'Lists your chats so you can pick which agent gets the upgrade plan, and counts the plan\'s finished turns.' },
			{ id: 'agents.send', class: 'medium', reason: 'Sends the upgrade plan to the chat you pick, lists the models you can start one with, and draws the plan on Scratch.' },
			{ id: 'agents.create', class: 'high', reason: 'Starts a new chat with the model you pick for the upgrade.' },
			{ id: 'agents.context', class: 'high', reason: 'Saves a memory note with the outdated packages, so later chats know about them.' },
			{ id: 'browser.drive', class: 'high', reason: 'Opens a package\'s npm page in Volt\'s browser when you ask.' },
		],
	},
};

suite('Volt install sheet: Agent Lab and the code scan (UX-SHEET-LAB)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('UX-SHEET-LAB-1: every declared capability is listed by class with its reason; Allow grants the two medium ones', () => {
		const groups = installSheetGroups({ contributes: AGENT_LAB as IExtensionDescription['contributes'] });
		assert.deepStrictEqual(groups.map(group => [group.class, group.capabilities.map(entry => `${entry.id}${entry.required ? '' : '?'}${entry.targets ? ` ${entry.targets.join(',')}` : ''}`)]), [
			['low', ['tools.register', 'files.read:workspace', 'net.connect registry.npmjs.org', 'agents.read:current']],
			['medium', ['agents.read:any?', 'agents.send?']],
			['high', ['agents.create?', 'agents.context?', 'browser.drive?']],
		]);
		assert.ok(groups.every(group => group.capabilities.every(entry => entry.reason)), 'each shows the extension\'s own reason');
		assert.deepStrictEqual(installSheetDrafts('plugin:volt-examples.volt-agent-lab@local', groups, 1).map(draft => draft.capability), ['agents.read:any@1', 'agents.send@1']);
	});

	function render(findings: boolean, runInSandbox?: () => void) {
		const disposables = store.add(new DisposableStore());
		const instantiation = workbenchInstantiationService(undefined, disposables);
		const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		disposables.add({ dispose: () => container.remove() });
		const answers: boolean[] = [];
		disposables.add(showInstallSheet({ activeContainer: container } as Partial<ILayoutService> as ILayoutService, instantiation, {
			extensionName: 'Agent Lab',
			publisher: 'volt-examples',
			groups: installSheetGroups({ contributes: AGENT_LAB as IExtensionDescription['contributes'] }),
			gesture: { registry: new GestureTokenRegistry(), principal: 'plugin:volt-examples.volt-agent-lab@local' },
			...(findings ? {
				findings: [
					{ severity: 'high' as const, text: 'builds a sensitive name from pieces to hide it (eval, child_process)', where: 'out/testFixture/fixture.js:220' },
					{ severity: 'medium' as const, text: 'starts other programs (child_process)', where: 'out/testFixture/fixture.js:160' },
				],
			} : {}),
			...(runInSandbox ? { runInSandbox } : {}),
		}, allowed => answers.push(allowed)));
		const text = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)].map(element => element.textContent ?? '');
		return { container, answers, text };
	}

	test('UX-SHEET-LAB-2: the code scan\'s findings come first, the hidden ones marked; Run in a Sandbox opts in and keeps the sheet', () => {
		const opted: string[] = [];
		const { container, text } = render(true, () => opted.push('sandbox'));
		const rows = [...container.querySelectorAll<HTMLElement>('.monaco-list-row')].map(row => row.textContent ?? '');
		assert.ok(rows[0].startsWith('Found in its code'), rows[0]);
		assert.ok(rows[0].includes('It runs with your access'), rows[0]);
		assert.ok(rows[1].includes('Builds a sensitive name from pieces to hide it') && rows[1].includes('fixture.js:220'), rows[1]);
		assert.strictEqual(container.querySelectorAll('.volt-install-sheet-capability.high').length, 1, 'only the high finding is marked');
		assert.ok(rows[3].startsWith('Low'), 'the capabilities follow');
		assert.deepStrictEqual(text('.volt-add-footer .monaco-button'), ['Run in a Sandbox', 'Don\'t Allow', 'Allow']);
		container.querySelector<HTMLElement>('.volt-add-footer .sandbox')!.click();
		assert.deepStrictEqual(opted, ['sandbox']);
		assert.deepStrictEqual(text('.volt-add-footer .sandbox'), ['Sandbox On After Reload']);
		assert.ok(container.querySelector('.volt-install-sheet'), 'the sheet stays for the permissions');
	});

	test('UX-SHEET-LAB-3: without findings, or once sandboxed, the sheet is as before', () => {
		const clean = render(false);
		assert.ok(!clean.text('.monaco-list-row')[0].startsWith('Found in its code'));
		assert.deepStrictEqual(clean.text('.volt-add-footer .monaco-button'), ['Don\'t Allow', 'Allow']);
		clean.container.remove();
		const sandboxed = render(true);
		assert.ok(sandboxed.text('.monaco-list-row')[0].includes('It runs in Volt\'s sandbox'));
		assert.deepStrictEqual(sandboxed.text('.volt-add-footer .monaco-button'), ['Don\'t Allow', 'Allow']);
	});

	test('UX-SHEET-LAB-4: reviewed and sandboxed before install, the findings alone are said once: no permission rows, only OK', () => {
		const disposables = store.add(new DisposableStore());
		const instantiation = workbenchInstantiationService(undefined, disposables);
		const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		disposables.add({ dispose: () => container.remove() });
		const answers: boolean[] = [];
		disposables.add(showInstallSheet({ activeContainer: container } as Partial<ILayoutService> as ILayoutService, instantiation, {
			extensionName: 'Agent Lab',
			publisher: 'volt-examples',
			groups: [],
			gesture: { registry: new GestureTokenRegistry(), principal: 'plugin:volt-examples.volt-agent-lab@local' },
			findings: [{ severity: 'high', text: 'builds a sensitive name from pieces to hide it (eval, child_process)', where: 'out/testFixture/fixture.js:220' }],
		}, allowed => answers.push(allowed)));
		const text = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)].map(element => element.textContent ?? '');
		assert.deepStrictEqual(text('h2'), ['What Volt found in Agent Lab\'s code']);
		const rows = text('.monaco-list-row');
		assert.strictEqual(rows.length, 2, rows.join(' | '));
		assert.ok(rows[0].includes('It runs in Volt\'s sandbox'), rows[0]);
		assert.deepStrictEqual(text('.volt-add-footer .monaco-button'), ['OK']);
		container.querySelector<HTMLElement>('.volt-add-footer .deny')!.click();
		assert.deepStrictEqual(answers, [false], 'OK grants nothing');
	});
});
