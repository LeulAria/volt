/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt P2/P8: the opt-in per extension (per profile, user settings) and the kill switch.
// P8-KILL-1: a refusal is shown with "Run Without Sandbox", the extension stays off until the user
// confirms that choice, and a refused confirmation changes nothing.

import assert from 'assert';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IConfirmation, IConfirmationResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, IPromptChoice, Severity } from '../../../../../platform/notification/common/notification.js';
import { VOLT_SANDBOXED_EXTENSIONS_SETTING, VOLT_UNSANDBOXED_EXTENSIONS_SETTING } from '../../../../../platform/voltSandbox/common/extensionHostSandbox.js';
import { IHostService } from '../../../host/browser/host.js';
import { VoltExtensionSandboxService } from '../../browser/voltExtensionSandboxService.js';

suite('Volt: per-extension sandbox opt-in and kill switch (P2, P8)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function service(confirm: boolean) {
		const config = new class extends TestConfigurationService {
			readonly writes: [string, unknown, ConfigurationTarget | undefined][] = [];
			override updateValue(key: string, value: unknown, target?: unknown): Promise<void> {
				this.writes.push([key, value, target as ConfigurationTarget]);
				return this.setUserConfiguration(key, value);
			}
		}();
		const prompts: { message: string; choices: IPromptChoice[] }[] = [];
		const confirmations: IConfirmation[] = [];
		const notifications = new class extends mock<INotificationService>() {
			override prompt(_severity: Severity, message: string, choices: IPromptChoice[]) {
				prompts.push({ message, choices });
				return undefined!;
			}
		};
		const dialogs = new class extends mock<IDialogService>() {
			override async confirm(confirmation: IConfirmation): Promise<IConfirmationResult> {
				confirmations.push(confirmation);
				return { confirmed: confirm };
			}
		};
		const s = store.add(new VoltExtensionSandboxService(config, notifications, dialogs, new class extends mock<IHostService>() { }, new NullLogService()));
		return { s, config, prompts, confirmations };
	}

	test('opting in writes the per-profile user setting; not opted in is the shared host as before', async () => {
		const { s, config } = service(true);
		assert.deepStrictEqual(s.state('pub.lint'), { kind: 'shared' });
		await s.setOptedIn('pub.lint', true);
		assert.deepStrictEqual(config.writes[0], [VOLT_SANDBOXED_EXTENSIONS_SETTING, ['pub.lint'], ConfigurationTarget.USER]);
		assert.ok(s.isOptedIn('PUB.LINT'));
		assert.strictEqual(s.state('pub.lint').kind, 'starting');
		s.report('pub.lint', { kind: 'sandboxed' });
		assert.strictEqual(s.state('pub.lint').kind, 'sandboxed');
		await s.setOptedIn('pub.lint', false);
		assert.deepStrictEqual(config.getValue(VOLT_SANDBOXED_EXTENSIONS_SETTING), []);
		assert.deepStrictEqual(s.state('pub.lint'), { kind: 'shared' });
	});

	test('P8-KILL-1: a refusal says why and stays off until the user confirms "Run Without Sandbox"', async () => {
		const refused = service(false);
		await refused.s.setOptedIn('pub.ui', true);
		refused.s.report('pub.ui', { kind: 'refused', code: 'server-off', reason: 'The agent server is off.' });
		assert.strictEqual(refused.prompts.length, 1, 'shown once');
		assert.match(refused.prompts[0].message, /pub\.ui stays off.*The agent server is off\./);
		assert.deepStrictEqual(refused.prompts[0].choices.map(c => c.label), ['Run Without Sandbox', 'Stop Sandboxing It']);
		refused.s.report('pub.ui', { kind: 'refused', code: 'server-off', reason: 'The agent server is off.' });
		assert.strictEqual(refused.prompts.length, 1, 'not again in this window');
		// The user is asked first; saying no changes nothing.
		await refused.prompts[0].choices[0].run();
		assert.strictEqual(refused.confirmations.length, 1);
		assert.match(String(refused.confirmations[0].detail), /The agent server is off\./);
		assert.deepStrictEqual(refused.config.getValue(VOLT_UNSANDBOXED_EXTENSIONS_SETTING) ?? [], []);
		assert.strictEqual(refused.s.state('pub.ui').kind, 'refused', 'still off');

		const confirmed = service(true);
		await confirmed.s.setOptedIn('pub.ui', true);
		confirmed.s.report('pub.ui', { kind: 'refused', code: 'ui-full-access', reason: 'It must run beside the window.' });
		assert.strictEqual(await confirmed.s.runWithoutSandbox('pub.ui'), true);
		assert.deepStrictEqual(confirmed.config.getValue(VOLT_UNSANDBOXED_EXTENSIONS_SETTING), ['pub.ui']);
		assert.deepStrictEqual(confirmed.s.state('pub.ui'), { kind: 'unsandboxed' });
		// Opting out clears that choice, so a later opt-in starts sandboxed again.
		await confirmed.s.setOptedIn('pub.ui', false);
		assert.deepStrictEqual(confirmed.config.getValue(VOLT_UNSANDBOXED_EXTENSIONS_SETTING), []);
	});
});
