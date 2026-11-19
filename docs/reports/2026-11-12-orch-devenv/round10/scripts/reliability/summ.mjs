// node summ.mjs [filter]   one line per run row in ../../data/reliability/runs.jsonl
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const rows = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../data/reliability/runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const f = process.argv[2];
const verbose = process.argv.includes('-v');
for (const r of rows.filter(r => !f || r.id.includes(f))) {
	const head = r.test === 'C2' ? `dropped ${r.dropped}/3 applied ${r.applied}/3 locks ${r.c3.locks} (${r.c3.probes} probes, longest ${r.c3.longestLockS}s, echo p50 ${r.c3.echoP50} max ${r.c3.echoMax})`
		: r.test === 'ORCH' ? `${r.result} work ${JSON.stringify(r.work)} lead saw ${r.reportsSeenByLead} finals ${JSON.stringify(r.finals)} queued ${JSON.stringify(r.queued)}`
			: `${r.survival} resumed ${r.resumed}${r.resumedAfterMs ? ` +${r.resumedAfterMs}ms` : ''} manual ${r.manualContinue} ${JSON.stringify(r.groups)}${r.queuedDelivered !== undefined ? ` queued delivered ${r.queuedDelivered} answered ${r.queuedAnswered}` : ''}`;
	console.log(`${r.id} [${r.arm}] ${r.test} ${head} | done ${r.done} ${r.endS}s | load ${r.load.split(' ')[0]} | fault ${JSON.stringify(r.fault ?? null).slice(0, 260)}`);
	if (verbose) {
		console.log('   steps:', r.captureSteps?.join(' '));
		console.log('   ui after watch:', JSON.stringify(r.uiAfterWatch ?? r.uiAfterFault ?? null).slice(0, 500));
		console.log('   thread tail:', JSON.stringify((r.threadTail ?? '').slice(-260)));
		if (r.followups) { for (const s of r.followups) { console.log('   ', s.id, 'accepted', s.accepted, 'delivered', s.delivered, s.deliveredAfterMs, 'ms later in request', s.deliveredInRequest, 'applied', s.applied, 'model was at', s.modelPhase); } }
		if (r.tasks) { console.log('   tasks:', JSON.stringify(r.tasks)); }
	}
}
