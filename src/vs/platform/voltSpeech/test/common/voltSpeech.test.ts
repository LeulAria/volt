/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { pcm16Bytes, rmsLevel, transcriptionUrl, wavFromPcm16 } from '../../common/voltSpeech.js';

suite('Volt speech', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('float samples become clamped 16-bit little-endian PCM', () => {
		const bytes = pcm16Bytes(new Float32Array([0, 1, -1, 2, -2, 0.5]));
		const view = new DataView(bytes.buffer);
		assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map(i => view.getInt16(i * 2, true)), [0, 32767, -32768, 32767, -32768, 16384]);
	});

	test('the level of a block is its RMS, 0 for silence', () => {
		assert.strictEqual(rmsLevel(new Float32Array(0)), 0);
		assert.strictEqual(rmsLevel(new Float32Array([0, 0, 0, 0])), 0);
		assert.strictEqual(rmsLevel(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.5);
		assert.strictEqual(rmsLevel(new Float32Array([3, 3])), 1);
	});

	test('a WAV file wraps the PCM with a 44-byte header at the given rate', () => {
		const pcm = new Uint8Array([1, 2, 3, 4]);
		const wav = wavFromPcm16(pcm, 16000);
		const view = new DataView(wav.buffer);
		const text = (offset: number, length: number) => String.fromCharCode(...wav.subarray(offset, offset + length));
		assert.strictEqual(wav.byteLength, 48);
		assert.strictEqual(text(0, 4), 'RIFF');
		assert.strictEqual(view.getUint32(4, true), 40);
		assert.strictEqual(text(8, 4), 'WAVE');
		assert.strictEqual(view.getUint16(20, true), 1);
		assert.strictEqual(view.getUint16(22, true), 1);
		assert.strictEqual(view.getUint32(24, true), 16000);
		assert.strictEqual(view.getUint32(28, true), 32000);
		assert.strictEqual(view.getUint16(34, true), 16);
		assert.strictEqual(text(36, 4), 'data');
		assert.strictEqual(view.getUint32(40, true), 4);
		assert.deepStrictEqual([...wav.subarray(44)], [1, 2, 3, 4]);
	});

	test('the transcription endpoint is the base URL plus /audio/transcriptions', () => {
		assert.strictEqual(transcriptionUrl('http://localhost:8000/v1'), 'http://localhost:8000/v1/audio/transcriptions');
		assert.strictEqual(transcriptionUrl(' https://api.example.com/v1/// '), 'https://api.example.com/v1/audio/transcriptions');
		assert.strictEqual(transcriptionUrl('http://localhost:9000'), 'http://localhost:9000/audio/transcriptions');
		assert.throws(() => transcriptionUrl('file:///etc/passwd'), /http or https/);
		assert.throws(() => transcriptionUrl('not a url'));
	});
});
