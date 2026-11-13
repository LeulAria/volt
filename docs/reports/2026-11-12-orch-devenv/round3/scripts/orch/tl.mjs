// Timeline of one Volt bench run: every event of the root chat and its subagents on one clock.
//   node tl.mjs <raw/<id>.traces.json> [sentAtIso]   (sentAt defaults to the root's first run.start)
// Columns: t (s from send), chat (P = parent, 1..n = task index), event, detail. Usage lines show the
// request count and context size so model requests can be told from Volt's own gaps.
import { readFileSync } from 'fs';

const [file, sentIso] = process.argv.slice(2);
const { tree, traces } = JSON.parse(readFileSync(file, 'utf8'));
const tasks = tree?.tasks ?? [];
const label = new Map([[traces[0].chat, 'P']]);
tasks.forEach((t, i) => t.childId && label.set(t.childId, String(i + 1)));
const all = [];
for (const t of traces) {
	for (const l of t.lines) {
		all.push({ chat: label.get(t.chat) ?? '?', ...l });
	}
}
for (const [i, t] of tasks.entries()) {
	for (const k of ['createdAt', 'startedAt', 'endedAt']) {
		if (t[k]) {
			all.push({ chat: String(i + 1), ts: t[k], kind: 'task', task: `${k} ${t.title} (${t.state}${t.result ? `, report ${t.result.length} chars` : ''})` });
		}
	}
}
const firstStart = all.filter(l => l.event?.type === 'run.start').map(l => l.ts).sort((a, b) => a - b)[0];
const t0 = sentIso ? Date.parse(sentIso) : firstStart;
all.sort((a, b) => a.ts - b.ts);
const s = ms => ((ms - t0) / 1000).toFixed(2).padStart(7);
for (const l of all) {
	let d = '';
	if (l.kind === 'task') {
		d = `task ${l.task}`;
	} else if (l.kind === 'metrics') {
		const m = l.metrics;
		d = `metrics src=${m.agentSource} ready=${m.agentReadyMs} prompt=${m.promptMs} first=${m.firstEventMs} text=${m.firstTextMs} total=${m.totalMs} req=${m.usage?.requests} maxIn=${m.usage?.maxRequestInput} tools=${m.tools?.count}`;
	} else {
		const e = l.event;
		switch (e.type) {
			case 'usage': d = `usage used=${e.used ?? ''} in=${e.input ?? ''} out=${e.output ?? ''} cache=${e.cache ?? ''}`; break;
			case 'tool.start': d = `tool.start ${e.name ?? e.title ?? ''} ${JSON.stringify(e.input ?? e.args ?? '').slice(0, 140)}`; break;
			case 'tool.end': d = `tool.end ${e.name ?? e.title ?? ''} ${String(e.output ?? e.result ?? '').length}ch`; break;
			case 'host.tool': d = `host.tool ${e.name}`; break;
			case 'text.end': d = `text.end ${(e.delta ?? '').length}ch ${(e.delta ?? '').slice(0, 80).replace(/\n/g, ' ')}`; break;
			case 'lifecycle': d = `lifecycle ${e.phase ?? e.state ?? JSON.stringify(e).slice(0, 100)}`; break;
			default: d = `${e.type} ${JSON.stringify(e).slice(0, 120)}`;
		}
	}
	console.log(`${s(l.ts)}  ${l.chat.padEnd(2)} ${d}`);
}
