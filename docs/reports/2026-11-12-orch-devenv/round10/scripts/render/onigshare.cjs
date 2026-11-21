// Offline (plain node, no Volt): TextMate tokenization of a TypeScript file with stock vscode-oniguruma scanners
// ('plain': every rule compiles its own copy of every pattern), with one compiled regex per distinct pattern
// shared by all rules through the public API ('dedup'), and the same with a JS copy of oniguruma's per-regex
// search cache and the binding's own entry point ('fast'). Prints CPU ms cold and warm, a hash of all tokens
// (must be equal across modes) and the WASM heap (MiB before, after, end). Exploratory: a choice, not shipped.
// 'volt' = the shipped src/vs/workbench/services/textMate/browser/sharedOnigScanner.ts from out/ (a scanner that
// has answered 1,024 calls goes back to oniguruma's own); 'volt:<n>' = the same with n calls.
//   node onigshare.cjs <repo root> plain|dedup|fast|volt|volt:<n> <file>     (GRAMMAR=<tmLanguage.json>, default TypeScript)
const fs = require('fs'); const path = require('path');
const root = process.argv[2]; const mode = process.argv[3]; const file = process.argv[4];
const onig = require(path.join(root, 'node_modules/vscode-oniguruma')); const tm = require(path.join(root, 'node_modules/vscode-textmate'));
class Shared { constructor(src) { this.scanner = onig.createOnigScanner([src]); this.ptr = this.scanner._ptr; this.refs = 0; this.g = /\\G/.test(src); this.cId = -1; this.cPos = 0; this.cOpt = 0; this.cMatched = false; this.cLoc = 0; } }
const pool = new Map();
class DedupScanner {
	constructor(sources) { this.parts = sources.map(s => { let p = pool.get(s); if (!p) { p = new Shared(s); pool.set(s, p); } p.refs++; return p; }); this.sources = sources; }
	findNextMatchSync(string, start, options) {
		if (mode === 'fast') {
			const parts = this.parts; const b = parts[0].scanner._onigBinding; const pos = string.convertUtf16OffsetToUtf8(start); const id = string.id, ptr = string.ptr, len = string.utf8Length;
			let best = -1, bestLoc = 0, last = -1;
			const heap = b.HEAPU32;
			for (let i = 0; i < parts.length; i++) {
				const p = parts[i]; let loc;
				if (!p.g && p.cId === id && p.cOpt === options && p.cPos <= pos && (!p.cMatched || p.cLoc >= pos)) { if (!p.cMatched) { continue; } loc = p.cLoc; }
				else {
					const r = b._findNextOnigScannerMatch(p.ptr, id, ptr, len, pos, options);
					if (!p.g) { p.cId = id; p.cPos = pos; p.cOpt = options; p.cMatched = r !== 0; if (r !== 0) { p.cLoc = b.HEAPU32[(r >>> 2) + 2]; } }
					if (r === 0) { continue; }
					loc = b.HEAPU32[(r >>> 2) + 2];
				}
				if (best === -1 || loc < bestLoc) { best = i; bestLoc = loc; } if (loc === pos) { break; }
			}
			if (best === -1) { return null; }
			const m = parts[best].scanner.findNextMatchSync(string, start, options); m.index = best; return m;
		}
		let best = null, bestLoc = 0, bestIndex = 0; const parts = this.parts;
		for (let i = 0; i < parts.length; i++) {
			const r = parts[i].scanner.findNextMatchSync(string, start, options);
			if (r) { const loc = r.captureIndices[0].start; if (best === null || loc < bestLoc) { best = r; bestLoc = loc; bestIndex = i; } if (loc === start) { break; } }
		}
		if (best) { best.index = bestIndex; }
		return best;
	}
	dispose() { for (let i = 0; i < this.parts.length; i++) { const p = this.parts[i]; if (--p.refs === 0) { p.scanner.dispose(); pool.delete(this.sources[i]); } } }
}
const grammarFile = process.env.GRAMMAR ? path.resolve(process.env.GRAMMAR) : path.join(root, 'extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json');
const scopeName = JSON.parse(fs.readFileSync(grammarFile, 'utf8')).scopeName;
(async () => {
	const shipped = mode.startsWith('volt') ? new (await import(path.join(root, 'out/vs/workbench/services/textMate/browser/sharedOnigScanner.js'))).SharedOnigPatterns(onig, mode.includes(':') ? Number(mode.split(':')[1]) : undefined) : undefined;
	await onig.loadWASM(fs.readFileSync(path.join(root, 'node_modules/vscode-oniguruma/release/onig.wasm')).buffer);
	const registry = new tm.Registry({
		onigLib: Promise.resolve({ createOnigScanner: sources => shipped ? shipped.createOnigScanner(sources) : mode !== 'plain' ? new DedupScanner(sources) : onig.createOnigScanner(sources), createOnigString: s => onig.createOnigString(s) }),
		loadGrammar: async scope => scope === scopeName ? tm.parseRawGrammar(fs.readFileSync(grammarFile, 'utf8'), 'grammar.json') : null,
	});
	const grammar = await registry.loadGrammar(scopeName);
	const lines = fs.readFileSync(file, 'utf8').split('\n');
	const mem = () => { const m = process.memoryUsage(); return Math.round((m.arrayBuffers + m.external) / 1048576); };
	const run = () => { let state = tm.INITIAL; const h = require('crypto').createHash('sha1'); const t0 = BigInt(process.cpuUsage().user) * 1000n; for (const line of lines) { const r = grammar.tokenizeLine2(line, state); state = r.ruleStack; h.update(Buffer.from(r.tokens.buffer, r.tokens.byteOffset, r.tokens.byteLength)); } return { ms: Math.round(Number(BigInt(process.cpuUsage().user) * 1000n - t0) / 1e6), hash: h.digest('hex').slice(0, 12) }; };
	const before = mem(); const cold = run(); const after = mem(); const warm = [run(), run(), run(), run(), run()];
	console.log(JSON.stringify({ mode, lines: lines.length, coldMs: cold.ms, warmMs: warm.map(w => w.ms), hash: cold.hash, sameWarm: warm.every(w => w.hash === cold.hash), wasmMiB: [before, after, mem()], pool: shipped ? shipped.size : pool.size }));
})();
