/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DependencyReport, describeReport, outdated, projectFolder, readDependencies, scoutDependencies, upgradePlan } from './lab';

/**
 * Agent Lab: scouts the open project's npm dependencies on registry.npmjs.org, keeps the report in
 * its own storage, serves it to agents as a tool (with a chart), and hands the upgrade plan to the
 * agent and model you pick: a chat you have, or a new one on a model from Volt's list. The plan is
 * drawn on Scratch and remembered in a memory note. See README.md and docs/volt/extension-api.md.
 *
 * The misbehavior switches (`agentLab.testFixture.mode`) live in `src/testFixture/`, which only
 * the test build compiles (`node build.mjs --fixture`). This file has no misbehavior.
 */

type Volt = typeof vscode.volt;

const REPORT_KEY = 'report';

export function activate(context: vscode.ExtensionContext): void {
	const volt = (vscode as Partial<typeof vscode>).volt;
	if (!volt) {
		vscode.window.showWarningMessage('Agent Lab needs Volt.');
		return;
	}
	const output = vscode.window.createOutputChannel('Agent Lab');
	context.subscriptions.push(output);

	// The tool agents call. Declared in package.json, class `reads` (it reads the project's package.json).
	context.subscriptions.push(volt.tools.registerTool('agent_lab_dependencies', async input => {
		const report = await volt.storage.get<DependencyReport>(REPORT_KEY);
		if (!report) {
			const deps = await readDependencies(await projectFolder(volt)).catch(() => undefined);
			return { text: deps ? `Agent Lab has not scouted this project yet (${deps.length} dependencies in package.json). Ask the user to run "Agent Lab: Scout Dependencies".` : 'There is no package.json in the open project.' };
		}
		const rows = input.onlyOutdated === true ? outdated(report) : report.packages;
		const text = describeReport(report, rows);
		if (input.chart !== true || !rows.length) {
			return { text };
		}
		const chart = await volt.visuals.renderChart({
			title: 'Releases behind latest',
			subtitle: `${report.project}, scouted ${new Date(report.at).toLocaleString()}`,
			charts: [{ type: 'bar', data: rows.slice(0, 20).map(row => ({ package: row.name, behind: row.behind.major * 100 + row.behind.minor * 10 + row.behind.patch })), x: 'package', y: 'behind' }],
		});
		return { ...chart, text };
	}));

	context.subscriptions.push(vscode.commands.registerCommand('agentLab.scan', () => scan(volt, output)));
	context.subscriptions.push(vscode.commands.registerCommand('agentLab.handOff', () => handOff(volt, output)));
	context.subscriptions.push(vscode.commands.registerCommand('agentLab.openPackage', () => openPackage(volt)));

	// The test fixture, only in the test build: absent from the published one, so this does nothing there.
	const fixture = loadFixture(output);
	context.subscriptions.push(vscode.commands.registerCommand('agentLab.testFixture.run', async () => {
		if (!fixture) {
			vscode.window.showInformationMessage('This Agent Lab build has no test fixture (published builds never do).');
			return;
		}
		await fixture.run(context, volt, output);
	}));
	fixture?.activate(context, volt, output);
}

export function deactivate(): void { }

async function scan(volt: Volt, output: vscode.OutputChannel): Promise<DependencyReport | undefined> {
	const registry = vscode.workspace.getConfiguration('agentLab').get<string>('registry') || 'https://registry.npmjs.org';
	let report: DependencyReport;
	try {
		report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Agent Lab: scouting dependencies' }, async () => scoutDependencies(registry, await projectFolder(volt)));
	} catch (err) {
		vscode.window.showErrorMessage(`Agent Lab could not scout: ${messageOf(err)}`);
		return undefined;
	}
	await volt.storage.set(REPORT_KEY, report);
	output.appendLine(describeReport(report, report.packages));
	const behind = outdated(report);
	const failed = report.packages.filter(row => row.error).length;
	const pick = await vscode.window.showInformationMessage(
		`Agent Lab: ${behind.length} of ${report.packages.length} dependencies are behind${failed ? ` (${failed} not found)` : ''}.`,
		...(behind.length ? ['Hand to an Agent'] : []), 'Show Report');
	if (pick === 'Hand to an Agent') {
		await handOff(volt, output);
	} else if (pick === 'Show Report') {
		output.show(true);
	}
	return report;
}

interface ITarget extends vscode.QuickPickItem {
	readonly target: 'current' | 'chat' | 'new';
	readonly chatId?: string;
}

/** Picks an agent (a chat, or a new chat on a model from Volt's list), sends it the plan, draws it on Scratch and remembers it. */
async function handOff(volt: Volt, output: vscode.OutputChannel): Promise<void> {
	const report = await volt.storage.get<DependencyReport>(REPORT_KEY) ?? await scan(volt, output);
	if (!report) {
		return;
	}
	const behind = outdated(report);
	if (!behind.length) {
		vscode.window.showInformationMessage('Agent Lab: every dependency is on its latest version.');
		return;
	}
	const plan = upgradePlan(report);
	try {
		const current = await volt.chats.current();
		const targets: ITarget[] = [];
		if (current) {
			targets.push({ target: 'current', chatId: current.id, label: `$(comment-discussion) ${current.title || 'The chat in front'}`, ...(current.title ? { description: 'the chat in front' } : {}) });
		}
		targets.push({ target: 'chat', label: '$(list-unordered) Another chat', description: 'pick one of your chats' });
		targets.push({ target: 'new', label: '$(add) A new chat', description: 'on a model you pick' });
		const target = await vscode.window.showQuickPick(targets, { title: 'Agent Lab: who should do the upgrade?' });
		if (!target) {
			return;
		}
		let chatId = target.chatId;
		if (target.target === 'chat') {
			const chats = await volt.chats.list({ limit: 30 });
			const chat = await vscode.window.showQuickPick(chats.map(item => ({ label: item.title || item.id, description: `${item.status}, ${item.turnCount} turns`, id: item.id })), { title: 'Agent Lab: pick a chat' });
			if (!chat) {
				return;
			}
			chatId = chat.id;
		}
		if (target.target === 'new') {
			const model = await pickModel(volt, current?.id);
			if (model === undefined) {
				return;
			}
			const started = await volt.chats.start({ title: `Upgrade ${behind.length} dependencies`, message: plan, project: report.root, ...(model ? { model } : {}) });
			if (started.error) {
				throw new Error(started.error);
			}
			output.appendLine(`Started a chat: ${started.text ?? ''}`);
			// "Launched <title> (id <chat id>) on <model>, ...".
			chatId = /\(id ([\w-]+)\)/.exec(started.text ?? '')?.[1];
		} else if (chatId) {
			const sent = await volt.chats.send(chatId, plan);
			if (sent.error) {
				throw new Error(sent.error);
			}
		}
		await volt.visuals.drawOnScratch({
			title: `Upgrade plan: ${report.project}`,
			mermaid: ['flowchart LR', '  plan([Upgrade plan])', ...behind.slice(0, 12).map((row, i) => `  plan --> p${i}["${row.name}: ${row.current} to ${row.latest}"]`)].join('\n'),
		}, chatId ? { chatId } : undefined).then(undefined, err => output.appendLine(`Scratch: ${messageOf(err)}`));
		await volt.memory.write({
			name: `agent lab ${report.project}`,
			description: `Outdated npm dependencies of ${report.project}, from Agent Lab`,
			body: behind.map(row => `${row.name}: ${row.current} -> ${row.latest}`).join('\n'),
			type: 'project',
			scope: 'project',
		}).then(undefined, err => output.appendLine(`Memory: ${messageOf(err)}`));
		if (chatId) {
			watchTurns(volt, chatId, output);
		}
		vscode.window.showInformationMessage(`Agent Lab handed ${behind.length} upgrades to ${target.target === 'new' ? 'a new chat' : 'the chat'}.`);
	} catch (err) {
		vscode.window.showWarningMessage(`Agent Lab: ${refusalText(err)}`);
	}
}

/** A model from Volt's own list (`list_models`); '' for Volt's default; undefined when the user closed the pick. */
async function pickModel(volt: Volt, chatId: string | undefined): Promise<string | undefined> {
	const listed = await volt.tools.invokeTool('list_models', {}, chatId ? { chatId } : undefined);
	const models = (listed.text ?? '').split('\n').flatMap(line => {
		const match = /^- model: (\S+) \u00b7 (.+?)(?: \u00b7 (.+))?$/.exec(line.trim());
		return match ? [{ label: match[2], description: match[1], detail: match[3], model: match[1] }] : [];
	});
	const picked = await vscode.window.showQuickPick([{ label: 'Volt\'s default model', model: '' }, ...models], { title: 'Agent Lab: which model?', matchOnDescription: true });
	return picked?.model;
}

const watched = new Set<string>();

/** Says when the chat that got the plan finishes a turn (needs `agents.read:any`, asked once). */
function watchTurns(volt: Volt, chatId: string, output: vscode.OutputChannel): void {
	if (watched.has(chatId)) {
		return;
	}
	watched.add(chatId);
	volt.chats.onDidEndTurn(turn => {
		if (turn.chatId === chatId) {
			output.appendLine(`The upgrade chat finished a turn: ${turn.outcome ?? 'done'}`);
			vscode.window.setStatusBarMessage(`Agent Lab: the upgrade chat finished a turn (${turn.outcome ?? 'done'}).`, 8000);
		}
	});
}

async function openPackage(volt: Volt): Promise<void> {
	const report = await volt.storage.get<DependencyReport>(REPORT_KEY);
	const names = report?.packages.map(row => row.name) ?? (await readDependencies(await projectFolder(volt)).catch(() => [])).map(dep => dep.name);
	const name = await vscode.window.showQuickPick(names, { title: 'Agent Lab: open which package?' });
	if (!name) {
		return;
	}
	try {
		await volt.browser.open(`https://www.npmjs.com/package/${name}`);
	} catch (err) {
		vscode.window.showWarningMessage(`Agent Lab: ${refusalText(err)}`);
	}
}

/** A refusal says which capability and which layer refused it. */
function refusalText(err: unknown): string {
	const refusal = err as Partial<vscode.volt.CapabilityError>;
	return refusal?.name === 'VoltCapabilityError' ? `Volt refused ${refusal.capability} (${refusal.deniedBy}).` : messageOf(err);
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface IFixture {
	activate(context: vscode.ExtensionContext, volt: Volt, output: vscode.OutputChannel): void;
	run(context: vscode.ExtensionContext, volt: Volt, output: vscode.OutputChannel): Promise<void>;
}

function loadFixture(output: vscode.OutputChannel): IFixture | undefined {
	try {
		return require('./testFixture/fixture') as IFixture;
	} catch {
		output.appendLine('No test fixture in this build.');
		return undefined;
	}
}
