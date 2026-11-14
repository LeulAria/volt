// Counts the tokens of texts with POST /v1/messages/count_tokens (the live login's access token from
// TOK_CFG_CREDS), as the difference against a bare "hi" message, the way anatomy.mjs does.
//   node counttext.mjs [--model claude-opus-5-5] <file>...      one row per file
//   echo text | node counttext.mjs -                            stdin
import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const mi = args.indexOf('--model');
const model = mi >= 0 ? args.splice(mi, 2)[1] : 'claude-opus-5-5';
const token = JSON.parse(readFileSync(process.env.TOK_CFG_CREDS ?? `${process.env.HOME}/.volt-r6/tokens/run/cfg-clean/.credentials.json`, 'utf8')).claudeAiOauth.accessToken;

async function count(extra) {
	const req = { model, messages: [{ role: 'user', content: 'hi' }], ...extra };
	for (let attempt = 0; attempt < 4; attempt++) {
		const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20,token-counting-2024-11-01', 'content-type': 'application/json' },
			body: JSON.stringify(req),
		});
		const json = await res.json();
		if (typeof json.input_tokens === 'number') { return json.input_tokens; }
		if (res.status === 429) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
		throw new Error(`count_tokens ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
	}
	throw new Error('count_tokens: rate limited');
}

const base = await count({});
for (const file of args) {
	const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
	const n = (await count({ messages: [{ role: 'user', content: `hi\n${text}` }] })) - base;
	console.log(`${n}\t${text.length}\t${file}`);
}
