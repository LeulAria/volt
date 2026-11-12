// Copies A/B answers into blind files for scoring: node blind.mjs <abDir> <tag> <outDir>
// Writes <outDir>/<id>.md (question id + answer only) and <outDir>/key.json (id -> arm, question, run).
import fs from 'node:fs';
import crypto from 'node:crypto';

const [abDir, tag, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const key = {};
for (const arm of ['arm1', 'arm2']) {
	for (const file of fs.readdirSync(`${abDir}/${arm}`).filter(f => f.endsWith('.answer.md') && f.includes(`-${tag}-`))) {
		const [, q, run] = /^(Q\d+)-.*-r(\d+)\.answer\.md$/.exec(file) ?? [];
		const id = crypto.randomBytes(4).toString('hex');
		key[id] = { arm, q, run: Number(run), file: `${arm}/${file}` };
		fs.writeFileSync(`${outDir}/${id}.md`, `# ${q}\n\n${fs.readFileSync(`${abDir}/${arm}/${file}`, 'utf8')}`);
	}
}
fs.writeFileSync(`${outDir}/key.json`, JSON.stringify(key, null, 1));
console.log(Object.keys(key).length, 'answers');
