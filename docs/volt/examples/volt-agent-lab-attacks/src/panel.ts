/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/** The lab's webview: buttons for each action, and what each returned. */
export function openLabPanel(context: vscode.ExtensionContext, actions: Record<string, () => Promise<unknown>>): vscode.WebviewPanel {
	const panel = vscode.window.createWebviewPanel('voltAgentLab', 'Agent Lab', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
	const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
	const buttons = Object.keys(actions).map(id => `<button data-action="${id}"${id === 'mockAttacks' ? ' class="test-only"' : ''}>${label(id)}</button>`).join('');
	panel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font: 13px system-ui, sans-serif; color: var(--vscode-foreground); padding: 12px 16px; }
h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
p { color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
button { font: inherit; padding: 4px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
button.test-only { border-color: var(--vscode-editorWarning-foreground); }
pre { font: 12px ui-monospace, monospace; white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; margin: 0; }
</style></head>
<body>
<h1>Agent Lab</h1>
<p>Runs each part of the extension and shows what came back. The orange button is for testing Volt's sandbox only.</p>
<div class="actions">${buttons}</div>
<pre id="out">Pick an action.</pre>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const button of document.querySelectorAll('button')) {
	button.addEventListener('click', () => { document.getElementById('out').textContent = 'Running...'; vscode.postMessage({ action: button.dataset.action }); });
}
window.addEventListener('message', e => { document.getElementById('out').textContent = JSON.stringify(e.data, null, 2); });
</script>
</body></html>`;
	context.subscriptions.push(panel.webview.onDidReceiveMessage(async (message: { action?: string }) => {
		const action = message.action && actions[message.action];
		if (!action) {
			return;
		}
		try {
			await panel.webview.postMessage(await action());
		} catch (err) {
			const refusal = err as Partial<vscode.volt.CapabilityError>;
			await panel.webview.postMessage({ error: refusal.name === 'VoltCapabilityError' ? `Volt refused ${refusal.capability} (${refusal.deniedBy})` : String(err) });
		}
	}));
	return panel;
}

function label(id: string): string {
	switch (id) {
		case 'selfTest': return 'Run Self Test';
		case 'runAgent': return 'Pick a Model and Run';
		case 'recentChats': return 'Recent Chats';
		case 'mockAttacks': return 'Mock Attacks (TEST ONLY)';
		default: return id;
	}
}
