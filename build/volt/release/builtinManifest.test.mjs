/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// node --test build/volt/release/builtinManifest.test.mjs

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { generateBuiltinManifest, serializeBuiltinManifest } from './builtinManifest.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');

test('hashes every file of the volt-* extensions and nothing else', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-manifest-'));
	try {
		const ext = path.join(root, 'extensions');
		fs.mkdirSync(path.join(ext, 'volt-browser', 'media'), { recursive: true });
		fs.writeFileSync(path.join(ext, 'volt-browser', 'package.json'), '{"name":"browser"}');
		fs.writeFileSync(path.join(ext, 'volt-browser', 'media', 'icon.svg'), '<svg/>');
		fs.mkdirSync(path.join(ext, 'git'));
		fs.writeFileSync(path.join(ext, 'git', 'package.json'), '{}');
		fs.mkdirSync(path.join(root, 'bin'));
		fs.writeFileSync(path.join(root, 'bin', 'helper'), 'binary');

		const manifest = generateBuiltinManifest({ extensionsDir: ext, appRoot: root, helpers: ['bin/helper'] });
		assert.deepStrictEqual(manifest, {
			version: 1,
			algorithm: 'sha256',
			extensions: { 'volt-browser': { 'media/icon.svg': sha('<svg/>'), 'package.json': sha('{"name":"browser"}') } },
			helpers: { 'bin/helper': sha('binary') },
		});
		const { text, sha256 } = serializeBuiltinManifest(manifest);
		assert.strictEqual(sha256, sha(text));

		// The CLI the gulp build runs prints the same file.
		const printed = execFileSync(process.execPath, [path.join(import.meta.dirname, 'builtinManifest.mjs'), ext], { encoding: 'utf8' });
		assert.deepStrictEqual(JSON.parse(printed), { ...manifest, helpers: {} });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
