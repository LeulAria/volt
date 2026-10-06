/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { browserDataBytes, cachedDataKeep, checkpointKeep, fileUriToPath, formatBytes, IVoltStorageLayout, logKeep, machineRows, nativeTranscriptKeep, sessionIdFromFile, summarizeRow, traceKeep, workspaceStorageKeep, workspaceStorageTarget, worktreeKeep } from '../../common/voltStorageRules.js';

const layout: IVoltStorageLayout = {
	userDataPath: '/data',
	userRoamingPath: '/data/User',
	logsSessionPath: '/data/logs/20261006T090000',
	worktreesRoot: '/home/me/.volt/worktrees',
	commit: 'abc123',
};

suite('Volt storage rules', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('machine rows cover Volt\'s folders, GPU caches and run groups are never cleaned', () => {
		const rows = machineRows(layout);
		const byId = new Map(rows.map(row => [row.id, row]));
		assert.deepStrictEqual(byId.get('logs')?.roots, ['/data/logs']);
		assert.deepStrictEqual(byId.get('worktrees')?.roots, ['/home/me/.volt/worktrees']);
		assert.deepStrictEqual(byId.get('chatHistory')?.roots, ['/data/User/agentSessions']);
		assert.strictEqual(byId.get('gpuCache')?.keep, 'inUse');
		assert.strictEqual(byId.get('runGroups')?.unit, 'info');
		assert.strictEqual(byId.get('chromiumCache')?.unit, 'whole');
		assert.strictEqual(new Set(rows.map(row => row.id)).size, rows.length);
	});

	test('the current log session and this build\'s code cache stay', () => {
		assert.strictEqual(logKeep('/data/logs/20261006T090000', layout), 'current');
		assert.strictEqual(logKeep('/data/logs/20261001T080000', layout), undefined);
		assert.strictEqual(cachedDataKeep('abc123', 'abc123'), 'current');
		assert.strictEqual(cachedDataKeep('old999', 'abc123'), undefined);
		// Dev builds have no commit: every CachedData folder is from another build.
		assert.strictEqual(cachedDataKeep('abc123', undefined), undefined);
	});

	test('session files: traces of running chats stay, transcripts only of deleted chats go', () => {
		assert.strictEqual(sessionIdFromFile('agent-0514385d-df40-4012-bc75-40accac4d489.jsonl'), 'agent-0514385d-df40-4012-bc75-40accac4d489');
		assert.strictEqual(sessionIdFromFile('agent-0514385d-df40-4012-bc75-40accac4d489.draft.json'), 'agent-0514385d-df40-4012-bc75-40accac4d489');
		assert.strictEqual(sessionIdFromFile('index.json'), undefined);
		const running = new Set(['agent-11111111-aaaa']);
		assert.strictEqual(traceKeep('agent-11111111-aaaa.jsonl', running), 'open');
		assert.strictEqual(traceKeep('agent-22222222-bbbb.jsonl', running), undefined);
		const known = new Set(['agent-11111111-aaaa']);
		assert.strictEqual(nativeTranscriptKeep('agent-11111111-aaaa.json', known), 'exists');
		assert.strictEqual(nativeTranscriptKeep('agent-33333333-cccc.json', known), undefined);
		assert.strictEqual(nativeTranscriptKeep('notes.txt', known), 'exists');
	});

	test('workspace storage: open entries stay, machine-wide only gone folders are cleaned', () => {
		assert.strictEqual(workspaceStorageTarget('{"folder":"file:///Users/me/My%20App"}'), 'file:///Users/me/My%20App');
		assert.strictEqual(workspaceStorageTarget('{"workspace":"file:///w.code-workspace"}'), 'file:///w.code-workspace');
		assert.strictEqual(workspaceStorageTarget('nope'), undefined);
		assert.strictEqual(fileUriToPath('file:///Users/me/My%20App'), '/Users/me/My App');
		assert.strictEqual(fileUriToPath('file:///c%3A/src'), 'c:/src');
		assert.strictEqual(fileUriToPath('vscode-remote://ssh/x'), undefined);
		const open = new Set(['open1']);
		assert.strictEqual(workspaceStorageKeep('open1', 'file:///gone', false, open), 'open');
		assert.strictEqual(workspaceStorageKeep('a', 'file:///gone', false, open), undefined);
		assert.strictEqual(workspaceStorageKeep('b', 'file:///here', true, open), 'exists');
		assert.strictEqual(workspaceStorageKeep('c', 'vscode-remote://ssh/x', false, open), 'exists');
		assert.strictEqual(workspaceStorageKeep('d', undefined, false, open), undefined);
		// From a project, its own entry may go even though the folder exists.
		assert.strictEqual(workspaceStorageKeep('b', 'file:///here', true, open, true), undefined);
		assert.strictEqual(workspaceStorageKeep('open1', 'file:///here', true, open, true), 'open');
	});

	test('worktrees: open chats\' and dirty ones stay, unreadable ones warn', () => {
		const refs = [
			{ path: '/wt/r/volt-aaaaaaaa', sessionId: 's1', archived: false },
			{ path: '/wt/r/volt-bbbbbbbb', sessionId: 's2', archived: true },
		];
		assert.strictEqual(worktreeKeep('/wt/r/volt-aaaaaaaa', refs, false), 'inUse');
		assert.strictEqual(worktreeKeep('/wt/r/volt-aaaaaaaa/', refs, false), 'inUse');
		assert.strictEqual(worktreeKeep('/wt/r/volt-bbbbbbbb', refs, false), undefined);
		assert.strictEqual(worktreeKeep('/wt/r/volt-bbbbbbbb', refs, true), 'dirty');
		assert.strictEqual(worktreeKeep('/wt/r/volt-cccccccc', refs, undefined), 'unknown');
		assert.strictEqual(checkpointKeep(false), undefined);
		assert.strictEqual(checkpointKeep(true), 'exists');
		assert.strictEqual(checkpointKeep(undefined), 'exists');
	});

	test('row totals count only what Clean may remove', () => {
		const entries = [{ path: '/a', bytes: 100 }, { path: '/b', bytes: 50, keep: 'current' as const }];
		const row = summarizeRow({ id: 'logs', roots: ['/logs'], unit: 'children' }, 160, entries);
		assert.strictEqual(row.cleanableBytes, 100);
		assert.strictEqual(row.cleanable, true);
		assert.strictEqual(summarizeRow({ id: 'codeCache', roots: [], unit: 'whole' }, 70, []).cleanableBytes, 70);
		const info = summarizeRow({ id: 'gpuCache', roots: [], unit: 'info', keep: 'inUse' }, 70, []);
		assert.strictEqual(info.cleanable, false);
		assert.strictEqual(info.cleanableBytes, 0);
		assert.strictEqual(browserDataBytes(300, 120), 180);
		assert.strictEqual(browserDataBytes(100, 120), 0);
	});

	test('formats sizes like Finder', () => {
		assert.strictEqual(formatBytes(0), '0 B');
		assert.strictEqual(formatBytes(812), '812 B');
		assert.strictEqual(formatBytes(4_200_000), '4.2 MB');
		assert.strictEqual(formatBytes(61_000_000), '61.0 MB');
		assert.strictEqual(formatBytes(294_000_000), '294 MB');
		assert.strictEqual(formatBytes(1_310_000_000), '1.31 GB');
	});
});
