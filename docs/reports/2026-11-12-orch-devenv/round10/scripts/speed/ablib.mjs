// Shim for a3.mjs (round 3's A3 rig) and a4.mjs (round 6's A4 rig) on the round-10 speed rig: the names they import,
// for the arm in A_ARM (profile dir, CDP 9987, replay log of the 18997 server).
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
export { cdp, DATA, focusComposer, newChat, sleep, median } from './lib.mjs';
import { HOME, ud } from './lib.mjs';

export const UD = ud(process.env.A_ARM ?? 'minbase');
const REPLAY_LOG = `${HOME}/.volt-r10/speed/replay/requests.jsonl`;

/** The three load averages as `uptime` prints them. */
export function load() {
	return execSync('uptime').toString().replace(/.*averages?:\s*/, '').trim();
}

export function replayRequests(fromNs = 0n) {
	if (!existsSync(REPLAY_LOG)) {
		return [];
	}
	return readFileSync(REPLAY_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => BigInt(Math.round(r.t_ns)) >= fromNs);
}
