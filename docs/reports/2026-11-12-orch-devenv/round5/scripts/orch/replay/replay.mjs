// Replays a captured request body N times against the API (OAuth access token of the clean config dir),
// streaming, and records time to first byte, total time, output tokens and thinking tokens.
// usage: node replay.mjs <body.json> <label> <n>
import { appendFileSync, readFileSync } from 'fs';
const [file, label, n = 3] = process.argv.slice(2);
const token = JSON.parse(readFileSync(process.env.HOME + '/.volt-r5/orch/c1/cfg-clean/.credentials.json', 'utf8')).claudeAiOauth.accessToken;
const body = JSON.parse(readFileSync(file, 'utf8'));
body.stream = true;
delete body.safeguards;
if (body.thinking?.display === 'updates') { body.thinking.display = 'summarized'; }
for (let i = 0; i < Number(n); i++) {
	const t0 = Date.now();
	const res = await fetch('https://api.anthropic.com/v1/messages?beta=true', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': process.env.BETAS ?? 'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27', 'content-type': 'application/json' }, body: JSON.stringify(body) });
	if (!res.ok) { console.log(res.status, (await res.text()).slice(0, 500)); process.exit(1); }
	const text = await res.text();
	let out = 0, think = 0, firstText = null, txt = '';
	for (const line of text.split('\n')) {
		if (!line.startsWith('data:')) { continue; }
		const e = JSON.parse(line.slice(5));
		if (e.type === 'message_delta') { out = e.usage?.output_tokens ?? out; think = e.usage?.output_tokens_details?.thinking_tokens ?? think; }
		if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { txt += e.delta.text; }
	}
	const row = { label, i, ms: Date.now() - t0, out, think, textChars: txt.length, at: new Date().toISOString() };
	appendFileSync(process.env.HOME + '/.volt-r5/orch/replay/rows.jsonl', JSON.stringify(row) + '\n');
	console.log(JSON.stringify(row));
}
