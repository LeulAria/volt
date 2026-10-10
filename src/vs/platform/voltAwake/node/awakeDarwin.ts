/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { homedir, userInfo } from 'os';
import { join } from '../../../base/common/path.js';
import { Emitter } from '../../../base/common/event.js';
import { LidCapability, parseClamshellState, parsePmsetSleepDisabled } from '../common/voltAwake.js';
import { IAwakeBackendContext, IAwakeLidBackend, LID_HOLD_TTL_SECONDS } from './awakeBackend.js';

/**
 * macOS. A power assertion cannot stop the sleep a closed lid forces on battery without an external
 * display; only `pmset -a disablesleep 1` does, and it needs root. A one-time administrator approval
 * installs a sudoers rule for exactly the two commands below (the same approach as Insomnia).
 *
 * `disablesleep` outlives Volt (crash, force quit, restart), so every change is journaled first and a
 * launchd recovery agent turns sleep back on once no live Volt process holds it.
 */
export const SUDOERS_FILE = '/etc/sudoers.d/volt-lid-closed-mode';
export const RECOVERY_LABEL = 'dev.volt.lid-closed-mode';
const SLEEP_KEY = 'darwinSleepDisabled';
const PMSET = '/usr/bin/pmset';
const SUDO = '/usr/bin/sudo';
const LAUNCHCTL = '/bin/launchctl';
const LID_POLL_MS = 10_000;

export const NEEDS_SETUP_DETAIL = 'Volt needs a one-time administrator approval to keep your Mac awake with the lid closed.';
export const RESTORE_HINT = 'sudo pmset -a disablesleep 0';

export interface IDarwinLidOptions {
	/** Where the recovery agent's plist goes (tests point it at a temp folder). */
	readonly launchAgentsDir?: string;
	/** Hold the `caffeinate -s` assertion (off in tests). */
	readonly caffeinate?: boolean;
}

export class DarwinLidBackend implements IAwakeLidBackend {

	private readonly _onDidChangeLid = new Emitter<boolean | undefined>();
	readonly onDidChangeLid = this._onDidChangeLid.event;

	/** `caffeinate -s`: the assertion against system sleep. macOS honours it on AC power only. */
	private caffeinate: ChildProcess | undefined;
	/** Our holder file says lid=1 and `disablesleep` is on (ours or another Volt's). */
	private holdingFull = false;
	private lidPoll: ReturnType<typeof setInterval> | undefined;
	private lidClosed: boolean | undefined;
	private selfStarted: Promise<string> | undefined;

	constructor(private readonly ctx: IAwakeBackendContext, private readonly options: IDarwinLidOptions = {}) { }

	async probe(): Promise<LidCapability> {
		const ioreg = await this.ctx.exec('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'], { timeoutMs: 10_000 });
		if (ioreg.code === 0 && parseClamshellState(ioreg.stdout) === undefined) {
			return { kind: 'unsupported', detail: 'This Mac has no lid.' };
		}
		if (await this.sleepDisabled() && !(await this.ctx.registry.readChanges()).has(SLEEP_KEY)) {
			return { kind: 'foreign', detail: `Sleep is already turned off by another app or by hand (pmset disablesleep). Volt leaves it alone; to turn it back on, run: ${RESTORE_HINT}` };
		}
		return await this.granted() ? { kind: 'ready' } : { kind: 'needsSetup', detail: NEEDS_SETUP_DETAIL };
	}

	async reconcile(): Promise<void> {
		await this.ctx.registry.withLock(() => this.restoreIfUnheld('startup'));
	}

	async hold(capability: LidCapability): Promise<boolean> {
		this.startCaffeinate();
		if (capability.kind !== 'ready' || this.holdingFull) {
			return this.holdingFull;
		}
		await this.ctx.registry.withLock(async () => {
			await this.writeSelf(true);
			await this.ensureRecoveryAgent();
			if (await this.sleepDisabled()) {
				if ((await this.ctx.registry.readChanges()).has(SLEEP_KEY)) {
					this.holdingFull = true; // another Volt process turned it off; our holder file keeps it off
					return;
				}
				await this.ctx.registry.removeHolder(process.pid);
				return; // someone else's setting (probe reports it as foreign)
			}
			await this.ctx.registry.setChange(SLEEP_KEY, '1');
			const result = await this.ctx.exec(SUDO, ['-n', PMSET, '-a', 'disablesleep', '1'], { terminateOnly: true });
			if (result.code !== 0 || !(await this.sleepDisabled())) {
				if (result.stuckPid === undefined) {
					await this.ctx.registry.setChange(SLEEP_KEY, undefined);
				}
				await this.ctx.registry.removeHolder(process.pid);
				throw new Error(result.stuckPid !== undefined
					? `pmset did not finish (pid ${result.stuckPid}). If sleep stays off, run: ${RESTORE_HINT}`
					: `Could not turn off lid-close sleep: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
			}
			this.holdingFull = true;
			this.ctx.log.info('[volt awake] lid-close sleep turned off (pmset disablesleep 1)');
		});
		if (this.holdingFull) {
			this.startLidPoll();
		}
		return this.holdingFull;
	}

	async renew(): Promise<void> {
		if (this.holdingFull) {
			await this.writeSelf(true);
		}
	}

	async release(): Promise<void> {
		this.stopCaffeinate();
		this.stopLidPoll();
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
		const user = userInfo().username;
		if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)) {
			throw new Error(`Your account name (${user}) cannot go into a sudoers rule. Add the rule by hand: ${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 1, ${PMSET} -a disablesleep 0`);
		}
		const lines = [
			'# Volt Lid-Closed Mode: lets this account turn lid-close sleep off and back on without a password.',
			`${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 1`,
			`${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 0`,
		];
		await this.runAsAdmin([
			'set -e',
			'tmp=$(/usr/bin/mktemp /tmp/volt-lid-closed-mode.XXXXXX)',
			`trap '/bin/rm -f "$tmp"' EXIT`,
			`/usr/bin/printf '%s\\n' ${lines.map(shellQuote).join(' ')} > "$tmp"`,
			'/usr/sbin/visudo -cf "$tmp" >/dev/null',
			`/usr/bin/install -m 0440 -o root -g wheel "$tmp" ${SUDOERS_FILE}`,
		].join('\n'), 'Volt wants to keep your Mac awake with the lid closed while agents work. This lets your account turn sleep off and back on (pmset disablesleep) without a password.');
		if (!(await this.granted())) {
			throw new Error(`The rule was installed but sudo does not accept it. Check ${SUDOERS_FILE}.`);
		}
		this.ctx.log.info(`[volt awake] installed ${SUDOERS_FILE}`);
	}

	async removeSetup(): Promise<void> {
		if (this.holdingFull || (await this.ctx.registry.readChanges()).has(SLEEP_KEY)) {
			throw new Error('Lid-Closed Mode is keeping the Mac awake right now. Try again when agents have finished.');
		}
		await this.runAsAdmin(`/bin/rm -f ${SUDOERS_FILE}`, 'Volt will remove its permission to keep your Mac awake with the lid closed.');
		const uid = process.getuid?.() ?? 0;
		await this.ctx.exec(LAUNCHCTL, ['bootout', `gui/${uid}/${RECOVERY_LABEL}`], { timeoutMs: 10_000 });
		await fs.rm(this.plistPath, { force: true });
		this.ctx.log.info(`[volt awake] removed ${SUDOERS_FILE}`);
	}

	dispose(): void {
		this.stopCaffeinate();
		this.stopLidPoll();
		this._onDidChangeLid.dispose();
	}

	/** Turns sleep back on when our journal says we turned it off and no live holder wants it off. Call under the lock. */
	private async restoreIfUnheld(why: string): Promise<void> {
		const live = await this.ctx.registry.liveHolders();
		if (live.some(holder => holder.lid) || !(await this.ctx.registry.readChanges()).has(SLEEP_KEY)) {
			return;
		}
		const result = await this.ctx.exec(SUDO, ['-n', PMSET, '-a', 'disablesleep', '0'], { terminateOnly: true });
		if (result.code !== 0) {
			throw new Error(result.stuckPid !== undefined
				? `pmset did not finish (pid ${result.stuckPid}). If sleep stays off, run: ${RESTORE_HINT}`
				: `Could not turn sleep back on. Run: ${RESTORE_HINT}`);
		}
		await this.ctx.registry.setChange(SLEEP_KEY, undefined);
		this.ctx.log.info(`[volt awake] lid-close sleep turned back on (${why})`);
	}

	private async writeSelf(lid: boolean): Promise<void> {
		this.selfStarted ??= this.ctx.probe.startedOf(process.pid);
		await this.ctx.registry.writeHolder({
			pid: process.pid,
			started: await this.selfStarted,
			boot: await this.ctx.probe.bootId(),
			deadline: Math.floor(Date.now() / 1000) + LID_HOLD_TTL_SECONDS,
			lid,
			owner: this.ctx.owner,
		});
	}

	private async sleepDisabled(): Promise<boolean> {
		const result = await this.ctx.exec(PMSET, ['-g'], { timeoutMs: 10_000 });
		return result.code === 0 && parsePmsetSleepDisabled(result.stdout);
	}

	private async granted(): Promise<boolean> {
		const result = await this.ctx.exec(SUDO, ['-n', '-l', PMSET, '-a', 'disablesleep', '1'], { timeoutMs: 10_000, terminateOnly: true });
		return result.code === 0;
	}

	private async runAsAdmin(script: string, prompt: string): Promise<void> {
		// The script and prompt travel as arguments, so neither needs AppleScript escaping.
		const result = await this.ctx.exec('/usr/bin/osascript', [
			'-e', 'on run argv',
			'-e', 'do shell script (item 1 of argv) with administrator privileges with prompt (item 2 of argv)',
			'-e', 'end run',
			script, prompt,
		], { timeoutMs: 5 * 60_000 });
		if (result.code !== 0) {
			const message = (result.stderr || result.stdout).trim();
			throw new Error(/-128|cancel/i.test(message) ? 'Setup was cancelled.' : message || `osascript exited with ${result.code}`);
		}
	}

	private get plistPath(): string {
		return join(this.options.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents'), `${RECOVERY_LABEL}.plist`);
	}

	/** Writes recovery.sh and its LaunchAgent, and loads it. Runs before the first `disablesleep 1`. */
	private async ensureRecoveryAgent(): Promise<void> {
		const script = join(this.ctx.registry.dir, 'recovery.sh');
		await writeIfChanged(script, RECOVERY_SCRIPT, 0o700);
		const plistChanged = await writeIfChanged(this.plistPath, recoveryPlist(script), 0o644);
		const uid = process.getuid?.() ?? 0;
		const target = `gui/${uid}/${RECOVERY_LABEL}`;
		const loaded = (await this.ctx.exec(LAUNCHCTL, ['print', target], { timeoutMs: 10_000 })).code === 0;
		if (loaded && !plistChanged) {
			return;
		}
		if (loaded) {
			await this.ctx.exec(LAUNCHCTL, ['bootout', target], { timeoutMs: 10_000 });
		}
		const boot = await this.ctx.exec(LAUNCHCTL, ['bootstrap', `gui/${uid}`, this.plistPath], { timeoutMs: 10_000 });
		if ((await this.ctx.exec(LAUNCHCTL, ['print', target], { timeoutMs: 10_000 })).code !== 0) {
			throw new Error(`Could not load the recovery agent that turns sleep back on if Volt quits unexpectedly: ${(boot.stderr || boot.stdout).trim()}`);
		}
		this.ctx.log.info(`[volt awake] recovery agent ${RECOVERY_LABEL} loaded`);
	}

	private startCaffeinate(): void {
		if (this.options.caffeinate === false || (this.caffeinate && this.caffeinate.exitCode === null)) {
			return;
		}
		// -w: the assertion goes away with Volt, even on a crash.
		const child = spawn('/usr/bin/caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' });
		child.on('error', err => this.ctx.log.warn('[volt awake] caffeinate failed', err));
		this.caffeinate = child;
	}

	private stopCaffeinate(): void {
		this.caffeinate?.kill();
		this.caffeinate = undefined;
	}

	/** With `disablesleep` on, macOS leaves the panel lit under a closed lid; ask it to sleep. */
	private startLidPoll(): void {
		if (this.lidPoll) {
			return;
		}
		const poll = async () => {
			const result = await this.ctx.exec('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'], { timeoutMs: 5_000 });
			const closed = result.code === 0 ? parseClamshellState(result.stdout) : undefined;
			if (closed === this.lidClosed) {
				return;
			}
			this.lidClosed = closed;
			this._onDidChangeLid.fire(closed);
			if (closed && this.holdingFull) {
				this.ctx.log.info('[volt awake] lid closed: asking the display to sleep');
				await this.ctx.exec(PMSET, ['displaysleepnow'], { timeoutMs: 5_000 });
			}
		};
		void poll();
		this.lidPoll = setInterval(() => void poll(), LID_POLL_MS);
	}

	private stopLidPoll(): void {
		if (this.lidPoll) {
			clearInterval(this.lidPoll);
			this.lidPoll = undefined;
		}
		if (this.lidClosed !== undefined) {
			this.lidClosed = undefined;
			this._onDidChangeLid.fire(undefined);
		}
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** True when the file changed. */
async function writeIfChanged(path: string, content: string, mode: number): Promise<boolean> {
	const current = await fs.readFile(path, 'utf8').catch(() => undefined);
	if (current === content) {
		return false;
	}
	await fs.mkdir(join(path, '..'), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	await fs.writeFile(temp, content, { mode });
	await fs.rename(temp, path);
	return true;
}

function recoveryPlist(script: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${RECOVERY_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>${xmlEscape(script)}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StartInterval</key>
	<integer>60</integer>
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
`;
}

/**
 * launchd runs this every 60 s and at login. Plain sh with /usr/bin tools only: launchd may not read
 * a Volt binary under ~/Desktop (privacy rules), and this must work after Volt is gone.
 */
export const RECOVERY_SCRIPT = `#!/bin/sh
# Volt Lid-Closed Mode recovery agent (launchd: every 60 s and at login).
# Turns sleep back on (pmset -a disablesleep 0) once no live Volt process holds Lid-Closed Mode:
# its process is gone, its pid belongs to another program now, the Mac restarted, or its deadline passed.
# It reads only ~/.volt/awake and runs nothing else as root.
PATH="\${VOLT_AWAKE_TEST_PATH:+$VOLT_AWAKE_TEST_PATH:}/usr/bin:/bin:/usr/sbin:/sbin"
export LC_ALL=C
DIR="$HOME/.volt/awake"
CHANGES="$DIR/changes"
[ -f "$CHANGES" ] || exit 0
grep -q '^${SLEEP_KEY}=1$' "$CHANGES" || exit 0
LOG="$DIR/recovery.log"
log() {
	if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 262144 ]; then mv -f "$LOG" "$LOG.1"; fi
	printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" >> "$LOG"
}
LOCK="$DIR/lock.d"
tries=0
while ! mkdir "$LOCK" 2>/dev/null; do
	owner=$(cat "$LOCK/pid" 2>/dev/null)
	if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
		rm -rf "$LOCK"
		continue
	fi
	if [ -z "$owner" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
		rm -rf "$LOCK"
		continue
	fi
	tries=$((tries + 1))
	[ "$tries" -ge 100 ] && exit 75
	sleep 0.1
done
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT
trap 'exit 1' HUP INT TERM
now=$(date +%s)
boot=$(sysctl -n kern.bootsessionuuid 2>/dev/null)
held=0
for f in "$DIR"/holders/*; do
	[ -f "$f" ] || continue
	case "\${f##*/}" in *[!0-9]*) continue ;; esac
	pid=$(sed -n 's/^pid=//p' "$f")
	started=$(sed -n 's/^started=//p' "$f")
	hboot=$(sed -n 's/^boot=//p' "$f")
	deadline=$(sed -n 's/^deadline=//p' "$f")
	lid=$(sed -n 's/^lid=//p' "$f")
	valid=1
	case "$pid" in ''|*[!0-9]*) valid=0 ;; esac
	case "$deadline" in ''|*[!0-9]*) valid=0 ;; esac
	if [ "$valid" = 1 ] && [ "$deadline" -le "$now" ]; then valid=0; fi
	if [ "$valid" = 1 ] && [ -n "$hboot" ] && [ -n "$boot" ] && [ "$hboot" != "$boot" ]; then valid=0; fi
	if [ "$valid" = 1 ] && ! kill -0 "$pid" 2>/dev/null; then valid=0; fi
	if [ "$valid" = 1 ] && [ -n "$started" ]; then
		current=$(ps -o lstart= -p "$pid" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//')
		[ "$current" = "$started" ] || valid=0
	fi
	if [ "$valid" = 1 ]; then
		[ "$lid" = 1 ] && held=1
	else
		rm -f "$f"
	fi
done
[ "$held" = 1 ] && exit 0
if sudo -n ${PMSET} -a disablesleep 0; then
	grep -v '^${SLEEP_KEY}=' "$CHANGES" > "$CHANGES.tmp" || true
	if [ -s "$CHANGES.tmp" ]; then mv -f "$CHANGES.tmp" "$CHANGES"; else rm -f "$CHANGES.tmp" "$CHANGES"; fi
	log "sleep turned back on: no Volt process holds Lid-Closed Mode"
else
	log "failed: sudo -n ${PMSET} -a disablesleep 0 (is ${SUDOERS_FILE} still there?)"
	exit 1
fi
`;
