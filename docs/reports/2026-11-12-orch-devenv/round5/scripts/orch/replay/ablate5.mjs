// On top of b6: e1 = no "# Working in Volt" system append; e2 = no "## volt" MCP server instructions.
import { readFileSync, writeFileSync } from 'fs';
const b6 = JSON.parse(readFileSync('v-b6.json', 'utf8'));
const e1 = JSON.parse(JSON.stringify(b6));
const s = e1.system.at(-1); s.text = s.text.slice(0, s.text.indexOf('# Working in Volt'));
writeFileSync('v-e1.json', JSON.stringify(e1));
const e2 = JSON.parse(JSON.stringify(b6));
const sm = e2.messages.find(m => m.role === 'system');
for (const p of sm.content) { if (p.text?.includes('## volt\n')) { p.text = p.text.replace(/## volt\n[^\n]*\n/, ''); } }
writeFileSync('v-e2.json', JSON.stringify(e2));
console.log(JSON.stringify(e2).length, JSON.stringify(b6).length, JSON.stringify(e1).length);
