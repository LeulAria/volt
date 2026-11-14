// Variants of the captured Volt lead final request (diag run 2), to find what makes its last turn think longer.
import { readFileSync, writeFileSync } from 'fs';
const base = JSON.parse(readFileSync('volt-final.json', 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base));
const results = m => (Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'tool_result');
const v = {};
v.a0 = clone();
// a1: Q4's report as decisive as Claude Code's Q4 subagent's.
v.a1 = clone();
for (const m of v.a1.messages) for (const p of results(m)) for (const c of p.content) if (c.text?.includes('Q4: The Q1')) {
	c.text = c.text.replace(/report:\n[\s\S]*$/, 'report:\ncheckout returns -9000 cents (a negative total). reserve(\'A1\', 1) succeeds (A1 has 3 units). The 10 reaches applyDiscount(1000, 10), and the Q1 bug gives 1000 * (1 - 10) = -9000. Assumes checkout returns the discounted total with no tax.');
}
// a2: no [Volt] rule lines and no <volt_workspace> in the first user message.
v.a2 = clone();
v.a2.messages[0].content = v.a2.messages[0].content.map(p => p.text?.startsWith('[Volt]') ? { ...p, text: '' } : p).filter(p => p.text !== '');
// a3: tool results carry only the report text (no task_id/title/model/status/role/spent header lines).
v.a3 = clone();
for (const m of v.a3.messages) for (const p of results(m)) for (const c of p.content) if (c.text?.includes('report:\n')) {
	c.text = c.text.split(/\n\n(?=task_id: )/).map(part => part.includes('report:\n') ? part.slice(part.indexOf('report:\n') + 8) : part).join('\n\n');
}
for (const [k, b] of Object.entries(v)) writeFileSync(`v-${k}.json`, JSON.stringify(b));
console.log(Object.keys(v));
