/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Decides which CI jobs a change needs (.github/workflows/volt-ci.yml, job `changes`).
// A README edit does not run the type check, an apps/docs change does not run the core unit tests.
// Pushes to main, merge queue runs, manual runs and changes to the CI itself get every job.
// Detection fails open: if the diff cannot be read, every job runs.
// Usage: node build/volt/ci/changes.mjs --base <sha> [--head <sha>]   (prints key=value lines)
//        node build/volt/ci/changes.mjs --all

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const releaseAndCiScripts = /^build\/volt\/(ci|release)\//;

/**
 * Each job's trigger paths (repository-relative, `/` separators). A file can wake several jobs.
 * @type {Record<string, { include: RegExp[], exclude?: RegExp[] }>}
 */
export const areas = {
	// Type check, layer checks and unit tests over src/.
	src: {
		include: [/^src\//, /^test\//, /^build\//, /^remote\//, /^scripts\//, /^resources\//, /^\.eslint-plugin-local\//, /^(package|package-lock)\.json$/, /^\.npmrc$/, /^\.nvmrc$/, /^product\.json$/, /^gulpfile\.js$/, /^eslint\.config\.js$/],
		exclude: [releaseAndCiScripts],
	},
	// Built-in extensions compile.
	extensions: {
		include: [/^extensions\//, /^build\//, /^(package|package-lock)\.json$/, /^\.npmrc$/, /^\.nvmrc$/],
		exclude: [releaseAndCiScripts],
	},
	cli: { include: [/^cli\//] },
	docs: { include: [/^apps\/docs\//] },
	// The app, the widgets it bundles and the client-core it imports, checked together.
	mobile: { include: [/^apps\/mobile\//, /^apps\/mobile-widgets\//, /^apps\/client-core\//] },
	relay: { include: [/^apps\/relay\//] },
	govern: { include: [/^apps\/volt-govern\//] },
	// Workflows, actions and the scripts they run.
	workflows: { include: [/^\.github\//, releaseAndCiScripts] },
};

/** Editing the CI itself runs every job, so a workflow change is tested by the run it starts. */
const ciDefinition = [/^\.github\/workflows\/volt-ci\.yml$/, /^\.github\/actions\//, /^build\/volt\/ci\/changes\.mjs$/];

/** Files that never need a build or test: prose, images, issue templates, editor settings. */
const documentation = [/\.(md|txt)$/i, /^docs\//, /^brand\//, /^\.github\/ISSUE_TEMPLATE\//, /^\.github\/CODEOWNERS$/, /^\.vscode\//, /^LICENSE/, /^\.(gitignore|gitattributes|mailmap|editorconfig)$/];

/** Folders whose areas are listed above; any other path falls back to `src`, so a new top-level folder is checked until someone decides otherwise. */
const owned = [/^apps\//, /^cli\//, /^extensions\//, /^\.github\//, releaseAndCiScripts];

/**
 * @param {string[]} files changed paths
 * @returns {Record<string, boolean>}
 */
export function detect(files) {
	if (files.some(file => ciDefinition.some(re => re.test(file)))) {
		return everything();
	}
	/** @type {Record<string, boolean>} */
	const result = Object.fromEntries(Object.keys(areas).map(area => [area, false]));
	for (const file of files) {
		if (documentation.some(re => re.test(file)) && !/^(src|extensions|apps)\//.test(file)) {
			continue;
		}
		let claimed = false;
		for (const [area, { include, exclude = [] }] of Object.entries(areas)) {
			if (include.some(re => re.test(file)) && !exclude.some(re => re.test(file))) {
				result[area] = true;
				claimed = true;
			}
		}
		if (!claimed && !owned.some(re => re.test(file))) {
			result.src = true;
		}
	}
	return result;
}

/** @returns {Record<string, boolean>} */
export function everything() {
	return Object.fromEntries(Object.keys(areas).map(area => [area, true]));
}

/**
 * @param {string} base
 * @param {string} head
 * @returns {string[]}
 */
export function changedFiles(base, head) {
	const out = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	return out.split('\0').filter(Boolean);
}

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {{ base?: string, head: string, all: boolean }} */
	const args = { head: 'HEAD', all: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--base') {
			args.base = argv[++i] || undefined;
		} else if (argv[i] === '--head') {
			args.head = argv[++i];
		} else if (argv[i] === '--all') {
			args.all = true;
		}
	}
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	let result;
	let reason;
	if (args.all || !args.base) {
		result = everything();
		reason = args.all ? 'every job requested' : 'no base commit';
	} else {
		try {
			const files = changedFiles(args.base, args.head);
			result = detect(files);
			reason = `${files.length} changed files`;
		} catch (error) {
			// stderr: stdout goes to $GITHUB_OUTPUT, which takes only key=value lines.
			console.error(`::warning::Could not diff ${args.base}..${args.head}, so every job runs: ${error instanceof Error ? error.message : error}`);
			result = everything();
			reason = 'the diff failed';
		}
	}
	console.log(Object.entries(result).map(([area, on]) => `${area}=${on}`).join('\n'));
	if (process.env.GITHUB_STEP_SUMMARY) {
		const rows = Object.entries(result).map(([area, on]) => `| ${area} | ${on ? 'runs' : 'skipped'} |`);
		fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Jobs for this change (${reason})\n\n| Area | Jobs |\n| --- | --- |\n${rows.join('\n')}\n`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
