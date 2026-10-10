/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { Event } from '../../../base/common/event.js';
import { LidCapability, parseActiveSchemeGuid, parseLidAction } from '../common/voltAwake.js';
import { IAwakeBackendContext, IAwakeLidBackend, LID_HOLD_TTL_SECONDS } from './awakeBackend.js';

/**
 * Windows. Power requests (what Electron's powerSaveBlocker uses) do not override the lid: the lid
 * action is a power plan setting (SUB_BUTTONS/LIDACTION, 0 = do nothing). Volt sets it to 0 for AC
 * and battery while the hold lasts, after journaling the old values. The setting persists, so a
 * PowerShell guard restores it when Volt exits for any reason, and a RunOnce entry restores it at
 * the next logon if the machine went down first.
 */
const WIN32_KEY = 'win32Lid';
const RUN_ONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
const RUN_ONCE_VALUE = 'VoltLidClosedMode';

export class Win32LidBackend implements IAwakeLidBackend {

	readonly onDidChangeLid = Event.None;

	private holdingFull = false;
	private guardStarted = false;
	private selfStarted: Promise<string> | undefined;
	private lastFailure: string | undefined;

	constructor(private readonly ctx: IAwakeBackendContext) { }

	private get powercfg(): string {
		return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'powercfg.exe');
	}

	private get reg(): string {
		return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
	}

	private get restoreScript(): string {
		return join(this.ctx.registry.dir, 'restore.ps1');
	}

	async probe(): Promise<LidCapability> {
		if (this.lastFailure) {
			return { kind: 'unsupported', detail: this.lastFailure };
		}
		const current = await this.readLidAction();
		return current ? { kind: 'ready' } : { kind: 'unsupported', detail: 'Windows did not report the power plan\'s lid action (powercfg).' };
	}

	async reconcile(): Promise<void> {
		await this.ctx.registry.withLock(() => this.restoreIfUnheld('startup'));
	}

	async hold(capability: LidCapability): Promise<boolean> {
		if (capability.kind !== 'ready' || this.holdingFull) {
			return this.holdingFull;
		}
		await this.ctx.registry.withLock(async () => {
			await this.writeSelf();
			if ((await this.ctx.registry.readChanges()).has(WIN32_KEY)) {
				this.holdingFull = true; // another Volt process already set it
				return;
			}
			const current = await this.readLidAction();
			if (!current) {
				await this.ctx.registry.removeHolder(process.pid);
				throw new Error('Windows did not report the power plan\'s lid action (powercfg).');
			}
			if (current.ac === 0 && current.dc === 0) {
				this.holdingFull = true; // already "Do nothing": nothing to change or undo
				return;
			}
			await writeFileIfChanged(this.restoreScript, RESTORE_SCRIPT);
			await this.ctx.exec(this.reg, ['add', RUN_ONCE_KEY, '/v', RUN_ONCE_VALUE, '/t', 'REG_SZ', '/d', this.restoreCommand(), '/f'], { timeoutMs: 10_000 });
			await this.ctx.registry.setChange(WIN32_KEY, `${current.scheme},${current.ac},${current.dc}`);
			this.startGuard();
			const ok = await this.writeLidAction(current.scheme, 0, 0);
			if (!ok) {
				await this.writeLidAction(current.scheme, current.ac, current.dc);
				await this.ctx.registry.setChange(WIN32_KEY, undefined);
				await this.ctx.registry.removeHolder(process.pid);
				this.lastFailure = 'Windows refused to change the power plan\'s lid action. It may be managed by your organization.';
				throw new Error(this.lastFailure);
			}
			this.holdingFull = true;
			this.ctx.log.info(`[volt awake] lid action set to "Do nothing" (was AC ${current.ac}, DC ${current.dc})`);
		});
		return this.holdingFull;
	}

	async renew(): Promise<void> {
		if (this.holdingFull) {
			await this.writeSelf();
		}
	}

	async release(): Promise<void> {
		if (!this.holdingFull) {
			return;
		}
		this.holdingFull = false;
		await this.ctx.registry.withLock(async () => {
			await this.ctx.registry.removeHolder(process.pid);
			await this.restoreIfUnheld('release');
		});
	}

	async setUp(): Promise<void> {
		this.lastFailure = undefined; // nothing to approve; try the power plan again
	}

	async removeSetup(): Promise<void> { }

	dispose(): void { }

	private async restoreIfUnheld(why: string): Promise<void> {
		const live = await this.ctx.registry.liveHolders();
		const saved = (await this.ctx.registry.readChanges()).get(WIN32_KEY);
		if (live.some(holder => holder.lid) || !saved) {
			return;
		}
		const [scheme, ac, dc] = saved.split(',');
		if (!(await this.writeLidAction(scheme, Number(ac), Number(dc)))) {
			throw new Error(`Could not put the lid action back. Run: powercfg /setacvalueindex ${scheme} SUB_BUTTONS LIDACTION ${ac} & powercfg /setdcvalueindex ${scheme} SUB_BUTTONS LIDACTION ${dc}`);
		}
		await this.ctx.registry.setChange(WIN32_KEY, undefined);
		await this.ctx.exec(this.reg, ['delete', RUN_ONCE_KEY, '/v', RUN_ONCE_VALUE, '/f'], { timeoutMs: 10_000 });
		this.ctx.log.info(`[volt awake] lid action restored (AC ${ac}, DC ${dc}) (${why})`);
	}

	private async readLidAction(): Promise<{ scheme: string; ac: number; dc: number } | undefined> {
		const active = await this.ctx.exec(this.powercfg, ['/getactivescheme'], { timeoutMs: 10_000 });
		const scheme = active.code === 0 ? parseActiveSchemeGuid(active.stdout) : undefined;
		if (!scheme) {
			return undefined;
		}
		const query = await this.ctx.exec(this.powercfg, ['/q', scheme, 'SUB_BUTTONS', 'LIDACTION'], { timeoutMs: 10_000 });
		const values = query.code === 0 ? parseLidAction(query.stdout) : undefined;
		return values && { scheme, ...values };
	}

	private async writeLidAction(scheme: string, ac: number, dc: number): Promise<boolean> {
		const a = await this.ctx.exec(this.powercfg, ['/setacvalueindex', scheme, 'SUB_BUTTONS', 'LIDACTION', String(ac)], { timeoutMs: 10_000 });
		const d = await this.ctx.exec(this.powercfg, ['/setdcvalueindex', scheme, 'SUB_BUTTONS', 'LIDACTION', String(dc)], { timeoutMs: 10_000 });
		// Values written to the active plan apply once it is set active again; another plan keeps them for later.
		const active = await this.ctx.exec(this.powercfg, ['/getactivescheme'], { timeoutMs: 10_000 });
		if (parseActiveSchemeGuid(active.stdout) === scheme) {
			await this.ctx.exec(this.powercfg, ['/setactive', scheme], { timeoutMs: 10_000 });
		}
		const after = await this.readLidAction();
		return a.code === 0 && d.code === 0 && (!after || after.scheme !== scheme || (after.ac === ac && after.dc === dc));
	}

	private async writeSelf(): Promise<void> {
		this.selfStarted ??= this.ctx.probe.startedOf(process.pid);
		await this.ctx.registry.writeHolder({
			pid: process.pid,
			started: await this.selfStarted,
			boot: '',
			deadline: Math.floor(Date.now() / 1000) + LID_HOLD_TTL_SECONDS,
			lid: true,
			owner: this.ctx.owner,
		});
	}

	private restoreCommand(): string {
		return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${this.restoreScript}"`;
	}

	/** Waits for this Volt process to exit, however it exits, then restores what no one holds any more. */
	private startGuard(): void {
		if (this.guardStarted) {
			return;
		}
		this.guardStarted = true;
		const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', this.restoreScript, '-WaitPid', String(process.pid)], { detached: true, stdio: 'ignore', windowsHide: true });
		child.on('error', err => this.ctx.log.warn('[volt awake] restore guard failed to start', err));
		child.unref();
	}
}

async function writeFileIfChanged(path: string, content: string): Promise<void> {
	if (await fs.readFile(path, 'utf8').catch(() => undefined) !== content) {
		await fs.writeFile(path, content);
	}
}

/** The guard (with -WaitPid) and the RunOnce entry (without). Same lock and holder rules as the app. */
const RESTORE_SCRIPT = `# Volt Lid-Closed Mode: puts the power plan's lid action back once no live Volt process holds it.
param([int]$WaitPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
if ($WaitPid -gt 0) { Wait-Process -Id $WaitPid }
$dir = Join-Path $env:USERPROFILE '.volt\\awake'
$changes = Join-Path $dir 'changes'
if (-not (Get-Content $changes | Where-Object { $_ -like '${WIN32_KEY}=*' })) { exit 0 }
$lock = Join-Path $dir 'lock.d'
$got = $false
for ($i = 0; $i -lt 200 -and -not $got; $i++) {
	try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null; $got = $true }
	catch {
		$owner = 0
		[int]::TryParse(((Get-Content (Join-Path $lock 'pid')) -join ''), [ref]$owner) | Out-Null
		if ($owner -gt 0 -and -not (Get-Process -Id $owner)) { Remove-Item -Recurse -Force $lock }
		else { Start-Sleep -Milliseconds 50 }
	}
}
if (-not $got) { exit 75 }
Set-Content -Path (Join-Path $lock 'pid') -Value $PID
try {
	$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
	$held = $false
	Get-ChildItem (Join-Path $dir 'holders') -File | Where-Object { $_.Name -match '^\\d+$' } | ForEach-Object {
		$kv = @{}
		Get-Content $_.FullName | ForEach-Object { $at = $_.IndexOf('='); if ($at -gt 0) { $kv[$_.Substring(0, $at)] = $_.Substring($at + 1) } }
		$valid = $false
		$p = Get-Process -Id ([int]$kv['pid'])
		if ($p -and [int64]$kv['deadline'] -gt $now) {
			if (-not $kv['started'] -or $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $kv['started']) { $valid = $true }
		}
		if (-not $valid) { Remove-Item -Force $_.FullName }
		elseif ($kv['lid'] -eq '1') { $held = $true }
	}
	if ($held) { exit 0 }
	$line = Get-Content $changes | Where-Object { $_ -like '${WIN32_KEY}=*' } | Select-Object -First 1
	if (-not $line) { exit 0 }
	$parts = $line.Substring(${WIN32_KEY.length + 1}).Split(',')
	powercfg /setacvalueindex $parts[0] SUB_BUTTONS LIDACTION $parts[1]
	$ok = $LASTEXITCODE -eq 0
	powercfg /setdcvalueindex $parts[0] SUB_BUTTONS LIDACTION $parts[2]
	$ok = $ok -and $LASTEXITCODE -eq 0
	if ((powercfg /getactivescheme) -match $parts[0]) { powercfg /setactive $parts[0] }
	if ($ok) {
		$rest = @(Get-Content $changes | Where-Object { $_ -notlike '${WIN32_KEY}=*' })
		if ($rest.Count) { Set-Content -Path $changes -Value $rest } else { Remove-Item -Force $changes }
		reg delete '${RUN_ONCE_KEY}' /v ${RUN_ONCE_VALUE} /f | Out-Null
	}
} finally {
	Remove-Item -Recurse -Force $lock
}
`;
