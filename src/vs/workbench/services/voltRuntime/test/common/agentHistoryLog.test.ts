/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGENT_HISTORY_FORMAT_VERSION, AgentHistoryRecord, IAgentSessionHeader, IAgentSessionMeta } from '../../common/history/agentHistory.js';
import {
	attachmentFileName,
	attachmentRef,
	compactRecords,
	decodeLog,
	deriveMeta,
	deriveTitle,
	encodeRecord,
	encodeRecords,
	foldTranscript,
	normalizeIndex,
	parseAttachmentRef,
	renderTranscriptMarkdown,
	searchSessions,
	settleIndexAfterRestart,
	shouldCompact,
	sortSessions,
	truncateAtWord,
} from '../../common/history/agentHistoryLog.js';

const header: IAgentSessionHeader = {
	type: 'header',
	version: AGENT_HISTORY_FORMAT_VERSION,
	id: 'agent-1',
	createdAt: 1000,
	workspace: { id: 'ws', label: 'volt', folders: ['/tmp/volt'] },
};

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function meta(partial: Partial<IAgentSessionMeta> & { id: string }): IAgentSessionMeta {
	return {
		title: partial.id,
		createdAt: 0,
		updatedAt: 0,
		workspaceId: 'ws',
		workspaceLabel: 'volt',
		turnCount: 1,
		preview: '',
		status: 'done',
		...partial,
	};
}

suite('Volt agent history log', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips records through JSONL', () => {
		const records: AgentHistoryRecord[] = [
			header,
			{ type: 'user', turn: 't1', at: 1001, text: 'hello', message: { kind: 'user', text: 'hello' } },
			{ type: 'agent', turn: 't1', at: 1002, final: true, status: 'done', text: 'hi', message: { kind: 'agent' } },
		];
		const encoded = encodeRecords(records);
		const decoded = decodeLog(bytes(encoded));
		assert.deepStrictEqual(decoded.header, header);
		assert.strictEqual(decoded.entries.length, 2);
		assert.strictEqual(decoded.validBytes, bytes(encoded).length);
		assert.strictEqual(decoded.damaged, false);
		assert.strictEqual(decoded.recordCount, 3);
	});

	test('drops a torn trailing line and reports where to resume', () => {
		const good = encodeRecord(header) + encodeRecord({ type: 'user', turn: 't1', at: 1, text: 'a', message: null });
		const torn = good + '{"type":"agent","turn":"t1","at":2,"final":tr';
		const decoded = decodeLog(bytes(torn));
		assert.strictEqual(decoded.entries.length, 1);
		assert.strictEqual(decoded.damaged, true);
		assert.strictEqual(decoded.validBytes, bytes(good).length);
	});

	test('skips a corrupt complete line but keeps later records', () => {
		const text = encodeRecord(header)
			+ 'not json\n'
			+ encodeRecord({ type: 'user', turn: 't1', at: 1, text: 'a', message: null })
			+ '{"type":"bogus"}\n'
			+ encodeRecord({ type: 'agent', turn: 't1', at: 2, final: true, status: 'done', text: 'b', message: null });
		const decoded = decodeLog(bytes(text));
		assert.strictEqual(decoded.entries.length, 2);
		assert.strictEqual(decoded.damaged, true);
		assert.strictEqual(decoded.validBytes, bytes(text).length);
	});

	test('handles multi-byte characters across lines', () => {
		const text = encodeRecord(header) + encodeRecord({ type: 'user', turn: 't1', at: 1, text: 'héllo 🌍 “quotes”', message: null });
		const decoded = decodeLog(bytes(text));
		assert.strictEqual(decoded.entries.length, 1);
		assert.strictEqual((decoded.entries[0] as { text: string }).text, 'héllo 🌍 “quotes”');
	});

	test('folds streaming snapshots so the last one wins', () => {
		const transcript = foldTranscript(header, [
			{ type: 'user', turn: 't1', at: 1, text: 'q', message: null },
			{ type: 'agent', turn: 't1', at: 2, final: false, status: 'running', text: 'partial', message: null },
			{ type: 'agent', turn: 't1', at: 3, final: true, status: 'done', text: 'complete', message: null },
		]);
		assert.strictEqual(transcript.turns.length, 1);
		assert.strictEqual(transcript.turns[0].assistant?.text, 'complete');
		assert.strictEqual(transcript.turns[0].assistant?.final, true);
	});

	test('truncate removes the turn and everything after it', () => {
		const transcript = foldTranscript(header, [
			{ type: 'user', turn: 't1', at: 1, text: 'one', message: null },
			{ type: 'agent', turn: 't1', at: 2, final: true, status: 'done', text: 'r1', message: null },
			{ type: 'user', turn: 't2', at: 3, text: 'two', message: null },
			{ type: 'agent', turn: 't2', at: 4, final: true, status: 'done', text: 'r2', message: null },
			{ type: 'user', turn: 't3', at: 5, text: 'three', message: null },
			{ type: 'truncate', at: 6, from: 't2' },
			{ type: 'user', turn: 't4', at: 7, text: 'two edited', message: null },
		]);
		assert.deepStrictEqual(transcript.turns.map(turn => turn.id), ['t1', 't4']);
		assert.strictEqual(transcript.turns[1].user.text, 'two edited');
	});

	test('meta entries carry title, mode and model', () => {
		const transcript = foldTranscript(header, [
			{ type: 'meta', at: 1, mode: 'plan' },
			{ type: 'meta', at: 2, title: 'Custom', model: 'openai/gpt' },
			{ type: 'meta', at: 3, title: '' },
		]);
		assert.strictEqual(transcript.title, undefined);
		assert.strictEqual(transcript.mode, 'plan');
		assert.strictEqual(transcript.model, 'openai/gpt');
	});

	test('compaction keeps only effective records', () => {
		const transcript = foldTranscript(header, [
			{ type: 'meta', at: 0, title: 'Named' },
			{ type: 'user', turn: 't1', at: 1, text: 'q', message: null },
			{ type: 'agent', turn: 't1', at: 2, final: false, status: 'running', text: 'p', message: null },
			{ type: 'agent', turn: 't1', at: 3, final: false, status: 'running', text: 'pp', message: null },
			{ type: 'agent', turn: 't1', at: 4, final: true, status: 'done', text: 'done', message: null },
			{ type: 'user', turn: 't2', at: 5, text: 'gone', message: null },
			{ type: 'truncate', at: 6, from: 't2' },
		]);
		const records = compactRecords(transcript);
		assert.deepStrictEqual(records.map(record => record.type), ['header', 'meta', 'user', 'agent']);
		const refolded = foldTranscript(header, decodeLog(bytes(encodeRecords(records))).entries);
		assert.strictEqual(refolded.title, 'Named');
		assert.strictEqual(refolded.turns.length, 1);
		assert.strictEqual(refolded.turns[0].assistant?.text, 'done');
	});

	test('shouldCompact triggers on damage or enough stale records', () => {
		assert.strictEqual(shouldCompact(3, 3, false), false);
		assert.strictEqual(shouldCompact(3, 3, true), true);
		assert.strictEqual(shouldCompact(5, 3, false), false);
		assert.strictEqual(shouldCompact(6, 3, false), true);
		assert.strictEqual(shouldCompact(120, 100, false), true);
	});

	test('derives titles from the first meaningful line', () => {
		assert.strictEqual(deriveTitle('  \n# fix the login bug\nmore'), 'Fix the login bug');
		assert.strictEqual(deriveTitle('<file path="a.ts"> explain   this'), 'Explain this');
		assert.strictEqual(deriveTitle(''), '');
		const long = deriveTitle('please refactor the entire authentication module so that sessions are durable and searchable');
		assert.ok(long.length <= 57, long);
		assert.ok(long.endsWith('…'));
	});

	test('truncateAtWord prefers word boundaries', () => {
		assert.strictEqual(truncateAtWord('short', 10), 'short');
		assert.strictEqual(truncateAtWord('hello wonderful world', 18), 'hello wonderful…');
		// A boundary too far back would leave almost nothing; cut mid-word instead.
		assert.strictEqual(truncateAtWord('hello wonderful world', 14), 'hello wonderf…');
	});

	test('derives index meta from a transcript', () => {
		const transcript = foldTranscript(header, [
			{ type: 'user', turn: 't1', at: 2000, text: 'Add dark mode toggle', message: null },
			{ type: 'agent', turn: 't1', at: 3000, final: true, status: 'done', text: 'done', summary: 'Edited settings.ts, theme.ts', message: null },
		]);
		const derived = deriveMeta(transcript, { pinned: true });
		assert.strictEqual(derived.id, 'agent-1');
		assert.strictEqual(derived.title, 'Add dark mode toggle');
		assert.strictEqual(derived.customTitle, false);
		assert.strictEqual(derived.updatedAt, 3000);
		assert.strictEqual(derived.turnCount, 1);
		assert.strictEqual(derived.status, 'done');
		assert.strictEqual(derived.summary, 'Edited settings.ts, theme.ts');
		assert.strictEqual(derived.pinned, true);
		assert.strictEqual(derived.workspaceFolder, '/tmp/volt');
	});

	test('status reflects unfinished turns', () => {
		const running = foldTranscript(header, [
			{ type: 'user', turn: 't1', at: 1, text: 'q', message: null },
			{ type: 'agent', turn: 't1', at: 2, final: false, status: 'running', text: '', message: null },
		]);
		assert.strictEqual(deriveMeta(running).status, 'running');
		const noReply = foldTranscript(header, [{ type: 'user', turn: 't1', at: 1, text: 'q', message: null }]);
		assert.strictEqual(deriveMeta(noReply).status, 'interrupted');
		assert.strictEqual(deriveMeta(foldTranscript(header, [])).status, 'idle');
	});

	test('normalizes and settles the index', () => {
		assert.strictEqual(normalizeIndex(undefined), undefined);
		assert.strictEqual(normalizeIndex({ version: 'x' }), undefined);
		const index = normalizeIndex({
			version: 1,
			sessions: [
				meta({ id: 'a', status: 'running' }),
				{ id: 'broken' },
				meta({ id: 'a', status: 'done' }),
				meta({ id: 'b' }),
			],
		});
		assert.ok(index);
		assert.deepStrictEqual(index.sessions.map(item => item.id), ['a', 'b']);
		const settled = settleIndexAfterRestart(index);
		assert.strictEqual(settled.sessions[0].status, 'interrupted');
		assert.strictEqual(settled.sessions[1].status, 'done');
	});

	test('sorts pinned first, then most recent', () => {
		const sorted = sortSessions([
			meta({ id: 'old', updatedAt: 1 }),
			meta({ id: 'new', updatedAt: 3 }),
			meta({ id: 'pinned', updatedAt: 2, pinned: true }),
		]);
		assert.deepStrictEqual(sorted.map(item => item.id), ['pinned', 'new', 'old']);
	});

	test('search requires every token and ranks title hits first', () => {
		const sessions = [
			meta({ id: 'a', title: 'Polished icon design', preview: 'make the icons crisp', updatedAt: 1 }),
			meta({ id: 'b', title: 'Changelog suggestions', preview: 'icon ideas for the changelog', updatedAt: 2 }),
			meta({ id: 'c', title: 'Unrelated', preview: 'nothing here', updatedAt: 3 }),
		];
		assert.deepStrictEqual(searchSessions(sessions, 'icon').map(item => item.id), ['a', 'b']);
		assert.deepStrictEqual(searchSessions(sessions, 'icon changelog').map(item => item.id), ['b']);
		assert.deepStrictEqual(searchSessions(sessions, 'zzz').map(item => item.id), []);
		assert.deepStrictEqual(searchSessions(sessions, '   ').map(item => item.id), ['c', 'b', 'a']);
	});

	test('search is fuzzy across title and preview', () => {
		const sessions = [
			meta({ id: 'readme', title: 'Add a readme file', preview: 'document the project', updatedAt: 1 }),
			meta({ id: 'other', title: 'Unrelated', preview: 'nothing here', updatedAt: 2 }),
		];
		assert.deepStrictEqual(searchSessions(sessions, 'rdme').map(item => item.id), ['readme']);
		assert.deepStrictEqual(searchSessions(sessions, 'adrm').map(item => item.id), ['readme']);
	});

	test('search respects case, whole word and regex toggles', () => {
		const sessions = [
			meta({ id: 'a', title: 'Polished Icon design', preview: 'icons', updatedAt: 1 }),
			meta({ id: 'b', title: 'iconography notes', preview: 'nothing', updatedAt: 2 }),
		];
		assert.deepStrictEqual(searchSessions(sessions, 'Icon', { matchCase: true }).map(item => item.id), ['a']);
		assert.deepStrictEqual(searchSessions(sessions, 'icon', { wholeWord: true }).map(item => item.id), ['a']);
		assert.deepStrictEqual(searchSessions(sessions, 'icon.*design', { isRegex: true }).map(item => item.id), ['a']);
		assert.deepStrictEqual(searchSessions(sessions, '(', { isRegex: true }).map(item => item.id), []);
	});

	test('attachment refs are content addressed and validated', () => {
		const fileName = attachmentFileName('0123456789abcdef', 'image/png');
		assert.strictEqual(fileName, '0123456789abcdef.png');
		const ref = attachmentRef(fileName);
		assert.deepStrictEqual(parseAttachmentRef(ref), { fileName, mime: 'image/png' });
		assert.strictEqual(parseAttachmentRef('volt-attachment:../etc/passwd'), undefined);
		assert.strictEqual(parseAttachmentRef('http://x'), undefined);
		assert.strictEqual(attachmentFileName('abcdefabcdef', 'image/jpeg'), 'abcdefabcdef.jpg');
		assert.strictEqual(parseAttachmentRef(attachmentRef('abcdefabcdef.jpg'))?.mime, 'image/jpeg');
	});

	test('renders a transcript as markdown', () => {
		const transcript = foldTranscript(header, [
			{ type: 'meta', at: 1, mode: 'agent' },
			{ type: 'user', turn: 't1', at: 2, text: 'Fix the bug', message: {} },
			{ type: 'agent', turn: 't1', at: 3, final: true, status: 'done', text: 'Done.', message: {} },
			{ type: 'user', turn: 't2', at: 4, text: 'And tests?', message: {} },
			{ type: 'agent', turn: 't2', at: 5, final: true, status: 'cancelled', text: '', message: {} },
		]);
		const markdown = renderTranscriptMarkdown('Bug fix', transcript, at => `@${at}`);
		assert.strictEqual(markdown, [
			'# Bug fix', '',
			'_volt · @1000 · agent_', '',
			'## User', '', 'Fix the bug', '',
			'## Agent', '', 'Done.', '',
			'## User', '', 'And tests?', '',
			'## Agent _(cancelled)_', '', '_(no reply)_', '',
		].join('\n'));
	});
});
