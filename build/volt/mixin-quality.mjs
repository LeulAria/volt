/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Turns a checkout into one release channel before a build, the way VS Code's distro
// `mixin-quality` step does: product.json gets the channel's identity and `quality`,
// package.json gets the release version, and the channel's icons replace the app icons.
// Run in CI only; it rewrites tracked files.
// Usage: node build/volt/mixin-quality.mjs --channel stable|beta|nightly [--version 0.0.1-beta.1]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dirname, '..', '..');
const { values } = parseArgs({ options: { channel: { type: 'string' }, version: { type: 'string' } } });
const channel = values.channel;
const qualities = JSON.parse(fs.readFileSync(path.join(root, 'build', 'volt', 'qualities.json'), 'utf8'));
if (!channel || !qualities[channel] || channel.startsWith('$')) {
	console.error(`Unknown channel "${channel}". Expected one of: ${Object.keys(qualities).filter(k => !k.startsWith('$')).join(', ')}`);
	process.exit(1);
}
const quality = qualities[channel];

function readJson(rel) {
	return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function writeJson(rel, value) {
	fs.writeFileSync(path.join(root, rel), JSON.stringify(value, null, '\t') + '\n');
}

// product.json
const product = readJson('product.json');
Object.assign(product, quality.product, { quality: channel, updateUrl: product.voltRelease.feedUrl });
writeJson('product.json', product);

// package.json (+ lockfile root, so `npm ci` keeps agreeing with it)
const pkg = readJson('package.json');
const version = values.version || pkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
	console.error(`Invalid version "${version}"`);
	process.exit(1);
}
pkg.version = version;
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
const lock = readJson('package-lock.json');
lock.version = version;
lock.packages[''].version = version;
fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');

// Icons
const copy = (from, to) => fs.copyFileSync(path.join(root, from), path.join(root, to));
copy(quality.icons.icns, 'resources/darwin/code.icns');
copy(quality.icons.png, 'resources/linux/code.png');
fs.writeFileSync(path.join(root, 'resources/win32/code.ico'), createIco([
	'icon_16x16.png', 'icon_32x32.png', 'icon_32x32@2x.png', 'icon_128x128.png', 'icon_256x256.png'
].map(name => fs.readFileSync(path.join(root, quality.icons.iconset, name)))));

console.log(`Mixed in ${channel}: ${product.nameLong} ${version} (${product.darwinBundleIdentifier}, ${product.dataFolderName})`);

/**
 * An .ico whose entries are PNG streams (supported since Windows Vista, and by rcedit).
 * @param {Buffer[]} pngs
 */
function createIco(pngs) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(pngs.length, 4);
	const entries = [];
	let offset = 6 + 16 * pngs.length;
	for (const png of pngs) {
		const width = png.readUInt32BE(16);
		const height = png.readUInt32BE(20);
		const entry = Buffer.alloc(16);
		entry.writeUInt8(width >= 256 ? 0 : width, 0);
		entry.writeUInt8(height >= 256 ? 0 : height, 1);
		entry.writeUInt8(0, 2);
		entry.writeUInt8(0, 3);
		entry.writeUInt16LE(1, 4);
		entry.writeUInt16LE(32, 6);
		entry.writeUInt32LE(png.length, 8);
		entry.writeUInt32LE(offset, 12);
		offset += png.length;
		entries.push(entry);
	}
	return Buffer.concat([header, ...entries, ...pngs]);
}
