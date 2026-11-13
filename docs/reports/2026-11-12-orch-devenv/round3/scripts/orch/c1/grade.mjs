// C1-style grader with OUR OWN tests (ADEMark's hidden tests are not public: only their SHA-256).
// Follows TESTS.md section 4's grading steps: copy the repository state at the end (main), restore the
// pristine test/ folder from the arena, add the hidden tests, run them with TZ=UTC, record each group.
//   node grade.mjs <repo> [--out file.json]
// Groups: W1 (limiter + api), W2 (dates), W3 (cursor), W4 (create + idempotency), Integration (the
// integration file and the whole `npm test` on main). Handoff: codes in REPORT.md and atop each module.
import { execFileSync, spawnSync } from 'child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const ARENA = '/tmp/ademark/arena';
export const CODES = { W1: 'ADM-W1-7NOIVE', W2: 'ADM-W2-57JYD2', W3: 'ADM-W3-3J3ROC', W4: 'ADM-W4-BYA2FU' };
const MODULES = { W1: 'src/rate-limiter.ts', W2: 'src/dates.ts', W3: 'src/paginate.ts', W4: 'src/idempotency.ts' };
const GROUPS = { W1: ['w1-limiter', 'w1-api'], W2: ['w2-dates'], W3: ['w3-cursor'], W4: ['w4-create', 'w4-idempotency'], Integration: ['integration'] };

export function grade(repo) {
	const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
	const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
	const work = mkdtempSync(join(tmpdir(), 'c1-grade-'));
	try {
		if (branch === 'main') {
			// The checkout on main: its state at the end, uncommitted changes included.
			cpSync(repo, work, { recursive: true, filter: src => !src.includes('/.git/') && !src.endsWith('/.git') && !src.includes('/node_modules/') });
		} else {
			execFileSync('sh', ['-c', `git -C "${repo}" archive main | tar -x -C "${work}"`]);
		}
		// Pristine test/ (agents may not change it) plus the hidden tests; new test files of theirs stay.
		for (const name of readdirSync(join(ARENA, 'test'))) {
			cpSync(join(ARENA, 'test', name), join(work, 'test', name));
		}
		for (const name of readdirSync(join(here, 'tests'))) {
			cpSync(join(here, 'tests', name), join(work, 'test', `hidden-${name}`));
		}
		const env = { ...process.env, TZ: 'UTC' };
		const files = {};
		for (const name of Object.values(GROUPS).flat()) {
			const r = spawnSync(process.execPath, ['--test', `test/hidden-${name}.test.ts`], { cwd: work, env, encoding: 'utf8', timeout: 120_000 });
			const failed = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]);
			files[name] = { pass: r.status === 0, failed, tail: r.status === 0 ? undefined : (r.stdout + r.stderr).split('\n').filter(l => /not ok|Error|expected|actual/.test(l)).slice(0, 12).join('\n') };
		}
		const full = spawnSync('npm', ['test', '--silent'], { cwd: work, env, encoding: 'utf8', timeout: 300_000 });
		const groups = {};
		for (const [group, names] of Object.entries(GROUPS)) {
			groups[group] = names.every(name => files[name].pass) && (group !== 'Integration' || full.status === 0);
		}
		const report = existsSync(join(work, 'REPORT.md')) ? readFileSync(join(work, 'REPORT.md'), 'utf8') : '';
		const handoff = {};
		for (const [w, code] of Object.entries(CODES)) {
			const line = report.split('\n').find(l => new RegExp(`^\\s*${w}\\s*\\|`).test(l)) ?? '';
			const module = existsSync(join(work, MODULES[w])) ? readFileSync(join(work, MODULES[w]), 'utf8').split('\n')[0].trim() : '';
			handoff[w] = line.includes(code) && module === `// handoff: ${code}`;
		}
		return {
			branch,
			shipped: ['W1', 'W2', 'W3', 'W4', 'Integration'].filter(g => groups[g]).length,
			groups,
			handoff: Object.values(handoff).filter(Boolean).length,
			handoffDetail: handoff,
			npmTest: { status: full.status, summary: (full.stdout ?? '').split('\n').filter(l => /^# (tests|pass|fail)/.test(l)).join(' ') },
			files,
			report: report.trim().slice(0, 600),
		};
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const repo = process.argv[2];
	const result = grade(repo);
	const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined;
	if (out) {
		writeFileSync(out, JSON.stringify(result, null, 1));
	}
	console.log(JSON.stringify({ shipped: `${result.shipped}/5`, groups: result.groups, handoff: `${result.handoff}/4`, npmTest: result.npmTest }, null, 1));
}
