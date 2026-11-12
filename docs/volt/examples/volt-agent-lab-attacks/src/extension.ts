/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as childProcess from 'child_process';
import { randomBytes } from 'crypto';
import * as https from 'https';
import * as vscode from 'vscode';
import { IAttackResult, runMockAttacks } from './attacks';
import { openLabPanel } from './panel';

/**
 * Agent Lab: one extension that uses many things at once, to show a Volt extension end to end and
 * to give Volt's sandbox something real to hold: Volt's model picker and a chat on the picked
 * model, an HTTP API, workspace files, secrets, a terminal and a process, settings, a webview and
 * an agent tool. Its TEST ONLY mode (`voltAgentLab.testOnly.mockAttacks`) tries what a malicious
 * extension would, now and again later. See docs/volt-e2e-review/03-sandbox-and-extensions.md.
 */

interface IStep {
	readonly step: string;
	readonly ok: boolean;
	readonly ms: number;
	readonly detail: string;
}

const activatedAt = Date.now();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('Agent Lab');
	context.subscriptions.push(output);
	const volt = (vscode as Partial<typeof vscode>).volt;
	let last: unknown = { activated: true };

	/** Results land in the output, the extension's own storage folder (what a test reads back) and the lab_status tool. */
	const record = async (kind: string, value: unknown) => {
		last = { kind, at: new Date().toISOString(), value };
		output.appendLine(`[${kind}] ${JSON.stringify(value)}`);
		try {
			await vscode.workspace.fs.createDirectory(context.globalStorageUri);
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(context.globalStorageUri, `${kind}.json`), new TextEncoder().encode(JSON.stringify(last, null, 1)));
		} catch (err) {
			output.appendLine(`[record] could not write ${kind}.json: ${err}`);
		}
		return last;
	};

	const step = async (name: string, fn: () => Promise<string>): Promise<IStep> => {
		const started = performance.now();
		try {
			const detail = await fn();
			return { step: name, ok: true, ms: Math.round(performance.now() - started), detail };
		} catch (err) {
			const refusal = err as Partial<vscode.volt.CapabilityError>;
			return { step: name, ok: false, ms: Math.round(performance.now() - started), detail: refusal.name === 'VoltCapabilityError' ? `refused ${refusal.capability} (${refusal.deniedBy})` : String((err as Error)?.message ?? err).slice(0, 200) };
		}
	};

	/** Everything that works without asking the user: what a sandboxed host must still be able to do. */
	const selfTest = async () => {
		const steps: IStep[] = [];
		steps.push(await step('settings', async () => {
			const task = vscode.workspace.getConfiguration('voltAgentLab').get<string>('task');
			const viaVolt = volt ? await volt.settings.get<string>('voltAgentLab.task') : task;
			return task === viaVolt ? `task setting read (${task?.length} chars)` : 'the two reads differ';
		}));
		steps.push(await step('secrets', async () => {
			const token = randomBytes(8).toString('hex');
			await context.secrets.store('lab-token', token);
			return (await context.secrets.get('lab-token')) === token ? 'stored and read back' : 'read back something else';
		}));
		steps.push(await step('workspace-read', async () => {
			const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 5);
			if (!files.length) {
				return 'no files in the workspace';
			}
			const bytes = await vscode.workspace.fs.readFile(files[0]);
			return `${files.length} files found, read ${vscode.workspace.asRelativePath(files[0])} (${bytes.length} bytes)`;
		}));
		steps.push(await step('workspace-write', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				return 'no workspace folder';
			}
			// A WorkspaceEdit: Volt's window applies it (a sandboxed host can't write the project itself).
			const notes = vscode.Uri.joinPath(folder.uri, 'lab-notes.md');
			const edit = new vscode.WorkspaceEdit();
			edit.createFile(notes, { overwrite: true, contents: new TextEncoder().encode(`# Agent Lab\n\nSelf test at ${new Date().toISOString()}\n`) });
			if (!await vscode.workspace.applyEdit(edit)) {
				throw new Error('the edit was not applied');
			}
			return 'wrote lab-notes.md with a WorkspaceEdit';
		}));
		steps.push(await step('http (fetch)', async () => {
			try {
				const response = await fetch('https://www.githubstatus.com/api/v2/status.json', { headers: { 'user-agent': 'volt-agent-lab' }, signal: AbortSignal.timeout(10_000) });
				return `www.githubstatus.com answered ${response.status}`;
			} catch (err) {
				const cause = (err as { cause?: { code?: string; message?: string } }).cause;
				throw new Error(`${(err as Error).message}${cause ? `: ${cause.code ?? ''} ${cause.message ?? ''}` : ''}`);
			}
		}));
		steps.push(await step('http (https module)', () => new Promise((resolve, reject) => {
			const req = https.get('https://www.githubstatus.com/api/v2/status.json', { headers: { 'user-agent': 'volt-agent-lab' }, timeout: 10_000 }, res => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', chunk => body += chunk);
				res.on('end', () => res.statusCode === 200 ? resolve(`www.githubstatus.com answered 200`) : reject(new Error(`HTTP ${res.statusCode}: ${body.trim().slice(0, 160)}`)));
			});
			req.on('error', reject);
			req.on('timeout', () => req.destroy(new Error('timed out')));
		})));
		// Declared too, but it takes data from anyone (I.4): the sandbox refuses it, the install review says so.
		steps.push(await step('http (exfil-capable host)', async () => `api.github.com answered ${(await fetch('https://api.github.com/zen', { headers: { 'user-agent': 'volt-agent-lab' }, signal: AbortSignal.timeout(10_000) })).status}`));
		steps.push(await step('process', () => new Promise((resolve, reject) => childProcess.execFile('git', ['--version'], { timeout: 10_000 }, (err, stdout) => err ? reject(err) : resolve(stdout.trim())))));
		steps.push(await step('terminal', async () => {
			const terminal = vscode.window.createTerminal({ name: 'Agent Lab' });
			terminal.sendText('echo agent-lab-terminal-ok');
			setTimeout(() => terminal.dispose(), 4_000);
			return 'opened a terminal';
		}));
		if (volt) {
			steps.push(await step('volt.storage', async () => {
				await volt.storage.set('selfTest', { at: Date.now() });
				return (await volt.storage.get<{ at: number }>('selfTest'))?.at ? 'set and read back' : 'nothing read back';
			}));
			steps.push(await step('volt.chats.current', async () => `the chat in front: ${(await volt.chats.current())?.title || 'none'}`));
			steps.push(await step('volt api latency', async () => {
				const times: number[] = [];
				for (let i = 0; i < 30; i++) {
					const started = performance.now();
					await volt.storage.get('selfTest');
					times.push(performance.now() - started);
				}
				times.sort((a, b) => a - b);
				return `volt.storage.get round trip p50 ${times[15].toFixed(2)} ms, p90 ${times[27].toFixed(2)} ms (n=30)`;
			}));
		}
		return record('selfTest', { activationMs: activationMs, hostUptimeAtActivationMs, steps });
	};

	const runAgent = async () => {
		if (!volt) {
			return { error: 'Not running in Volt.' };
		}
		const model = await volt.chats.pickModel({ placeHolder: 'Model for the lab task' });
		if (!model) {
			return { cancelled: true };
		}
		const task = vscode.workspace.getConfiguration('voltAgentLab').get<string>('task') ?? 'Say hello.';
		const started = await volt.chats.start({ title: 'Agent Lab task', message: task, model: model.id });
		return record('runAgent', { model, started: started.text ?? started.error });
	};

	const recentChats = async () => volt ? record('recentChats', (await volt.chats.list({ limit: 5 })).map(chat => chat.title)) : { error: 'Not running in Volt.' };

	const mockAttacks = async (phase = 'now') => {
		const results: IAttackResult[] = await runMockAttacks(phase);
		const through = results.filter(result => result.outcome === 'through');
		output.appendLine(`[mockAttacks ${phase}] ${through.length} of ${results.length} got through`);
		return record(`mockAttacks-${phase}`, { through: through.map(result => result.id), results });
	};

	const actions = { selfTest, runAgent, recentChats, mockAttacks: () => mockAttacks('panel') };
	context.subscriptions.push(
		vscode.commands.registerCommand('voltAgentLab.open', () => openLabPanel(context, actions)),
		vscode.commands.registerCommand('voltAgentLab.runAgent', runAgent),
		vscode.commands.registerCommand('voltAgentLab.selfTest', selfTest),
		vscode.commands.registerCommand('voltAgentLab.mockAttacks', () => mockAttacks('command')),
	);
	if (volt) {
		context.subscriptions.push(volt.tools.registerTool('lab_status', async () => ({ text: JSON.stringify(last).slice(0, 4_000) })));
	}

	const activationMs = Date.now() - activatedAt;
	const hostUptimeAtActivationMs = Math.round(process.uptime() * 1000);
	await record('activation', { activationMs, hostUptimeAtActivationMs, pid: process.pid });

	// TEST ONLY: a malicious extension would not wait to be asked. Once at start, and once later
	// (after install, at runtime) to check that the sandbox and its warning hold then too.
	const testOnly = vscode.workspace.getConfiguration('voltAgentLab');
	if (testOnly.get<boolean>('testOnly.mockAttacks')) {
		void mockAttacks('start');
		const timer = setTimeout(() => void mockAttacks('delayed'), Math.max(1_000, testOnly.get<number>('testOnly.delayMs') ?? 20_000));
		context.subscriptions.push({ dispose: () => clearTimeout(timer) });
	}
}

export function deactivate(): void { }
