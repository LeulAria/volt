// b6: the lead's first user message without the "[Volt] Project files, read just now" block (all else kept).
import { readFileSync, writeFileSync } from 'fs';
const base = JSON.parse(readFileSync('volt-final.json', 'utf8'));
const first = base.messages[0].content;
const idx = first.findIndex(p => p.text?.startsWith('[Volt]'));
const b = JSON.parse(JSON.stringify(base));
b.messages[0].content[idx].text = first[idx].text.replace(/\n\[Volt\] Project files, read just now[\s\S]*?<\/file>(?=\n\n<volt_workspace)/, '');
if (b.messages[0].content[idx].text === first[idx].text) { throw new Error('no block'); }
writeFileSync('v-b6.json', JSON.stringify(b));
console.log(b.messages[0].content[idx].text.slice(-700));
