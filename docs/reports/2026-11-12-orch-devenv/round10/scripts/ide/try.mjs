// node try.mjs <profile> <root> [--sandbox] < calls.jsonl   (one {"tool","args"} per line)
import { readFileSync } from 'fs';
import { server } from './lib.mjs';
const [name, root, flag] = process.argv.slice(2);
const s = await server(name);
const chat = await s.chat(root, flag === '--sandbox' ? { level: 'workspace-write', network: true } : undefined);
for (const line of readFileSync(0, 'utf8').split('\n').filter(l => l.trim())) {
	const { tool, args } = JSON.parse(line);
	const r = await s.tool(chat, tool, args ?? {});
	console.log(`\n>>> ${tool} ${JSON.stringify(args ?? {})}\n[${r.isError ? 'ERROR' : 'ok'} ${r.ms.toFixed(0)} ms, ${r.tokens} tok]\n${r.text}`);
}
s.close(); process.exit(0);
