/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILocalVoiceState, IVoltLocalVoiceService, LocalVoiceModelId } from '../../../../../platform/voltLocalVoice/common/voltLocalVoice.js';
import { readAloudLocalVoice } from '../../browser/chat/agentReadAloud.js';
import { READ_ALOUD_SYSTEM_VOICE } from '../../common/agentReadAloud.js';

suite('Agent Read Aloud voice', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const service = (ready: readonly LocalVoiceModelId[]) => ({
		getStates: async () => (['supertonic', 'kokoro'] as const).map((model): ILocalVoiceState => ({ model, status: ready.includes(model) ? 'ready' : 'absent', totalBytes: 0 })),
	}) as unknown as IVoltLocalVoiceService;

	test('an unset voice reads with the downloaded voice Settings and calls use, not the system one', async () => {
		assert.strictEqual((await readAloudLocalVoice(undefined, service(['supertonic'])))?.ref, 'supertonic:f1');
		assert.strictEqual((await readAloudLocalVoice('', service(['kokoro'])))?.ref, 'kokoro:af_heart');
		assert.strictEqual(await readAloudLocalVoice(undefined, service([])), undefined);
	});

	test('a picked downloaded voice reads; one whose model is gone gives way to one that is there', async () => {
		assert.strictEqual((await readAloudLocalVoice('supertonic:m1', service(['supertonic', 'kokoro'])))?.ref, 'supertonic:m1');
		assert.strictEqual((await readAloudLocalVoice('kokoro:af_heart', service(['supertonic'])))?.ref, 'supertonic:f1');
	});

	test('a system voice, picked by name or as the default, keeps the system reading', async () => {
		assert.strictEqual(await readAloudLocalVoice(READ_ALOUD_SYSTEM_VOICE, service(['supertonic'])), undefined);
		assert.strictEqual(await readAloudLocalVoice('Samantha', service(['supertonic'])), undefined);
	});
});
