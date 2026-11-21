/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { lexiconSpeech, lexiconWords } from '../../common/lexiconSpeech.js';
import { spokenCode } from '../../common/spokenCode.js';
import { DEFAULT_LOCAL_VOICES, LOCAL_VOICES, localVoice, localVoiceRuntime, pickLocalVoice, trimTail } from '../../common/voltLocalVoice.js';

suite('Local voice', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// A dictionary like the engine's: every letter, the number names, and some plain words.
	const words = lexiconWords([
		...'abcdefghijklmnopqrstuvwxyz',
		'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'nineteen',
		'twenty', 'forty', 'fifty', 'eighty', 'hundred', 'thousand', 'million', 'oh', 'point', 'percent', 'dot', 'first', 'second', 'twentieth',
		'millisecond', 'megabytes', 'megabyte', 'dollars', 'times', 'and', 'for', 'example', 'so', 'on',
		'it', 'took', 'the', 'user', 'users', 'in', 'is', 'of', 'see', 'fix', 'do', 'not', 'use', 'ok', 'run', 'cost',
		'work', 'tree', 'agent', 'editor', 'read', 'aloud', 'voice', 'jason', 'git', 'hub', 'volt', 'volts', 'don\'t', 'naive', '\'s', '\'d',
	].map(word => `${word} x`).join('\n'));
	const say = (text: string) => lexiconSpeech(text, word => words.has(word));

	test('reads the dictionary\'s first column', () => {
		assert.deepStrictEqual([...lexiconWords('kokoro k O\n\'s s\nlast l a')], ['kokoro', '\'s', 'last']);
	});

	test('spells out numbers, units and money', () => {
		assert.strictEqual(say('It took 42 ms.'), 'it took forty two millisecond \'s.');
		assert.strictEqual(say('3.5 MB and 1 MB'), 'three point five megabytes and one megabyte.');
		assert.strictEqual(say('50% of 1,200'), 'fifty percent of one thousand two hundred.');
		assert.strictEqual(say('10x, $5'), 'ten times, five dollars.');
		assert.strictEqual(say('the 1st, the 2nd, the 20th'), 'the first, the second, the twentieth.');
		assert.strictEqual(say('007'), 'zero zero seven.');
	});

	test('reads four digits as a year where one fits', () => {
		assert.strictEqual(say('in 1984'), 'in nineteen eighty four.');
		assert.strictEqual(say('in 2005'), 'in two thousand five.');
		assert.strictEqual(say('in 2011'), 'in twenty eleven.');
		assert.strictEqual(say('1900'), 'nineteen hundred.');
	});

	test('reads versions and dotted names', () => {
		assert.strictEqual(say('v1.2.10'), 'v one point two point ten.');
		assert.strictEqual(say('see agentEditor.ts'), 'see agent editor dot t s.');
	});

	test('splits identifiers and compounds into known words', () => {
		assert.strictEqual(say('the worktree'), 'the work tree.');
		assert.strictEqual(say('read_aloud_voice'), 'read aloud voice.');
		assert.strictEqual(say('AgentEditor and HTMLEditor'), 'agent editor and h t m l editor.');
	});

	test('spells initials and words without a dictionary entry', () => {
		assert.strictEqual(say('the UI (API) of npm'), 'the u i, a p i, of n p m.');
		assert.strictEqual(say('Do NOT use it. OK?'), 'do not use it. ok?');
	});

	test('keeps possessives and contractions audible', () => {
		assert.strictEqual(say('Volt\u2019s fix'), 'volts fix.');
		assert.strictEqual(say('the agent\'s fix'), 'the agent \'s fix.');
		assert.strictEqual(say('Don\u2019t'), 'don\'t.');
		assert.strictEqual(say('it worked'), 'it work \'d.');
	});

	test('respells what developers say differently', () => {
		assert.strictEqual(say('JSON in GitHub, e.g. the fix'), 'jason in git hub, for example the fix.');
	});

	test('keeps one mark between words and ends the sentence', () => {
		assert.strictEqual(say('see \u2014 (the fix), ... ok'), 'see, the fix. ok.');
		assert.strictEqual(say('na\u00efve'), 'naive.');
		assert.strictEqual(say('\u2192 #'), '');
	});

	test('names voices by setting and runtimes by platform', () => {
		const kokoro = LOCAL_VOICES.filter(voice => voice.model === 'kokoro');
		const supertonic = LOCAL_VOICES.filter(voice => voice.model === 'supertonic');
		assert.deepStrictEqual(kokoro.map(voice => voice.speaker), [...Array(28).keys()]);
		assert.deepStrictEqual(supertonic.map(voice => voice.speaker), [...Array(10).keys()]);
		assert.deepStrictEqual(supertonic.map(voice => voice.female), [true, true, true, true, true, false, false, false, false, false]);
		assert.strictEqual(new Set(LOCAL_VOICES.map(voice => voice.ref)).size, 38);
		assert.strictEqual(localVoice(DEFAULT_LOCAL_VOICES.kokoro)?.speaker, 3);
		assert.strictEqual(localVoice(DEFAULT_LOCAL_VOICES.supertonic)?.speaker, 0);
		assert.strictEqual(localVoice('kokoro:bm_george')?.accent, 'gb');
		assert.strictEqual(localVoice('supertonic:m2')?.speaker, 6);
		assert.strictEqual(localVoice('Samantha'), undefined);
		assert.strictEqual(localVoice('kokoro:nobody'), undefined);
		assert.strictEqual(localVoiceRuntime('win32', 'x64')?.url, 'https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-2.0.1.tgz');
		assert.strictEqual(localVoiceRuntime('darwin', 'arm64')?.bytes, 10013200);
		assert.strictEqual(localVoiceRuntime('freebsd', 'x64'), undefined);
	});

	test('speaks with the picked voice when its model is downloaded, else the fastest that is', () => {
		assert.strictEqual(pickLocalVoice('kokoro:bm_george', ['supertonic', 'kokoro'])?.ref, 'kokoro:bm_george');
		assert.strictEqual(pickLocalVoice('kokoro:bm_george', ['supertonic'])?.ref, 'supertonic:f1');
		assert.strictEqual(pickLocalVoice('Samantha', ['kokoro', 'supertonic'])?.ref, 'supertonic:f1');
		assert.strictEqual(pickLocalVoice(undefined, ['kokoro'])?.ref, 'kokoro:af_heart');
		assert.strictEqual(pickLocalVoice('supertonic:m2', []), undefined);
	});

	test('says file names, paths and code the way a developer does', () => {
		assert.strictEqual(spokenCode('Based on the earlier listing (I haven\'t run anything new), this project has one file: README.md.'), 'Based on the earlier listing, I haven\'t run anything new, this project has one file: readme dot M D.');
		assert.strictEqual(spokenCode('I fixed src/vs/workbench/editor/agentEditor.ts and agentReadAloud.test.ts.'), 'I fixed agent editor dot T S in editor and agent read aloud dot test dot T S.');
		assert.strictEqual(spokenCode('It calls getStates() when IVoltLocalVoiceService is ready, e.g. on start.'), 'It calls get states when I volt local voice service is ready, for example, on start.');
		assert.strictEqual(spokenCode('Version v1.2.3 on Ubuntu 24.04 took 150ms; it is 85 MB and 2x faster.'), 'Version one point two point three on Ubuntu twenty four point zero four took one hundred fifty milliseconds; it is eighty five megabytes and two times faster.');
		assert.strictEqual(spokenCode('Run npm install && npm test, then git commit --no-verify. See PR #100 and 9031bd0eca3.'), 'Run npm install and npm test, then git commit dash dash no verify. See PR number one hundred and nine zero three one.');
		assert.strictEqual(spokenCode('Set MAX_RETRY_COUNT in .env or config/settings.json.'), 'Set max retry count in dot env or config slash settings dot JSON.');
		assert.strictEqual(spokenCode('Two files: index.html, main.py. The TODO in LICENSE is done and/or moved.'), 'Two files: index dot H T M L, main dot pie. The to do in license is done and or moved.');
	});

	test('leaves plain prose alone', () => {
		for (const prose of ['Plain prose stays as it is, even with Juno, an API or a U.S. city.', 'Done. Nothing else changed!', 'On it.']) {
			assert.strictEqual(spokenCode(prose), prose);
		}
		assert.strictEqual(spokenCode(''), '');
	});

	test('writes numbers, money, dates and ranges out in words', () => {
		// The fast voice reads digits by guessing: "147" came out as "144 in", "17 Oct" as "octo de".
		assert.strictEqual(spokenCode('It costs $3.50 and takes 2.5 hours; $1 or $1.01 more.'), 'It costs three dollars and fifty cents and takes two point five hours; one dollar or one dollar and one cent more.');
		assert.strictEqual(spokenCode('Of 147 audit items, 54 are done and 1,200 rows, 50% of them, ran on the 3rd.'), 'Of one hundred forty seven audit items, fifty four are done and one thousand two hundred rows, fifty percent of them, ran on the third.');
		assert.strictEqual(spokenCode('Based on the 17 Oct audit, due Oct 3, 2026 or on 2026-10-17.'), 'Based on the October seventeenth audit, due October third, twenty twenty six or on October seventeenth, twenty twenty six.');
		assert.strictEqual(spokenCode('Decide DEC-006\u2013008; only ~56 of ~713 had them.'), 'Decide DEC six to eight; only about fifty six of about seven hundred thirteen had them.');
		assert.strictEqual(spokenCode('Fix the e2e specs and the a11y checks in 2026.'), 'Fix the end to end specs and the accessibility checks in twenty twenty six.');
		assert.strictEqual(spokenCode('Agent 007 is code 0042.'), 'Agent zero zero seven is code zero zero four two.');
	});

	test('says a dated file in capitals as words, without its sort number', () => {
		assert.strictEqual(spokenCode('Full list: docs/pms-audit/09-GAP-STATUS-2026-10-17.md.'), 'Full list: gap status october seventeenth twenty twenty six dot M D in pms audit.');
		assert.strictEqual(spokenCode('See 2026-11-19-notes.md and API-NOTES.md.'), 'See november nineteenth twenty twenty six notes dot M D and api notes dot M D.');
	});

	test('cuts the silence a model leaves after the last sound', () => {
		const samples = new Float32Array(1000);
		samples.fill(0.5, 0, 100);
		// 100 samples of sound, then 0.12 s (12 samples at 100 Hz) of silence are kept.
		assert.strictEqual(trimTail(samples, 100).length, 112);
		assert.strictEqual(trimTail(new Float32Array(1000).fill(0.5), 100).length, 1000);
		assert.strictEqual(trimTail(new Float32Array(50), 100).length, 12);
	});
});
