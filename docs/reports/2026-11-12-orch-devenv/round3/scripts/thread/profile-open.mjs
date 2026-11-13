#!/usr/bin/env node
// CPU profile of the renderer while a chat opens: click `--from`, then profile the click on `--chat`
// for `--ms` milliseconds. Prints the top functions by self and by total time; writes the
// .cpuprofile next to --out when given.
//
//   node profile-open.mjs --chat "Long thread 41k" [--from "Short thread"] [--ms 2500] [--out x.cpuprofile]
import fs from 'node:fs';
import { connect, rowCenter, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const port = Number(opt('port', '9953'));
const chat = opt('chat', 'Long thread 41k');
const from = opt('from', 'Short thread');
const ms = Number(opt('ms', '2500'));
const out = opt('out');

export function summarize(profile, top = 25) {
	const byId = new Map(profile.nodes.map(n => [n.id, n]));
	const parent = new Map();
	for (const n of profile.nodes) {
		for (const c of n.children ?? []) {
			parent.set(c, n.id);
		}
	}
	const self = new Map();
	const dt = profile.timeDeltas;
	for (let i = 0; i < profile.samples.length; i++) {
		self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (dt[i] ?? 0) / 1000);
	}
	const key = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-1)[0]}:${n.callFrame.lineNumber + 1}`;
	const selfBy = new Map();
	const totalBy = new Map();
	for (const [id, t] of self) {
		const n = byId.get(id);
		selfBy.set(key(n), (selfBy.get(key(n)) ?? 0) + t);
		const seen = new Set();
		for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
			const k = key(byId.get(cur));
			if (!seen.has(k)) {
				seen.add(k);
				totalBy.set(k, (totalBy.get(k) ?? 0) + t);
			}
		}
	}
	const fmt = m => [...m].filter(([k]) => !/^\((idle|program|root)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `${v.toFixed(1).padStart(8)} ms  ${k}`).join('\n');
	return `-- self --\n${fmt(selfBy)}\n-- total --\n${fmt(totalBy)}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const cdp = await connect(port);
	const fromAt = await rowCenter(cdp, from);
	await cdp.click(fromAt.x, fromAt.y);
	await sleep(2500);
	await cdp.send('Profiler.enable');
	await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
	await cdp.send('Profiler.start');
	const at = await rowCenter(cdp, chat);
	await cdp.click(at.x, at.y);
	await sleep(ms);
	const { result } = await cdp.send('Profiler.stop');
	if (out) {
		fs.writeFileSync(out, JSON.stringify(result.profile));
	}
	console.log(summarize(result.profile));
	cdp.close();
}
