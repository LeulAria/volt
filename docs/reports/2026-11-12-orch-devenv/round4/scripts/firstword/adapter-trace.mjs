// Diagnosis preload for Claude Code's ACP adapter (node --import <this file> <adapter>): logs, with wall-clock
// times, every ACP line the adapter reads and writes, every process it spawns, and every line it writes to
// or reads from the Claude CLI's stream-json pipes. Output: $ADAPTER_TRACE (default /tmp/v4-fw/adapter-trace.jsonl).
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';

const out = process.env.ADAPTER_TRACE ?? '/tmp/v4-fw/adapter-trace.jsonl';
const log = (kind, data) => appendFileSync(out, JSON.stringify({ t: Date.now(), pid: process.pid, kind, data: typeof data === 'string' ? data.slice(0, 400) : data }) + '\n');

process.stdin.on('data', d => log('acp-in', String(d)));
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => { log('acp-out', String(chunk)); return write(chunk, ...rest); };

for (const name of ['spawn', 'execFile']) {
	const orig = cp[name];
	cp[name] = function (file, args, ...rest) {
		const child = orig.call(this, file, args, ...rest);
		log(`${name}`, `${file} ${Array.isArray(args) ? args.filter(a => a.length < 80).join(' ') : ''}`);
		const pid = child.pid;
		child.on?.('exit', code => log('exit', `${pid} ${file.split('/').pop()} ${code}`));
		if (name === 'spawn' && child.stdin) {
			const w = child.stdin.write.bind(child.stdin);
			child.stdin.write = (chunk, ...r) => { log('cli-in', String(chunk)); return w(chunk, ...r); };
			child.stdout?.on('data', d => log('cli-out', String(d)));
		}
		return child;
	};
}
syncBuiltinESMExports();
log('start', process.argv.join(' '));
