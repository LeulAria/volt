/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Volt e2e review (package ide): a tiny client for a Volt window's host MCP server.
// The config file is what an agent gets ({ mcpServers: { volt: { url, headers } } }).
//
//   node scripts/volt-e2e/ide/mcp.mjs <config.json> <tool> '<json args>'     one call, prints ms + text
//   import { connect } from './mcp.mjs'                                         for benches

import { readFileSync } from 'node:fs';

export async function connect(configPath) {
	const server = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.volt;
	const headers = { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
	let id = 0;
	async function rpc(method, params) {
		const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
		const body = await response.text();
		const json = JSON.parse(body.startsWith('{') ? body : body.split('\n').find(line => line.startsWith('data: ')).slice(6));
		if (json.error) {
			throw new Error(`${method}: ${json.error.message}`);
		}
		return json.result;
	}
	await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'volt-e2e-ide', version: '1' } });
	return {
		rpc,
		async call(name, args) {
			const start = performance.now();
			const result = await rpc('tools/call', { name, arguments: args });
			const ms = performance.now() - start;
			const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
			return { ms, text, isError: !!result.isError };
		},
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [config, tool, args] = process.argv.slice(2);
	const client = await connect(config);
	const { ms, text, isError } = await client.call(tool, JSON.parse(args ?? '{}'));
	console.log(`[${tool} ${ms.toFixed(1)} ms, ${text.length} chars${isError ? ', ERROR' : ''}]\n${text}`);
}
