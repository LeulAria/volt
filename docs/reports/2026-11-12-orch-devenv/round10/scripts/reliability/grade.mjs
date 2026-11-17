// Grades a C2/C4/C5/C6 run the way TESTS.md section 4 says, with OUR OWN tests (ADEMark's hidden tests are private):
// copy the repository state at the end, restore the pristine test/ folder, add the hidden tests, run each group
// with TZ=UTC.   node grade.mjs <repo> C2|W3 [--out file.json]
import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
export const ADEMARK = process.env.ADEMARK ?? join(process.env.HOME, '.volt-r4/ademark');
/** Group -> test file and the test-name prefix that belongs to the group. */
const GROUPS = {
	C2: { 'W1-limiter': ['w1-limiter', 'W1-limiter'], 'W1-api': ['c2-api', 'W1-api'], 'C2-F1': ['c2-followups', 'C2-F1'], 'C2-F2': ['c2-followups', 'C2-F2'], 'C2-F3': ['c2-followups', 'C2-F3'] },
	W3: { 'W3-cursor': ['w3-cursor', 'W3-cursor'] },
};

export function grade(repo, task) {
	const work = mkdtempSync(join(tmpdir(), 'r10-grade-'));
	try {
		cpSync(repo, work, { recursive: true, filter: src => !src.includes('/.git/') && !src.endsWith('/.git') && !src.includes('/node_modules/') && !src.includes('/.claude/') });
		for (const name of readdirSync(join(ADEMARK, 'arena', 'test'))) {
			cpSync(join(ADEMARK, 'arena', 'test', name), join(work, 'test', name));
		}
		for (const name of readdirSync(join(here, 'tests'))) {
			cpSync(join(here, 'tests', name), join(work, 'test', `hidden-${name}`));
		}
		const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8', TZ: 'UTC' };
		const groups = {};
		const detail = {};
		for (const [group, [file, prefix]] of Object.entries(GROUPS[task])) {
			const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${prefix}`, `test/hidden-${file}.test.ts`], { cwd: work, env, encoding: 'utf8', timeout: 120_000 });
			const ok = [...(r.stdout ?? '').matchAll(/^ok \d+ - (.+)$/gm)].map(m => m[1]).filter(n => n.startsWith(prefix));
			const failed = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
			groups[group] = r.status === 0 && ok.length > 0 && failed.length === 0;
			detail[group] = { passed: ok.length, failed, tail: groups[group] ? undefined : (r.stdout + r.stderr).split('\n').filter(l => /not ok|Error|expected|actual|Cannot find/.test(l)).slice(0, 8).join('\n') };
		}
		return { task, groups, detail, node: process.version };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [repo, task] = process.argv.slice(2);
	const result = grade(repo, task);
	const out = process.argv.indexOf('--out');
	if (out > 0) { writeFileSync(process.argv[out + 1], JSON.stringify(result, null, 1)); }
	console.log(JSON.stringify(result, null, 1));
}
