/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Transpiles changed and new src/ files into out/ the way `gulp watch-client` does (Oxc, same
// options). The watcher never picks up files created after it started; run this after adding files.
// Usage: node build/volt/syncOut.mjs [--all-changed] [files...]

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(path.join(root, 'build', 'package.json'));
const { transformSync } = await import(require.resolve('oxc-transform'));
const { inlineOxcRuntimeHelpers } = require(path.join(root, 'build', 'lib', 'tsb', 'transpiler.js'));

function changedFiles() {
	const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
	return [...new Set([...git('diff', '--name-only', 'HEAD'), ...git('ls-files', '--others', '--exclude-standard')])]
		.filter(f => f.startsWith('src/') && (f.endsWith('.ts') || f.endsWith('.css')) && !f.endsWith('.d.ts'));
}

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
const targets = files.length ? files.map(f => path.relative(root, path.resolve(f))) : changedFiles();
let wrote = 0;
for (const rel of targets) {
	const src = path.join(root, rel);
	if (!fs.existsSync(src)) {
		continue;
	}
	const outRel = rel.replace(/^src\//, 'out/').replace(/\.ts$/, '.js');
	const out = path.join(root, outRel);
	if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) {
		continue;
	}
	fs.mkdirSync(path.dirname(out), { recursive: true });
	if (rel.endsWith('.css')) {
		fs.copyFileSync(src, out);
	} else {
		const source = fs.readFileSync(src, 'utf8');
		const result = transformSync(src, source, {
			lang: 'ts', sourceType: 'module', sourcemap: true, target: 'es2022',
			decorator: { legacy: true },
			typescript: { onlyRemoveTypeImports: false, removeClassFieldsWithoutInitializer: true, optimizeConstEnums: false },
			assumptions: { setPublicClassFields: true },
		});
		const fatal = result.errors.filter(e => e.severity === 'Error');
		if (fatal.length && !result.code) {
			console.error(`${rel}: ${fatal.map(e => e.message).join('\n')}`);
			process.exitCode = 1;
			continue;
		}
		let code = inlineOxcRuntimeHelpers(result.code);
		if (result.map?.mappings) {
			code += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(result.map)).toString('base64')}`;
		}
		fs.writeFileSync(out, code);
	}
	wrote++;
}
console.log(`syncOut: ${wrote} file(s) written`);
