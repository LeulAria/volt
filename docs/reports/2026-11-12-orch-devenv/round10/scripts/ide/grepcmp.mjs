// Round 10 IDE bench: Volt's tools against grep and read alone, on 18 code questions (no model).
//   node grepcmp.mjs <app> <arm>
// Each question has two scripted plans: the Volt tool call(s) that answer it, and the fewest
// ripgrep / whole-file read steps that put the same facts in front of an agent (what Claude Code's
// Grep and Read return: `rg -n` output, and a file with line numbers). Counted per plan: steps
// (tool calls), tokens of the results (characters / 4), and whether the results hold every fact of
// the known answer. The grep plans are written by hand to be minimal; a real agent takes at least
// these steps, usually more. Model tokens for reasoning are not counted in either arm.
import { execFileSync, execSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { fixture, reset } from './cases.mjs';
import { HOME, launch, profile, server, sleep, stop, tokens, waitWindow, writeSettings } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [app, arm] = process.argv.slice(2);
const fx = join(HOME, 'fx');
execSync(`${join(here, 'setup.sh')} ${HOME}`);

// A path is always given (rg reads stdin otherwise when it is not a terminal); output paths are made root-relative as Grep shows them.
const rg = (root, args) => {
	const withPath = args.some(arg => arg === 'src' || arg === 'pricing') ? args : [...args, '.'];
	let out;
	try { out = execFileSync('rg', ['-n', '--no-heading', ...withPath], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (err) { out = err.stdout || ''; }
	return out.replace(/^\.\//gm, '');
};
const read = (root, file) => readFileSync(join(root, file), 'utf8').split('\n').map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join('\n');
const sh = (root, cmd) => { try { return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { return `${err.stdout ?? ''}${err.stderr ?? ''}`; } };

function questions() {
	const ts = fixture('ts', fx), py = fixture('py', fx), go = fixture('go', fx);
	const f = ts.n.files, p = py.n.files, g = go.n.files;
	const at = (fix, spec) => `${fix.n.files[spec[0]]}:${fix.line(spec)}`;
	// `facts`: strings the results must contain, per arm where the formats differ (path:line for tools, path and line for grep).
	const lines = (fix, specs) => specs.map(spec => ({ file: fix.n.files[spec[0]], line: fix.line(spec) }));
	return [
		{ id: 'Q1', lang: 'ts', q: 'Where is computeTax defined?', want: lines(ts, [ts.n.decl.computeTax]), tools: [['find_symbol', { name: 'computeTax' }]], grep: r => [rg(r, ['function computeTax'])] },
		{ id: 'Q2', lang: 'ts', q: 'Every reference to lineTotal', want: lines(ts, ts.n.lineTotalRefs), tools: [['code_nav', { op: 'references', symbol: 'lineTotal' }]], grep: r => [rg(r, ['-w', 'lineTotal'])] },
		{ id: 'Q3', lang: 'ts', q: 'What implements PriceRule?', want: lines(ts, ts.n.implementations.map(key => ts.n.decl[key])), tools: [['code_nav', { op: 'implementations', symbol: 'PriceRule' }]], grep: r => [rg(r, ['implements PriceRule|: PriceRule = ']), rg(r, ['extends BaseRule'])] },
		{ id: 'Q4', lang: 'ts', q: 'Which functions call roundCents?', names: ['computeTax', 'checkout', 'quote', 'summarize'], tools: [['code_nav', { op: 'callers', symbol: 'roundCents' }]], grep: r => [rg(r, ['-w', 'roundCents']), read(r, f.tax), read(r, f.checkout), read(r, f.report)] },
		{ id: 'Q5', lang: 'ts', q: 'Which entry points reach applyRules?', names: ['checkout', 'quote', 'handleCheckout', 'handleQuote', 'main'], tools: [['code_nav', { op: 'callers', symbol: 'applyRules', depth: 3 }]], grep: r => [rg(r, ['-w', 'applyRules']), read(r, f.checkout), rg(r, ['-w', 'checkout|quote', 'src']), read(r, f.handlers), rg(r, ['-w', 'handleCheckout|handleQuote']), read(r, f.main)] },
		{ id: 'Q6', lang: 'ts', q: 'Signature of computeTax', names: ['amount: number, region: Region', 'number'], tools: [['code_nav', { op: 'hover', symbol: 'computeTax' }]], grep: r => [rg(r, ['function computeTax'])] },
		{ id: 'Q7', lang: 'ts', q: 'Show the checkout function', names: ['const discounted = applyRules(cart, rules);', 'total: roundCents(discounted + tax)'], tools: [['code_nav', { op: 'body', symbol: 'checkout', path: f.checkout }]], grep: r => [rg(r, ['function checkout']), read(r, f.checkout)] },
		{ id: 'Q8', lang: 'ts', q: 'What does changing roundCents affect, and which tests cover it?', names: [f.tax, f.checkout, f.report, f.test], tools: [['code_nav', { op: 'impact', symbol: 'roundCents' }]], grep: r => [rg(r, ['-w', 'roundCents']), rg(r, ["from '.*/(tax|checkout|report)\\.ts'"])] },
		{ id: 'Q9', lang: 'ts', q: 'Outline of src/cart.ts', names: ['CartItem', 'lineTotal', 'Cart', 'subtotal', 'count'], tools: [['code_nav', { op: 'symbols', path: f.cart }]], grep: r => [read(r, f.cart)] },
		{ id: 'Q10', lang: 'ts', q: 'Does src/refund.ts type-check?', names: ['computeTax', '2304'], tools: [['diagnostics', { paths: [f.refund] }]], grep: r => [sh(r, `${join(here, '../../../../../../node_modules/.bin/tsc')} --noEmit -p .`)] },
		{ id: 'Q11', lang: 'ts', q: 'Rename lineTotal to lineAmount everywhere', edit: true, names: [f.cart, f.main, f.report, f.test], tools: [['code_action', { op: 'rename', path: f.cart, symbol: 'lineTotal', new_name: 'lineAmount' }]], grep: r => [rg(r, ['-w', 'lineTotal']), ...[f.cart, f.main, f.report, f.test].flatMap(file => [read(r, file), `The file ${join(r, file)} has been updated.`])] },
		{ id: 'Q12', lang: 'ts', q: 'Every call roundCents(x), also across lines', want: lines(ts, ts.n.structuralHits), tools: [['code_nav', { op: 'structural', pattern: 'roundCents($X)' }]], grep: r => [rg(r, ['roundCents\\('])] },
		{ id: 'Q13', lang: 'py', q: 'Every reference to line_total', want: lines(py, py.n.lineTotalRefs), tools: [['code_nav', { op: 'references', symbol: 'line_total' }]], grep: r => [rg(r, ['-w', 'line_total'])] },
		{ id: 'Q14', lang: 'py', q: 'Which functions call round_cents?', names: ['compute_tax', 'checkout', 'quote', 'summarize'], tools: [['code_nav', { op: 'callers', symbol: 'round_cents' }]], grep: r => [rg(r, ['-w', 'round_cents']), read(r, p.tax), read(r, p.checkout), read(r, p.report)] },
		{ id: 'Q15', lang: 'py', q: 'Which classes are PriceRules?', want: lines(py, py.n.implementations.map(key => py.n.decl[key])), tools: [['code_nav', { op: 'implementations', symbol: 'PriceRule' }]], grep: r => [rg(r, ['class \\w+\\(.*PriceRule']), rg(r, ['class \\w+\\(.*BaseRule'])] },
		{ id: 'Q16', lang: 'go', q: 'Which types implement PriceRule?', want: lines(go, go.n.implementations.map(key => go.n.decl[key])), tools: [['code_nav', { op: 'implementations', symbol: 'PriceRule' }]], grep: r => [read(r, g.rule), rg(r, ['func \\(.*\\) (Apply|Name)\\(']), rg(r, ['^type \\w+ struct', '-A3', 'pricing'])] },
		{ id: 'Q17', lang: 'go', q: 'Which functions call RoundCents?', names: ['ComputeTax', 'Checkout', 'Quote', 'Summarize'], tools: [['code_nav', { op: 'callers', symbol: 'RoundCents' }]], grep: r => [rg(r, ['-w', 'RoundCents']), read(r, g.tax), read(r, g.checkout), read(r, g.report)] },
		{ id: 'Q18', lang: 'go', q: 'Every real use of LineTotal (not comments or strings)', want: lines(go, go.n.lineTotalRefs), tools: [['code_nav', { op: 'references', symbol: 'LineTotal' }]], grep: r => [rg(r, ['-w', 'LineTotal'])] },
	];
	void at;
}

/** Whether results hold the known answer: every path with its line (in either `path:line` or grouped form), or every name. */
function holds(question, text) {
	if (question.names) { return question.names.filter(name => !text.includes(name)); }
	return question.want.filter(({ file, line }) => !(text.includes(`${file}:${line}`) || new RegExp(`${file.replace(/[.]/g, '\\.')}:\\n(?:[ \\t]+\\d+[^\\n]*\\n)*?[ \\t]+${line}\\b`).test(text + '\n'))).map(({ file, line }) => `${file}:${line}`);
}
/** Lines the results name that are not in the known answer (look-alikes an agent has to rule out). */
function extras(question, text) {
	if (!question.want) { return 0; }
	const want = new Set(question.want.map(({ file, line }) => `${file}:${line}`));
	const got = new Set();
	let file;
	for (const row of text.split('\n')) {
		const head = /^(\S+\.[a-z]+):$/.exec(row);
		if (head) { file = head[1]; continue; }
		const grouped = /^\s+(\d+)[:\s-]/.exec(row);
		if (grouped && file) { got.add(`${file}:${grouped[1]}`); continue; }
		const flat = /^([\w./-]+\.[a-z]+):(\d+)[:\s]/.exec(row);
		if (flat) { got.add(`${flat[1]}:${flat[2]}`); }
	}
	return [...got].filter(item => !want.has(item)).length;
}

stop(arm);
rmSync(profile(arm).ud, { recursive: true, force: true });
writeSettings(arm);
launch(app, arm);
await waitWindow();
const s = await server(arm);
await s.toolsReady();
const chats = {};
const rows = [];
for (const question of questions()) {
	const root = join(fx, question.lang);
	chats[question.lang] ??= await s.chat(root, { level: 'workspace-write', network: true });
	// Warm, as in bench.mjs: the comparison is of answers and tokens, not of a cold start.
	if (!chats[question.lang].warm) {
		for (let i = 0; i < 40; i++) {
			const probe = await s.tool(chats[question.lang], 'find_symbol', { name: fixture(question.lang, fx).n.computeTax });
			const ready = !probe.isError && probe.text.includes(':') && (question.lang !== 'ts' || !/code index/.test((await s.tool(chats.ts, 'code_nav', { op: 'references', symbol: 'lineTotal' })).text));
			if (ready) { break; }
			await sleep(500);
		}
		chats[question.lang].warm = true;
	}
	const toolResults = [];
	for (const [tool, args] of question.tools) { toolResults.push((await s.tool(chats[question.lang], tool, args)).text); }
	if (question.edit) { reset(root); }
	const grepResults = question.grep(root);
	const one = results => ({ steps: results.length, tokens: results.reduce((sum, text) => sum + tokens(text), 0), missing: holds(question, results.join('\n')), extra: extras(question, results.join('\n')) });
	const row = { id: question.id, lang: question.lang, q: question.q, tools: { calls: question.tools.map(([tool, args]) => `${tool} ${args.op ?? ''}`.trim()), ...one(toolResults) }, grep: one(grepResults) };
	rows.push(row);
	console.log(`${row.id}\t${row.lang}\t${row.q}\ttools ${row.tools.steps} step, ${row.tools.tokens} tok, missing ${row.tools.missing.length}, extra ${row.tools.extra}\tgrep ${row.grep.steps} steps, ${row.grep.tokens} tok, missing ${row.grep.missing.length}, extra ${row.grep.extra}`);
}
const sum = key => rows.reduce((total, row) => total + row[key].tokens, 0);
const steps = key => rows.reduce((total, row) => total + row[key].steps, 0);
console.log(`total\ttools ${steps('tools')} steps, ${sum('tools')} tok\tgrep ${steps('grep')} steps, ${sum('grep')} tok`);
mkdirSync(join(HOME, 'out'), { recursive: true });
writeFileSync(join(HOME, 'out', `grepcmp-${arm}.json`), JSON.stringify({ arm, app, at: new Date().toISOString(), rows, totals: { tools: { steps: steps('tools'), tokens: sum('tools') }, grep: { steps: steps('grep'), tokens: sum('grep') } } }, null, 1));
s.close();
stop(arm);
process.exit(0);
