// Offline (plain node, no Volt): what the TypeScript grammar's compiled regexes cost in oniguruma's WASM heap when
// the code fences of ADEMark's replay stream are tokenized as Volt's code cards do (line by line, TextMate), and
// how many of the compiled patterns are duplicates of one another (same source compiled again for another rule).
// With `volt` as third argument the scanners come from the shipped sharedOnigScanner.ts (out/): each distinct
// pattern compiled once.
//   node onigprobe.cjs <repo root> [stream session jsonl|-] [volt]
const fs = require('fs'); const path = require('path');
const root = process.argv[2]; const session = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : `${process.env.HOME}/.volt-r4/ademark/bench/replay/sessions/stream-1.jsonl`;
const onig = require(path.join(root, 'node_modules/vscode-oniguruma')); const tm = require(path.join(root, 'node_modules/vscode-textmate'));
(async () => {
	await onig.loadWASM(fs.readFileSync(path.join(root, 'node_modules/vscode-oniguruma/release/onig.wasm')).buffer);
	const shipped = process.argv[4] === 'volt' ? new (await import(path.join(root, 'out/vs/workbench/services/textMate/browser/sharedOnigScanner.js'))).SharedOnigPatterns(onig) : undefined;
	let scanners = 0, patterns = 0, bytes = 0; const uniq = new Map(); const lists = new Map();
	const registry = new tm.Registry({
		onigLib: Promise.resolve({
			createOnigScanner: sources => { scanners++; patterns += sources.length; for (const s of sources) { bytes += s.length; uniq.set(s, (uniq.get(s) ?? 0) + 1); } const k = sources.join('\u0000'); lists.set(k, (lists.get(k) ?? 0) + 1); return shipped ? shipped.createOnigScanner(sources) : onig.createOnigScanner(sources); },
			createOnigString: s => onig.createOnigString(s),
		}),
		loadGrammar: async scope => scope === 'source.ts' ? tm.parseRawGrammar(fs.readFileSync(path.join(root, 'extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json'), 'utf8'), 'ts.json') : null,
	});
	const grammar = await registry.loadGrammar('source.ts');
	let text = '';
	for (const l of fs.readFileSync(session, 'utf8').split('\n')) { for (const m of l.matchAll(/"text(?:_delta)?":\s*"((?:[^"\\]|\\.)*)"/g)) { try { text += JSON.parse(`"${m[1]}"`); } catch { } } }
	const fences = [...text.matchAll(/```(\w+)\n([\s\S]*?)```/g)].filter(m => m[1] === 'ts' || m[1] === 'diff').map(m => m[1] === 'diff' ? m[2].split('\n').filter(x => !/^(@@|---|\+\+\+|diff )/.test(x)).map(x => x.slice(1)).join('\n') : m[2]);
	const mem = () => { const m = process.memoryUsage(); return Math.round((m.arrayBuffers + m.external) / 1048576); };
	const before = mem(); let lines = 0; const t0 = process.hrtime.bigint();
	for (const code of fences) { let state = tm.INITIAL; for (const line of code.split('\n')) { state = grammar.tokenizeLine2(line, state).ruleStack; lines++; } }
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	const dupLists = [...lists.values()].reduce((n, c) => n + c - 1, 0);
	console.log(JSON.stringify({ fences: fences.length, lines, tokenizeMs: Math.round(ms), scanners, duplicateScanners: dupLists, patterns, uniquePatterns: uniq.size, sourceMB: +(bytes / 1048576).toFixed(2), uniqueSourceMB: +([...uniq.keys()].reduce((n, s) => n + s.length, 0) / 1048576).toFixed(2), externalMiBBefore: before, externalMiBAfter: mem(), sharedPatterns: shipped?.size }));
	const top = [...uniq.entries()].sort((a, b) => b[1] * b[0].length - a[1] * a[0].length).slice(0, 5).map(([s, c]) => `${c}x ${s.length} chars`);
	console.log('most repeated sources:', top.join('; '));
})();
