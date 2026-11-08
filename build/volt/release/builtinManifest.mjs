/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// builtin-manifest.json (spec H.10): SHA-256 of every file of the `volt-*` built-in extensions, and of
// helper binaries, written next to product.json when the app is packaged (build/gulpfile.vscode.js).
// The app checks it when it scans built-in extensions:
// src/vs/platform/extensionManagement/common/voltBuiltinIntegrity.ts. Keep the two formats in step.
//   node build/volt/release/builtinManifest.mjs <extensionsDir> [<appRoot> <helper>...]   prints the manifest

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const BUILTIN_MANIFEST_FILE = 'builtin-manifest.json';

/**
 * Helper binaries to hash, as paths relative to the packaged app root (`resources/app`), e.g.
 * `out/vs/platform/voltDesktop/node/helper/volt-desktop`. Empty until the helper signing work adds them;
 * the app checks them through VoltBuiltinIntegrity.checkHelper.
 */
export const BUILTIN_HELPERS = [];

const sha256 = data => createHash('sha256').update(data).digest('hex');

/** Every file under `dir` (posix paths relative to it, sorted) with its hash. */
function hashTree(dir) {
	const files = {};
	const walk = rel => {
		for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
			const child = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(child);
			} else {
				files[child] = sha256(fs.readFileSync(path.join(dir, child)));
			}
		}
	};
	walk('');
	return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/**
 * @param {{ extensionsDir: string, appRoot?: string, helpers?: string[] }} o
 */
export function generateBuiltinManifest(o) {
	const extensions = {};
	const names = fs.existsSync(o.extensionsDir) ? fs.readdirSync(o.extensionsDir, { withFileTypes: true }) : [];
	for (const entry of names.filter(entry => entry.isDirectory() && entry.name.startsWith('volt-')).map(entry => entry.name).sort()) {
		extensions[entry] = hashTree(path.join(o.extensionsDir, entry));
	}
	const helpers = {};
	for (const helper of o.helpers ?? BUILTIN_HELPERS) {
		helpers[helper] = sha256(fs.readFileSync(path.join(o.appRoot ?? '.', helper)));
	}
	return { version: 1, algorithm: 'sha256', extensions, helpers };
}

/** The file's text and its hash (product.json `voltBuiltinManifestSha256`). */
export function serializeBuiltinManifest(manifest) {
	const text = JSON.stringify(manifest, null, '\t') + '\n';
	return { text, sha256: sha256(Buffer.from(text, 'utf8')) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
	const [extensionsDir, appRoot, ...helpers] = process.argv.slice(2);
	if (!extensionsDir) {
		console.error('usage: builtinManifest.mjs <extensionsDir> [<appRoot> <helper>...]');
		process.exit(1);
	}
	process.stdout.write(serializeBuiltinManifest(generateBuiltinManifest({ extensionsDir, appRoot, helpers: appRoot ? helpers : undefined })).text);
}
