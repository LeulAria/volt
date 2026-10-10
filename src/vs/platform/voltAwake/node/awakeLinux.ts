/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { Event } from '../../../base/common/event.js';
import { LidCapability } from '../common/voltAwake.js';
import { IAwakeBackendContext, IAwakeLidBackend } from './awakeBackend.js';

/**
 * Linux (systemd-logind). logind ignores "sleep" inhibitors for the lid by default
 * (LidSwitchIgnoreInhibited=yes); only a "handle-lid-switch" block inhibitor stops it. The inhibitor
 * lives as long as the `cat` below: when Volt exits for any reason its stdin closes, `cat` ends, and
 * logind lets go. Nothing persists, so there is nothing to journal or recover.
 */
const CANDIDATES = ['/usr/bin/systemd-inhibit', '/bin/systemd-inhibit'];

export class LinuxLidBackend implements IAwakeLidBackend {

	readonly onDidChangeLid = Event.None;

	private child: ChildProcess | undefined;
	private lastFailure: LidCapability | undefined;

	constructor(private readonly ctx: IAwakeBackendContext) { }

	async probe(): Promise<LidCapability> {
		if (!(await hasLid())) {
			return { kind: 'unsupported', detail: 'This computer has no lid.' };
		}
		if (!(await this.inhibitPath())) {
			return { kind: 'unsupported', detail: 'Lid-Closed Mode needs systemd-logind (systemd-inhibit was not found).' };
		}
		return this.lastFailure ?? { kind: 'ready' };
	}

	async reconcile(): Promise<void> { }

	async hold(capability: LidCapability): Promise<boolean> {
		if (capability.kind !== 'ready') {
			return false;
		}
		if (this.child && this.child.exitCode === null) {
			return true;
		}
		const path = await this.inhibitPath();
		if (!path) {
			return false;
		}
		const child = spawn(path, ['--what=handle-lid-switch:sleep', '--who=Volt', '--why=Agents are working (Lid-Closed Mode)', '--mode=block', 'cat'], { stdio: ['pipe', 'ignore', 'pipe'] });
		let stderr = '';
		child.stderr?.on('data', chunk => stderr += chunk);
		const exited = await new Promise<boolean>(resolve => {
			const timer = setTimeout(() => resolve(false), 1_000);
			child.once('exit', () => { clearTimeout(timer); resolve(true); });
			child.once('error', () => { clearTimeout(timer); resolve(true); });
		});
		if (exited) {
			const output = stderr.trim() || 'systemd-inhibit exited at once';
			const denied = /access denied|not authorized|permission/i.test(output);
			const detail = denied ? `The system did not allow Volt to hold the lid switch (polkit: org.freedesktop.login1.inhibit-handle-lid-switch). ${output}` : output;
			this.lastFailure = { kind: denied ? 'needsSetup' : 'unsupported', detail };
			throw new Error(detail);
		}
		this.child = child;
		this.ctx.log.info('[volt awake] holding the lid switch (systemd-inhibit handle-lid-switch)');
		return true;
	}

	async renew(): Promise<void> { }

	async release(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		if (child) {
			child.stdin?.end();
			child.kill();
			this.ctx.log.info('[volt awake] released the lid switch');
		}
	}

	async setUp(): Promise<void> {
		this.lastFailure = undefined; // try again (after the user changed the polkit rule)
	}

	async removeSetup(): Promise<void> { }

	dispose(): void {
		void this.release();
	}

	private async inhibitPath(): Promise<string | undefined> {
		for (const path of CANDIDATES) {
			if (await fs.access(path).then(() => true, () => false)) {
				return path;
			}
		}
		return undefined;
	}
}

async function hasLid(): Promise<boolean> {
	if (await fs.readdir('/proc/acpi/button/lid').then(entries => entries.length > 0, () => false)) {
		return true;
	}
	// Some laptops expose no ACPI lid node; a battery is the next best sign of one.
	return fs.readdir('/sys/class/power_supply').then(entries => entries.some(name => /^BAT/i.test(name)), () => false);
}
