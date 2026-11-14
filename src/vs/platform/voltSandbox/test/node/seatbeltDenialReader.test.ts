/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ISandboxRunDenial } from '../../common/sandboxBackend.js';
import { logShowStart, SeatbeltDenialReader } from '../../node/seatbeltBackend.js';

function kernelLine(tag: string, path: string, mach: number, pid = 0): string {
	return JSON.stringify({
		processID: pid,
		senderImagePath: '/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox',
		machTimestamp: mach,
		eventMessage: `Sandbox: touch(4242) deny(1) file-write-create ${path}\nVOLTSBX-${tag}`,
	});
}

function markerLine(marker: string): string {
	return JSON.stringify({ processID: 777, senderImagePath: '/usr/bin/logger', eventMessage: marker });
}

suite('SeatbeltDenialReader (on-demand kernel refusals)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function rig(lines: () => string[], options: { markerAfter?: number } = {}) {
		const markers: string[] = [];
		const starts: string[] = [];
		let queries = 0;
		const reader = new SeatbeltDenialReader(
			async start => {
				queries++;
				starts.push(start);
				const marker = markers[markers.length - 1];
				const withMarker = queries > (options.markerAfter ?? 0);
				return [...lines(), ...(withMarker && marker ? [markerLine(marker)] : [])].join('\n') + '\n';
			},
			async marker => { markers.push(marker); },
		);
		return { reader, markers, starts, queries: () => queries };
	}

	test('nothing is read while no sandboxed process listens (no resident log process, no query)', async () => {
		const { reader, queries } = rig(() => [kernelLine('aaaa1111', '/x', 1)]);
		await reader.check(1000);
		assert.strictEqual(queries(), 0);
		reader.dispose();
	});

	test('a check delivers the kernel\'s refusals to the run they name, once, and never a forged line', async () => {
		const lines = [kernelLine('aaaa1111', '/Users/me/blocked.txt', 10), kernelLine('aaaa1111', '/Users/me/forged', 11, 4242), kernelLine('bbbb2222', '/Users/me/other', 12)];
		const { reader } = rig(() => lines);
		const a: ISandboxRunDenial[] = [];
		const b: ISandboxRunDenial[] = [];
		reader.listen('aaaa1111', d => a.push(d));
		reader.listen('bbbb2222', d => b.push(d));
		await reader.check(1000);
		assert.deepStrictEqual(a.map(d => [d.kind, d.target, d.source]), [['write', '/Users/me/blocked.txt', 'os']]);
		assert.deepStrictEqual(b.map(d => d.target), ['/Users/me/other']);
		// The next window overlaps the last one: what was delivered is not delivered again.
		lines.push(kernelLine('aaaa1111', '/Users/me/second.txt', 13));
		await reader.check(1000);
		assert.deepStrictEqual(a.map(d => d.target), ['/Users/me/blocked.txt', '/Users/me/second.txt']);
		reader.dispose();
	});

	test('the read waits until Volt\'s own marker is in the log, so every earlier refusal is in it', async () => {
		let lines: string[] = [];
		const { reader, queries } = rig(() => lines, { markerAfter: 2 });
		const got: string[] = [];
		reader.listen('aaaa1111', d => got.push(d.target));
		const done = reader.check(5000);
		// The refusal reaches the datastore late, with the marker after it.
		lines = [kernelLine('aaaa1111', '/late.txt', 20)];
		await done;
		assert.strictEqual(queries(), 3);
		assert.deepStrictEqual(got, ['/late.txt']);
		reader.dispose();
	});

	test('a check during a read waits for a fresh read; many checks during one read share the next', async () => {
		const { reader, queries } = rig(() => []);
		reader.listen('aaaa1111', () => undefined);
		const first = reader.check(1000);
		const second = reader.check(1000);
		const third = reader.check(1000);
		await Promise.all([first, second, third]);
		assert.strictEqual(queries(), 2);
		reader.dispose();
	});

	test('a read starts before the oldest unchecked moment of any listening run', async () => {
		const { reader, starts } = rig(() => []);
		const before = logShowStart(Date.now() - 5_000);
		reader.listen('aaaa1111', () => undefined);
		await reader.check(1000);
		assert.ok(starts[0] >= before && starts[0] <= logShowStart(Date.now()), `${starts[0]} vs ${before}`);
		assert.match(starts[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
		reader.dispose();
	});

	test('a check for one failed call reads only from that call\'s start, and never more than 15 minutes back', async () => {
		let now = Date.parse('2026-11-14T10:00:00Z');
		const starts: string[] = [];
		const markers: string[] = [];
		const reader = new SeatbeltDenialReader(async start => { starts.push(start); return markerLine(markers[markers.length - 1]); }, async marker => { markers.push(marker); }, () => now);
		reader.listen('aaaa1111', () => undefined);
		// An hour later, a call that started 30 s ago failed: 32 s of log (the overlap), not an hour.
		now += 3_600_000;
		await reader.check(1000, now - 30_000);
		assert.strictEqual(starts[0], logShowStart(now - 32_000));
		// A plain check reads what is still unread for the run, but at most 15 minutes of it.
		await reader.check(1000);
		assert.strictEqual(starts[1], logShowStart(now - 15 * 60_000 - 2_000));
		// That read covered the run up to now: the next one starts there.
		now += 10_000;
		await reader.check(1000);
		assert.strictEqual(starts[2], logShowStart(now - 12_000));
		reader.dispose();
	});

	test('unlisten: the last run gone, checks read nothing', async () => {
		const { reader, queries } = rig(() => []);
		reader.listen('aaaa1111', () => undefined);
		reader.unlisten('aaaa1111');
		await reader.check(1000);
		assert.strictEqual(queries(), 0);
		assert.strictEqual(reader.listening, 0);
		reader.dispose();
	});
});
