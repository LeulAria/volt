/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt e2e review (package ide): Volt's code tools through a running window's volt MCP server
// (the path Claude Code and Codex take), timed and sized. No models.
//
//   node scripts/volt-e2e/ide/toolBench.mjs [mcp-config.json] [out.json] [--runs 5]
//
// Each call runs `runs` times: the first is reported as "first" (cold for the language server
// and the answer cache), the rest as the warm median. Tokens are estimated as chars / 4.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { connect } from './mcp.mjs';

const config = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '/tmp/volt-e2e/ide/mcp-volt.json';
const outFile = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined;
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 5;
const repo = '/tmp/volt-e2e/ide/hotel';

const CALLS = [
	['find_symbol exact', 'find_symbol', { name: 'ReservationService' }],
	['find_symbol fuzzy', 'find_symbol', { name: 'nightAudSvc', match: 'fuzzy' }],
	['find_files', 'find_files', { query: 'reservation controller' }],
	['instant_grep literal', 'instant_grep', { pattern: 'assertTransition(', literal: true }, ['-F', 'assertTransition(']],
	['instant_grep regex', 'instant_grep', { pattern: '\\.(insert|update|delete)\\(reservations\\)', type: 'ts' }, ['-t', 'ts', '-e', '\\.(insert|update|delete)\\(reservations\\)']],
	['instant_grep files', 'instant_grep', { pattern: 'FolioService', output_mode: 'files' }, ['-l', '-e', 'FolioService']],
	['instant_grep glob+type', 'instant_grep', { pattern: 'update\\(reservations\\)', glob: 'apps/api/src/modules/reservation/reservation.service.ts', type: 'ts' }, ['-g', 'apps/api/src/modules/reservation/reservation.service.ts', '-e', 'update\\(reservations\\)']],
	['instant_grep !glob', 'instant_grep', { pattern: 'insert\\(reservations\\)', glob: '!**/*.spec.ts', output_mode: 'files' }, ['-l', '-g', '!**/*.spec.ts', '-e', 'insert\\(reservations\\)']],
	['code_nav definition', 'code_nav', { op: 'definition', path: 'apps/api/src/modules/night-audit/night-audit.service.ts', line: 42, symbol: 'ReservationService' }],
	['code_nav references', 'code_nav', { op: 'references', path: 'apps/api/src/modules/reservation/reservation-state-machine.ts', line: 41, symbol: 'assertTransition' }],
	['code_nav references (ORM column)', 'code_nav', { op: 'references', path: 'packages/database/src/schema/room.ts', line: 50, symbol: 'maxOccupancy' }],
	['code_nav callers', 'code_nav', { op: 'callers', path: 'apps/api/src/modules/reservation/reservation-state-machine.ts', line: 41, symbol: 'assertTransition' }],
	['code_nav implementations', 'code_nav', { op: 'implementations', path: 'packages/shared/src/payment-gateway.interface.ts', line: 66, symbol: 'PaymentGateway' }],
	['code_nav inspect', 'code_nav', { op: 'inspect', path: 'apps/api/src/modules/reservation/reservation-state-machine.ts', line: 41, symbol: 'assertTransition' }],
	['code_nav workspace_symbols', 'code_nav', { op: 'workspace_symbols', query: 'NightAudit' }],
	['diagnostics file', 'diagnostics', { paths: ['apps/api/src/modules/reservation/reservation.service.ts'] }],
];

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const client = await connect(config);
const rows = [];
for (const [label, tool, args, rgArgs] of CALLS) {
	const times = [];
	let text = '';
	let isError = false;
	for (let i = 0; i < runs; i++) {
		const result = await client.call(tool, args).catch(err => ({ ms: NaN, text: String(err), isError: true }));
		times.push(result.ms);
		text = result.text;
		isError = result.isError;
	}
	let rgMs;
	if (rgArgs) {
		const rgTimes = [];
		for (let i = 0; i < 5; i++) {
			const start = performance.now();
			spawnSync('rg', ['-n', ...rgArgs, repo], { maxBuffer: 64 * 1024 * 1024 });
			rgTimes.push(performance.now() - start);
		}
		rgMs = +median(rgTimes).toFixed(1);
	}
	const row = { label, tool, firstMs: +times[0].toFixed(1), warmMedianMs: +median(times.slice(1)).toFixed(1), rgMs, chars: text.length, estTokens: Math.round(text.length / 4), isError, head: text.split('\n').slice(0, 2).join(' | ').slice(0, 160) };
	rows.push(row);
	console.log(`${label.padEnd(36)} first ${String(row.firstMs).padStart(8)} ms  warm ${String(row.warmMedianMs).padStart(7)} ms  ${rgMs !== undefined ? `rg ${String(rgMs).padStart(6)} ms  ` : ''.padEnd(13)}${String(row.chars).padStart(6)} chars ~${row.estTokens} tok${isError ? '  ERROR' : ''}  ${row.head}`);
}
if (outFile) {
	writeFileSync(outFile, JSON.stringify({ runs, rows }, null, 1));
}
process.exit(0);
