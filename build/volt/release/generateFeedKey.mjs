/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Creates the Ed25519 keys that sign the update feed, one per channel.
//   node build/volt/release/generateFeedKey.mjs [--out <dir>] [stable beta nightly]
// Writes <dir>/<channel>.key (PKCS #8 PEM, mode 600) for the VOLT_FEED_SIGNING_KEY_<CHANNEL> secrets,
// and prints the public keys for product.json `voltRelease.feedPublicKeys`. Nothing secret is printed.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { publicKeyBase64 } from './feedSigning.mjs';

let out = path.resolve('volt-feed-keys');
const channels = [];
for (const args = process.argv.slice(2); args.length;) {
	const arg = args.shift();
	if (arg === '--out') {
		out = path.resolve(args.shift() ?? '');
	} else {
		channels.push(arg);
	}
}
const wanted = channels.length ? channels : ['stable', 'beta', 'nightly'];

fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const pins = {};
for (const channel of wanted) {
	if (!['stable', 'beta', 'nightly'].includes(channel)) {
		console.error(`Unknown channel "${channel}"`);
		process.exit(1);
	}
	const file = path.join(out, `${channel}.key`);
	if (fs.existsSync(file)) {
		console.error(`${file} exists; refusing to overwrite a signing key`);
		process.exit(1);
	}
	const { privateKey } = crypto.generateKeyPairSync('ed25519');
	fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
	pins[channel] = publicKeyBase64(privateKey);
	console.log(`${channel}: private key in ${file}`);
}
console.log('\nproduct.json, under "voltRelease":');
console.log(`"feedPublicKeys": ${JSON.stringify(pins, null, '\t')}`);
console.log(`\nAdd each ${out}/<channel>.key as the repository secret VOLT_FEED_SIGNING_KEY_<CHANNEL>, then delete the files.`);
