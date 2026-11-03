/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Biome lint and format for an app with its own biome.json (apps/docs), as a ratchet: the changed
// files are checked at the base commit and at the head, and only problems the change adds fail.
// The base versions are written to a temporary folder next to the base biome.json, so both runs
// use the configuration of their own commit.
// Usage: node build/volt/ci/biomeDiff.mjs --app apps/docs --base <sha> [--head <sha>]

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { addedLinesByFile, compareProblems, lineLookup, listChanges, report, showFile } from './ratchet.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

/** @typedef {import('./ratchet.mjs').Problem} Problem */

const commandLine = /^::(error|warning|notice) (.*?)::(.*)$/;

/**
 * Parses Biome's `--reporter=github` output into problems with paths relative to `cwd`.
 * @param {string} output
 * @param {string} cwd
 * @param {string} prefix prepended to each path (the app folder)
 * @returns {Problem[]}
 */
export function parseGithubReporter(output, cwd, prefix) {
	/** @type {Problem[]} */
	const problems = [];
	for (const line of output.split(/\r?\n/)) {
		const m = commandLine.exec(line);
		if (!m) {
			continue;
		}
		/** @type {Record<string, string>} */
		const props = {};
		for (const part of m[2].split(',')) {
			const eq = part.indexOf('=');
			if (eq > 0) {
				props[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1).replace(/%(?![0-9A-F]{2})/gi, '%25'));
			}
		}
		if (!props.file) {
			continue;
		}
		const relative = path.relative(cwd, path.resolve(cwd, props.file)).split(path.sep).join('/');
		problems.push({
			file: `${prefix}/${relative}`,
			line: props.line ? Number(props.line) : undefined,
			column: props.col ? Number(props.col) : undefined,
			message: m[3].replace(/%0A/g, '\n').replace(/%0D/g, '\r').replace(/%25/g, '%'),
			rule: props.title,
		});
	}
	return problems;
}

/**
 * @param {string} biome
 * @param {string} cwd
 * @param {string[]} files relative to cwd
 * @param {string | undefined} level the lowest severity reported (info, warn, error)
 */
function runBiome(biome, cwd, files, level) {
	if (!files.length) {
		return '';
	}
	const args = ['check', '--reporter=github', '--vcs-enabled=false', '--no-errors-on-unmatched', '--files-ignore-unknown=true', '--max-diagnostics=none', ...(level ? [`--diagnostic-level=${level}`] : []), ...files];
	try {
		return execFileSync(biome, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (error) {
		// Biome exits 1 when it reports problems; its report is still on stdout.
		const failure = /** @type {{ stdout?: string, status?: number }} */ (error);
		if (failure.status === 1 && typeof failure.stdout === 'string') {
			return failure.stdout;
		}
		throw error;
	}
}

/**
 * Writes the app's Biome configuration at a commit into `dir` (a copy of the repository layout),
 * with the files it extends, so `extends: ["../biome-shared.jsonc"]` resolves there too.
 * @param {string} commit
 * @param {string} app
 * @param {string} dir
 * @returns {boolean} whether the app had a configuration at that commit
 */
export function writeConfigAt(commit, app, dir) {
	for (const name of ['biome.json', 'biome.jsonc']) {
		const config = showFile(commit, `${app}/${name}`, root);
		if (!config) {
			continue;
		}
		fs.mkdirSync(path.join(dir, app), { recursive: true });
		fs.writeFileSync(path.join(dir, app, name), config);
		/** @type {unknown} */
		let parsed;
		try {
			parsed = JSON.parse(config.toString('utf8').replace(/^\s*\/\/.*$/gm, ''));
		} catch {
			return true;
		}
		const extendsList = /** @type {{ extends?: unknown }} */ (parsed).extends;
		for (const target of Array.isArray(extendsList) ? extendsList : []) {
			if (typeof target !== 'string' || !target.startsWith('.')) {
				continue;
			}
			const relative = path.posix.normalize(path.posix.join(app, target));
			const contents = showFile(commit, relative, root);
			if (contents && !relative.startsWith('..')) {
				fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
				fs.writeFileSync(path.join(dir, relative), contents);
			}
		}
		return true;
	}
	return false;
}

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {{ base?: string, head?: string, app?: string, biome?: string, level?: string }} */
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--base') {
			args.base = argv[++i];
		} else if (argv[i] === '--head') {
			args.head = argv[++i];
		} else if (argv[i] === '--app') {
			args.app = argv[++i]?.replace(/\/$/, '');
		} else if (argv[i] === '--biome') {
			args.biome = argv[++i];
		} else if (argv[i] === '--diagnostic-level') {
			args.level = argv[++i];
		}
	}
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.base || !args.app) {
		console.error('Usage: node build/volt/ci/biomeDiff.mjs --app apps/docs --base <sha> [--head <sha>] [--biome <path>] [--diagnostic-level warn]');
		process.exit(2);
	}
	const app = args.app;
	const appDir = path.join(root, app);
	// The app's own Biome, or one passed in for apps that do not install it (see apps/biome-shared.jsonc).
	const biome = args.biome ?? path.join(appDir, 'node_modules', '.bin', process.platform === 'win32' ? 'biome.cmd' : 'biome');
	const tool = `Biome (${app})`;
	const changes = listChanges(args.base, args.head, root)
		.filter(change => change.status !== 'D' && change.path.startsWith(`${app}/`) && fs.existsSync(path.join(root, change.path)));
	if (!changes.length) {
		report(tool, [], { fixed: 0, files: 0 });
		return;
	}

	// The base versions go into a copy of the repository layout, so relative `extends` still resolve.
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'volt-biome-base-')));
	try {
		const baseAppDir = path.join(tmp, app);
		const baseConfig = writeConfigAt(args.base, app, tmp);
		/** @type {string[]} */
		const baseFiles = [];
		for (const change of changes) {
			const contents = change.status === 'A' ? undefined : showFile(args.base, change.oldPath, root);
			if (contents) {
				const relative = change.path.slice(app.length + 1);
				fs.mkdirSync(path.dirname(path.join(baseAppDir, relative)), { recursive: true });
				fs.writeFileSync(path.join(baseAppDir, relative), contents);
				baseFiles.push(relative);
			}
		}
		const headFiles = changes.map(change => change.path.slice(app.length + 1));
		const baseProblems = baseConfig ? parseGithubReporter(runBiome(biome, baseAppDir, baseFiles, args.level), baseAppDir, app) : [];
		const headProblems = parseGithubReporter(runBiome(biome, fs.realpathSync(appDir), headFiles, args.level), fs.realpathSync(appDir), app);

		const read = (/** @type {string} */ dir, /** @type {string[]} */ files) => new Map(files.map(f => [`${app}/${f}`, fs.readFileSync(path.join(dir, f), 'utf8').split(/\r\n|\r|\n/)]));
		const added = addedLinesByFile(args.base, args.head, root);
		const result = compareProblems(baseProblems, headProblems, {
			baseLine: lineLookup(read(baseAppDir, baseFiles)),
			headLine: lineLookup(read(appDir, headFiles)),
			added: file => added.get(file) ?? new Set(),
		});
		report(tool, result.added, { fixed: result.fixed, files: headFiles.length });
		if (result.added.length) {
			console.log(`\nFix these before merging. In ${app}, \`bunx @biomejs/biome check --write <file>\` fixes what Biome can.`);
			process.exitCode = 1;
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
