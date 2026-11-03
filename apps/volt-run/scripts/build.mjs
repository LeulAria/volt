/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Combines volt-run's modules, and what it shares with Volt (release naming, channel names, the
// QR encoder), into one dependency-free file: npx fetches a single small file and Node loads a
// single module. With --release the release manifest is written in, so the published package
// starts without asking the network which build to download.
//
//   node scripts/build.mjs                          dist/volt-run.mjs, reads the update feed when it runs
//   node scripts/build.mjs --release latest         pinned to the channel's latest release
//   node scripts/build.mjs --release 0.0.6 [--channel stable] [--feed <url>] [--out <file>]

import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fetchManifest } from '../src/release.mjs';

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** qrcode-generator is MIT: its notice goes with the copy built in. */
const NOTICES = `
// Includes qrcode-generator 2.0.4 (https://github.com/kazuhikoarase/qrcode-generator),
// Copyright (c) 2009 Kazuhiko Arase, MIT license. "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
`;

/**
 * @param {{ manifest?: object, version?: string, outfile?: string }} o `version` defaults to package.json's
 * @returns {Promise<{ outfile: string, bytes: number }>}
 */
export async function build(o = {}) {
	const version = o.version ?? JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
	const esbuild = await import('esbuild').catch(() => {
		throw new Error('esbuild is not installed: run "npm ci" in apps/volt-run first.');
	});
	const outfile = path.resolve(o.outfile ?? path.join(PACKAGE_ROOT, 'dist', 'volt-run.mjs'));
	await mkdir(path.dirname(outfile), { recursive: true });
	await esbuild.build({
		entryPoints: [path.join(PACKAGE_ROOT, 'src', 'cli.mjs')],
		outfile,
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node20',
		// Readable on purpose: people should be able to read what they run with npx.
		minify: false,
		legalComments: 'none',
		footer: { js: NOTICES },
		define: { __VOLT_RELEASE__: JSON.stringify(o.manifest ?? null), __VOLT_RUN_VERSION__: JSON.stringify(version) },
		logLevel: 'warning',
	});
	await chmod(outfile, 0o755);
	return { outfile, bytes: (await stat(outfile)).size };
}

if (process.argv[1] === import.meta.filename) {
	const { values } = parseArgs({ options: { release: { type: 'string' }, channel: { type: 'string' }, feed: { type: 'string' }, out: { type: 'string' } } });
	const manifest = values.release
		? await fetchManifest({ channel: values.channel ?? 'stable', version: values.release, feedUrl: values.feed, token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN })
		: undefined;
	const { outfile, bytes } = await build({ manifest, outfile: values.out });
	const pinned = manifest ? `Volt ${manifest.channel} ${manifest.version} (${Object.keys(manifest.assets).join(', ')})` : 'no release written in (reads the update feed when it runs)';
	console.log(`${path.relative(process.cwd(), outfile)}: ${(bytes / 1024).toFixed(0)} KB, ${pinned}`);
}
