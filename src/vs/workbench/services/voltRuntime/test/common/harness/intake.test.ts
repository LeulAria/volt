/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { intake, normalizeRequest } from '../../../common/harness/intake.js';

suite('Volt request intake', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('strips a slash command and keeps the body', () => {
		const request = normalizeRequest('/fast rename foo in a.ts');
		assert.strictEqual(request.slash, 'fast');
		assert.strictEqual(request.text, 'rename foo in a.ts');
		assert.ok(request.raw.startsWith('/fast'));
	});

	test('a price question wants web, not the workspace', () => {
		const taken = intake('how much is a Nissan Kicks in the UAE', 'agent');
		assert.strictEqual(taken.intent.lane, 'chat');
		assert.strictEqual(taken.signals.webRequired, true);
		assert.strictEqual(taken.signals.workspaceRequired, false);
		assert.strictEqual(taken.signals.autonomy, 'supervised');
		assert.strictEqual(taken.signals.risk, 'safe');
	});

	test('preview and destructive asks raise the matching signals', () => {
		const preview = intake('run the app and show me in the browser', 'agent', { hasWorkspace: true });
		assert.strictEqual(preview.signals.browserRequired, true);
		assert.strictEqual(preview.signals.workspaceRequired, true);

		const danger = intake('delete the production database', 'agent', { hasWorkspace: true });
		assert.strictEqual(danger.signals.risk, 'critical');
		assert.ok(danger.signals.autonomy !== 'supervised' || danger.intent.lane === 'chat');
	});

	test('the user can force supervised autonomy', () => {
		const taken = intake('add a logout button but ask me before you edit', 'agent', { hasWorkspace: true });
		assert.strictEqual(taken.signals.autonomy, 'supervised');
	});
});
