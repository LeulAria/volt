/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IVoltUsageLimitGroup } from '../../../voltUsage/common/voltUsage.js';
import { ClaudeAccounts, limitPressure, pickAutoSwitchTarget } from '../../node/claudeAccounts.js';
import { claudeKeychainService, claudeLiveLocation, FileAccountSecrets, JsonObject, spliceCredentials, withClaudeLocks } from '../../node/claudeLogin.js';

const HOUR = 60 * 60 * 1000;

function group(session: number, week: number, extra: IVoltUsageLimitGroup['windows'] = []): IVoltUsageLimitGroup {
	return {
		provider: 'claude',
		checkedAt: Date.now(),
		windows: [
			{ id: 'session:', label: 'Current session', usedPercent: session, resetsAt: Date.now() + HOUR },
			{ id: 'weekly_all:', label: 'Current week', scope: 'All models', usedPercent: week, resetsAt: Date.now() + 24 * HOUR },
			...extra,
		],
	};
}

suite('Volt Claude accounts', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('pressure is the fuller of the session and the all-models week; per-model weeks and past resets do not count', () => {
		assert.strictEqual(limitPressure(group(40, 72)), 72);
		assert.strictEqual(limitPressure(group(10, 20, [{ id: 'weekly_scoped:Fable', label: 'Current week', scope: 'Fable', usedPercent: 100 }])), 20);
		const reset: IVoltUsageLimitGroup = { provider: 'claude', checkedAt: 0, windows: [{ id: 'session:', label: 'Current session', usedPercent: 100, resetsAt: Date.now() - 1000 }] };
		assert.strictEqual(limitPressure(reset), 0);
		assert.strictEqual(limitPressure({ provider: 'claude', checkedAt: 0, windows: [], error: 'x' }), undefined);
	});

	test('auto switch moves only past the threshold, to the usable account with the most left under the margin', () => {
		const active = { id: 'a', pressure: 92, usable: true };
		assert.strictEqual(pickAutoSwitchTarget({ ...active, pressure: 80 }, [{ id: 'b', pressure: 0, usable: true }], 90), undefined);
		assert.strictEqual(pickAutoSwitchTarget(active, [{ id: 'b', pressure: 50, usable: true }, { id: 'c', pressure: 10, usable: true }], 90), 'c');
		// Inside the margin, dead or unread: stay.
		assert.strictEqual(pickAutoSwitchTarget(active, [{ id: 'b', pressure: 87, usable: true }, { id: 'c', pressure: 0, usable: false }, { id: 'd', pressure: undefined, usable: true }], 90), undefined);
	});

	test('a switch swaps only the account keys of the credential blob', () => {
		const live = { claudeAiOauth: { accessToken: 'a' }, trustedDeviceToken: 'ta', mcpOAuth: { server: 1 } };
		assert.deepStrictEqual(spliceCredentials(live, { claudeAiOauth: { accessToken: 'b' } }), { claudeAiOauth: { accessToken: 'b' }, mcpOAuth: { server: 1 } });
	});

	test('a config folder gets its own keychain service, hashed as given', () => {
		assert.strictEqual(claudeKeychainService(undefined), 'Claude Code-credentials');
		assert.match(claudeKeychainService('/tmp/x'), /^Claude Code-credentials-[0-9a-f]{8}$/);
		assert.notStrictEqual(claudeKeychainService('/tmp/x'), claudeKeychainService('/tmp/x/'));
	});

	suite('with a fake home', () => {

		let root: string;
		let home: string;
		let accounts: ClaudeAccounts;
		let limits: Map<string, IVoltUsageLimitGroup>;
		let refreshed: string[];

		const oauth = (email: string, uuid: string) => ({ accountUuid: uuid, emailAddress: email, organizationUuid: `org-${uuid}`, organizationName: `${email} org` });
		const credentials = (token: string, extra: JsonObject = {}) => ({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: Date.now() + 8 * HOUR, rateLimitTier: 'default_claude_max_20x' }, ...extra });

		async function signIn(dir: string, email: string, uuid: string, token: string, extra: JsonObject = {}): Promise<void> {
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, '.credentials.json'), JSON.stringify(credentials(token, extra)));
		}

		async function liveToken(): Promise<string> {
			const blob = JSON.parse(await readFile(join(home, '.claude', '.credentials.json'), 'utf8'));
			return blob.claudeAiOauth.accessToken;
		}

		async function liveEmail(): Promise<string> {
			return JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).oauthAccount.emailAddress;
		}

		setup(async () => {
			root = await mkdtemp(join(tmpdir(), 'volt-accounts-'));
			home = join(root, 'home');
			limits = new Map();
			refreshed = [];
			await signIn(join(home, '.claude'), 'a@x.com', 'ua', 'token-a', { mcpOAuth: { keep: true } });
			await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: oauth('a@x.com', 'ua'), projects: { '/p': {} } }));
			accounts = new ClaudeAccounts({
				home,
				storeDir: join(root, 'store'),
				secrets: new FileAccountSecrets(join(root, 'store', 'credentials')),
				env: async () => ({}),
				logService: new NullLogService(),
				platform: 'linux',
				location: env => claudeLiveLocation(home, env, 'linux'),
				readLimits: async credential => ({ group: limits.get(String(credential.accessToken)) }),
				refresh: async blob => {
					const current = blob.claudeAiOauth as JsonObject;
					refreshed.push(String(current.accessToken));
					return { ok: true, credentials: { ...blob, claudeAiOauth: { ...current, accessToken: `${current.accessToken}+`, refreshToken: `${current.refreshToken}+`, expiresAt: Date.now() + 8 * HOUR } } };
				},
			});
		});

		teardown(async () => {
			accounts.dispose();
			await rm(root, { recursive: true, force: true });
		});

		async function addSecondAccount(): Promise<string> {
			const login = await accounts.beginLogin();
			assert.match(login.command, /^CLAUDE_CONFIG_DIR='.+' claude auth login --claudeai$/);
			const dir = /CLAUDE_CONFIG_DIR='([^']+)'/.exec(login.command)![1];
			assert.deepStrictEqual(await accounts.completeLogin(login.id), { status: 'pending' });
			await signIn(dir, 'b@x.com', 'ub', 'token-b');
			await writeFile(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: oauth('b@x.com', 'ub') }));
			assert.deepStrictEqual(await accounts.completeLogin(login.id), { status: 'added', email: 'b@x.com', updated: false });
			await assert.rejects(stat(dir), 'the throwaway folder is removed');
			const state = await accounts.getState();
			return state.accounts.find(account => account.email === 'b@x.com')!.id;
		}

		test('the live login is saved on sight, and a terminal sign-in adds another without touching it', async () => {
			const first = await accounts.getState();
			assert.deepStrictEqual(first.accounts.map(account => [account.email, account.active, account.plan]), [['a@x.com', true, 'Max 20x']]);
			await addSecondAccount();
			assert.strictEqual(await liveToken(), 'token-a');
			assert.deepStrictEqual((await accounts.getState()).accounts.map(account => [account.email, account.active]), [['a@x.com', true], ['b@x.com', false]]);
		});

		test('switching writes the other account into Claude Code, keeps machine keys and the outgoing account\u2019s rotated tokens', async () => {
			const b = await addSecondAccount();
			// Claude Code refreshed A's token since Volt saved it.
			const blob = JSON.parse(await readFile(join(home, '.claude', '.credentials.json'), 'utf8'));
			blob.claudeAiOauth.accessToken = 'token-a2';
			await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify(blob));

			const state = await accounts.switchTo(b);
			assert.strictEqual(await liveToken(), 'token-b');
			assert.strictEqual(await liveEmail(), 'b@x.com');
			const live = JSON.parse(await readFile(join(home, '.claude', '.credentials.json'), 'utf8'));
			assert.deepStrictEqual(live.mcpOAuth, { keep: true });
			assert.deepStrictEqual(Object.keys(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'))).sort(), ['oauthAccount', 'projects']);
			assert.deepStrictEqual(state.accounts.map(account => [account.email, account.active]), [['a@x.com', false], ['b@x.com', true]]);
			assert.strictEqual(state.lastSwitch?.toEmail, 'b@x.com');

			const a = state.accounts.find(account => account.email === 'a@x.com')!.id;
			await accounts.switchTo(a);
			assert.strictEqual(await liveToken(), 'token-a2', 'A comes back with the token Claude Code rotated to');
			assert.deepStrictEqual(refreshed, []);
			// Claude Code's locks were released.
			await withClaudeLocks(claudeLiveLocation(home, {}, 'linux'), async () => undefined);
		});

		test('a stored token near expiry is refreshed before the switch, and the rotation is kept', async () => {
			const b = await addSecondAccount();
			const secrets = new FileAccountSecrets(join(root, 'store', 'credentials'));
			const stored = JSON.parse((await secrets.get(b))!);
			stored.claudeAiOauth.expiresAt = Date.now() - 1000;
			await secrets.set(b, JSON.stringify(stored));
			await accounts.switchTo(b);
			assert.deepStrictEqual(refreshed, ['token-b']);
			assert.strictEqual(await liveToken(), 'token-b+');
		});

		test('automatic switching moves to the account with the most left, once, then cools down', async () => {
			const b = await addSecondAccount();
			accounts.configure('auto', 90);
			limits.set('token-a', group(95, 40));
			limits.set('token-b', group(10, 30));
			const events: string[] = [];
			const listener = accounts.onDidAutoSwitch(event => events.push(`${event.fromEmail}->${event.toEmail}: ${event.detail}`));
			await accounts.autoSwitchTick();
			assert.deepStrictEqual(events, ['a@x.com->b@x.com: Session limit at 95%']);
			assert.strictEqual(await liveToken(), 'token-b');
			limits.set('token-b', group(99, 30));
			await accounts.autoSwitchTick();
			assert.strictEqual(events.length, 1, 'no second switch inside the cooldown');
			listener.dispose();
			assert.strictEqual((await accounts.getState()).accounts.find(account => account.id === b)?.active, true);
		});

		test('manual switching never moves on its own, and the account in use cannot be forgotten', async () => {
			const b = await addSecondAccount();
			limits.set('token-a', group(100, 100));
			limits.set('token-b', group(0, 0));
			await accounts.autoSwitchTick();
			assert.strictEqual(await liveToken(), 'token-a');
			const a = (await accounts.getState()).accounts.find(account => account.active)!.id;
			await assert.rejects(accounts.remove(a));
			const state = await accounts.remove(b);
			assert.deepStrictEqual(state.accounts.map(account => account.email), ['a@x.com']);
		});
	});
});
