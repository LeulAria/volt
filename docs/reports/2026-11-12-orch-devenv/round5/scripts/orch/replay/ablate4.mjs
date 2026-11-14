// On top of b6 (no primer files): c1 = + decisive Q4 report (as a1), c2 = + tool results without task headers (as a3).
import { readFileSync, writeFileSync } from 'fs';
const b6 = JSON.parse(readFileSync('v-b6.json', 'utf8'));
const a1 = JSON.parse(readFileSync('v-a1.json', 'utf8'));
const a3 = JSON.parse(readFileSync('v-a3.json', 'utf8'));
const c1 = JSON.parse(JSON.stringify(a1)); c1.messages[0] = b6.messages[0];
const c2 = JSON.parse(JSON.stringify(a3)); c2.messages[0] = b6.messages[0];
writeFileSync('v-c1.json', JSON.stringify(c1));
writeFileSync('v-c2.json', JSON.stringify(c2));
