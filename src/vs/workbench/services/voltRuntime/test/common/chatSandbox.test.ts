/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isAtLeastAsStrict, spawnSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxInheritance.js';
import { DEFAULT_SANDBOX_SETTINGS, IVoltSandboxSettings, sandboxStrategy } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { confineChatSandbox, handoffSandboxRefusal, IChatSandboxStore, sandboxedInstructionRefusal } from '../../common/access/chatSandbox.js';
import { sandboxCovers } from '../../common/hostToolSandbox.js';
import { isSandboxRefusedMessage, isSandboxUnavailableError, sandboxPlatformUnavailable, sandboxRefusedMessage, sandboxRefusedReason, sandboxUnavailableError } from '../../common/access/sandboxRefusal.js';

class FakeStore implements IChatSandboxStore {
	readonly chats = new Map<string, IVoltSandboxSettings>();
	writes = 0;
	constructor(private readonly defaults: IVoltSandboxSettings = DEFAULT_SANDBOX_SETTINGS) { }
	getSandboxSettings(id: string): IVoltSandboxSettings {
		return this.chats.get(id) ?? this.defaults;
	}
	async setSandboxSettings(id: string, settings: IVoltSandboxSettings): Promise<void> {
		this.writes++;
		this.chats.set(id, settings);
	}
}

const READ_ONLY: IVoltSandboxSettings = { level: 'read-only', network: false };
const WRITE: IVoltSandboxSettings = { level: 'workspace-write', network: true };

suite('Volt chat sandbox', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a child of a sandboxed chat is confined at least as tightly', async () => {
		const store = new FakeStore();
		store.chats.set('parent', READ_ONLY);
		await confineChatSandbox(store, 'child', store.getSandboxSettings('parent'));
		assert.deepStrictEqual(store.getSandboxSettings('child'), READ_ONLY);
	});

	test('nothing is written when the parent is unconfined or the child already stricter', async () => {
		const store = new FakeStore();
		store.chats.set('strict', READ_ONLY);
		await confineChatSandbox(store, 'child', DEFAULT_SANDBOX_SETTINGS);
		await confineChatSandbox(store, 'strict', WRITE);
		await confineChatSandbox(store, 'other', undefined);
		assert.strictEqual(store.writes, 0);
		assert.deepStrictEqual(store.getSandboxSettings('strict'), READ_ONLY);
	});

	test('a sandboxed chat may not instruct a less sandboxed one', () => {
		const store = new FakeStore();
		store.chats.set('sandboxed', WRITE);
		store.chats.set('strict', READ_ONLY);
		const refusal = sandboxedInstructionRefusal(store, 'sandboxed', 'open', 'Open chat');
		assert.ok(refusal && refusal.includes('"Open chat"'), refusal);
		assert.strictEqual(sandboxedInstructionRefusal(store, 'sandboxed', 'strict', 'Strict'), undefined, 'a stricter target is fine');
		assert.strictEqual(sandboxedInstructionRefusal(store, 'open', 'sandboxed', 'Sandboxed'), undefined, 'an unconfined sender is not limited');
		assert.strictEqual(sandboxedInstructionRefusal(store, 'sandboxed', 'sandboxed', 'Self'), undefined);
		assert.ok(sandboxedInstructionRefusal(store, 'strict', 'sandboxed', 'Looser'), 'network on and writable workspace are looser than read-only offline');
	});

	// --- GATE-SPAWN-1..6 (B-10, B-11, INV-11) ------------------------------------------------------

	const CALLER = { strategy: 'wrap' as const, roots: ['/Users/me/.volt/worktrees/p/wt-a', '/Users/me/code/p/.git'] };

	test('GATE-SPAWN-1: thread_launch {model: codex} from a sandboxed chat runs wrapped, never with Codex\'s own sandbox', async () => {
		assert.strictEqual(sandboxStrategy('codex', 'workspace-write', 'darwin'), 'wrap');
		assert.strictEqual(sandboxStrategy('codex', 'workspace-write', 'linux'), 'wrap');
		const store = new FakeStore();
		store.chats.set('caller', WRITE);
		const decision = await confineChatSandbox(store, 'child', WRITE, { caller: CALLER, child: { strategy: sandboxStrategy('codex', 'workspace-write', 'darwin'), roots: CALLER.roots } });
		assert.strictEqual(decision.refused, undefined);
		assert.deepStrictEqual(store.getSandboxSettings('child'), WRITE);
		// An agent that could only sandbox itself, or not at all, is refused rather than run weaker.
		for (const strategy of ['native', 'none'] as const) {
			const refused = await confineChatSandbox(store, `weak-${strategy}`, WRITE, { caller: CALLER, child: { strategy, roots: CALLER.roots } });
			assert.ok(refused.refused, strategy);
			assert.strictEqual(store.chats.has(`weak-${strategy}`), false, 'nothing stored for a refused child');
		}
	});

	test('GATE-SPAWN-2: a handoff (or thread_configure) of a sandboxed chat to Codex stays wrapped; to an unsandboxable agent it is refused', () => {
		assert.strictEqual(handoffSandboxRefusal(WRITE, 'claude-code', 'codex', 'GPT-6', 'darwin'), undefined);
		assert.strictEqual(handoffSandboxRefusal(READ_ONLY, 'claude-code', 'codex', 'GPT-6', 'linux'), undefined);
		assert.ok(handoffSandboxRefusal(WRITE, undefined, 'codex', 'GPT-6', 'win32')?.includes('weaker'), 'from a wrapped agent to one with no OS sandbox here');
		assert.strictEqual(handoffSandboxRefusal(DEFAULT_SANDBOX_SETTINGS, 'claude-code', 'codex', 'GPT-6', 'win32'), undefined, 'an unsandboxed chat moves freely');
		assert.ok(sandboxCovers(WRITE, WRITE, { target: '/p', caller: '/p', targetStrategy: 'wrap', callerStrategy: 'wrap' }));
		assert.ok(!sandboxCovers(WRITE, WRITE, { target: '/p', caller: '/p', targetStrategy: 'native', callerStrategy: 'wrap' }), 'native is weaker than wrap');
		assert.ok(!isAtLeastAsStrict(WRITE, WRITE, { a: { strategy: 'native' }, b: { strategy: 'wrap' } }));
	});

	test('GATE-SPAWN-3: project: other from a sandboxed chat runs read-only there', async () => {
		const store = new FakeStore();
		const decision = await confineChatSandbox(store, 'child', WRITE, { caller: CALLER, child: { roots: ['/Users/me/code/other'] } });
		assert.ok(decision.forcedReadOnly);
		assert.strictEqual(store.getSandboxSettings('child').level, 'read-only');
	});

	test('GATE-SPAWN-4: workspace: root from a worktree (the main checkout) runs read-only', async () => {
		const store = new FakeStore();
		const decision = await confineChatSandbox(store, 'child', WRITE, { caller: CALLER, child: { roots: ['/Users/me/code/p'] } });
		assert.ok(decision.forcedReadOnly, 'the main checkout is not the caller\'s worktree');
		assert.strictEqual(store.getSandboxSettings('child').level, 'read-only');
		// Its own checkout (or a folder below it) stays writable.
		const own = await confineChatSandbox(store, 'own', WRITE, { caller: CALLER, child: { roots: ['/Users/me/.volt/worktrees/p/wt-a', '/Users/me/code/p/.git'] } });
		assert.ok(!own.forcedReadOnly);
		assert.strictEqual(store.getSandboxSettings('own').level, 'workspace-write');
	});

	test('GATE-SPAWN-5: existing_worktree of another chat runs read-only; a read-only caller\'s child is read-only anyway', async () => {
		const store = new FakeStore();
		const decision = await confineChatSandbox(store, 'child', WRITE, { caller: CALLER, child: { roots: ['/Users/me/.volt/worktrees/p/wt-b', '/Users/me/code/p/.git'] } });
		assert.ok(decision.forcedReadOnly);
		assert.strictEqual(store.getSandboxSettings('child').level, 'read-only');
		const strict = await confineChatSandbox(store, 'strict-child', READ_ONLY, { caller: { roots: ['/a'] }, child: { roots: ['/b'] } });
		assert.ok(!strict.forcedReadOnly);
		assert.strictEqual(store.getSandboxSettings('strict-child').level, 'read-only');
	});

	test('GATE-SPAWN-6: roots are compared as real paths; a sibling with the same prefix, or an allowed folder, are told apart', async () => {
		const store = new FakeStore();
		// The caller resolved its folders: a child folder named inside the worktree but really elsewhere is outside.
		const sibling = await confineChatSandbox(store, 'sibling', WRITE, { caller: CALLER, child: { roots: ['/Users/me/.volt/worktrees/p/wt-a-evil'] } });
		assert.ok(sibling.forcedReadOnly, 'a shared prefix is not containment');
		const allowed = await confineChatSandbox(store, 'allowed', { ...WRITE, extraWritableRoots: ['/data'] }, { caller: CALLER, child: { roots: ['/data/sub'] } });
		assert.ok(!allowed.forcedReadOnly, 'inside a folder the user allowed the caller');
		assert.ok(!sandboxCovers(WRITE, WRITE, { target: '/Users/me/real-elsewhere', caller: '/Users/me/.volt/worktrees/p/wt-a' }));
		assert.ok(spawnSandboxSettings(DEFAULT_SANDBOX_SETTINGS, WRITE, { child: { roots: ['/anywhere'] } }).settings === undefined, 'an unsandboxed caller confines nothing');
	});

	test('refused spawns: the error name survives, the message is recognized', () => {
		const err = sandboxUnavailableError('No sandbox backend for network isolation');
		assert.ok(isSandboxUnavailableError(err));
		// Errors cross IPC as plain Errors with their name kept.
		const overIpc = new Error(err.message);
		overIpc.name = err.name;
		assert.ok(isSandboxUnavailableError(overIpc));
		assert.ok(!isSandboxUnavailableError(new Error('ACP process exited')));
		const message = sandboxRefusedMessage(err.message);
		assert.ok(isSandboxRefusedMessage(message));
		assert.ok(message.startsWith('Sandbox unavailable: No sandbox backend for network isolation.'), message);
		assert.ok(sandboxRefusedReason(message).startsWith('No sandbox backend'));
		assert.ok(!isSandboxRefusedMessage('Agent process died.'));
		assert.ok(sandboxPlatformUnavailable('win32'));
		assert.strictEqual(sandboxPlatformUnavailable('darwin'), undefined);
	});
});
