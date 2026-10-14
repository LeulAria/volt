/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Builds the Volt web app (the agent server serves it at /) into out-volt-web/. It bundles the
// agent window's own modules from src/vs, so the web app renders with the same code and CSS.
// Usage: node build/volt/buildAgentWeb.mjs [--watch] [--minify]

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(path.join(root, 'build', 'package.json'));
const esbuild = require('esbuild');
const outdir = path.join(root, 'out-volt-web');
const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

/** Modules that only make sense inside the workbench get web stand-ins. */
const shims = {
	'amdX.js': path.join(root, 'src/vs/workbench/contrib/voltAgentWeb/browser/shims/amdX.ts'),
};

const shimPlugin = {
	name: 'volt-web-shims',
	setup(build) {
		build.onResolve({ filter: /\/amdX\.js$/ }, () => ({ path: shims['amdX.js'] }));
		// Sources import each other as .js; esbuild must find the .ts next to them.
		build.onResolve({ filter: /^\.\.?\/.*\.js$/ }, args => {
			if (!args.importer.startsWith(path.join(root, 'src'))) {
				return undefined;
			}
			const ts = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
			if (fs.existsSync(ts)) {
				return { path: ts };
			}
			return undefined;
		});
	},
};

/**
 * The languages and TextMate grammars the built-in extensions contribute, so code cards in the
 * web app are tokenized exactly as in the desktop.
 */
function collectLanguages() {
	const extensionsDir = path.join(root, 'extensions');
	const languages = [];
	const grammars = [];
	const grammarsOut = path.join(outdir, 'grammars');
	fs.mkdirSync(grammarsOut, { recursive: true });
	for (const name of fs.readdirSync(extensionsDir)) {
		const manifestPath = path.join(extensionsDir, name, 'package.json');
		if (!fs.existsSync(manifestPath)) {
			continue;
		}
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		for (const language of manifest.contributes?.languages ?? []) {
			const { id, extensions, aliases, filenames, filenamePatterns, firstLine, mimetypes } = language;
			languages.push({ id, extensions, aliases, filenames, filenamePatterns, firstLine, mimetypes });
		}
		for (const grammar of manifest.contributes?.grammars ?? []) {
			const source = path.join(extensionsDir, name, grammar.path);
			if (!fs.existsSync(source)) {
				continue;
			}
			const file = `${name}-${path.basename(grammar.path)}`;
			fs.copyFileSync(source, path.join(grammarsOut, file));
			grammars.push({ language: grammar.language, scopeName: grammar.scopeName, file, embeddedLanguages: grammar.embeddedLanguages, injectTo: grammar.injectTo, tokenTypes: grammar.tokenTypes });
		}
	}
	fs.writeFileSync(path.join(outdir, 'languages.json'), JSON.stringify({ languages, grammars }));
}

/**
 * Token colors for code cards: the theme's TextMate rules, and the desktop's color map (the
 * `.mtkN` ids in the captured theme CSS) so tokens get the same classes as in the agent window.
 */
function writeTheme() {
	const theme = JSON.parse(fs.readFileSync(path.join(root, 'extensions/theme-cursor/themes/cursor-dark-color-theme.json'), 'utf8'));
	const css = fs.readFileSync(path.join(root, 'src/vs/workbench/contrib/voltAgentWeb/browser/media/desktopTheme.css'), 'utf8');
	const colorMap = [''];
	for (const match of css.matchAll(/\.mtk(\d+) \{ color: rgb\((\d+), (\d+), (\d+)\); \}/g)) {
		const hex = '#' + [match[2], match[3], match[4]].map(n => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
		colorMap[Number(match[1])] = hex;
	}
	fs.writeFileSync(path.join(outdir, 'theme.json'), JSON.stringify({ tokenColors: theme.tokenColors ?? [], foreground: theme.colors?.['editor.foreground'], colorMap }));
}

function copyStatic() {
	fs.mkdirSync(outdir, { recursive: true });
	fs.copyFileSync(path.join(root, 'src/vs/workbench/contrib/voltAgentWeb/browser/index.html'), path.join(outdir, 'index.html'));
	fs.cpSync(path.join(root, 'src/vs/workbench/contrib/voltAgentWeb/browser/media/brand'), path.join(outdir, 'brand'), { recursive: true });
	const katex = path.join(outdir, 'node_modules', 'katex', 'dist');
	if (!fs.existsSync(katex)) {
		fs.mkdirSync(path.dirname(katex), { recursive: true });
		fs.cpSync(path.join(root, 'node_modules', 'katex', 'dist'), katex, { recursive: true });
	}
	const icons = path.join(outdir, 'fileicons');
	const iconSource = path.join(root, '.build', 'builtInExtensions', 'PKief.material-icon-theme', 'icons');
	if (!fs.existsSync(icons) && fs.existsSync(iconSource)) {
		fs.cpSync(iconSource, icons, { recursive: true });
	}
	const onig = path.join(outdir, 'onig.wasm');
	if (!fs.existsSync(onig)) {
		fs.copyFileSync(path.join(root, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'), onig);
	}
}

const options = {
	absWorkingDir: root,
	entryPoints: { main: 'src/vs/workbench/contrib/voltAgentWeb/browser/agentWebMain.ts' },
	bundle: true,
	splitting: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	outdir,
	sourcemap: true,
	minify,
	logLevel: 'info',
	loader: { '.ttf': 'file', '.svg': 'file', '.png': 'file', '.woff2': 'file', '.woff': 'file' },
	assetNames: 'assets/[name]-[hash]',
	chunkNames: 'chunks/[name]-[hash]',
	tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
	define: { 'process.env.NODE_ENV': '"production"' },
	// Served by the agent server at runtime, not bundled.
	external: ['/fileicons/*', '/node_modules/*'],
	plugins: [shimPlugin],
};

copyStatic();
collectLanguages();
writeTheme();
if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	await esbuild.build(options);
}
