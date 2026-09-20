/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { DEFAULT_MODEL_CAPABILITIES } from '../../../common/capabilities.js';
import { classifyIntent } from '../../../common/harness/intent.js';
import { VoltLane } from '../../../common/harness/lanes.js';
import { canEscalate, escalate, IRoutableModel, IRoutingRequest, route, roleFor } from '../../../common/harness/modelRouter.js';
import { analyzeTask } from '../../../common/harness/taskIntel.js';
import { VoltMode } from '../../../common/modes.js';

suite('Volt model router', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const haiku = model('model:a:haiku', 'Haiku', { reasoning: false, contextWindow: 200_000 });
	const sonnet = model('model:a:sonnet', 'Sonnet', { reasoning: false, parallelToolCalls: true, contextWindow: 200_000 });
	const opus = model('model:a:opus', 'Opus', { reasoning: true, contextWindow: 400_000 });
	const gpt = model('model:b:gpt', 'GPT', { reasoning: true, contextWindow: 400_000 });
	const seeing = model('model:c:vision', 'Vision', { vision: true });
	const catalog = [haiku, sonnet, opus, gpt, seeing];

	suite('role selection', () => {
		const cases: readonly (readonly [string, VoltLane, VoltMode, string])[] = [
			['rename foo to bar in utils.ts', 'fast', 'agent', 'fast'],
			['what does this function do', 'chat', 'ask', 'fast'],
			['tell me each model and their price give me in a table', 'chat', 'ask', 'coding'],
			['add a logout button to the header', 'agent', 'agent', 'coding'],
			['migrate the entire backend from express to fastify end-to-end and rewrite every route', 'mission', 'agent', 'reasoning'],
			['add a logout button to the header', 'agent', 'plan', 'reasoning'],
			['add a logout button to the header', 'agent', 'debug', 'reasoning'],
		];
		for (const [text, lane, mode, expected] of cases) {
			test(`${lane}/${mode} -> ${expected}`, () => {
				assert.strictEqual(roleFor(request(text, lane, mode)), expected);
			});
		}

		test('an image overrides every other consideration', () => {
			assert.strictEqual(roleFor({ ...request('rename foo', 'fast', 'agent'), needsVision: true }), 'vision');
		});
	});

	suite('routing', () => {
		test('never overrides the model the user picked', () => {
			const decision = route({ ...request('add a button', 'agent', 'agent'), explicitRef: haiku.ref }, catalog, { coding: sonnet.ref });
			assert.strictEqual(decision?.ref, haiku.ref);
			assert.strictEqual(decision?.reason, 'The model you selected.');
		});

		test('ignores an explicit pick that is not usable', () => {
			const decision = route({ ...request('add a button', 'agent', 'agent'), explicitRef: 'model:gone' }, catalog, { coding: sonnet.ref });
			assert.strictEqual(decision?.ref, sonnet.ref);
		});

		test('uses the slot configured for the role', () => {
			const decision = route(request('add a logout button to the header', 'agent', 'agent'), catalog, { coding: sonnet.ref, reasoning: opus.ref });
			assert.strictEqual(decision?.ref, sonnet.ref);
			assert.strictEqual(decision?.role, 'coding');
		});

		test('borrows a neighbouring slot and says so', () => {
			const decision = route(request('add a logout button to the header', 'agent', 'agent'), catalog, { reasoning: opus.ref });
			assert.strictEqual(decision?.ref, opus.ref);
			assert.ok(/no reasoning model is configured|using the reasoning slot/.test(decision?.reason ?? ''), decision?.reason);
		});

		test('picks the best fit when nothing is configured', () => {
			const reasoningTurn = route(request('migrate the entire backend end-to-end and rewrite every route handler', 'mission', 'agent'), catalog, {});
			assert.ok(reasoningTurn?.ref === opus.ref || reasoningTurn?.ref === gpt.ref, `got ${reasoningTurn?.ref}`);

			const fastTurn = route(request('rename foo to bar in utils.ts', 'fast', 'agent'), catalog, {});
			assert.ok(fastTurn?.ref === haiku.ref || fastTurn?.ref === sonnet.ref, `got ${fastTurn?.ref}`);
		});

		test('routes an image only to a model that can see', () => {
			const decision = route({ ...request('what is in this screenshot', 'chat', 'ask'), needsVision: true }, catalog, {});
			assert.strictEqual(decision?.ref, seeing.ref);
		});

		test('skips a disabled or unhealthy model', () => {
			const decision = route(request('add a button', 'agent', 'agent'), [
				{ ...sonnet, enabled: false },
				{ ...opus, healthy: false },
				haiku,
			], { coding: sonnet.ref, reasoning: opus.ref });
			assert.strictEqual(decision?.ref, haiku.ref);
		});

		test('skips a model whose window cannot hold the turn', () => {
			const small = model('model:d:small', 'Small', { contextWindow: 8_000 });
			const decision = route({ ...request('add a button', 'agent', 'agent'), estimatedTokens: 50_000 }, [small, sonnet], {});
			assert.strictEqual(decision?.ref, sonnet.ref);
		});

		test('will not route a coding lane to a model that cannot call tools', () => {
			const noTools = model('model:e:notools', 'No tools', { toolCalling: false });
			assert.strictEqual(route(request('add a button', 'agent', 'agent'), [noTools], {}), undefined);
			assert.ok(route(request('what is 2+2', 'chat', 'ask'), [noTools], {}), 'closed chat needs no tools');
			assert.strictEqual(route(request('how much does this cost right now', 'chat', 'ask'), [noTools], {}), undefined);
		});

		test('returns nothing when the catalog is empty', () => {
			assert.strictEqual(route(request('add a button', 'agent', 'agent'), [], {}), undefined);
		});

		test('ranks a different provider ahead of a sibling as a fallback', () => {
			const decision = route(request('add a logout button to the header', 'agent', 'agent'), catalog, { coding: sonnet.ref });
			assert.strictEqual(decision?.fallbacks.includes(sonnet.ref), false, 'the chosen model is not its own fallback');
			const firstProvider = catalog.find(entry => entry.ref === decision?.fallbacks[0])?.providerId;
			assert.notStrictEqual(firstProvider, 'a', `expected a different provider first, got ${decision?.fallbacks[0]}`);
		});
	});

	suite('escalation', () => {
		test('goes to the configured reasoning model', () => {
			const result = escalate(sonnet.ref, catalog, { reasoning: opus.ref }, request('add a button', 'agent', 'agent'));
			assert.strictEqual(result?.ref, opus.ref);
			assert.ok(/configured reasoning model/.test(result?.reason ?? ''));
		});

		test('picks the strongest untried model when none is configured', () => {
			const result = escalate(haiku.ref, catalog, {}, request('add a button', 'agent', 'agent'));
			assert.ok(result?.ref === opus.ref || result?.ref === gpt.ref, `got ${result?.ref}`);
		});

		test('never returns a model already tried', () => {
			const result = escalate(sonnet.ref, catalog, { reasoning: opus.ref }, request('add a button', 'agent', 'agent'), [opus.ref]);
			assert.notStrictEqual(result?.ref, opus.ref);
			assert.notStrictEqual(result?.ref, sonnet.ref);
		});

		test('gives up when everything has been tried', () => {
			const tried = catalog.map(entry => entry.ref);
			assert.strictEqual(escalate(sonnet.ref, catalog, {}, request('add a button', 'agent', 'agent'), tried), undefined);
			assert.strictEqual(canEscalate(sonnet.ref, catalog, request('add a button', 'agent', 'agent'), tried), false);
		});

		test('reports up front whether escalating is possible', () => {
			assert.strictEqual(canEscalate(sonnet.ref, catalog, request('add a button', 'agent', 'agent')), true);
			assert.strictEqual(canEscalate(sonnet.ref, [sonnet], request('add a button', 'agent', 'agent')), false);
		});
	});
});

function request(text: string, lane: VoltLane, mode: VoltMode): IRoutingRequest {
	const intent = classifyIntent(text, mode, { hasWorkspace: true });
	return { lane, mode, intel: analyzeTask(text, intent) };
}

function model(ref: string, label: string, capabilities: Partial<IRoutableModel['capabilities']> = {}): IRoutableModel {
	return {
		ref,
		label,
		kind: 'model',
		providerId: ref.split(':')[1],
		enabled: true,
		capabilities: { ...DEFAULT_MODEL_CAPABILITIES, ...capabilities },
	};
}
