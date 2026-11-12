/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Hello Volt: a tool agents can call to remember a fact (Volt's memory), and a turn counter that
 * listens for chats' turns. See docs/volt/extension-api.md.
 */
export function activate(context: vscode.ExtensionContext): void {
	// Outside Volt there is no `vscode.volt`.
	const volt = (vscode as Partial<typeof vscode>).volt;
	if (!volt) {
		return;
	}

	// A tool agents in every chat can call. Declared in package.json (`contributes.voltTools`) so
	// agents see it before this extension starts; its class `persists` needs `agents.context`.
	context.subscriptions.push(volt.tools.registerTool('hello_remember', async (input, call) => {
		const fact = typeof input.fact === 'string' ? input.fact.trim() : '';
		if (!fact) {
			return { error: 'Pass the fact to remember as `fact`.' };
		}
		const note = await volt.memory.write({
			name: `hello ${fact.slice(0, 40)}`,
			description: 'Saved by Hello Volt',
			body: fact,
			type: 'project',
		});
		return { text: `Saved "${note.name}"${call.chatId ? ` for chat ${call.chatId}` : ''}. Every later chat recalls it.` };
	}));

	// Counts finished turns per chat in the extension's own storage (no capability needed); the
	// events themselves need `agents.read:any`, which Volt asks the user for once.
	context.subscriptions.push(volt.chats.onDidEndTurn(async turn => {
		const counts = await volt.storage.get<Record<string, number>>('turns') ?? {};
		counts[turn.chatId] = (counts[turn.chatId] ?? 0) + 1;
		await volt.storage.set('turns', counts);
		if (counts[turn.chatId] === 1 && turn.outcome === 'done') {
			const notes = await volt.memory.list('all');
			vscode.window.setStatusBarMessage(`Hello Volt: a chat finished its first turn. Volt remembers ${notes.length} notes.`, 5000);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('volt-hello.chats', async () => {
		try {
			const chats = await volt.chats.list({ limit: 5 });
			vscode.window.showInformationMessage(`Latest chats: ${chats.map(chat => chat.title).join(', ') || 'none'}`);
		} catch (err) {
			// A refusal says which capability and which layer refused it.
			const refusal = err as Partial<vscode.volt.CapabilityError>;
			vscode.window.showWarningMessage(refusal.name === 'VoltCapabilityError' ? `Volt refused ${refusal.capability} (${refusal.deniedBy}).` : String(err));
		}
	}));
}

export function deactivate(): void { }
