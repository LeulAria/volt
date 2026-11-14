/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt e2e review (package ide): fixtures for the five IDE-tooling tasks, written into the hotel repo.
//   node scripts/volt-e2e/ide/ideFixtures.mjs [repo]          creates them (and breaks one state-machine rule for T2)
//   node scripts/volt-e2e/ide/ideFixtures.mjs [repo] --reset  git checkout + removes e2e-ide/
// T1 profile a slow script, T2 debug a failing test, T3 call an API, T4 inspect a SQLite DB, T5 draw the booking flow.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '/tmp/volt-e2e/ide/hotel';
const dir = join(repo, 'e2e-ide');
const machine = join(repo, 'apps/api/src/modules/reservation/reservation-state-machine.ts');

if (process.argv.includes('--reset')) {
	execFileSync('git', ['-C', repo, 'checkout', '--', '.']);
	rmSync(dir, { recursive: true, force: true });
	console.log('reset');
	process.exit(0);
}

mkdirSync(dir, { recursive: true });

// T1: a report that recompiles a regex and rescans every reservation per room (quadratic).
writeFileSync(join(dir, 'occupancy-report.mjs'), `// Builds the nightly occupancy report from a synthetic export. Usage: node e2e-ide/occupancy-report.mjs
const rooms = Array.from({ length: 600 }, (_, i) => ({ id: 'room-' + i, type: ['STD-K', 'DLX-D', 'STE'][i % 3] }));
const reservations = Array.from({ length: 6000 }, (_, i) => ({ id: 'res-' + i, roomId: 'room-' + (i * 7 % 600), status: ['checked_in', 'stayover', 'due_out', 'cancelled'][i % 4], nights: 1 + (i % 5) }));

function isInHouse(status) {
	return new RegExp('^(checked_in|stayover|due_out)$').test(status);
}

function nightsFor(room) {
	let nights = 0;
	for (const reservation of reservations) {
		if (isInHouse(reservation.status) && reservation.roomId === room.id) {
			nights += reservation.nights;
		}
	}
	return nights;
}

function report() {
	const byType = {};
	for (let pass = 0; pass < 12; pass++) {
		for (const room of rooms) {
			byType[room.type] = (byType[room.type] ?? 0) + (pass === 0 ? nightsFor(room) : 0) + (pass > 0 ? nightsFor(room) * 0 : 0);
		}
	}
	return byType;
}

const started = Date.now();
console.log(JSON.stringify(report()));
console.log('took', Date.now() - started, 'ms');
`);

// T3: a mock of the reservations API (started by the bench, port 9987).
writeFileSync(join(dir, 'mock-api.mjs'), `// A mock of HAIP's reservations API for the e2e review. Usage: node e2e-ide/mock-api.mjs [port]
import { createServer } from 'node:http';
const port = Number(process.argv[2] ?? 9987);
const reservations = new Map([['r1', { id: 'r1', propertyId: 'p1', status: 'confirmed', roomId: null }], ['r2', { id: 'r2', propertyId: 'p1', status: 'assigned', roomId: '101' }]]);
createServer((req, res) => {
	const url = new URL(req.url, 'http://x');
	const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
	if (req.method === 'GET' && url.pathname === '/api/v1/reservations') {
		return send(200, [...reservations.values()].filter(r => r.propertyId === url.searchParams.get('propertyId')));
	}
	const checkIn = /^\\/api\\/v1\\/reservations\\/(\\w+)\\/check-in$/.exec(url.pathname);
	if (req.method === 'PATCH' && checkIn) {
		const r = reservations.get(checkIn[1]);
		if (!r) { return send(404, { message: 'not found' }); }
		// Bug on purpose: checks in a reservation that has no room (the state machine requires assigned first).
		r.status = 'checked_in';
		return send(200, r);
	}
	send(404, { message: 'no route' });
}).listen(port, '127.0.0.1', () => console.log('mock api on', port));
`);

// T4: a SQLite copy of a few tables.
const db = join(dir, 'hotel.db');
rmSync(db, { force: true });
const rows = [];
for (let i = 0; i < 40; i++) {
	const type = ['rt-std', 'rt-dlx', 'rt-ste'][i % 3];
	const status = ['checked_in', 'confirmed', 'checked_in', 'cancelled', 'stayover'][i % 5];
	const adults = 1 + (i % 3);
	const children = i === 7 || i === 22 ? 3 : i % 2;
	rows.push(`('res-${i}', '${type}', '${status}', ${adults}, ${children})`);
}
execFileSync('sqlite3', [db], {
	input: `create table room_types (id text primary key, code text, max_occupancy integer);
insert into room_types values ('rt-std', 'STD-K', 2), ('rt-dlx', 'DLX-D', 4), ('rt-ste', 'STE', 5);
create table reservations (id text primary key, room_type_id text references room_types(id), status text, adults integer, children integer);
insert into reservations values ${rows.join(', ')};
`,
});

// T2: break one transition (assigned may no longer become no_show); reservation-state-machine.spec.ts fails.
const source = readFileSync(machine, 'utf8');
writeFileSync(machine, source.replace(`assigned: ['checked_in', 'cancelled', 'no_show'],`, `assigned: ['checked_in', 'cancelled'],`));
console.log('fixtures in', dir);
