/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { totalBadgeCount } from '../../../../../platform/voltBadge/common/voltBadge.js';
import { agentChatWidthCss, resolveAgentChatWidth } from '../../common/agentChatWidth.js';
import {
	deriveProjectColor,
	deriveProjectMonogram,
	monogramTextColor,
	normalizeMonogramLetters,
	normalizeProjectColor,
	PROJECT_MONOGRAM_COLORS,
	resolveMonogram,
	reviveProjectIcon,
} from '../../common/agentProjectIcons.js';
import {
	agentNotifyMode,
	agentNotifySound,
	AgentUnreadThreads,
	IAgentThreadSnapshot,
	isBackgroundThread,
	shouldNotifyThread,
	threadAttentionEvents,
} from '../../common/agentThreadAttention.js';

suite('Agent sidebar polish', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('project monograms', () => {
		test('two words give their initials, one word its first letter', () => {
			assert.strictEqual(deriveProjectMonogram('beta-site'), 'BS');
			assert.strictEqual(deriveProjectMonogram('my_cool project'), 'MC');
			assert.strictEqual(deriveProjectMonogram('myProject'), 'MP');
			assert.strictEqual(deriveProjectMonogram('volt'), 'V');
			assert.strictEqual(deriveProjectMonogram('vrcp2-alpha'), 'VA');
			assert.strictEqual(deriveProjectMonogram('api.git'), 'A');
			assert.strictEqual(deriveProjectMonogram('   '), '?');
			// allow-any-unicode-next-line
			assert.strictEqual(deriveProjectMonogram('été-café'), 'ÉC');
		});

		test('colors are stable, from the palette, and ignore case and spacing', () => {
			const color = deriveProjectColor('Volt');
			assert.ok(PROJECT_MONOGRAM_COLORS.includes(color));
			assert.strictEqual(deriveProjectColor(' volt '), color);
			const spread = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'].map(deriveProjectColor));
			assert.ok(spread.size >= 4, 'names spread over the palette');
		});

		test('edited letters and colors are normalized', () => {
			assert.strictEqual(normalizeMonogramLetters(' a b c '), 'AB');
			assert.strictEqual(normalizeMonogramLetters(''), undefined);
			assert.strictEqual(normalizeProjectColor('#ABC'), '#aabbcc');
			assert.strictEqual(normalizeProjectColor('#12345g'), undefined);
			assert.deepStrictEqual(resolveMonogram('beta-site', { kind: 'monogram', letters: 'x', color: '#FF0000' }), { letters: 'X', color: '#ff0000' });
			assert.deepStrictEqual(resolveMonogram('beta-site', undefined), { letters: 'BS', color: deriveProjectColor('beta-site') });
		});

		test('text on a tile stays readable', () => {
			assert.strictEqual(monogramTextColor('#5b8def'), '#ffffff');
			assert.strictEqual(monogramTextColor('#f5e663'), '#1f2328');
		});

		test('stored icons are checked before they are drawn', () => {
			assert.deepStrictEqual(reviveProjectIcon({ kind: 'codicon', id: 'rocket', color: '#E57A45' }), { kind: 'codicon', id: 'rocket', color: '#e57a45' });
			assert.strictEqual(reviveProjectIcon({ kind: 'codicon', id: 'rocket"><script>' }), undefined);
			assert.strictEqual(reviveProjectIcon({ kind: 'image', dataUrl: 'javascript:alert(1)' }), undefined);
			assert.deepStrictEqual(reviveProjectIcon({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA' }), { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' });
			assert.deepStrictEqual(reviveProjectIcon({ kind: 'monogram', letters: 'abc' }), { kind: 'monogram', letters: 'AB' });
			assert.strictEqual(reviveProjectIcon('monogram'), undefined);
		});
	});

	suite('chat width', () => {
		test('presets map to their caps; full has none', () => {
			assert.deepStrictEqual(resolveAgentChatWidth('narrow'), { preset: 'narrow', px: 600 });
			assert.deepStrictEqual(resolveAgentChatWidth('default'), { preset: 'default', px: 728 });
			assert.deepStrictEqual(resolveAgentChatWidth('Wide'), { preset: 'wide', px: 960 });
			assert.deepStrictEqual(resolveAgentChatWidth('full'), { preset: 'full', px: undefined });
			assert.strictEqual(agentChatWidthCss(resolveAgentChatWidth('full')), 'none');
		});

		test('numbers and numeric strings are clamped pixels', () => {
			assert.deepStrictEqual(resolveAgentChatWidth(900), { preset: 'custom', px: 900 });
			assert.deepStrictEqual(resolveAgentChatWidth('1100px'), { preset: 'custom', px: 1100 });
			assert.deepStrictEqual(resolveAgentChatWidth(100), { preset: 'custom', px: 480 });
			assert.deepStrictEqual(resolveAgentChatWidth(99999), { preset: 'custom', px: 2400 });
			assert.strictEqual(agentChatWidthCss(resolveAgentChatWidth(812.4)), '812px');
		});

		test('anything else is the default width', () => {
			assert.deepStrictEqual(resolveAgentChatWidth('huge'), { preset: 'default', px: 728 });
			assert.deepStrictEqual(resolveAgentChatWidth(undefined), { preset: 'default', px: 728 });
			assert.deepStrictEqual(resolveAgentChatWidth(Number.NaN), { preset: 'default', px: 728 });
		});
	});

	suite('thread attention', () => {
		const running: IAgentThreadSnapshot = { activeTurnId: 't1', inputs: [], queued: 0 };

		test('a run that ends on its own is news; a stop is not', () => {
			assert.deepStrictEqual(threadAttentionEvents(running, { inputs: [], queued: 0, last: { turnId: 't1', outcome: 'done' } }), [{ kind: 'finished', outcome: 'done' }]);
			assert.deepStrictEqual(threadAttentionEvents(running, { inputs: [], queued: 0, last: { turnId: 't1', outcome: 'failed', error: 'boom' } }), [{ kind: 'finished', outcome: 'failed', error: 'boom' }]);
			assert.deepStrictEqual(threadAttentionEvents(running, { inputs: [], queued: 0, last: { turnId: 't1', outcome: 'cancelled' } }), []);
		});

		test('nothing is said while queued prompts keep the chat going, or for a state seen first', () => {
			assert.deepStrictEqual(threadAttentionEvents(running, { inputs: [], queued: 1, last: { turnId: 't1', outcome: 'done' } }), []);
			assert.deepStrictEqual(threadAttentionEvents(running, { activeTurnId: 't2', inputs: [], queued: 0, last: { turnId: 't1', outcome: 'done' } }), []);
			assert.deepStrictEqual(threadAttentionEvents(undefined, { inputs: [], queued: 0, last: { turnId: 't1', outcome: 'done' } }), []);
		});

		test('a new approval or question is news once', () => {
			const asking: IAgentThreadSnapshot = { ...running, inputs: [{ id: 'i1', kind: 'approval' }] };
			assert.deepStrictEqual(threadAttentionEvents(running, asking), [{ kind: 'input', input: 'approval' }]);
			assert.deepStrictEqual(threadAttentionEvents(asking, asking), []);
			assert.deepStrictEqual(threadAttentionEvents(asking, { ...asking, inputs: [...asking.inputs, { id: 'i2', kind: 'question' }] }), [{ kind: 'input', input: 'question' }]);
		});

		test('notification modes', () => {
			const focusedOnIt = { windowFocused: true, threadVisible: true };
			const focusedElsewhere = { windowFocused: true, threadVisible: false };
			const away = { windowFocused: false, threadVisible: true };
			assert.strictEqual(shouldNotifyThread('off', away), false);
			assert.strictEqual(shouldNotifyThread('whenUnfocused', away), true);
			assert.strictEqual(shouldNotifyThread('whenUnfocused', focusedElsewhere), false);
			assert.strictEqual(shouldNotifyThread('always', focusedElsewhere), true);
			assert.strictEqual(shouldNotifyThread('always', focusedOnIt), false);
			assert.strictEqual(isBackgroundThread(away), true);
			assert.strictEqual(agentNotifyMode('loud'), 'off');
			assert.strictEqual(agentNotifySound('kazoo'), 'chime');
		});

		test('unread: finished out of sight, cleared once seen in a focused window', () => {
			const unread = new AgentUnreadThreads();
			assert.strictEqual(unread.finished('a', { windowFocused: true, threadVisible: true }), false);
			assert.strictEqual(unread.finished('b', { windowFocused: true, threadVisible: false }), true);
			assert.strictEqual(unread.finished('c', { windowFocused: false, threadVisible: true }), true);
			assert.strictEqual(unread.finished('c', { windowFocused: false, threadVisible: true }), false);
			assert.strictEqual(unread.count, 2);
			// On screen but the window is in the background: still unread.
			assert.strictEqual(unread.seen(['c'], false), false);
			assert.strictEqual(unread.seen(['c'], true), true);
			assert.deepStrictEqual(unread.values(), ['b']);
			assert.strictEqual(unread.clear('b'), true);
			assert.strictEqual(unread.count, 0);
		});

		test('the badge sums every window', () => {
			assert.strictEqual(totalBadgeCount([2, 3, 0]), 5);
			assert.strictEqual(totalBadgeCount([-1, Number.NaN, 1.7]), 1);
			assert.strictEqual(totalBadgeCount([]), 0);
		});
	});
});
