// One [Volt] part of the lead's first user message dropped at a time.
import { readFileSync, writeFileSync } from 'fs';
const base = JSON.parse(readFileSync('volt-final.json', 'utf8'));
const first = base.messages[0].content;
const idx = first.findIndex(p => p.text?.startsWith('[Volt]'));
const text = first[idx].text;
const [rules, ws] = text.split(/\n\n(?=<volt_workspace)/);
const lines = rules.split('\n');
const variants = {
	b1: lines.filter(l => !l.startsWith('[Volt] Deliver')).join('\n') + '\n\n' + ws,
	b2: lines.filter(l => !l.startsWith('[Volt] Small, clear UI')).join('\n') + '\n\n' + ws,
	b3: lines.filter(l => !l.startsWith('[Volt] When you end your turn')).join('\n') + '\n\n' + ws,
	b4: lines.filter(l => !l.startsWith('[Volt] Keep project')).join('\n') + '\n\n' + ws,
	b5: rules,
};
for (const [k, t] of Object.entries(variants)) {
	const b = JSON.parse(JSON.stringify(base));
	b.messages[0].content[idx].text = t;
	writeFileSync(`v-${k}.json`, JSON.stringify(b));
}
console.log(lines.map(l => l.slice(0, 40)), !!ws);
