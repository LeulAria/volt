/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { agentServerPaths, channelProduct, preferredPort, tildify, userDataDir } from '../src/paths.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');

test('the profile is the desktop app\'s user data dir on every platform', () => {
	const home = '/home/me';
	assert.equal(userDataDir('Volt', { platform: 'darwin', env: {}, home: '/Users/me' }), '/Users/me/Library/Application Support/Volt');
	assert.equal(userDataDir('Volt', { platform: 'linux', env: {}, home }), '/home/me/.config/Volt');
	assert.equal(userDataDir('Volt Beta', { platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home }), '/xdg/Volt Beta');
	assert.equal(userDataDir('Volt', { platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, home: 'C:\\Users\\me' }), 'C:\\Users\\me\\AppData\\Roaming\\Volt');
	assert.equal(userDataDir('Volt', { platform: 'darwin', env: { VSCODE_APPDATA: '/data' }, home }), '/data/Volt');
});

test('channel names come from build/volt/qualities.json', () => {
	assert.equal(channelProduct('stable').nameShort, 'Volt');
	assert.equal(channelProduct('beta').applicationName, 'volt-beta');
	assert.equal(channelProduct('nightly').nameLong, 'Volt Nightly');
	assert.throws(() => channelProduct('canary'), /Unknown channel/);
});

test('agent server files match the desktop\'s (agentServerFiles.ts)', () => {
	// The desktop and volt-run must agree on these, or each starts its own server for the same profile.
	const source = readFileSync(path.join(REPO, 'src', 'vs', 'platform', 'voltAgentServer', 'node', 'agentServerFiles.ts'), 'utf8');
	assert.match(source, /join\(userDataDir, 'agentServer'\)/);
	assert.match(source, /tokenFile: join\(dir, 'token'\)/);
	assert.match(source, /runtimeFile: join\(dir, 'runtime\.json'\)/);
	assert.match(source, /logFile: join\(userDataDir, 'logs', 'agent-server\.log'\)/);
	assert.match(source, /compileCacheDir: join\(dir, 'compile-cache'\)/);
	assert.match(source, /`com\.volt\.agent-server\.\$\{createHash\('sha256'\)\.update\(userDataDir\)\.digest\('hex'\)\.slice\(0, 12\)\}`/);
	assert.match(source, /47_100 \+ \(hash\.readUInt16BE\(0\) % 800\)/);
	const launcher = readFileSync(path.join(REPO, 'src', 'vs', 'platform', 'voltAgentServer', 'node', 'agentServerLauncher.ts'), 'utf8');
	assert.match(launcher, /join\(this\.paths\.dir, 'network\.json'\)/);

	const paths = agentServerPaths('/Users/me/Library/Application Support/Volt');
	assert.equal(paths.dir, '/Users/me/Library/Application Support/Volt/agentServer');
	assert.equal(paths.networkFile, '/Users/me/Library/Application Support/Volt/agentServer/network.json');
	assert.match(paths.label, /^com\.volt\.agent-server\.[0-9a-f]{12}$/);
	const port = preferredPort('/Users/me/Library/Application Support/Volt');
	assert.ok(port >= 47_100 && port < 47_900);
});

test('tildify shortens paths under the home folder only', () => {
	assert.equal(tildify('/Users/me/Library/x', '/Users/me'), '~/Library/x');
	assert.equal(tildify('/Users/meow/x', '/Users/me'), '/Users/meow/x');
});
