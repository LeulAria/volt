/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { evaluateAccess } from '../../common/access/accessBroker.js';
import { modeOverlay, presetRules, SYSTEM_HARD_DENY } from '../../common/access/accessPresets.js';
import { IAccessRequest } from '../../common/access/accessTypes.js';
import { compilePolicy, lastMatch } from '../../common/access/policyCompiler.js';
import { classifyRisk } from '../../common/access/riskClassifier.js';

function request(action: IAccessRequest['action'], resource: string): IAccessRequest {
	return {
		id: 'r1',
		sessionId: 's1',
		runId: 'run1',
		providerId: 'codex',
		action,
		resource: { type: action === 'shell' ? 'command' : 'file', value: resource },
		risk: classifyRisk(action, resource),
		createdAt: 0,
	};
}

suite('Volt policy compiler', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('last match wins within a tier', () => {
		const policy = compilePolicy({
			preset: [
				{ action: 'shell', resource: '*', effect: 'allow' },
				{ action: 'shell', resource: 'git push*', effect: 'ask' },
				{ action: 'shell', resource: 'git push --force*', effect: 'deny' },
			],
		});
		assert.strictEqual(lastMatch(policy.configured, 'shell', 'git status').effect, 'allow');
		assert.strictEqual(lastMatch(policy.configured, 'shell', 'git push origin main').effect, 'ask');
		assert.strictEqual(lastMatch(policy.configured, 'shell', 'git push --force origin main').effect, 'deny');
	});

	test('configured deny beats saved allow', () => {
		const policy = compilePolicy({
			preset: [{ action: 'shell', resource: 'git push --force*', effect: 'deny' }],
			session: [{ action: 'shell', resource: 'git push --force*', effect: 'allow' }],
		});
		const decision = evaluateAccess(request('shell', 'git push --force origin main'), policy);
		assert.strictEqual(decision.effect, 'deny');
	});

	test('plan overlay tightens full access', () => {
		const policy = compilePolicy({
			preset: presetRules('full-access'),
			overlay: modeOverlay('plan'),
		});
		assert.strictEqual(evaluateAccess(request('read', 'src/foo.ts'), policy, { accessMode: 'full-access' }).effect, 'allow');
		assert.strictEqual(evaluateAccess(request('edit', 'src/foo.ts'), policy, { accessMode: 'full-access' }).effect, 'deny');
		assert.strictEqual(evaluateAccess(request('shell', 'npm test'), policy, { accessMode: 'full-access' }).effect, 'deny');
		assert.strictEqual(evaluateAccess(request('mcp', 'create_issue'), policy, { accessMode: 'full-access' }).effect, 'deny');
	});

	test('system hard deny survives full access', () => {
		const policy = compilePolicy({
			system: SYSTEM_HARD_DENY,
			preset: presetRules('full-access'),
		});
		assert.strictEqual(evaluateAccess(request('shell', 'git push --force origin main'), policy, { accessMode: 'full-access' }).effect, 'deny');
		assert.strictEqual(evaluateAccess(request('read', '.env'), policy, { accessMode: 'full-access' }).effect, 'deny');
		assert.strictEqual(evaluateAccess(request('read', '.env.example'), policy, { accessMode: 'full-access' }).effect, 'allow');
	});

	test('project override is more specific than preset', () => {
		const policy = compilePolicy({
			preset: [{ action: 'shell', resource: '*', effect: 'allow' }],
			project: [{ action: 'shell', resource: 'git push*', effect: 'ask' }],
		});
		assert.strictEqual(evaluateAccess(request('shell', 'git status'), policy).effect, 'allow');
		assert.strictEqual(evaluateAccess(request('shell', 'git push origin main'), policy).effect, 'ask');
	});
});
