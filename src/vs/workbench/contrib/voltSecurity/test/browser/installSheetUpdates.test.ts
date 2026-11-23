/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// UX-SHEET-UPD: updates and the install sheet (H.10, P4, G.9). An update that gains capabilities or
// `high` code-scan findings gets the sheet again; one the install side held (publisher, signature,
// capabilities, code) is applied only after the user says Update on a sheet that says why; and an
// extension Volt runs sandboxed by default but can't sandbox here is chosen for once, at install.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstallOptions } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { heldUpdateMessage, IVoltHeldUpdate, VOLT_UPDATE_APPROVED_CONTEXT } from '../../../../../platform/extensionManagement/common/voltExtensionLock.js';
import { IExtensionDescription } from '../../../../../platform/extensions/common/extensions.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ICodeScanFinding } from '../../../../../platform/voltPlugins/common/extensionCodeScan.js';
import { GestureTokenRegistry } from '../../../../../platform/voltSandbox/common/trust.js';
import { setVoltInstallReview, voltWithHeldUpdateReview } from '../../../../services/extensionManagement/common/voltInstallReview.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { heldUpdateReason, IInstallSheetRequest, InstallSheetPlace, installSheetGroups, installSheetPlan, showInstallSheet } from '../../browser/installSheet.js';

const SUBJECT = 'plugin:acme.lint@local';

const finding = (evidence: string): ICodeScanFinding => ({ rule: 'invisible-code', severity: 'high', file: 'out/extension.js', line: 3, evidence, count: 1 });

suite('Volt install sheet: updates (UX-SHEET-UPD)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('UX-SHEET-UPD-1: an update that gains a capability or a high finding gets the sheet again (a new key); an unchanged one does not', () => {
		const v1 = installSheetGroups({ contributes: { voltCapabilities: { optional: [{ id: 'agents.read:any' }] } } as unknown as IExtensionDescription['contributes'] });
		const v2 = installSheetGroups({ contributes: { voltCapabilities: { optional: [{ id: 'agents.read:any' }, { id: 'agents.send' }] } } as unknown as IExtensionDescription['contributes'] });
		const shownForV1 = installSheetPlan({ subject: SUBJECT, groups: v1, high: [], reviewed: false, sandboxed: false })!;
		assert.ok(shownForV1, 'the first version declares a capability');
		assert.strictEqual(installSheetPlan({ subject: SUBJECT, groups: v1, high: [], reviewed: false, sandboxed: false })!.key, shownForV1.key, 'same declared set: the stored key says it was shown');
		assert.notStrictEqual(installSheetPlan({ subject: SUBJECT, groups: v2, high: [], reviewed: false, sandboxed: false })!.key, shownForV1.key, 'a new capability: asked again');

		// Code: nothing found, then an update with a hidden payload, while it runs with the user's access.
		assert.strictEqual(installSheetPlan({ subject: SUBJECT, groups: [], high: [], reviewed: true, sandboxed: false }), undefined);
		const payload = installSheetPlan({ subject: SUBJECT, groups: [], high: [finding('variation selectors in a string')], reviewed: true, sandboxed: false })!;
		assert.ok(payload, 'the update with new code gets the sheet');
		assert.notStrictEqual(installSheetPlan({ subject: SUBJECT, groups: [], high: [finding('bidi controls left open in a comment')], reviewed: true, sandboxed: false })!.key, payload.key, 'different findings: a different key');
		// Reviewed and sandboxed before install: said once, nothing to grant.
		assert.deepStrictEqual(installSheetPlan({ subject: SUBJECT, groups: v1, high: [finding('variation selectors in a string')], reviewed: true, sandboxed: true })!.groups, []);
	});

	test('UX-SHEET-UPD-2: a held update waits for the user: Update installs it with that version approved, Cancel keeps the installed one', async () => {
		const held: IVoltHeldUpdate = { id: 'acme.lint', version: '2.0.0', installedVersion: '1.0.0', publisher: 'acme', concerns: [{ kind: 'publisher-changed', from: 'Acme', to: 'Someone Else' }] };
		let approve = true;
		const asked: string[] = [];
		const hook = setVoltInstallReview({ review: async () => true, reviewHeldUpdate: async h => { asked.push(`${h.id}@${h.version}`); return approve; } });
		try {
			const runs: (InstallOptions | undefined)[] = [];
			const install = (options: InstallOptions | undefined) => {
				runs.push(options);
				// The install side holds it until the approval for exactly this version comes with it.
				return options?.context?.[VOLT_UPDATE_APPROVED_CONTEXT] === 'acme.lint@2.0.0' ? Promise.resolve('installed') : Promise.reject(new Error(heldUpdateMessage(held)));
			};
			assert.strictEqual(await voltWithHeldUpdateReview({ isApplicationScoped: true }, install), 'installed');
			assert.deepStrictEqual(asked, ['acme.lint@2.0.0']);
			assert.strictEqual(runs.length, 2);
			assert.strictEqual(runs[1]?.isApplicationScoped, true, 'the original options are kept');

			approve = false;
			await assert.rejects(voltWithHeldUpdateReview(undefined, install), (error: unknown) => error instanceof CancellationError, 'Cancel: nothing installed');
			// Errors that are not a hold are not turned into a question.
			await assert.rejects(voltWithHeldUpdateReview(undefined, () => Promise.reject(new Error('Download failed'))), /Download failed/);
			assert.strictEqual(asked.length, 2);
		} finally {
			hook.dispose();
		}
	});

	function render(request: Partial<IInstallSheetRequest>) {
		const disposables = store.add(new DisposableStore());
		const instantiation = workbenchInstantiationService(undefined, disposables);
		const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		disposables.add({ dispose: () => container.remove() });
		const answers: [boolean, InstallSheetPlace | undefined][] = [];
		disposables.add(showInstallSheet({ activeContainer: container } as Partial<ILayoutService> as ILayoutService, instantiation, {
			extensionName: 'Lint',
			publisher: 'acme',
			groups: [],
			gesture: { registry: new GestureTokenRegistry(), principal: SUBJECT },
			...request,
		}, (allowed, _gesture, place) => answers.push([allowed, place])));
		const text = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)].map(element => element.textContent ?? '');
		return { container, answers, text };
	}

	test('UX-SHEET-UPD-3: the held update\'s sheet says why first and its button is Update', () => {
		const held: IVoltHeldUpdate = {
			id: 'acme.lint', version: '2.0.0', installedVersion: '1.0.0', publisher: 'acme',
			concerns: [
				{ kind: 'publisher-unverified', publisher: 'acme' },
				{ kind: 'signature-worse', from: 'Success', to: 'NotSigned' },
				{ kind: 'capabilities', added: ['agents.send'] },
				{ kind: 'code', added: ['invisible-code: variation selectors in a string'] },
			],
		};
		const reasons = held.concerns.map(concern => heldUpdateReason(concern, held));
		assert.deepStrictEqual(reasons, [
			'Its publisher, acme, was verified when you installed it and is not now.',
			'Version 1.0.0 was signed (Success); version 2.0.0 is not (NotSigned).',
			'Version 2.0.0 asks for Volt features 1.0.0 didn\'t: agents.send.',
			'Version 2.0.0 has code that hides what it does, which 1.0.0 didn\'t have (1 new findings, listed below).',
		]);
		const { container, answers, text } = render({
			findings: [{ severity: 'high', text: 'hides code in characters an editor doesn\'t show (variation selectors in a string)', where: 'out/extension.js:3' }],
			install: { heldBecause: reasons },
		});
		assert.deepStrictEqual(text('h2'), ['Update Lint?']);
		assert.deepStrictEqual(text('.volt-install-sheet-held .title'), ['Volt held this update for you']);
		assert.deepStrictEqual(text('.volt-install-sheet-held .detail'), reasons);
		assert.deepStrictEqual(text('.volt-add-footer .monaco-button'), ['Cancel', 'Update']);
		container.querySelector<HTMLElement>('.volt-add-footer .allow')!.click();
		assert.deepStrictEqual(answers, [[true, undefined]]);
	});

	test('UX-SHEET-UPD-4: sandboxed by default but not sandboxable here: the choice is made at install, and Keep it off is what Install keeps', () => {
		const { container, answers, text } = render({ install: { sandbox: { available: false, reason: 'It must run beside Volt\'s window.', stayOff: true } } });
		assert.match(text('.volt-install-sheet-where .detail')[0], /can't run it in a sandbox here: It must run beside Volt's window\. It is installed but stays off\./);
		assert.ok(container.querySelector('.volt-install-sheet-place'), 'a choice: keep it off, or run it with your access');
		container.querySelector<HTMLElement>('.volt-add-footer .allow')!.click();
		assert.deepStrictEqual(answers, [[true, 'off']], 'never silently unsandboxed');
	});
});
