/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHmac, randomBytes } from 'crypto';
import { mkdirSync, promises as fs, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from '../../../base/common/path.js';
import { IBrokerAudit, IBrokerAuditEvent } from '../common/broker.js';

/**
 * The brokers' audit log (spec I.1 #6, INV-36): one JSON object per privileged broker operation,
 * `{ts, principal, chain, method, target, decision, epoch}`, appended to
 * `~/.volt/trust/audit/brokers.log` (0600, rotated by size; `~/.volt/trust` is denied to every
 * sandbox). Targets are hashed with a per-install salt (I.2): the log says that the same file was
 * touched again, never which file.
 */

export const DEFAULT_BROKER_AUDIT_DIR = join(homedir(), '.volt', 'trust', 'audit');

export interface IBrokerAuditLogOptions {
	readonly maxBytes?: number;
	readonly keep?: number;
}

/** The install's salt (created once, 0600): reading it is denied to every sandbox with the folder. */
export function auditSalt(dir: string): Buffer {
	const file = join(dir, 'salt');
	try {
		const existing = readFileSync(file);
		if (existing.length >= 32) {
			return existing;
		}
	} catch {
		// Created below.
	}
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const salt = randomBytes(32);
	writeFileSync(file, salt, { mode: 0o600 });
	return salt;
}

export function saltedTargetHash(salt: Buffer, target: string): string {
	return createHmac('sha256', salt).update(target).digest('base64url').slice(0, 22);
}

export class BrokerAuditLog implements IBrokerAudit {

	private readonly file: string;
	private salt: Buffer | undefined;
	private size = -1;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(readonly dir = DEFAULT_BROKER_AUDIT_DIR, private readonly options: IBrokerAuditLogOptions = {}) {
		this.file = join(dir, 'brokers.log');
	}

	redact(target: string): string {
		this.salt ??= auditSalt(this.dir);
		return saltedTargetHash(this.salt, target);
	}

	record(event: Omit<IBrokerAuditEvent, 'target'> & { readonly target?: string }): void {
		const line: IBrokerAuditEvent = { ...event, ...(event.target !== undefined ? { target: this.redact(event.target) } : {}) };
		const text = JSON.stringify(line) + '\n';
		const run = this.queue.then(async () => {
			if (this.size < 0) {
				await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
				this.size = (await fs.stat(this.file).catch(() => undefined))?.size ?? 0;
			}
			if (this.size >= (this.options.maxBytes ?? 5 * 1024 * 1024)) {
				await this.rotate();
			}
			await fs.appendFile(this.file, text, { mode: 0o600 });
			this.size += Buffer.byteLength(text);
		});
		// An audit write that fails never fails the operation it records; the next one tries again.
		this.queue = run.catch(() => { this.size = -1; });
	}

	flush(): Promise<void> {
		return this.queue.then(() => undefined);
	}

	private async rotate(): Promise<void> {
		const keep = this.options.keep ?? 5;
		await fs.unlink(join(this.dir, `brokers.${keep}.log`)).catch(() => undefined);
		for (let i = keep - 1; i >= 1; i--) {
			await fs.rename(join(this.dir, `brokers.${i}.log`), join(this.dir, `brokers.${i + 1}.log`)).catch(() => undefined);
		}
		await fs.rename(this.file, join(this.dir, 'brokers.1.log')).catch(() => undefined);
		this.size = 0;
	}
}
