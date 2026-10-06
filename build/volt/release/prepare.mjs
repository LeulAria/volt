/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Prints GitHub Actions outputs (key=value lines) for a release run: version, tag, prerelease flag
// and the per-OS build matrices. Inputs come from the environment (see volt-build.yml).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveRelease } from './releaseNaming.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const env = process.env;

const release = resolveRelease({
	channel: env.CHANNEL,
	version: env.VERSION,
	packageVersion: pkg.version,
	refType: env.REF_TYPE,
	refName: env.REF_NAME,
	runNumber: env.RUN_NUMBER,
	platforms: env.PLATFORMS,
	now: new Date(),
});

for (const [key, value] of Object.entries(release)) {
	console.log(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
}
