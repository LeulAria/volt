/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The secrets broker (spec I.3): secrets by reference, injected only at the point of use.
 *
 * CRED-6: a raw read is denied to every third party (even one holding a `secrets.read` grant) and to
 * a first party outside its ceiling. CRED-7: a reference minted for principal A is useless to B, to
 * A under another signer, and when edited. Also: the header goes only to the hosts the secret
 * lists, over https; a reference survives a host restart; a revoked grant stops the next use; no
 * value ever reaches an audit record or an error.
 */

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IManifestView } from '../../../voltSandbox/common/authority.js';
import { BrokerError } from '../../../voltSandbox/common/broker.js';
import { ICallContext, SubjectKey } from '../../../voltSandbox/common/principals.js';
import { BrokerHost, grant, outcome } from '../../../voltSandbox/test/node/brokerFixture.js';
import { secretHostAllowed, validateInjectHosts } from '../../common/secretsBroker.js';
import { FileSecretsStore, SecretsBroker } from '../../node/secretsBroker.js';

const PLUGIN: SubjectKey = 'plugin:acme.issues@signer-a';
const SAME_PLUGIN_OTHER_SIGNER: SubjectKey = 'plugin:acme.issues@signer-b';
const OTHER: SubjectKey = 'plugin:evil.reader@local';
const FIRST_PARTY: SubjectKey = 'firstparty:volt.usage';
const VALUE = 'ghp_CANARY_0123456789abcdef';

suite('Volt secrets broker (I.3)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let store: DisposableStore;
	let host: BrokerHost;
	let secrets: FileSecretsStore;
	let broker: SecretsBroker;

	const manifests: IManifestView[] = [
		{ subject: PLUGIN, declared: [{ id: 'secrets.use:github' }, { id: 'secrets.read' }], network: 'broker' },
		{ subject: SAME_PLUGIN_OTHER_SIGNER, declared: [{ id: 'secrets.use:github' }], network: 'broker' },
		{ subject: OTHER, declared: [{ id: 'secrets.use:github' }], network: 'broker' },
		{ subject: FIRST_PARTY, declared: [{ id: 'secrets.use:*' }, { id: 'secrets.read' }], network: 'broker' },
	];

	async function make(): Promise<SecretsBroker> {
		return new SecretsBroker({ authority: host.authority, callers: host.registry, audit: host.audit, store: secrets, refKey: await secrets.refKey() });
	}

	setup(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'volt-secrets-broker-'));
		store = disposables.add(new DisposableStore());
		host = new BrokerHost(store, {
			manifests,
			// The third party even holds a `secrets.read` grant: it must still never see a value.
			grants: [grant(PLUGIN, 'secrets.use:github'), grant(PLUGIN, 'secrets.read'), grant(SAME_PLUGIN_OTHER_SIGNER, 'secrets.use:github'), grant(OTHER, 'secrets.use:github')],
		});
		secrets = new FileSecretsStore(join(dir, 'secrets'));
		broker = await make();
		await broker.storeForSubject(PLUGIN, 'github', { value: VALUE, injectHosts: ['api.github.com', '*.githubusercontent.com'] });
	});

	teardown(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	function assertNoValue(): void {
		assert.ok(!JSON.stringify(host.audit.events).includes(VALUE), 'a secret value reached the audit');
	}

	test('injection: the header goes only to the hosts the secret lists, over https', async () => {
		const { context } = host.connect(PLUGIN);
		const { ref } = await broker.ref(context, { service: 'github' });
		assert.ok(!ref.includes(VALUE));
		assert.deepStrictEqual(await broker.authorize(context, ref, 'https://api.github.com/repos/acme/x/issues'), { name: 'Authorization', value: `Bearer ${VALUE}` });
		assert.strictEqual(await outcome(broker.authorize(context, ref, 'https://raw.githubusercontent.com/acme/x/main/a')), 'ok');
		for (const url of ['https://evil.example/collect', 'https://api.github.com.evil.example/', 'https://githubusercontent.com/', 'http://api.github.com/', 'https://user:pw@api.github.com/', 'not a url']) {
			const result = await outcome(broker.authorize(context, ref, url));
			assert.ok(result === 'denied' || result === 'invalid', `${url}: ${result}`);
		}
		assert.strictEqual(secretHostAllowed('API.GITHUB.COM.', ['api.github.com']), true);
		assert.throws(() => validateInjectHosts(['*.com']));
		assert.throws(() => validateInjectHosts(['127.0.0.1']));
		assert.throws(() => validateInjectHosts([]));
		assertNoValue();
	});

	test('CRED-6: a raw read is denied to a third party (even with a secrets.read grant) and to a first party outside its ceiling', async () => {
		const plugin = host.connect(PLUGIN);
		const { ref } = await broker.ref(plugin.context, { service: 'github' });
		const refused = broker.read(plugin.context, { ref });
		assert.strictEqual(await outcome(refused), 'denied');
		await refused.catch(err => assert.ok(err instanceof BrokerError && !err.message.includes(VALUE)));
		assert.strictEqual(await outcome(broker.handle(plugin.context, 'read', { ref })), 'denied');

		// A first party: its ceiling decides (volt.usage holds secrets.use:*, not secrets.read).
		const feature = host.connect(FIRST_PARTY, 't2');
		await broker.storeForSubject(FIRST_PARTY, 'openai', { value: VALUE, injectHosts: ['api.openai.com'] });
		const own = await broker.ref(feature.context, { service: 'openai' });
		assert.strictEqual(await outcome(broker.read(feature.context, own)), 'denied');
		host.update({ ceilings: { 'volt.usage': [{ id: 'secrets.use:*' }, { id: 'secrets.read' }] } });
		assert.deepStrictEqual(await broker.read(feature.context, own), { value: VALUE });
		// ... but never on a third party's behalf.
		const routed = host.registry.route(plugin.context, feature.channel, 'routed')!;
		assert.strictEqual(await outcome(broker.read(routed, own)), 'denied');
		assertNoValue();
	});

	test('CRED-7: a reference from principal A is useless to B, to A under another signer, and when edited', async () => {
		const a = host.connect(PLUGIN);
		const b = host.connect(OTHER);
		const resigned = host.connect(SAME_PLUGIN_OTHER_SIGNER);
		const { ref } = await broker.ref(a.context, { service: 'github' });
		await broker.storeForSubject(OTHER, 'github', { value: 'OTHER_VALUE', injectHosts: ['api.github.com'] });
		assert.strictEqual(await outcome(broker.authorize(b.context, ref, 'https://api.github.com/')), 'handle');
		assert.strictEqual(await outcome(broker.authorize(resigned.context, ref, 'https://api.github.com/')), 'handle');
		const [version, service, signature] = ref.split('.');
		const edited = [
			`${version}.${Buffer.from('gitlab').toString('base64url')}.${signature}`,
			`${version}.${service}.${Buffer.alloc(32).toString('base64url')}`,
			`vsr2.${service}.${signature}`,
			ref.slice(0, -2),
			'',
		];
		for (const forged of edited) {
			assert.strictEqual(await outcome(broker.authorize(a.context, forged, 'https://api.github.com/')), 'handle', forged);
		}
		// B's own reference reaches B's own secret, never A's.
		const own = await broker.ref(b.context, { service: 'github' });
		assert.deepStrictEqual(await broker.authorize(b.context, own.ref, 'https://api.github.com/'), { name: 'Authorization', value: 'Bearer OTHER_VALUE' });
		assertNoValue();
	});

	test('a reference survives a host restart; a revoked grant stops the next use; a forged principal is refused', async () => {
		const first = host.connect(PLUGIN);
		const { ref } = await broker.ref(first.context, { service: 'github' });
		// A new broker over the same store (Volt restarted): the plugin's new principal uses the old reference.
		const restarted = await make();
		const again = host.connect(PLUGIN);
		assert.strictEqual(await outcome(restarted.authorize(again.context, ref, 'https://api.github.com/')), 'ok');

		host.update({ grants: host.grants.filter(g => g.subject !== PLUGIN) });
		assert.strictEqual(await outcome(restarted.authorize(again.context, ref, 'https://api.github.com/')), 'denied');
		assert.strictEqual(host.audit.events.at(-1)?.deniedBy, 'authority');

		const forged: ICallContext = { principal: { ...again.principal }, onBehalfOf: [], requestId: 'forged' };
		assert.strictEqual(await outcome(restarted.authorize(forged, ref, 'https://api.github.com/')), 'unauthenticated');
	});

	test('own namespace: set, list and delete names only; another subject\'s secret is never touched; validation', async () => {
		const b = host.connect(OTHER);
		await broker.set(b.context, { service: 'github', value: 'B_VALUE', injectHosts: ['api.github.com'] });
		assert.deepStrictEqual(await broker.list(b.context), { services: ['github'] });
		assert.deepStrictEqual(await broker.delete(b.context, { service: 'github' }), { deleted: true });
		// A's secret is still there.
		const a = host.connect(PLUGIN);
		const { ref } = await broker.ref(a.context, { service: 'github' });
		assert.strictEqual(await outcome(broker.authorize(a.context, ref, 'https://api.github.com/')), 'ok');
		// Undeclared service, bad names, a value that would inject a header line, reserved headers.
		assert.strictEqual(await outcome(broker.ref(b.context, { service: 'gitlab' })), 'denied');
		for (const args of [{ service: '../x' }, { service: 'GitHub' }, { service: 'github', value: 'a\r\nX-Evil: 1', injectHosts: ['api.github.com'] }, { service: 'github', value: 'v', injectHosts: ['api.github.com'], header: 'Host' }, { service: 'github', value: 'v' }, null]) {
			assert.strictEqual(await outcome(broker.handle(b.context, 'set', args)), 'invalid', JSON.stringify(args));
		}
		assert.strictEqual(await outcome(broker.handle(b.context, 'authorize', { ref })), 'invalid', 'injection is not a method a principal can call');
		// The store is 0600 in a 0700 folder.
		if (process.platform !== 'win32') {
			assert.strictEqual((await fs.stat(secrets.dir)).mode & 0o777, 0o700);
			for (const name of await fs.readdir(secrets.dir)) {
				assert.strictEqual((await fs.stat(join(secrets.dir, name))).mode & 0o077, 0, name);
			}
		}
		assertNoValue();
	});
});
