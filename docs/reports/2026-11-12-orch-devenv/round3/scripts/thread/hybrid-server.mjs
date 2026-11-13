#!/usr/bin/env node
// A release-shaped agent server for the remote A/B: an APFS clone of an installed Volt's app folder
// (its minified workbench bundle, product.json and node_modules) whose bundled
// out/volt-agent-server-main.js is replaced by this worktree's server, bundled with esbuild from
// out/ with the server files at `side` (base = 82ae771c1d9, new = HEAD). Both sides are bundled the
// same way, so the only difference between them is the branch's server change.
//
//   node hybrid-server.mjs base|new [--app /Applications/Volt.app/Contents/Resources/app] [--dir /tmp/v3-thread-hyb-<side>]
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const side = args[0];
if (side !== 'base' && side !== 'new') {
	console.error('usage: hybrid-server.mjs base|new');
	process.exit(2);
}
const WT = '/Users/leularia/Desktop/VOLT/volt-e3-thread';
const BASE = process.env.BASE ?? '82ae771c1d9';
const app = opt('app', '/Applications/Volt.app/Contents/Resources/app');
const dir = opt('dir', `/tmp/v3-thread-hyb-${side}`);
const outClone = `/tmp/v3-thread-out-${side}`;

const require = createRequire(path.join(WT, 'build', 'package.json'));
const { transformSync } = await import(require.resolve('oxc-transform'));
const { inlineOxcRuntimeHelpers } = require(path.join(WT, 'build', 'lib', 'tsb', 'transpiler.js'));

const git = (...a) => execFileSync('git', a, { cwd: WT, encoding: 'utf8', maxBuffer: 64 << 20 });
const serverFiles = git('diff', '--name-only', BASE, 'HEAD', '--', 'src/vs/server/*.ts').split('\n').filter(f => f && !f.includes('/test/'));

fs.rmSync(outClone, { recursive: true, force: true });
execFileSync('cp', ['-c', '-R', path.join(WT, 'out'), outClone]);
for (const rel of serverFiles) {
	let src;
	try {
		src = side === 'base' ? git('show', `${BASE}:${rel}`) : fs.readFileSync(path.join(WT, rel), 'utf8');
	} catch {
		src = undefined; // not in base
	}
	const out = path.join(outClone, rel.replace(/^src\//, '').replace(/\.ts$/, '.js'));
	if (src === undefined) {
		fs.rmSync(out, { force: true });
		continue;
	}
	const r = transformSync(rel, src, {
		lang: 'ts', sourceType: 'module', sourcemap: false, target: 'es2022', decorator: { legacy: true },
		typescript: { onlyRemoveTypeImports: false, removeClassFieldsWithoutInitializer: true },
		assumptions: { setPublicClassFields: true },
	});
	if (r.errors?.length) {
		throw new Error(`${rel}: ${r.errors.map(e => e.message).join('; ')}`);
	}
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, inlineOxcRuntimeHelpers(r.code));
	console.log(`${side}: ${rel}`);
}

fs.rmSync(dir, { recursive: true, force: true });
execFileSync('cp', ['-c', '-R', app, dir]);
execFileSync(path.join(WT, 'build/node_modules/.bin/esbuild'), [
	path.join(outClone, 'volt-agent-server-main.js'), '--bundle', '--platform=node', '--format=esm', '--packages=external',
	'--target=es2022', `--outfile=${path.join(dir, 'out/volt-agent-server-main.js')}`, '--log-level=warning',
	// CommonJS packages bundled into ESM call require(): give the bundle one.
	'--banner:js=import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
], { stdio: 'inherit' });
fs.rmSync(outClone, { recursive: true, force: true });
console.log(`${dir}: release app with the ${side} server`);
