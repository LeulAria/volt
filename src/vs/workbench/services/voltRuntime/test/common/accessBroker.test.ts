/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { evaluateAccess } from '../../common/access/accessBroker.js';
import { modeOverlay, presetRules, SYSTEM_HARD_DENY } from '../../common/access/accessPresets.js';
import { IAccessRequest, ICompiledPolicy } from '../../common/access/accessTypes.js';
import { compilePolicy } from '../../common/access/policyCompiler.js';
import { classifyRisk } from '../../common/access/riskClassifier.js';

function req(action: IAccessRequest['action'], resource: string, extras: Partial<IAccessRequest> = {}): IAccessRequest {
	return {
		id: extras.id ?? 'r1',
		sessionId: 's1',
		runId: 'run1',
		providerId: extras.providerId ?? 'codex',
		action,
		resource: { type: action === 'shell' ? 'command' : 'file', value: resource },
		risk: extras.risk ?? classifyRisk(action, resource),
		createdAt: 0,
		...extras,
	};
}

function policy(mode: 'supervised' | 'auto-accept-edits' | 'auto' | 'full-access', overlayMode: 'agent' | 'plan' | 'ask' = 'agent'): ICompiledPolicy {
	return compilePolicy({
		system: SYSTEM_HARD_DENY,
		preset: presetRules(mode),
		overlay: modeOverlay(overlayMode),
	});
}

suite('Volt access broker', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('supervised asks for edits and medium shell, auto-allows routine commands', () => {
		const compiled = policy('supervised');
		assert.strictEqual(evaluateAccess(req('read', 'src/a.ts'), compiled, { accessMode: 'supervised' }).effect, 'allow');
		assert.strictEqual(evaluateAccess(req('edit', 'src/a.ts'), compiled, { accessMode: 'supervised' }).effect, 'ask');
		assert.strictEqual(evaluateAccess(req('shell', 'npm test'), compiled, { accessMode: 'supervised' }).effect, 'allow');
		assert.strictEqual(evaluateAccess(req('shell', 'python3 -m http.server 8080'), compiled, { accessMode: 'supervised' }).effect, 'allow');
		assert.strictEqual(evaluateAccess(req('shell', 'npm install lodash'), compiled, { accessMode: 'supervised' }).effect, 'ask');
	});

	test('auto-accept edits allows edits and routine shell, asks for medium shell', () => {
		const compiled = policy('auto-accept-edits');
		assert.strictEqual(evaluateAccess(req('edit', 'src/a.ts'), compiled, { accessMode: 'auto-accept-edits' }).effect, 'allow');
		assert.strictEqual(evaluateAccess(req('shell', 'npm test'), compiled, { accessMode: 'auto-accept-edits' }).effect, 'allow');
		assert.strictEqual(evaluateAccess(req('shell', 'npm install lodash'), compiled, { accessMode: 'auto-accept-edits' }).effect, 'ask');
	});

	test('auto allows safe and low, asks for medium+', () => {
		const compiled = policy('auto');
		assert.strictEqual(evaluateAccess(req('shell', 'git status'), compiled, { accessMode: 'auto' }).effect, 'allow');
		assert.strictEqual(evaluateAccess(req('shell', 'npm test'), compiled, { accessMode: 'auto' }).effect, 'allow');
		assert.strictEqual(evaluateAccess(req('shell', 'npm install lodash'), compiled, { accessMode: 'auto' }).effect, 'ask');
		assert.strictEqual(evaluateAccess(req('shell', 'git push origin main'), compiled, { accessMode: 'auto' }).effect, 'ask');
	});

	test('auto can delegate medium to a native reviewer', () => {
		const compiled = policy('auto');
		assert.strictEqual(evaluateAccess(req('shell', 'npm install lodash'), compiled, { accessMode: 'auto', delegateMedium: true }).effect, 'allow');
		assert.strictEqual(evaluateAccess(req('shell', 'git push origin main'), compiled, { accessMode: 'auto', delegateMedium: true }).effect, 'ask');
	});

	test('full access allows normal work but not hard denies', () => {
		const compiled = policy('full-access');
		assert.strictEqual(evaluateAccess(req('shell', 'npm test'), compiled, { accessMode: 'full-access' }).effect, 'allow');
		assert.strictEqual(evaluateAccess(req('edit', 'src/a.ts'), compiled, { accessMode: 'full-access' }).effect, 'allow');
		assert.strictEqual(evaluateAccess(req('shell', 'git push --force origin main'), compiled, { accessMode: 'full-access' }).effect, 'deny');
	});

	test('saved approval never overrides deny', () => {
		const compiled = compilePolicy({
			system: SYSTEM_HARD_DENY,
			preset: presetRules('full-access'),
			session: [{ action: 'shell', resource: 'git push --force*', effect: 'allow' }],
		});
		assert.strictEqual(evaluateAccess(req('shell', 'git push --force origin main'), compiled, { accessMode: 'full-access' }).effect, 'deny');
	});

	test('ask and plan overlays still allow web lookups', () => {
		for (const mode of ['ask', 'plan'] as const) {
			const compiled = policy('supervised', mode);
			assert.strictEqual(evaluateAccess(req('web', 'https://example.com/prices'), compiled, { accessMode: 'supervised' }).effect, 'allow');
			assert.strictEqual(evaluateAccess(req('edit', 'src/a.ts'), compiled, { accessMode: 'supervised' }).effect, 'deny');
		}
	});

	test('plan overlay denies side effects under full access', () => {
		const compiled = policy('full-access', 'plan');
		assert.strictEqual(evaluateAccess(req('edit', 'src/a.ts'), compiled, { accessMode: 'full-access' }).effect, 'deny');
		assert.strictEqual(evaluateAccess(req('mcp', 'delete_issue'), compiled, { accessMode: 'full-access' }).effect, 'deny');
	});
});
