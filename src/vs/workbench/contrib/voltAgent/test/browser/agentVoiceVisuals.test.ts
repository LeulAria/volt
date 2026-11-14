/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentDictationState, AgentVoiceDictation } from '../../browser/composer/agentVoiceDictation.js';
import { AgentVoiceVisuals } from '../../browser/composer/agentVoiceVisuals.js';

class FakeDictation {
	readonly changed = new Emitter<void>();
	readonly heard = new Emitter<readonly number[]>();
	readonly onDidChange = this.changed.event;
	readonly onDidHear = this.heard.event;
	state: AgentDictationState = 'idle';
	level = 0;
	get active(): boolean { return this.state === 'starting' || this.state === 'listening'; }
	set(state: AgentDictationState): void { this.state = state; this.changed.fire(); }
	dispose(): void { this.changed.dispose(); this.heard.dispose(); }
}

suite('agentVoiceVisuals', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the glow is out of the layout at rest, shown while dictating, and rests again once faded out', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const inputBox = document.createElement('div');
		const mic = document.createElement('div');
		const dictation = store.add(new FakeDictation());
		store.add(new AgentVoiceVisuals(inputBox, mic, dictation as unknown as AgentVoiceDictation));
		const glow = inputBox.querySelector<HTMLElement>('.volt-agent-voice-glow')!;
		assert.ok(glow.classList.contains('resting'), 'no dictation: resting from the start');

		dictation.set('listening');
		assert.ok(!glow.classList.contains('resting'));
		assert.ok(inputBox.classList.contains('voice-active'));

		dictation.set('transcribing');
		assert.ok(!glow.classList.contains('resting'), 'transcribing still shows the glow');

		dictation.set('idle');
		assert.ok(!glow.classList.contains('resting'), 'fades out first');
		await timeout(100);
		dictation.set('listening');
		await timeout(1000);
		assert.ok(!glow.classList.contains('resting'), 'dictation again before the fade ended: stays');

		dictation.set('idle');
		await timeout(1000);
		assert.ok(glow.classList.contains('resting'));
	}));
});
