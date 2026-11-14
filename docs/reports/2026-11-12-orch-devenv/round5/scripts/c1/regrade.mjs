// Grades a finished run's checkout again (own tests): node regrade.mjs <repo> <seed>. The W1 server test sends 62
// requests in a row and needs them inside ~2 s (refill 1/s), so a grade taken at very high load can fail it.
import { grade } from './grade.mjs';
const [repo, seed] = process.argv.slice(2);
const t = Date.now(); const g = grade(repo, seed);
console.log(JSON.stringify({ groups: g.groups, shipped: g.shipped, handoff: g.handoff, npm: g.npmTest.status, failed: Object.fromEntries(Object.entries(g.files).filter(([,f]) => !f.pass).map(([k,f]) => [k, (f.tail||'').slice(0,160)])), ms: Date.now() - t }));
