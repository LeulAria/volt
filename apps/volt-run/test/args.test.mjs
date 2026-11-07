/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCli } from '../src/args.mjs';

test('no arguments starts Volt and opens the browser', () => {
	const o = parseCli([]);
	assert.equal(o.command, 'start');
	assert.equal(o.open, true);
	assert.equal(o.detach, false);
	assert.equal(o.port, undefined);
});

test('commands and options', () => {
	assert.equal(parseCli(['status']).command, 'status');
	assert.equal(parseCli(['help']).help, true);
	const o = parseCli(['start', '-p', '9000', '--host', '0.0.0.0', '--no-open', '-d', '--channel', 'beta', '--release', 'v0.0.7-beta.2', '--verbose']);
	assert.deepEqual([o.port, o.host, o.open, o.detach, o.channel, o.release, o.verbose], [9000, '0.0.0.0', false, true, 'beta', '0.0.7-beta.2', true]);
	assert.equal(parseCli(['--release', 'latest']).release, 'latest');
});

test('bad input is refused with a reason', () => {
	assert.throws(() => parseCli(['launch']), /Unknown command "launch"/);
	assert.throws(() => parseCli(['start', 'extra']), /Unexpected argument "extra"/);
	assert.throws(() => parseCli(['--port', '0']), /port number/);
	assert.throws(() => parseCli(['--port', 'abc']), /port number/);
	assert.throws(() => parseCli(['--channel', 'canary']), /stable, beta, nightly/);
	assert.throws(() => parseCli(['--release', 'newest']), /Volt version/);
	assert.throws(() => parseCli(['--host', ' ']), /takes an address/);
	assert.throws(() => parseCli(['--app', '.', '--download']), /--app runs a build/);
	assert.throws(() => parseCli(['--frobnicate']), /Unknown option/);
});
