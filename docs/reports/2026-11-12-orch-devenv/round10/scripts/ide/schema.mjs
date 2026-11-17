// node schema.mjs <profile> <tool>...   prints each tool's description and input schema
import { server } from './lib.mjs';
const [name, ...want] = process.argv.slice(2);
const s = await server(name);
const tools = await s.call('hostTools.listTools');
for (const t of tools.filter(t => !want.length || want.includes(t.name))) {
	console.log(`## ${t.name}\n${t.description}\n${JSON.stringify(t.inputSchema ?? t.schema)}\n`);
}
s.close(); process.exit(0);
