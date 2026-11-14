/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// EXT-SCAN-SVC: the window scans a third-party extension's folder once per version (cached), never a
// built-in's. EXT-WATCH: a third party's `vscode.volt` call beyond its manifest, or one Volt never
// gives, warns the user once per extension (updated as more arrive); consent refusals and built-ins
// do not.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier, IExtensionDescription, TargetPlatform } from '../../../../../platform/extensions/common/extensions.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService, IPromptChoice, Severity } from '../../../../../platform/notification/common/notification.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IWouldBeDenial } from '../../../voltPlugins/common/capabilities.js';
import { IVoltExtensionApiService } from '../../../voltPlugins/common/voltExtensionApi.js';
import { isMisbehaviorDenial, isScannedExtension, summarizeFindings, VoltExtensionCodeScanService, VoltExtensionWatchContribution } from '../../browser/voltExtensionCodeScan.js';
import { IExtensionService } from '../../common/extensions.js';
import { IVoltExtensionSandboxService } from '../../common/voltExtensionSandbox.js';

function extension(id: string, options: { builtin?: boolean; version?: string; main?: string; location?: URI; contributes?: object; proposals?: string[] } = {}): IExtensionDescription {
	const [publisher, name] = id.split('.');
	return {
		identifier: new ExtensionIdentifier(id),
		name,
		displayName: name === 'volt-agent-lab' ? 'Agent Lab' : name,
		publisher,
		version: options.version ?? '1.0.0',
		engines: { vscode: '*' },
		isBuiltin: !!options.builtin,
		isUserBuiltin: false,
		isUnderDevelopment: false,
		extensionLocation: options.location ?? URI.parse(`test-ext:/${id}`),
		targetPlatform: TargetPlatform.UNDEFINED,
		preRelease: false,
		publisherDisplayName: publisher,
		...(options.main !== undefined ? { main: options.main } : { main: './out/extension.js' }),
		...(options.contributes ? { contributes: options.contributes } : {}),
		...(options.proposals ? { enabledApiProposals: options.proposals } : {}),
	} as IExtensionDescription;
}

suite('Volt extension code scan in the window (EXT-SCAN-SVC)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function setup() {
		const fileService = store.add(new FileService(new NullLogService()));
		const provider = store.add(new InMemoryFileSystemProvider());
		store.add(fileService.registerProvider('test-ext', provider));
		const write = (path: string, text: string) => fileService.writeFile(URI.parse(`test-ext:${path}`), VSBuffer.fromString(text));
		await write('/pub.evil/package.json', '{}');
		await write('/pub.evil/out/extension.js', `const cp = require(['child', 'process'].join('_'));\nfetch('https://webhook.site/x');`);
		await write('/pub.evil/out/extension.js.map', `eval(map)`);
		await write('/pub.clean/out/extension.js', `const vscode = require('vscode'); exports.activate = () => vscode.window.showInformationMessage('hi');`);
		const storage = store.add(new TestStorageService());
		const service = store.add(new VoltExtensionCodeScanService(fileService, storage, new NullLogService()));
		const another = () => store.add(new VoltExtensionCodeScanService(fileService, storage, new NullLogService()));
		return { service, write, another };
	}

	test('EXT-SCAN-SVC-1: a third-party folder is scanned; a clean one has no finding', async () => {
		const { service } = await setup();
		const evil = await service.scan(extension('pub.evil', { location: URI.parse('test-ext:/pub.evil') }));
		assert.deepStrictEqual(evil?.findings.map(finding => `${finding.severity} ${finding.rule} ${finding.file}:${finding.line}`), [
			'high hidden-name out/extension.js:1',
			'high raw-host out/extension.js:2',
			'medium computed-require out/extension.js:1',
		]);
		assert.strictEqual(evil?.files, 1, 'the source map is not code');
		const clean = await service.scan(extension('pub.clean', { location: URI.parse('test-ext:/pub.clean') }));
		assert.deepStrictEqual(clean?.findings, []);
	});

	test('EXT-SCAN-SVC-2: once per version (cached across windows); built-ins and code-less extensions are not scanned', async () => {
		const { service, write, another } = await setup();
		const first = await service.scan(extension('pub.evil', { location: URI.parse('test-ext:/pub.evil') }));
		await write('/pub.evil/out/extension.js', `// cleaned up`);
		assert.deepStrictEqual(await another().scan(extension('pub.evil', { location: URI.parse('test-ext:/pub.evil') })), first, 'same version, another window: the stored result');
		assert.deepStrictEqual((await service.scan(extension('pub.evil', { version: '1.0.1', location: URI.parse('test-ext:/pub.evil') })))?.findings, [], 'a new version is read again');
		assert.strictEqual(await service.scan(extension('vscode.git', { builtin: true })), undefined);
		assert.strictEqual(await service.scan(extension('volt.memory')), undefined, 'a Volt feature with a ceiling');
		assert.strictEqual(await service.scan(extension('pub.theme', { main: '' })), undefined, 'no code');
		assert.ok(!isScannedExtension(extension('pub.theme', { main: '' })));
	});

	test('EXT-SCAN-SVC-3: findings read as one line per rule, high first', () => {
		assert.deepStrictEqual(summarizeFindings([
			{ rule: 'process-spawn', severity: 'medium', file: 'a.js', line: 3, evidence: 'child_process', count: 2 },
			{ rule: 'hidden-name', severity: 'high', file: 'b.js', line: 9, evidence: 'eval', count: 1 },
			{ rule: 'hidden-name', severity: 'high', file: 'b.js', line: 10, evidence: 'child_process', count: 1 },
		]), [
			{ rule: 'hidden-name', severity: 'high', text: 'builds a sensitive name from pieces to hide it (eval, child_process)', where: 'b.js:9' },
			{ rule: 'process-spawn', severity: 'medium', text: 'starts other programs (child_process)', where: 'a.js:3' },
		]);
	});
});

suite('Volt extension misbehavior warnings (EXT-WATCH)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(sandboxed = false) {
		const reports = store.add(new Emitter<IWouldBeDenial>());
		const prompts: { message: string; choices: IPromptChoice[]; handle: { message: string } }[] = [];
		const optedIn: string[] = [];
		const extensions = [extension('volt-examples.volt-agent-lab'), extension('vscode.git', { builtin: true })];
		const notifications = new class extends mock<INotificationService>() {
			override prompt(_severity: Severity, message: string, choices: IPromptChoice[]): INotificationHandle {
				const closed = store.add(new Emitter<void>());
				const handle = { message, onDidClose: closed.event, updateMessage: (next: string) => { handle.message = next; } } as unknown as INotificationHandle & { message: string };
				prompts.push({ message, choices, handle });
				return handle;
			}
		};
		const contribution = store.add(new VoltExtensionWatchContribution(
			new class extends mock<IVoltExtensionApiService>() { override readonly policy = { mode: 'enforce' as const, onDidReport: reports.event, check: () => ({ allowed: true }) }; },
			new class extends mock<IVoltExtensionSandboxService>() {
				override isOptedIn() { return sandboxed; }
				override async setOptedIn(id: string) { optedIn.push(id); }
			},
			new class extends mock<IExtensionService>() { override readonly extensions = extensions; override readonly onDidChangeExtensions = Event.None; },
			notifications,
			new class extends mock<IDialogService>() { },
			new class extends mock<ICommandService>() { },
			new NullLogService(),
		));
		const denial = (capability: string, deniedBy: IWouldBeDenial['deniedBy'], extensionId = 'volt-examples.volt-agent-lab'): IWouldBeDenial => ({ extensionId, api: capability, capability, deniedBy, reason: `${capability} (${deniedBy})` });
		return { contribution, reports, prompts, optedIn, denial };
	}

	test('EXT-WATCH-1: undeclared and critical calls warn once, naming what was tried, with the sandbox offered', async () => {
		const { reports, prompts, optedIn, denial } = setup();
		reports.fire(denial('automations.schedule', 'manifest'));
		reports.fire(denial('usage.report', 'manifest'));
		reports.fire(denial('usage.report', 'manifest'));
		reports.fire(denial('full', 'critical'));
		await timeout(450);
		assert.strictEqual(prompts.length, 1);
		assert.strictEqual(prompts[0].message, 'Volt blocked Agent Lab: it tried to use automations.schedule, usage.report, full, which it never declared or Volt never gives an extension.');
		assert.deepStrictEqual(prompts[0].choices.map(choice => choice.label), ['Show Details', 'Run in a Sandbox', 'Show Extension']);
		prompts[0].choices[1].run();
		assert.deepStrictEqual(optedIn, ['volt-examples.volt-agent-lab']);
		// A later refusal updates the open warning instead of opening another.
		reports.fire(denial('browser.read', 'manifest'));
		await timeout(450);
		assert.strictEqual(prompts.length, 1);
		assert.ok(prompts[0].handle.message.includes('and 1 more'), prompts[0].handle.message);
	});

	test('EXT-WATCH-2: consent refusals, built-ins and unknown extensions are not warned about', async () => {
		const { reports, prompts, denial } = setup();
		reports.fire(denial('agents.create', 'consent'));
		reports.fire(denial('automations.schedule', 'manifest', 'vscode.git'));
		reports.fire(denial('automations.schedule', 'manifest', 'pub.gone'));
		await timeout(450);
		assert.strictEqual(prompts.length, 0);
		assert.ok(isMisbehaviorDenial({ deniedBy: 'catalog' }) && !isMisbehaviorDenial({ deniedBy: 'consent' }) && !isMisbehaviorDenial({ deniedBy: 'ceiling' }));
	});

	test('EXT-WATCH-3: a sandboxed extension is not offered the sandbox again', async () => {
		const { reports, prompts, denial } = setup(true);
		reports.fire(denial('automations.schedule', 'manifest'));
		await timeout(450);
		assert.deepStrictEqual(prompts[0].choices.map(choice => choice.label), ['Show Details', 'Show Extension']);
	});
});
