// Round 10 IDE bench: the cases and their known answers, per language.
// Known answers are written here by hand as "this declaration / this use", named by a piece of the
// fixture's own text (an anchor), so a line number is never copied from a tool's output. The only
// answers computed from the fixture are plain text searches (instant_grep).
import { execSync } from 'child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const NAMES = {
	ts: {
		files: { cart: 'src/cart.ts', tax: 'src/tax.ts', checkout: 'src/checkout.ts', handlers: 'src/api/handlers.ts', main: 'src/index.ts', report: 'src/report.ts', refund: 'src/refund.ts', rule: 'src/pricing/rule.ts', base: 'src/pricing/base.ts', percent: 'src/pricing/percentOff.ts', bulk: 'src/pricing/bulkDiscount.ts', free: 'src/pricing/freeShipping.ts', test: 'test/checkout.test.ts' },
		lineTotal: 'lineTotal', renamed: 'lineAmount', computeTax: 'computeTax', roundCents: 'roundCents', applyRules: 'applyRules', checkout: 'checkout', quote: 'quote',
		handleCheckout: 'handleCheckout', handleQuote: 'handleQuote', main: 'main', summarize: 'summarize', refundTax: 'refundTax', subtotal: 'subtotal', free: 'freeShipping',
		decl: { lineTotal: ['cart', 'export function lineTotal'], computeTax: ['tax', 'export function computeTax'], roundCents: ['tax', 'export function roundCents'], checkout: ['checkout', 'export function checkout'], checkoutEnd: ['checkout', '^}', 3], PriceRule: ['rule', 'export interface PriceRule'], BaseRule: ['base', 'export abstract class BaseRule'], PercentOff: ['percent', 'export class PercentOff'], BulkDiscount: ['bulk', 'export class BulkDiscount'], free: ['free', 'export const freeShipping'], CartItem: ['cart', 'export interface CartItem'], Cart: ['cart', 'export class Cart'], add: ['cart', 'add(item'], list: ['cart', 'list():'], subtotal: ['cart', 'subtotal():'], count: ['cart', 'count():'] },
		lineTotalRefs: [['cart', 'export function lineTotal'], ['cart', '+ lineTotal(item)'], ['main', 'export { Cart, lineTotal }'], ['report', 'import { lineTotal }'], ['test', 'import { Cart, lineTotal }'], ['test', 'assert.equal(lineTotal(']],
		renameFiles: ['cart', 'main', 'report', 'test'],
		implementations: ['BaseRule', 'PercentOff', 'BulkDiscount', 'free'],
		supertypes: { of: 'PercentOff', expect: ['BaseRule'] }, subtypes: { of: 'BaseRule', expect: ['PercentOff', 'BulkDiscount'], not: ['freeShipping'] },
		checkoutUse: ['checkout', 'const tax = computeTax('], refundLine: ['refund', 'return computeTax('],
		hover: /computeTax\(amount: number, region: Region\): number/,
		badLine: 'export const broken: number = \'x\';', badMessage: /not assignable|2322/,
		refundMessage: /Cannot find name 'computeTax'|2304/,
		structural: 'roundCents($X)', structuralHits: [['tax', 'return roundCents(amount'], ['checkout', 'subtotal: roundCents('], ['checkout', 'discounted: roundCents('], ['checkout', 'total: roundCents('], ['checkout', 'return roundCents(applyRules'], ['report', 'roundCents( cart.subtotal() )']],
		formatted: ['export function summarize(cart: Cart): string {', 'const total = roundCents(cart.subtotal())'],
		organized: { has: [/import \{ Cart \} from '\.\/cart\.ts';/, /import \{ roundCents \} from '\.\/tax\.ts';/], lacks: [/computeTax/, /lineTotal/] },
		fixTitle: /Add import from ["']\.\/tax(\.ts)?["']/, fixed: /import \{ computeTax \} from ['"]\.\/tax\.ts['"]/,
		failingTest: /checkout without tax/, testMessage: /\b10\b[\s\S]*\b11\b|\b11\b[\s\S]*\b10\b/,
	},
	py: {
		files: { cart: 'shop/cart.py', tax: 'shop/tax.py', checkout: 'shop/checkout.py', handlers: 'shop/api/handlers.py', main: 'shop/main.py', report: 'shop/report.py', refund: 'shop/refund.py', rule: 'shop/pricing/rule.py', base: 'shop/pricing/base.py', percent: 'shop/pricing/percent_off.py', bulk: 'shop/pricing/bulk_discount.py', free: 'shop/pricing/free_shipping.py', test: 'tests/test_checkout.py' },
		lineTotal: 'line_total', renamed: 'line_amount', computeTax: 'compute_tax', roundCents: 'round_cents', applyRules: 'apply_rules', checkout: 'checkout', quote: 'quote',
		handleCheckout: 'handle_checkout', handleQuote: 'handle_quote', main: 'main', summarize: 'summarize', refundTax: 'refund_tax', subtotal: 'subtotal', free: 'FreeShipping',
		decl: { lineTotal: ['cart', 'def line_total'], computeTax: ['tax', 'def compute_tax'], roundCents: ['tax', 'def round_cents'], checkout: ['checkout', 'def checkout'], checkoutEnd: ['checkout', '^    )', 1], PriceRule: ['rule', 'class PriceRule'], BaseRule: ['base', 'class BaseRule'], PercentOff: ['percent', 'class PercentOff'], BulkDiscount: ['bulk', 'class BulkDiscount'], free: ['free', 'class FreeShipping'], CartItem: ['cart', 'class CartItem'], Cart: ['cart', 'class Cart:'], add: ['cart', 'def add('], list: ['cart', 'def list('], subtotal: ['cart', 'def subtotal('], count: ['cart', 'def count('] },
		lineTotalRefs: [['cart', 'def line_total'], ['cart', 'sum(line_total(item)'], ['report', 'import line_total'], ['test', 'import Cart, CartItem, line_total'], ['test', 'self.assertEqual(line_total(']],
		renameFiles: ['cart', 'report', 'test'],
		implementations: ['BaseRule', 'PercentOff', 'BulkDiscount', 'free'],
		supertypes: { of: 'PercentOff', expect: ['BaseRule'] }, subtypes: { of: 'BaseRule', expect: ['PercentOff', 'BulkDiscount'], not: ['FreeShipping'] },
		checkoutUse: ['checkout', 'tax = compute_tax('], refundLine: ['refund', 'return compute_tax('],
		hover: /compute_tax\(amount: float, region: str\) -> float/,
		badLine: 'broken: int = undefined_name', badMessage: /undefined_name/,
		refundMessage: /compute_tax/,
		structural: 'round_cents($X)', structuralHits: [['tax', 'return round_cents(amount'], ['checkout', 'subtotal=round_cents('], ['checkout', 'discounted=round_cents('], ['checkout', 'total=round_cents('], ['checkout', 'return round_cents(apply_rules'], ['report', 'round_cents( cart.subtotal() )']],
		formatted: ['def summarize(cart: Cart) -> str:', 'total = round_cents(cart.subtotal())'],
		organized: { has: [/from shop\.cart import Cart/, /from shop\.tax import round_cents$/m], lacks: [/compute_tax/, /line_total/] },
		fixTitle: /import.*compute_tax|compute_tax.*import/i, fixed: /from shop\.tax import compute_tax/,
		failingTest: /test_checkout_without_tax/, testMessage: /\b10\b[\s\S]*\b11\b|\b11\b[\s\S]*\b10\b/,
	},
	go: {
		files: { cart: 'cart/cart.go', tax: 'tax/tax.go', checkout: 'checkout/checkout.go', handlers: 'api/handlers.go', main: 'cmd/shop/main.go', report: 'api/report.go', refund: 'api/refund.go', rule: 'pricing/rule.go', base: 'pricing/base.go', percent: 'pricing/percent_off.go', bulk: 'pricing/bulk_discount.go', free: 'pricing/free_shipping.go', test: 'checkout/checkout_test.go' },
		lineTotal: 'LineTotal', renamed: 'LineAmount', computeTax: 'ComputeTax', roundCents: 'RoundCents', applyRules: 'ApplyRules', checkout: 'Checkout', quote: 'Quote',
		handleCheckout: 'HandleCheckout', handleQuote: 'HandleQuote', main: 'main', summarize: 'Summarize', refundTax: 'RefundTax', subtotal: 'Subtotal', free: 'FreeShipping',
		decl: { lineTotal: ['cart', 'func LineTotal'], computeTax: ['tax', 'func ComputeTax'], roundCents: ['tax', 'func RoundCents'], checkout: ['checkout', 'func Checkout'], checkoutEnd: ['checkout', '^}', 3], PriceRule: ['rule', 'type PriceRule interface'], BaseRule: ['base', 'type BaseRule struct'], PercentOff: ['percent', 'type PercentOff struct'], BulkDiscount: ['bulk', 'type BulkDiscount struct'], free: ['free', 'type FreeShipping struct'], CartItem: ['cart', 'type CartItem struct'], Cart: ['cart', 'type Cart struct'], add: ['cart', ') Add('], list: ['cart', ') List('], subtotal: ['cart', ') Subtotal('], count: ['cart', ') Count('] },
		lineTotalRefs: [['cart', 'func LineTotal'], ['cart', 'sum += LineTotal(item)'], ['test', 'cart.LineTotal(cart.CartItem']],
		renameFiles: ['cart', 'test'],
		implementations: ['PercentOff', 'BulkDiscount', 'free'],
		supertypes: { of: 'PercentOff', expect: ['PriceRule'] }, subtypes: { of: 'PriceRule', expect: ['PercentOff', 'BulkDiscount', 'FreeShipping'], not: [] },
		checkoutUse: ['checkout', 'taxed := tax.ComputeTax('], refundLine: ['refund', 'return tax.ComputeTax('],
		hover: /func ComputeTax\(amount float64, region string\) float64/,
		badLine: 'var broken int = "x"', badMessage: /cannot use|untyped string|int/,
		refundMessage: /undefined: tax|undeclared name: tax/,
		structural: 'tax.RoundCents($X)', structuralHits: [['checkout', 'Subtotal:   tax.RoundCents('], ['checkout', 'Discounted: tax.RoundCents('], ['checkout', 'Total:      tax.RoundCents('], ['checkout', 'return tax.RoundCents(ApplyRules'], ['report', 'tax.RoundCents( c.Subtotal() )']],
		formatted: ['func Summarize(c *cart.Cart) string {', '\ttotal := tax.RoundCents(c.Subtotal())', '\treturn fmt.Sprintf("items=%d total=%v", c.Count(), total)'],
		organized: undefined,
		fixTitle: /import.*tax/i, fixed: /"example\.com\/shop\/tax"/,
		failingTest: /TestCheckoutWithoutTax/, testMessage: /Total = 10, want 11/,
	},
};

/** What a result says when it knows it could not really answer (no language server, not checked). */
const DEGRADED = /no language server|language servers? (?:is|are) (?:off|not)|not type-checked|matched by name|no formatter|not checked|cannot check|no (?:call|type) hierarchy|offers rename|not covered|no test|run (?:it|them|those|the project's)[^.]* (?:in|with) (?:the )?shell|install /i;

const PRISTINE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixture(lang, fx) {
	const n = NAMES[lang];
	const root = join(fx, lang);
	// Anchors are read from the fixture as committed, never from the working copy a test edits.
	const src = file => readFileSync(join(PRISTINE, lang, n.files[file] ?? file), 'utf8');
	/** The 1-based line of the nth line containing `anchor` in a fixture file. */
	const line = ([file, anchor, nth = 1]) => {
		const lines = src(file).split('\n');
		let seen = 0;
		// `^text`: the whole line is `text`; else the line contains it.
		const hit = text => anchor.startsWith('^') ? text === anchor.slice(1) : text.includes(anchor);
		for (let i = 0; i < lines.length; i++) {
			if (hit(lines[i]) && ++seen === nth) { return i + 1; }
		}
		throw new Error(`anchor not found: ${lang} ${file} ${JSON.stringify(anchor)}`);
	};
	const loc = spec => `${n.files[spec[0]]}:${line(spec)}`;
	return { n, root, src, line, loc };
}

/** Every `path:line` a result names: flat `path:line` and grouped `path:` followed by `  line: text` rows. */
export function locations(text, root) {
	const found = new Set();
	let file;
	const rel = path => path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
	for (const raw of text.split('\n')) {
		const head = /^(\S+\.[A-Za-z]{1,4}):\s*$/.exec(raw.trim());
		if (head && !/^\s/.test(raw)) { file = rel(head[1]); continue; }
		const row = /^\s+(\d+)(?:-\d+)?(?::|\s|$)/.exec(raw);
		if (row && file) { found.add(`${file}:${row[1]}`); continue; }
		if (!/^\s/.test(raw)) { file = undefined; }
		for (const match of raw.matchAll(/([\w@./-]+\.[A-Za-z]{1,4}):(\d+)/g)) { found.add(`${rel(match[1])}:${match[2]}`); }
	}
	return found;
}

const word = name => new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);

function judge(result, correct, partial, detail = '') {
	if (correct) { return { status: 'correct', detail }; }
	if (result.isError) { return { status: DEGRADED.test(result.text) ? 'clear-error' : 'error', detail: detail || result.text.split('\n')[0].slice(0, 160) }; }
	if (partial) { return { status: 'partial', detail }; }
	return { status: DEGRADED.test(result.text) ? 'clear-none' : 'wrong', detail: detail || result.text.split('\n')[0].slice(0, 160) };
}

/** The result names exactly these places. */
function sameLocations(result, root, expected) {
	const got = locations(result.text, root);
	const want = new Set(expected);
	const missing = [...want].filter(item => !got.has(item));
	const extra = [...got].filter(item => !want.has(item));
	const outside = /(^|\s)\/(Users|private|tmp|var|home)\//.test(result.text);
	const detail = [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `extra ${extra.join(', ')}` : '', outside ? 'absolute paths' : ''].filter(Boolean).join('; ');
	return judge(result, !missing.length && !extra.length, got.size > 0 && missing.length < want.size, detail);
}

/** The result names all of these and none of those. */
function namesAll(result, expected, not = []) {
	const missing = expected.filter(name => !word(name).test(result.text));
	const extra = not.filter(name => word(name).test(result.text));
	const detail = [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `wrongly names ${extra.join(', ')}` : ''].filter(Boolean).join('; ');
	return judge(result, !missing.length && !extra.length, missing.length < expected.length && !result.isError && !/^No /.test(result.text), detail);
}

function textFiles(root, dir = '') {
	return readdirSync(join(root, dir)).flatMap(name => {
		if (name === '.git' || name === '__pycache__' || name === 'node_modules') { return []; }
		const path = dir ? `${dir}/${name}` : name;
		return statSync(join(root, path)).isDirectory() ? textFiles(root, path) : [path];
	});
}

const git = (root, args) => execSync(`git -C ${JSON.stringify(root)} ${args}`, { encoding: 'utf8' });
export const reset = root => { git(root, 'checkout -q .'); git(root, 'clean -fdq'); };

export function cases(lang, fx) {
	const { n, root, src, line, loc } = fixture(lang, fx);
	const f = n.files;
	const decl = name => loc(n.decl[name]);
	const read = file => readFileSync(join(root, f[file]), 'utf8');
	const callers = [n.computeTax, n.checkout, n.quote, n.summarize];
	const notCallers = [n.applyRules, n.handleCheckout, n.handleQuote, n.refundTax, n.lineTotal];
	const grepTruth = textFiles(root).flatMap(path => readFileSync(join(root, path), 'utf8').split('\n').flatMap((text, index) => text.includes(n.roundCents) ? [`${path}:${index + 1}`] : []));
	const badFile = join(root, f.tax);
	const list = [
		{
			id: 'definition', tool: 'code_nav', args: { op: 'definition', path: f.checkout, symbol: n.computeTax, line: line(n.checkoutUse) },
			check: r => sameLocations(r, root, [decl('computeTax')]),
		},
		{
			id: 'references', tool: 'code_nav', args: { op: 'references', symbol: n.lineTotal },
			check: r => sameLocations(r, root, n.lineTotalRefs.map(loc)),
		},
		{
			id: 'implementations', tool: 'code_nav', args: { op: 'implementations', symbol: 'PriceRule' },
			check: r => sameLocations(r, root, n.implementations.map(decl)),
		},
		{
			id: 'callers', tool: 'code_nav', args: { op: 'callers', symbol: n.roundCents },
			check: r => namesAll(r, callers, notCallers),
		},
		{
			id: 'callees', tool: 'code_nav', args: { op: 'callees', symbol: n.checkout, path: f.checkout },
			check: r => namesAll(r, [n.subtotal, n.applyRules, n.computeTax, n.roundCents], [n.quote, n.handleCheckout, n.summarize]),
		},
		{
			id: 'callers-depth3', tool: 'code_nav', args: { op: 'callers', symbol: n.applyRules, depth: 3 },
			check: r => namesAll(r, [n.checkout, n.quote, n.handleCheckout, n.handleQuote, n.main], [n.summarize, n.refundTax]),
		},
		{
			id: 'supertypes', tool: 'code_nav', args: { op: 'supertypes', symbol: n.supertypes.of },
			check: r => namesAll(r, n.supertypes.expect),
		},
		{
			id: 'subtypes', tool: 'code_nav', args: { op: 'subtypes', symbol: n.subtypes.of },
			check: r => namesAll(r, n.subtypes.expect, n.subtypes.not),
		},
		{
			id: 'hover', tool: 'code_nav', args: { op: 'hover', symbol: n.computeTax },
			check: r => judge(r, n.hover.test(r.text), false),
		},
		{
			id: 'outline', tool: 'code_nav', args: { op: 'symbols', path: f.cart },
			check: r => {
				const want = ['CartItem', 'lineTotal', 'Cart', 'add', 'list', 'subtotal', 'count'].map(key => ({ name: key === 'lineTotal' ? n.lineTotal : key === 'subtotal' ? n.subtotal : lang === 'go' && /^[a-z]/.test(key) ? key[0].toUpperCase() + key.slice(1) : key, start: line(n.decl[key]) }));
				const missing = want.filter(item => !new RegExp(`${item.name}\\b[^\\n]*\\[${item.start}[-\\]]`).test(r.text)).map(item => `${item.name}@${item.start}`);
				return judge(r, !missing.length, missing.length < want.length, missing.length ? `missing ${missing.join(', ')}` : '');
			},
		},
		{
			id: 'workspace-symbols', tool: 'code_nav', args: { op: 'workspace_symbols', query: 'PercentOff' },
			check: r => sameLocations(r, root, [decl('PercentOff')]),
		},
		{
			id: 'body', tool: 'code_nav', args: { op: 'body', symbol: n.checkout, path: f.checkout },
			check: r => judge(r, r.text.startsWith(`${f.checkout}:${line(n.decl.checkout)}-${line(n.decl.checkoutEnd)} `) && r.text.includes(src('checkout').split('\n')[line(n.decl.checkout)]), false),
		},
		{
			id: 'impact', tool: 'code_nav', args: { op: 'impact', symbol: n.roundCents },
			check: r => {
				const files = [f.tax, f.checkout, f.report].filter(file => !r.text.includes(file));
				const tests = /Tests to run \(\d+\)/.test(r.text) && r.text.slice(r.text.indexOf('Tests to run')).includes(f.test);
				const detail = [files.length ? `missing files ${files.join(', ')}` : '', tests ? '' : `tests to run lacks ${f.test}`].filter(Boolean).join('; ');
				return judge(r, !files.length && tests, !files.length || tests, detail);
			},
		},
		{
			id: 'structural', tool: 'code_nav', args: { op: 'structural', pattern: n.structural },
			check: r => sameLocations(r, root, n.structuralHits.map(loc)),
		},
		{
			id: 'find-symbol', tool: 'find_symbol', args: { name: n.computeTax },
			check: r => sameLocations(r, root, [decl('computeTax')]),
		},
		{
			id: 'grep', tool: 'instant_grep', args: { pattern: n.roundCents, case_sensitive: true },
			check: r => sameLocations(r, root, grepTruth),
		},
		{
			id: 'find-files', tool: 'find_files', args: { query: 'percent' },
			check: r => judge(r, r.text.trim().split('\n')[0].trim() === f.percent, r.text.includes(f.percent)),
		},
		{
			id: 'diagnostics-workspace', tool: 'diagnostics', args: {},
			check: r => {
				const at = `${f.refund}:${line(n.refundLine)}`;
				const others = [...locations(r.text, root)].filter(item => item !== at);
				return judge(r, r.text.includes(at) && n.refundMessage.test(r.text) && !others.length, r.text.includes(at), others.length ? `extra ${others.join(', ')}` : '');
			},
		},
		{
			id: 'diagnostics-file', tool: 'diagnostics', args: { paths: [f.refund] },
			check: r => judge(r, r.text.includes(`${f.refund}:${line(n.refundLine)}`) && n.refundMessage.test(r.text), false),
		},
		{
			id: 'diagnostics-after-edit', tool: 'diagnostics', args: { paths: [f.tax] }, kind: 'edit',
			// An agent's own Write tool changes the file on disk; the next diagnostics call must see it.
			prepare: () => writeFileSync(badFile, read('tax').replace(/\n*$/, '\n') + n.badLine + '\n'),
			check: r => {
				const at = `${f.tax}:${read('tax').replace(/\n*$/, '').split('\n').length}`;
				return judge(r, r.text.includes(at) && n.badMessage.test(r.text), false);
			},
		},
		{
			id: 'format', tool: 'code_action', args: { op: 'format', path: f.report }, kind: 'edit',
			check: r => {
				const after = read('report');
				const missing = n.formatted.filter(text => !after.split('\n').some(row => (text.startsWith('\t') ? row : row.trim()) === text));
				return judge(r, !missing.length && !r.isError, false, missing.length && !r.isError ? `file lacks ${JSON.stringify(missing[0])}` : '');
			},
		},
		...(n.organized ? [{
			id: 'organize-imports', tool: 'code_action', args: { op: 'organize_imports', path: f.report }, kind: 'edit',
			check: r => {
				const after = read('report');
				const ok = n.organized.has.every(re => re.test(after)) && n.organized.lacks.every(re => !re.test(after));
				return judge(r, ok && !r.isError, false);
			},
		}] : []),
		{
			id: 'quick-fixes', tool: 'code_action', args: { op: 'fixes', path: f.refund, line: line(n.refundLine) },
			check: r => judge(r, n.fixTitle.test(r.text), false),
		},
		{
			id: 'quick-fix-apply', tool: 'code_action', args: { op: 'fix', path: f.refund, line: line(n.refundLine), title: 'import' }, kind: 'edit',
			check: r => judge(r, n.fixed.test(read('refund')) && !r.isError, false),
		},
		{
			id: 'rename', tool: 'code_action', args: { op: 'rename', path: f.cart, symbol: n.lineTotal, new_name: n.renamed }, kind: 'edit',
			check: r => {
				const changed = git(root, 'status --short').split('\n').filter(Boolean).map(row => row.slice(3)).sort();
				const want = n.renameFiles.map(key => f[key]).sort();
				const stale = n.lineTotalRefs.filter(spec => lang !== 'ts' || spec[0] !== 'main').filter(spec => !word(n.renamed).test(read(spec[0]).split('\n')[line(spec) - 1]) || word(n.lineTotal).test(read(spec[0]).split('\n')[line(spec) - 1])).map(spec => `${f[spec[0]]}:${line(spec)}`);
				const sameFiles = JSON.stringify(changed) === JSON.stringify(want);
				return judge(r, sameFiles && !stale.length && !r.isError, changed.length > 0 && !r.isError, [sameFiles ? '' : `changed ${changed.join(', ') || 'nothing'}`, stale.length ? `not renamed at ${stale.join(', ')}` : ''].filter(Boolean).join('; '));
			},
		},
	];
	return { root, list, names: n };
}

/** Run, debug, terminal and git tools: one scripted use each, on the fixture that suits it. */
export function ideCases(lang, fx) {
	const { n, root, line } = fixture(lang, fx);
	const f = n.files;
	const out = [];
	out.push({
		id: 'tests-list', tool: 'tests', args: { op: 'list' },
		check: r => judge(r, n.failingTest.test(r.text), false),
	}, {
		id: 'tests-run', tool: 'tests', args: { op: 'run' }, reps: 3,
		check: r => judge(r, /2 passed, 1 failed/.test(r.text) && n.failingTest.test(r.text) && n.testMessage.test(r.text), n.failingTest.test(r.text)),
	});
	if (lang === 'ts') {
		out.push({
			id: 'tasks-list', tool: 'tasks', args: { op: 'list' },
			check: r => judge(r, /npm[:\s]+test|\btest\b/.test(r.text) && !/^No tasks/.test(r.text), false),
		}, {
			id: 'tasks-run', tool: 'tasks', args: { op: 'run', name: 'test', wait_ms: 60000 }, reps: 3,
			check: r => judge(r, /exit(?:ed)?(?: code)?[: ]+1\b/i.test(r.text) && /checkout without tax/.test(r.text), /checkout without tax/.test(r.text)),
		}, {
			id: 'debug-breakpoint', tool: 'debug', args: { op: 'start', program: 'scripts/tax-demo.mjs', breakpoints: ['scripts/tax-demo.mjs:3'] }, reps: 3,
			after: [{ tool: 'debug', args: { op: 'stop' } }],
			check: r => judge(r, /tax-demo\.mjs:3/.test(r.text) && /amount\D{1,6}90\b/.test(r.text) && /\btax\D{1,6}18\b/.test(r.text), /tax-demo\.mjs:3/.test(r.text)),
		}, {
			id: 'debug-evaluate', tool: 'debug', args: { op: 'evaluate', expression: 'amount * 2' }, reps: 3,
			before: [{ tool: 'debug', args: { op: 'start', program: 'scripts/tax-demo.mjs', breakpoints: ['scripts/tax-demo.mjs:3'] } }],
			after: [{ tool: 'debug', args: { op: 'stop' } }],
			check: r => judge(r, /\b180\b/.test(r.text), false),
		});
	}
	out.push({
		id: 'terminal-run', tool: 'terminal_start', args: { command: 'echo hello-$((6*7)); echo done', wait_ms: 5000 }, reps: 5,
		check: r => judge(r, /hello-42/.test(r.text) && /exited 0/.test(r.text), /hello-42/.test(r.text)),
	}, {
		id: 'terminal-interactive', tool: 'terminal_wait', reps: 3,
		// A prompt answered: start `read`, send the answer, wait for the echo.
		before: [{ tool: 'terminal_start', args: { command: 'read -r name; echo got-$name; sleep 30', wait_ms: 0 }, keep: 'id' }, { tool: 'terminal_send', args: { text: 'volt' }, useId: true }],
		argsFrom: id => ({ id, until: 'got-volt', timeout_ms: 10000 }),
		after: [{ tool: 'terminal_stop', args: {}, useId: true }],
		check: r => judge(r, /got-volt/.test(r.text), false),
	}, {
		id: 'git-status', tool: 'workspace_status', args: {}, kind: 'edit',
		prepare: () => writeFileSync(join(root, f.tax), readFileSync(join(root, f.tax), 'utf8') + '\n'),
		check: r => judge(r, new RegExp(`M\\s+${f.tax.replace(/[.]/g, '\\.')}`).test(r.text) && /on main/.test(r.text) && !new RegExp(f.cart.replace(/[.]/g, '\\.')).test(r.text), false),
	}, {
		id: 'git-worktree-status', tool: 'worktree_status', args: {},
		check: r => judge(r, /Branch: main/.test(r.text) && /No uncommitted changes/.test(r.text), /main/.test(r.text)),
	}, {
		id: 'git-rename-branch', tool: 'rename_branch', args: { name: 'feat/bench-rename' }, kind: 'edit',
		prepare: () => git(root, 'checkout -q -B volt/1a2b3c4d'),
		restore: () => { git(root, 'checkout -q main'); try { git(root, 'branch -q -D feat/bench-rename'); } catch { } try { git(root, 'branch -q -D volt/1a2b3c4d'); } catch { } },
		check: r => judge(r, git(root, 'branch --show-current').trim() === 'feat/bench-rename' && !r.isError, false),
	});
	void line;
	return { root, list: out };
}
