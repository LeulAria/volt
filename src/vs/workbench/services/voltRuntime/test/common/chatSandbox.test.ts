/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DEFAULT_SANDBOX_SETTINGS, IVoltSandboxSettings } from '../../../../../platform/voltSandbox/common/sandboxPolicy.js';
import { confineChatSandbox, IChatSandboxStore, sandboxedInstructionRefusal } from '../../common/access/chatSandbox.js';
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
