/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { PredictorAgent, IPredictorLaunch } from '../../browser/prediction/predictorAgent.js';
import { IVoltEvent } from '../../common/events.js';
import { IProviderProfile } from '../../common/profiles.js';
import { IAgentProvider, IAgentSessionHandle } from '../../common/providers.js';

suite('Volt predictor: what starts its agent (A7/A10, round 7)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function predictor() {
		const launches: string[] = [];
		const disposed: string[] = [];
		const provider = {
			async *send(): AsyncIterable<IVoltEvent> {
				yield { type: 'error', message: 'answer' } as IVoltEvent;
			},
			async dispose(handle: IAgentSessionHandle) { disposed.push(String(handle)); },
			isLive: () => true,
		} as unknown as IAgentProvider;
		const agent = store.add(new PredictorAgent(async ref => {
			launches.push(ref);
			return { provider, handle: `h${launches.length}` as unknown as IAgentSessionHandle, profile: {} as IProviderProfile, ownPrompt: true } satisfies IPredictorLaunch;
		}, new NullLogService()));
		return { agent, launches, disposed };
	}

	async function answers(agent: PredictorAgent): Promise<string[]> {
		const out: string[] = [];
		for await (const event of agent.ask('agent:x', 'composer', 'draft', CancellationToken.None)) {
			out.push(event.type === 'error' ? event.message : event.type);
		}
		return out;
	}

	test('a request alone (a paste, a cursor move) starts no agent', async () => {
		const { agent, launches } = predictor();
		assert.deepStrictEqual(await answers(agent), []);
		assert.deepStrictEqual(launches, []);
	});

	test('a keystroke or dictation starts it, and requests are then answered by that one session', async () => {
		const { agent, launches } = predictor();
		agent.warm('agent:x');
		assert.deepStrictEqual(await answers(agent), ['answer']);
		assert.deepStrictEqual(await answers(agent), ['answer']);
		assert.deepStrictEqual(launches, ['agent:x']);
	});

	test('once stopped, a request does not start it again', async () => {
		const { agent, launches, disposed } = predictor();
		agent.warm('agent:x');
		assert.deepStrictEqual(await answers(agent), ['answer']);
		agent.warm(undefined);
		await Promise.resolve();
		assert.deepStrictEqual(await answers(agent), []);
		assert.deepStrictEqual(launches, ['agent:x']);
		assert.deepStrictEqual(disposed, ['h1']);
	});
});
