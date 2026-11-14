// The Q4 subagent's request (diag run 2, after the report-form fix), with parts of its prompt dropped.
import { readFileSync, writeFileSync } from 'fs';
const base = JSON.parse(readFileSync('q4-child.json', 'utf8'));
const mk = (name, edit) => { const b = JSON.parse(JSON.stringify(base)); edit(b.messages[0].content); writeFileSync(`v-${name}.json`, JSON.stringify(b)); };
mk('q0', () => { });
// q1: no <parent_context> digest of the delegating chat.
mk('q1', c => { c[2].text = c[2].text.replace(/\n<parent_context[\s\S]*?<\/parent_context>\n/, '\n'); });
// q2: no harness lines ([Volt] answer/code-intelligence/deferred/mode/exploration) and no <volt_context>.
mk('q2', c => { c[1].text = ''; });
// q3: both.
mk('q3', c => { c[2].text = c[2].text.replace(/\n<parent_context[\s\S]*?<\/parent_context>\n/, '\n'); c[1].text = ''; });
for (const n of ['q1', 'q2']) { const b = JSON.parse(readFileSync(`v-${n}.json`, 'utf8')); console.log(n, b.messages[0].content.map(p => p.text.length)); }
