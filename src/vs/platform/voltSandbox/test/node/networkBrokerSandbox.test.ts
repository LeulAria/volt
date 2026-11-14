/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The network broker end to end through real sandboxes (Seatbelt on macOS, bubblewrap in the
 * Linux rig): a chat's agent with network off runs `curl` and `perl` in its sandbox, and the test
 * answers as the user would (Allow for This Chat, revoke on the Access page, a managed policy).
 * The broker resolves every name to a public address and its connector sends that address to a
 * local server, so nothing leaves the machine. Each sandboxed script waits for files the test
 * writes into its workspace, so the same running process makes the requests before and after an
 * answer (no restart).
 *
 * A machine without a working backend skips loudly; with `VOLT_SANDBOX_REQUIRED` it fails.
 * Linux: scripts/volt-sandbox-linux-test.sh suite.
 */

import assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as net from 'net';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ISandboxRunDenial } from '../../common/sandboxBackend.js';
import { stricterSandboxSettings } from '../../common/sandboxInheritance.js';
import { agentSandboxPolicy, IVoltSandboxSettings } from '../../common/sandboxPolicy.js';
import { IAdminPolicy } from '../../common/authority.js';
import { IPreparedSandbox, SandboxManager } from '../../node/sandboxManager.js';
import { ISandboxHostFacts, sandboxHostFacts } from '../../node/sandboxResolver.js';
import { realSandboxAvailable } from './sandboxSuiteGate.js';

const PUBLIC = { address: '93.184.216.34', family: 4 as const };
const CURL = '/usr/bin/curl';
const PERL = '/usr/bin/perl';

/** The internet, locally: plain HTTP on one port (answers `UPSTREAM <path>`), an echo server for tunnels on another. */
async function upstreams(): Promise<{ readonly http: number; readonly echo: number; readonly paths: string[]; readonly echoSockets: Set<net.Socket>; close(): Promise<void> }> {
	const paths: string[] = [];
	const web = http.createServer((req, res) => {
		paths.push(req.url ?? '');
		res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`UPSTREAM ${req.url}\n`);
	});
	const echoSockets = new Set<net.Socket>();
	const echo = net.createServer(socket => {
		echoSockets.add(socket);
		socket.on('error', () => undefined);
		socket.once('close', () => echoSockets.delete(socket));
		socket.pipe(socket);
	});
	await Promise.all([new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve)), new Promise<void>(resolve => echo.listen(0, '127.0.0.1', resolve))]);
	return {
		http: (web.address() as net.AddressInfo).port,
		echo: (echo.address() as net.AddressInfo).port,
		paths,
		echoSockets,
		close: async () => {
			echoSockets.forEach(socket => socket.destroy());
			web.closeAllConnections();
			await Promise.all([new Promise(resolve => web.close(resolve)), new Promise(resolve => echo.close(resolve))]);
		},
	};
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	return check();
}

/** The part of a chat's settings these tests vary. */
interface IChatNetwork {
	readonly network?: boolean;
	readonly allowedDomains?: readonly string[];
}

interface IRunning {
	readonly prepared: IPreparedSandbox;
	readonly child: ChildProcess;
	readonly denials: ISandboxRunDenial[];
	out(): string;
	readonly exited: Promise<number | null>;
	stop(): Promise<void>;
}

suite('Volt network broker through real sandboxes (NET-E2E)', function () {

	this.timeout(120_000);
	let root: string;
	let home: string;
	let ws: string;
	let host: ISandboxHostFacts;
	let net$: Awaited<ReturnType<typeof upstreams>>;
	let available = false;
	let admin: IAdminPolicy | undefined;
	let manager: SandboxManager;
	const running: IRunning[] = [];

	suiteSetup(async function () {
		root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'volt-sbx-net-')));
		home = join(root, 'home');
		ws = join(root, 'ws');
		await fs.mkdir(home, { recursive: true });
		await fs.mkdir(ws, { recursive: true });
		host = { ...await sandboxHostFacts(), home };
		net$ = await upstreams();
		manager = makeManager();
		available = realSandboxAvailable(await manager.capabilities(), 'network broker end-to-end suite');
	});

	suiteTeardown(async () => {
		await manager?.dispose();
		await net$?.close();
		if (root) {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	teardown(async () => {
		await Promise.all(running.splice(0).map(run => run.stop()));
		for (const name of await fs.readdir(ws)) {
			await fs.rm(join(ws, name), { recursive: true, force: true });
		}
	});
	// After the teardown above: the runs' listeners are disposed before the leak check.
	ensureNoDisposablesAreLeakedInTestSuite();

	// After the leak check's own setup: a skip here stops later setups but not its teardown.
	setup(function () {
		if (!available) {
			this.skip();
		}
	});

	function makeManager(): SandboxManager {
		return new SandboxManager(undefined, {
			runRoot: join(root, 'runs'),
			host,
			proxy: {
				lookup: async () => [PUBLIC],
				// Port 443 (tunnels) goes to the echo server, anything else to the web server.
				connect: (_address, port) => net.connect({ host: '127.0.0.1', port: port === 443 ? net$.echo : net$.http }),
			},
			adminPolicy: () => admin,
		});
	}

	/** A chat's agent policy with the network off, as a new sandboxed chat gets it. */
	function chatPolicy(settings: IChatNetwork = {}) {
		return agentSandboxPolicy({ level: 'workspace-write', network: false, providerId: 'claude-code', workspaceRoots: [ws], ...settings }, { platform: process.platform, home, tempDirs: [join(root, 'tmp')], cacheDir: join(home, '.volt', 'sandbox-cache') });
	}

	/** Starts `script` in a sandbox as chat `chatId` and leaves it running. */
	async function start(chatId: string, script: string, settings: IChatNetwork = {}): Promise<IRunning> {
		const prepared = await manager.prepare({
			command: '/bin/sh',
			args: ['-c', `echo volt-sandbox-ran; ${script}`],
			policy: chatPolicy(settings),
			context: { workspaceRoots: [ws], cwd: ws, hostEnv: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'C' } },
			subject: `chat:${chatId}`,
		});
		const denials: ISandboxRunDenial[] = [];
		const listener = prepared.onDenial(denial => denials.push(denial));
		const child = spawn(prepared.command, [...prepared.args], { cwd: prepared.cwd, env: prepared.env, stdio: ['ignore', 'pipe', 'pipe', ...prepared.extraStdio], detached: true });
		let out = '';
		child.stdout?.on('data', (data: Buffer) => { out += data.toString(); });
		child.stderr?.on('data', (data: Buffer) => { out += data.toString(); });
		const exited = new Promise<number | null>(resolve => child.once('close', (code, sig) => { out += `\n[exit ${code} ${sig}]\n`; resolve(code); }));
		const confirmation = await prepared.confirm(child);
		assert.ok(confirmation.ok, `the sandbox was confirmed: ${confirmation.ok ? '' : confirmation.error}`);
		const run: IRunning = {
			prepared, child, denials, out: () => out, exited,
			stop: async () => {
				await prepared.terminate(child);
				listener.dispose();
				await prepared.dispose();
			},
		};
		running.push(run);
		return run;
	}

	/** Lets the sandboxed script past `await <name>`. */
	const signal = (name: string) => fs.writeFile(join(ws, name), '1');
	/** Shell: wait for the test's file `name` (at most 30 s). */
	const wait = (name: string) => `i=0; while [ ! -f "${ws}/${name}" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done`;
	/** Shell: one plain-HTTP request through the run's proxy; prints `<tag> <status>`. */
	const get = (tag: string, url: string, proxy = '"$http_proxy"') => `printf '${tag} '; ${CURL} -s -o /dev/null -m 8 -x ${proxy} -w '%{http_code}\\n' '${url}' || echo " exit=$?"`;

	test('NET-E2E-1: a refused host is a 403 the agent sees and a recorded, approvable denial the card shows', async () => {
		const run = await start('e2e-1', `${get('first', 'http://blocked.test/a')}; echo done`);
		await run.exited;
		assert.match(run.out(), /volt-sandbox-ran/);
		assert.match(run.out(), /first 403/, run.out());
		const denial = run.denials.find(d => d.kind === 'network');
		assert.ok(denial && denial.source === 'proxy' && denial.target === 'blocked.test:80', JSON.stringify(run.denials));
		assert.ok(denial.denialId && denial.epoch !== undefined && denial.promptable, 'the broker\'s id and epoch: the card can offer Allow');
		assert.ok(!net$.paths.includes('/a'), 'nothing reached the host');
	});

	test('NET-E2E-2: Allow for This Chat lets the same running process through without a restart; revoking refuses it again', async () => {
		const chatId = 'e2e-2';
		const run = await start(chatId, [
			get('before', 'http://later.test/before'),
			wait('allowed'),
			get('after', 'http://later.test/after'),
			wait('revoked'),
			get('revoked', 'http://later.test/revoked'),
			'echo done',
		].join('; '));
		assert.ok(await until(() => run.denials.some(d => d.kind === 'network')), run.out());
		const denial = run.denials.find(d => d.kind === 'network')!;
		const broker = manager.currentBroker!;
		const approved = await broker.approveForChat(chatId, denial.denialId!, denial.epoch!);
		assert.ok(approved.ok, JSON.stringify(approved));
		const grant = broker.grantsOf(`chat:${chatId}`).find(candidate => candidate.scope.targets?.[0] === 'later.test:80');
		assert.ok(grant, 'the chat\'s grant for the host and port it was refused on');
		await signal('allowed');
		assert.ok(await until(() => /after \d/.test(run.out())), run.out());
		await broker.update({ revoke: [grant.id] });
		await signal('revoked');
		await run.exited;
		const out = run.out();
		assert.match(out, /before 403/, out);
		assert.match(out, /after 200/, 'the same process, no restart');
		assert.ok(net$.paths.includes('/after'));
		assert.match(out, /revoked 403/, 'refused again after the revoke');
		assert.ok(!net$.paths.includes('/revoked'));
	});

	test('NET-E2E-3: an open CONNECT tunnel is cut within 1 s of its grant being revoked', async () => {
		const chatId = 'e2e-3';
		const run = await start(chatId, [
			wait('allowed'),
			`${PERL} -MIO::Socket::INET -MMIME::Base64 -e '$|=1; ($a,$h)=$ENV{http_proxy}=~m{//([^@]+)@([^/]+)}; $s=IO::Socket::INET->new(PeerAddr=>$h, Timeout=>5) or die "noconnect"; print $s "CONNECT stream.test:443 HTTP/1.1\\r\\nHost: stream.test:443\\r\\nProxy-Authorization: Basic ".encode_base64($a,"")."\\r\\n\\r\\n"; $l=<$s>; print "tunnel $l"; while(($x=<$s>) ne "\\r\\n"){} print $s "ping\\n"; $p=<$s>; print "echo $p"; open(F,">${ws}/tunnel-up"); close F; $r=sysread($s,$b,10); print "after-revoke ".(defined $r && $r>0 ? "data" : "closed")."\\n";'`,
			'echo done',
		].join('; '));
		const broker = manager.currentBroker!;
		await broker.update({ add: [{ id: 'e2e-3-grant', subject: `chat:${chatId}`, capability: 'net.connect@1', scope: { targets: ['stream.test'] }, kind: 'session', sessionId: chatId, source: 'user', grantedAt: Date.now(), lastUsedAt: Date.now() }] });
		await signal('allowed');
		assert.ok(await until(() => fs.stat(join(ws, 'tunnel-up')).then(() => true, () => false)), run.out());
		assert.match(run.out(), /tunnel HTTP\/1.1 200/);
		assert.match(run.out(), /echo ping/, 'bytes flow through the tunnel');
		const open = net$.echoSockets.size;
		assert.ok(open >= 1);
		const started = Date.now();
		await broker.update({ revoke: ['e2e-3-grant'] });
		assert.ok(await until(() => net$.echoSockets.size < open, 1_000), 'the upstream side is closed within 1 s (INV-23)');
		await run.exited;
		assert.match(run.out(), /after-revoke closed/, run.out());
		assert.ok(Date.now() - started < 5_000, `the sandboxed side saw it closed in ${Date.now() - started} ms`);
	});

	test('NET-E2E-4: a second sandbox can\'t use the first one\'s proxy URL and token (B-31): its port is out of reach, the token is refused on its own', async () => {
		// Two chats allowed the same host: the only thing between B and A's route is the binding.
		const a = await start('e2e-4a', `${wait('a-done')}; echo a-done`, { allowedDomains: ['shared.test:80'] });
		const routeA = a.prepared.networkRoute()!;
		await fs.writeFile(join(ws, 'a-route'), `http://volt:${routeA.token}@127.0.0.1:${routeA.port}\n${routeA.token}\n`);
		const b = await start('e2e-4b', [
			'A=$(sed -n 1p a-route); T=$(sed -n 2p a-route); OWN=$(printf %s "$http_proxy" | sed "s#.*@##")',
			get('a-url', 'http://shared.test/from-b-a-url', '"$A"'),
			get('a-token', 'http://shared.test/from-b-a-token', '"http://volt:$T@$OWN"'),
			get('own', 'http://shared.test/from-b-own'),
			'echo done',
		].join('; '), { allowedDomains: ['shared.test:80'] });
		await b.exited;
		await signal('a-done');
		const out = b.out();
		assert.match(out, /a-url (000|.*exit=)/, `B can't reach A's port: ${out}`);
		assert.match(out, /a-token 407/, `A's token on B's own route: ${out}`);
		assert.match(out, /own 200/, `B's own route works: ${out}`);
		assert.ok(!net$.paths.includes('/from-b-a-url') && !net$.paths.includes('/from-b-a-token'), 'nothing B sent with A\'s credentials left');
		assert.ok(net$.paths.includes('/from-b-own'));
		assert.strictEqual(routeA.openConnections, 0);
	});

	test('NET-E2E-7: a chat with network off that reads another chat\'s proxy credential from its environment can\'t use it (macOS)', async function () {
		if (process.platform !== 'darwin') {
			// bubblewrap gives every sandbox its own pid namespace: another chat's process isn't there to read.
			this.skip();
		}
		// Seatbelt can't hide a process's environment from another sandbox of the same user
		// (`sysctl KERN_PROCARGS2` passes even `(deny sysctl-read (sysctl-name "kern.procargs2"))`),
		// and an agent CLI is node, not a platform binary whose environment macOS hides. So the
		// credential isn't a secret between chats: what keeps it to its chat is that only its own
		// sandbox can reach its route's port, and that the route takes only its own token (B-31).
		const sleeper = join(ws, 'agent');
		await fs.copyFile('/bin/sleep', sleeper);
		await new Promise<void>((resolve, reject) => spawn('/usr/bin/codesign', ['-s', '-', '-f', sleeper], { stdio: 'ignore' }).once('close', code => code === 0 ? resolve() : reject(new Error(`codesign ${code}`))));
		await fs.writeFile(join(ws, 'env.pl'), [
			'my $mib = pack("iii", 1, 49, $ARGV[0]); my $buf = "\\0" x 262144; my $len = pack("Q", 262144);',
			'syscall(202, $mib, 3, $buf, $len, 0, 0) == 0 or exit 1;',
			'print map { "$_\\n" } grep { /^http_proxy=/ } split(/\\0/, substr($buf, 0, unpack("Q", $len)));',
		].join('\n'));
		// B: a chat allowed secret.test, its agent a non-platform binary holding the proxy URL in its environment.
		const b = await start('e2e-7b', `echo $$ > b-pid; exec ${sleeper} 60`, { allowedDomains: ['secret.test:80'] });
		const routeB = b.prepared.networkRoute()!;
		const audit: { readonly reason?: string; readonly subject: string; readonly tokenOf?: string }[] = [];
		const broker = manager.currentBroker!;
		const original = broker.audit.bind(broker);
		broker.audit = event => { audit.push(event); original(event); };
		try {
			// A: network off, no grant; it finds B's pid and reads B's environment.
			const a = await start('e2e-7a', [
				wait('b-pid'),
				'P=$(cat b-pid); i=0; while [ $i -lt 100 ]; do L=$(/usr/bin/perl env.pl "$P"); [ -n "$L" ] && break; sleep 0.05; i=$((i+1)); done',
				'echo "read ${L:+yes}"',
				'BURL=${L#http_proxy=}; BTOKEN=$(printf %s "$BURL" | sed "s#^http://volt:##; s#@.*##"); OWN=$(printf %s "$http_proxy" | sed "s#.*@##")',
				get('b-url', 'http://secret.test/from-a-b-url', '"$BURL"'),
				get('b-token', 'http://secret.test/from-a-b-token', '"http://volt:$BTOKEN@$OWN"'),
				get('own', 'http://secret.test/from-a-own'),
				'echo done',
			].join('; '));
			await a.exited;
			const out = a.out();
			assert.match(out, /read yes/, `A read B's proxy URL from B's environment: ${out}`);
			assert.match(out, /b-url (000|.*exit=)/, `A can't reach B's route: ${out}`);
			assert.match(out, /b-token 407/, `B's token on A's route is refused: ${out}`);
			assert.match(out, /own 403/, `A's own route still refuses the host only B was allowed: ${out}`);
			assert.ok(!net$.paths.some(path => path.startsWith('/from-a-')), 'nothing A sent left');
			assert.strictEqual(routeB.openConnections, 0);
			assert.ok(audit.some(event => event.reason === 'auth' && event.subject === 'chat:e2e-7a' && event.tokenOf === 'chat:e2e-7b'), `the refusal names whose token it was: ${JSON.stringify(audit)}`);
		} finally {
			broker.audit = original;
		}
	});

	test('NET-E2E-5: a managed policy\'s denied host beats the chat\'s own grant', async () => {
		admin = { denyHosts: ['admin-blocked.test'] };
		manager.currentBroker?.adminChanged();
		try {
			const run = await start('e2e-5', [get('admin', 'http://admin-blocked.test/x'), get('other', 'http://fine.test/y'), 'echo done'].join('; '), { allowedDomains: ['admin-blocked.test:80', 'fine.test:80'] });
			await run.exited;
			assert.match(run.out(), /admin 403/, run.out());
			assert.match(run.out(), /other 200/, run.out());
			assert.ok(!net$.paths.includes('/x'));
		} finally {
			admin = undefined;
			manager.currentBroker?.adminChanged();
		}
	});

	test('NET-E2E-6: a child chat is never wider than its parent: a host only the child listed is refused', async () => {
		const parent: IVoltSandboxSettings = { level: 'workspace-write', network: false, allowedDomains: ['parent.test:80'] };
		const child: IVoltSandboxSettings = { level: 'workspace-write', network: false, allowedDomains: ['parent.test:80', 'child-only.test:80'] };
		const confined = stricterSandboxSettings(parent, child);
		assert.strictEqual(confined.level, 'workspace-write');
		const run = await start('e2e-6', [get('parent', 'http://parent.test/p'), get('child', 'http://child-only.test/c'), 'echo done'].join('; '), { network: confined.network, ...(confined.allowedDomains ? { allowedDomains: confined.allowedDomains } : {}) });
		await run.exited;
		assert.match(run.out(), /parent 200/, run.out());
		assert.match(run.out(), /child 403/, run.out());
	});
});
