// node probe.mjs launch <app> <profile> | tools <profile> | call <profile> <root> <tool> '<json args>' | stop <profile>
import { launch, waitWindow, server, stop, writeSettings, profile } from './lib.mjs';
const [cmd, a, b, c, d] = process.argv.slice(2);
if (cmd === 'launch') {
	writeSettings(b);
	const t = launch(a, b);
	await waitWindow();
	console.log(JSON.stringify({ pid: t.pid, ms: Date.now() - t.started, ud: profile(b).ud }));
} else if (cmd === 'tools') {
	const s = await server(a);
	const tools = await s.call('hostTools.listTools');
	for (const t of tools) { console.log(`${t.name}\t${t.group ?? ''}\t${JSON.stringify(t.inputSchema ?? t.schema ?? {}).length}\t${(t.description ?? '').length}`); }
	s.close();
} else if (cmd === 'call') {
	const s = await server(a);
	const chat = await s.chat(b);
	const r = await s.tool(chat, c, JSON.parse(d ?? '{}'));
	console.log(`[${r.isError ? 'ERROR' : 'ok'} ${r.ms.toFixed(0)} ms, ${r.tokens} tok]\n${r.text}`);
	s.close();
} else if (cmd === 'stop') {
	stop(a);
}
process.exit(0);
