#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { startRelayServer } from '../src/server.mjs';
import { signBody } from '../src/signature.mjs';

const USAGE = `volt-relay — a small self-hosted relay for Volt (webhooks held while offline, cloud tasks, machines)

  volt-relay serve                 start the relay (env below)
  volt-relay pair [--runner] [--name NAME]
                                   make a one-time pairing code and link (talks to the running relay)
  volt-relay sign --secret S [--github] FILE
                                   print the signature header value for a test delivery

Environment:
  VOLT_RELAY_PORT (8787)  VOLT_RELAY_HOST (0.0.0.0)  VOLT_RELAY_DATA (./relay-data)
  VOLT_RELAY_PUBLIC_URL   origin used in hook URLs and pairing links (default: request Host)
  VOLT_RELAY_ENROLL_KEY   lets runners join without a pairing code (shared secret)
  VOLT_RELAY_HOLD_DAYS (7) how long held webhooks wait for Volt before they expire
  VOLT_RELAY_ADMIN_TOKEN  admin token (default: generated into <data>/admin-token)
`;

const [command = 'serve', ...rest] = process.argv.slice(2);
const flag = name => rest.includes(name);
const value = name => {
	const index = rest.indexOf(name);
	return index >= 0 ? rest[index + 1] : undefined;
};
const dataDir = path.resolve(process.env.VOLT_RELAY_DATA ?? 'relay-data');
const port = Number(process.env.VOLT_RELAY_PORT ?? 8787);

if (command === 'serve') {
	const relay = await startRelayServer({
		dataDir,
		port,
		host: process.env.VOLT_RELAY_HOST ?? '0.0.0.0',
		publicUrl: process.env.VOLT_RELAY_PUBLIC_URL,
		enrollKey: process.env.VOLT_RELAY_ENROLL_KEY,
		holdDays: Number(process.env.VOLT_RELAY_HOLD_DAYS ?? 7),
		name: process.env.VOLT_RELAY_NAME,
	});
	console.log(`[relay] listening on :${relay.port}, data in ${dataDir}`);
	if (!relay.relay.state.devices.some(device => device.kind === 'client' && !device.revokedAt)) {
		const pairing = await relay.relay.createPairing('client', undefined);
		const base = (process.env.VOLT_RELAY_PUBLIC_URL ?? `http://localhost:${relay.port}`).replace(/\/+$/, '');
		console.log(`[relay] No Volt is paired yet. In Volt run "Connect to Relay…" and paste:\n\n    ${base}/#pair=${pairing.code}\n\n(valid 15 minutes; make another with "volt-relay pair")`);
	}
	const stop = async () => {
		await relay.close();
		process.exit(0);
	};
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
} else if (command === 'pair') {
	const token = process.env.VOLT_RELAY_ADMIN_TOKEN ?? fs.readFileSync(path.join(dataDir, 'admin-token'), 'utf8').trim();
	const response = await fetch(`http://127.0.0.1:${port}/api/pairings`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ kind: flag('--runner') ? 'runner' : 'client', name: value('--name') }),
	});
	const body = await response.json();
	if (!response.ok) {
		console.error(body.error ?? response.statusText);
		process.exit(1);
	}
	const base = (process.env.VOLT_RELAY_PUBLIC_URL ?? body.link.replace(/\/#pair=.*$/, '')).replace(/\/+$/, '');
	console.log(`${base}/#pair=${body.code}`);
	console.error(`(${body.kind} pairing code ${body.code}, valid until ${new Date(body.expiresAt).toLocaleTimeString()})`);
} else if (command === 'sign') {
	const file = rest.at(-1);
	const body = fs.readFileSync(file);
	const kind = flag('--github') ? 'github' : 'generic';
	console.log(signBody({ kind, secret: value('--secret') }, body));
} else {
	console.log(USAGE);
	process.exit(command === 'help' || command === '--help' ? 0 : 1);
}
