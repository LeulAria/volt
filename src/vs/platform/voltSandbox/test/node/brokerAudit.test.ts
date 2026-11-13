/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IBrokerAuditEvent } from '../../common/broker.js';
import { BrokerAuditLog } from '../../node/brokerAudit.js';

/**
 * AUDIT-1 (I.1 #6, INV-36): every broker operation is one JSON line with principal, chain, method,
 * decision and epoch; the target is a salted hash (the same file twice is the same hash, never the
 * path); the log and its salt are 0600 in a 0700 folder, and rotate by size.
 */
suite('Volt broker audit log (AUDIT-1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();
	let dir: string;

	setup(async () => {
		dir = join(await fs.mkdtemp(join(tmpdir(), 'volt-broker-audit-')), 'audit');
	});

	teardown(() => fs.rm(join(dir, '..'), { recursive: true, force: true }));

	const event = (target: string, decision: 'allow' | 'deny' = 'allow') => ({ ts: 1, broker: 'files', method: 'open', principal: 'p1', subject: 'plugin:acme.x@local' as const, chain: ['chat:c1' as const], decision, epoch: 7, target });

	test('records are JSON lines with a salted target; files are private; the log rotates', async () => {
		const log = new BrokerAuditLog(dir, { maxBytes: 600, keep: 2 });
		log.record(event('/Users/me/proj/secret-plan.txt'));
		log.record(event('/Users/me/proj/secret-plan.txt', 'deny'));
		log.record(event('/Users/me/proj/other.txt'));
		await log.flush();
		const lines = (await fs.readFile(join(dir, 'brokers.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as IBrokerAuditEvent);
		assert.strictEqual(lines.length, 3);
		assert.ok(lines.every(line => line.target && !line.target.includes('secret') && !line.target.includes('/')));
		assert.strictEqual(lines[0].target, lines[1].target, 'the same target hashes alike');
		assert.notStrictEqual(lines[0].target, lines[2].target);
		assert.deepStrictEqual({ ...lines[1], target: undefined }, { ...event(''), decision: 'deny', target: undefined });

		// Another install (another salt) hashes the same path differently.
		const other = new BrokerAuditLog(join(dir, '..', 'other'));
		assert.notStrictEqual(other.redact('/Users/me/proj/secret-plan.txt'), lines[0].target);

		if (process.platform !== 'win32') {
			assert.strictEqual((await fs.stat(dir)).mode & 0o777, 0o700);
			assert.strictEqual((await fs.stat(join(dir, 'brokers.log'))).mode & 0o077, 0);
			assert.strictEqual((await fs.stat(join(dir, 'salt'))).mode & 0o077, 0);
		}

		for (let i = 0; i < 20; i++) {
			log.record(event(`/f${i}`));
		}
		await log.flush();
		const names = (await fs.readdir(dir)).sort();
		assert.ok(names.includes('brokers.1.log') && names.includes('brokers.2.log') && !names.includes('brokers.3.log'), names.join(' '));
	});
});
