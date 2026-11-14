/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// EXT-LAB: the Agent Lab example (docs/volt/examples/volt-agent-lab). Its manifest validates, both
// builds type-check, the published build passes the install-time code scan clean, and the test
// build (with src/testFixture) is flagged for each hidden misbehavior it carries.

import assert from 'assert';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, promises as fs, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { FileAccess } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { codeScanOptionsOf, ICodeScanReader, ICodeScanResult, scanExtensionFolder } from '../../../../../platform/voltPlugins/common/extensionCodeScan.js';
import { validateVoltContributes } from '../../../voltPlugins/common/voltContributions.js';

const fsReader: ICodeScanReader = {
	list: async path => (await fs.readdir(path, { withFileTypes: true })).filter(entry => !entry.isSymbolicLink()).map(entry => ({ name: entry.name, directory: entry.isDirectory() })),
	read: path => fs.readFile(path, 'utf8'),
};

suite('Volt extension example: Agent Lab (EXT-LAB)', function () {

	this.timeout(180_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	const root = join(FileAccess.asFileUri('').fsPath, '..');
	const example = join(root, 'docs', 'volt', 'examples', 'volt-agent-lab');
	const manifest = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8'));
	const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
	const outDirs: string[] = [];

	suiteTeardown(() => outDirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));

	/** Compiles one build into a fresh folder shaped like the installed extension (`out/`) and scans it. */
	async function buildAndScan(project: 'tsconfig.json' | 'tsconfig.fixture.json'): Promise<ICodeScanResult> {
		const dir = mkdtempSync(join(tmpdir(), 'volt-agent-lab-build-'));
		outDirs.push(dir);
		// Throws with tsc's diagnostics when it doesn't type-check.
		execFileSync(process.execPath, [tsc, '-p', join(example, project), '--outDir', join(dir, 'out')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
		await fs.copyFile(join(example, 'package.json'), join(dir, 'package.json'));
		return scanExtensionFolder(dir, fsReader, codeScanOptionsOf(manifest), async () => { });
	}

	test('EXT-LAB-1: the manifest turns on vscode.volt and validates; tools and capabilities are declared with reasons', () => {
		assert.deepStrictEqual(manifest.enabledApiProposals, ['volt']);
		assert.deepStrictEqual(validateVoltContributes(manifest.contributes), []);
		const declared = [...manifest.contributes.voltCapabilities.required, ...manifest.contributes.voltCapabilities.optional];
		assert.deepStrictEqual(declared.map((entry: { id: string }) => entry.id), ['tools.register', 'files.read:workspace', 'net.connect', 'agents.read:current', 'agents.read:any', 'agents.send', 'agents.create', 'agents.context', 'browser.drive']);
		assert.ok(declared.every((entry: { reason?: string }) => entry.reason), 'every entry says why');
		assert.deepStrictEqual(manifest.contributes.voltTools.map((tool: { name: string; class: string }) => `${tool.name}:${tool.class}`), ['agent_lab_dependencies:reads']);
		assert.ok(existsSync(tsc), 'typescript is installed');
	});

	test('EXT-LAB-2: the published build passes the code scan clean', async () => {
		const result = await buildAndScan('tsconfig.json');
		assert.strictEqual(result.files, 2, 'extension.js and lab.js, no fixture');
		assert.deepStrictEqual(result.findings, []);
	});

	test('EXT-LAB-3: the test build is flagged for every hidden misbehavior, and lists what its code can do', async () => {
		const result = await buildAndScan('tsconfig.fixture.json');
		const high = result.findings.filter(finding => finding.severity === 'high').map(finding => `${finding.rule}: ${finding.evidence}`);
		assert.deepStrictEqual(high.sort(), [
			'encoded-payload: a network address: 127.0.0.1',
			'hidden-name: child_process',
			'hidden-name: eval',
			'undeclared-api: volt.automations.schedule needs automations.schedule',
			'undeclared-api: volt.browser.readPage needs browser.read',
			'undeclared-api: volt.usage needs usage.report',
		]);
		const medium = new Set(result.findings.filter(finding => finding.severity === 'medium').map(finding => finding.rule));
		assert.deepStrictEqual([...medium].sort(), ['credential-path', 'dynamic-code', 'env-harvest', 'process-spawn', 'raw-host']);
		assert.ok(result.findings.every(finding => finding.file === 'out/testFixture/fixture.js'), 'every finding is in the fixture, none in the extension itself');
	});
});
