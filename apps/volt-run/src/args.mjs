/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseArgs } from 'node:util';
import { CHANNELS } from './paths.mjs';

export const COMMANDS = ['start', 'stop', 'status', 'pair', 'clean'];

export const USAGE = `Usage: npx volt-run [command] [options]

Runs Volt on this computer and opens it in your browser: the agents, chats, files and
terminals of the Volt app, in a browser tab. If Volt is already running, it opens that one.

Commands:
  start            start Volt and open it (the default)
  stop             stop Volt's agent server
  status           show whether Volt is running, where, and from which build
  pair             make a pairing code and link for a phone or another computer
  clean            delete the Volt builds volt-run downloaded

Options:
  -p, --port <n>       listen on this port (default: the profile's own, 47100-47899)
      --host <addr>    listen on this address; 0.0.0.0 lets phones and other computers
                       on your network pair with Volt (they need a pairing code)
      --no-open        don't open the browser
  -d, --detach         start Volt in the background and return; it stops by itself after
                       15 minutes with no browser or window connected
      --profile <dir>  use this Volt profile (default: the Volt app's own, so chats are shared)
      --app <path>     run this Volt build: Volt.app, an install folder or a Volt checkout
      --download       use a downloaded build even when Volt is installed
      --release <v>    download this Volt version, or "latest"
      --channel <c>    stable, beta or nightly (default: stable)
      --verbose        print the agent server's log as it runs
  -v, --version        print the version
  -h, --help           print this help

Environment:
  BROWSER=none         never open a browser; BROWSER=<command> opens with that command
  VOLT_RUN_CACHE       where downloaded builds go (default: ~/.volt/runtime)
`;

/**
 * @param {string[]} argv
 * @returns {{ command: string, port?: number, host?: string, open: boolean, detach: boolean, profile?: string, app?: string, download: boolean, release?: string, channel?: string, verbose: boolean, help: boolean, version: boolean }}
 */
export function parseCli(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: {
			port: { type: 'string', short: 'p' },
			host: { type: 'string' },
			'no-open': { type: 'boolean' },
			detach: { type: 'boolean', short: 'd' },
			profile: { type: 'string' },
			app: { type: 'string' },
			download: { type: 'boolean' },
			release: { type: 'string' },
			channel: { type: 'string' },
			verbose: { type: 'boolean' },
			version: { type: 'boolean', short: 'v' },
			help: { type: 'boolean', short: 'h' },
			// Tests and mirrors: read release manifests from another update feed.
			feed: { type: 'string' },
		},
	});
	const [command = 'start', ...extra] = positionals;
	if (command === 'help') {
		return { ...defaults(), help: true };
	}
	if (!COMMANDS.includes(command)) {
		throw new Error(`Unknown command "${command}". Commands: ${COMMANDS.join(', ')}.`);
	}
	if (extra.length) {
		throw new Error(`Unexpected argument "${extra[0]}".`);
	}
	let port;
	if (values.port !== undefined) {
		port = Number(values.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(`--port takes a port number (1-65535), not "${values.port}".`);
		}
	}
	if (values.host !== undefined && !values.host.trim()) {
		throw new Error('--host takes an address, such as 127.0.0.1 or 0.0.0.0.');
	}
	if (values.channel !== undefined && !CHANNELS.includes(values.channel)) {
		throw new Error(`--channel takes ${CHANNELS.join(', ')}, not "${values.channel}".`);
	}
	if (values.release !== undefined && values.release !== 'latest' && !/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(values.release)) {
		throw new Error(`--release takes a Volt version (0.0.6) or "latest", not "${values.release}".`);
	}
	if (values.app && (values.download || values.release)) {
		throw new Error('--app runs a build you already have; leave out --download and --release.');
	}
	return {
		...defaults(),
		command,
		port,
		host: values.host?.trim(),
		open: !values['no-open'],
		detach: !!values.detach,
		profile: values.profile,
		app: values.app,
		download: !!values.download,
		release: values.release?.replace(/^v/, ''),
		channel: values.channel,
		verbose: !!values.verbose,
		version: !!values.version,
		help: !!values.help,
		feed: values.feed,
	};
}

function defaults() {
	return { command: 'start', open: true, detach: false, download: false, verbose: false, help: false, version: false };
}
