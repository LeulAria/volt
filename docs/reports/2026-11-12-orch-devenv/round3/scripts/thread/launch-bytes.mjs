#!/usr/bin/env node
// The bytes a phone's first launch of the web IDE downloads for the files the compression change
// touches, made with the server's own compressor at the levels before and after (Node's zlib, the
// same parameters as serverCompression.ts), from an installed Volt's files.
//   node launch-bytes.mjs [/Applications/Volt.app/Contents/Resources/app] [--out f.json]
import fs from 'node:fs';
import zlib from 'node:zlib';
const root = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '/Applications/Volt.app/Contents/Resources/app';
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined;
const br = (buf, q) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: q, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length;
const files = [
	['out/vs/code/browser/workbench/workbench.js', 'static (br 4 before, br 11 after)', b => br(b, 4), b => br(b, 11)],
	['extensions/PKief.material-icon-theme/dist/material-icons.json', 'vscode-remote-resource (raw before, br 7 after)', b => b.length, b => br(b, 7)],
	['extensions/theme-cursor/themes/cursor-dark-color-theme.json', 'vscode-remote-resource (raw before, br 7 after)', b => b.length, b => br(b, 7)],
];
const rows = [];
for (const [rel, how, before, after] of files) {
	const buf = fs.readFileSync(`${root}/${rel}`);
	const t = Date.now();
	const a = after(buf);
	rows.push({ file: rel, how, raw: buf.length, before: before(buf), after: a, afterMs: Date.now() - t });
}
for (const r of rows) console.log(`${r.file}: raw ${r.raw}, before ${r.before}, after ${r.after} (made in ${r.afterMs} ms)`);
const saved = rows.reduce((s, r) => s + r.before - r.after, 0);
console.log(`saved ${saved} bytes`);
if (out) fs.writeFileSync(out, JSON.stringify({ root, rows, saved }, null, 1));
