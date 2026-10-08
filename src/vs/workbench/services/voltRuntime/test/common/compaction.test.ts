/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentCompactionPrompt, COMPACT_CHIP_MIN_TOKENS, compactInstructions, isCompactCommand, OLD_THREAD_IDLE_MS, OLD_THREAD_TOKENS, shouldCompactBeforeSend, shouldOfferCompactChip } from '../../common/compaction.js';

suite('Volt compaction rules', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('/compact with or without focus instructions', () => {
		assert.ok(isCompactCommand('/compact'));
		assert.ok(isCompactCommand('  /compact keep the API notes'));
		assert.ok(!isCompactCommand('/compactor'));
		assert.ok(!isCompactCommand('please /compact'));
		assert.strictEqual(compactInstructions('/compact keep the API notes'), 'keep the API notes');
		assert.strictEqual(compactInstructions('/compact'), undefined);
		assert.ok(agentCompactionPrompt('the API').includes('focus on: the API'));
	});

	test('an old chat is compacted before a send only when idle past the cache and large', () => {
		const now = 10 * OLD_THREAD_IDLE_MS;
		const base = { enabled: true, canCompact: true, now, text: 'continue', lastActivityAt: now - OLD_THREAD_IDLE_MS, usedTokens: OLD_THREAD_TOKENS };
		assert.ok(shouldCompactBeforeSend(base));
		assert.ok(!shouldCompactBeforeSend({ ...base, lastActivityAt: now - OLD_THREAD_IDLE_MS + 1 }), 'the cache may still be warm');
		assert.ok(!shouldCompactBeforeSend({ ...base, usedTokens: OLD_THREAD_TOKENS - 1 }), 'small chats are cheap to resend');
		assert.ok(!shouldCompactBeforeSend({ ...base, enabled: false }));
		assert.ok(!shouldCompactBeforeSend({ ...base, canCompact: false }));
		assert.ok(!shouldCompactBeforeSend({ ...base, text: '/compact' }), 'never twice');
		assert.ok(!shouldCompactBeforeSend({ ...base, lastActivityAt: undefined }));
	});

	test('the Compact first chip needs a big chat, a nearly full window, and a summary that at least halves it', () => {
		const full = { usedTokens: 120_000, percentFull: 80, thresholdPercent: 80 };
		assert.ok(shouldOfferCompactChip(full));
		assert.ok(shouldOfferCompactChip({ ...full, compactedTokens: 24_000 }));
		assert.ok(!shouldOfferCompactChip({ ...full, usedTokens: COMPACT_CHIP_MIN_TOKENS - 1 }), 'a small chat gains little from a summary');
		assert.ok(!shouldOfferCompactChip({ ...full, percentFull: 79 }), 'the window is not nearly full');
		assert.ok(!shouldOfferCompactChip({ ...full, compactedTokens: 60_001 }), 'a summary that barely shrinks the chat is not worth a turn');
		assert.ok(shouldOfferCompactChip({ ...full, compactedTokens: 60_000 }));
	});

	test('a low threshold alone never offers a chip for a small chat', () => {
		assert.ok(!shouldOfferCompactChip({ usedTokens: 23_000, percentFull: 11, thresholdPercent: 5 }));
	});
});
