// Scoring for the cross-harness bench. Ground truth (written before any run):
//
// T1 (fixture /tmp/v3orch/w/t1 = /tmp/voltbench/fx):
//   Q1  applyDiscount in pricing.ts uses pct as a fraction; fix: Math.round(cents * (1 - pct / 100)).
//   Q2  cart.ts -> pricing.ts: LineItem, subtotal, applyDiscount, tax;
//       checkout.ts -> cart.ts: Cart; checkout.ts -> inventory.ts: reserve. (pricing.ts and inventory.ts import nothing.)
//   Q3  in stock: A1 (3) and C3 (12); B2 is not (0). reserve('A1', 3) returns true, then false.
//   Q4  1000 cents, 10% discount: applyDiscount(1000, 10) = round(1000 * -9) = -9000, tax(-9000) = -720,
//       so checkout returns -9720 (the correct value would be 972). -9000 with the right cause = half a point.
// T2: tests green (7/7), only src/pricing.ts, src/inventory.ts, src/checkout.ts changed.
// T3: hidden check /tmp/v3orch/check-t3.mjs (7 cases; the first 5 are the planted formatCents issue:
//     no zero padding of cents, wrong sign handling), only src/money.ts changed.
import { execSync } from 'child_process';

export function scoreT1(text = '') {
	const t = text.replace(/\*\*/g, '').replace(/`/g, '');
	const q1 = /applyDiscount/.test(t) && /pct\s*\/\s*100|pct\s*\*\s*0?\.01|\/\s*100/.test(t);
	const edges = [
		/cart(\.ts)?\s*(->|→|imports?)[^\n]*pricing/i.test(t) && /LineItem/.test(t) && /subtotal/.test(t) && /applyDiscount/.test(t) && /\btax\b/.test(t),
		/checkout(\.ts)?\s*(->|→|imports?)[^\n]*cart/i.test(t) && /\bCart\b/.test(t),
		/checkout(\.ts)?\s*(->|→|imports?)[^\n]*inventory/i.test(t) && /reserve/.test(t),
	];
	const q2 = edges.filter(Boolean).length / 3;
	const q3 = /A1/.test(t) && /C3/.test(t) && /\btrue\b/i.test(t) && /\bfalse\b/i.test(t);
	const q4 = /-\s?\$?9,?720|−\s?\$?9,?720|-97\.20|−97\.20/.test(t) ? 1 : (/-\s?\$?9,?000|−\s?\$?9,?000|-90\.00/.test(t) ? 0.5 : 0);
	return { q1: q1 ? 1 : 0, q2: Math.round(q2 * 100) / 100, q3: q3 ? 1 : 0, q4, score: Math.round(((q1 ? 1 : 0) + q2 + (q3 ? 1 : 0) + q4) * 100) / 100 };
}

const sh = (cmd, cwd) => {
	try {
		return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (err) {
		return String(err.stdout ?? '') + String(err.stderr ?? '');
	}
};

const changedFiles = dir => sh('git status --porcelain', dir).split('\n').filter(Boolean).map(l => l.slice(3));

export function scoreT2(dir = '/tmp/v3orch/w/t2') {
	const out = sh('npm test 2>&1', dir);
	const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0);
	const fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 0);
	const changed = changedFiles(dir);
	const allowed = new Set(['src/pricing.ts', 'src/inventory.ts', 'src/checkout.ts']);
	const stray = changed.filter(f => !allowed.has(f));
	return { pass, fail, green: fail === 0 && pass === 7, changed, stray, diffLines: Number(/(\d+) insertion/.exec(sh('git diff --shortstat', dir))?.[1] ?? 0) };
}

export function scoreT3(dir = '/tmp/v3orch/w/t3') {
	let check;
	try {
		check = JSON.parse(sh(`node /tmp/v3orch/check-t3.mjs ${dir}`, dir).trim().split('\n').at(-1));
	} catch {
		check = { pass: 0, total: 7, plantedFixed: false, error: 'check failed to run' };
	}
	const changed = changedFiles(dir);
	const stray = changed.filter(f => f !== 'src/money.ts');
	return { ...check, changed, stray };
}

export function resetFixture(task) {
	if (task === 't0') {
		return;
	}
	const dir = `/tmp/v3orch/w/${task}`;
	execSync('git reset -q --hard && git clean -fdxq', { cwd: dir });
}
